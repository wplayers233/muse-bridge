// Codex 的 coding plan 用量：问一次 `codex app-server` 的 account/rateLimits/read，缓存结果。
//
// 为什么走 app-server：ChatGPT 套餐的额度窗口（5h / 周）只有官方客户端才有入口，exec 路没有；
// app-server 的 account/rateLimits/read 正是官方桌面应用画那条用量条的同一条接口——
// planType（plus/pro/…）、primary/secondary 两个窗口的 usedPercent/resetsAt、credits 余额全在里面。
// 方法名随版本变：本机 0.149.0 只认驼峰 account/rateLimits/read，0.162.1 的 schema 里是下划线
// account/rate_limits/read——先驼峰，报错再回退下划线，两边都认（0.162.1 官方 schema 实证：
// GetAccountRateLimitsResponse → RateLimitSnapshot → RateLimitWindow。）
// 这边只借它读一次，进程用完即收：不托管会话、不留常驻进程。
//
// 起进程约 1 秒，不该每次开菜单都跑：成功缓存 5 分钟、失败 60 秒（plan 是慢变量，比模型清单还能缓）。
// 【API-key 模式没有 plan】：上游回 error 或缺 rateLimits 时一律归 null，前端据此整行隐藏——
// 余额这种东西宁可不见，也不能摆一个错的。
//
// 读这个接口【需要 ChatGPT 登录态】（API key 读不了），与 model/list 的「未登录也给清单」不同。

import { spawn } from 'node:child_process';
import { findCliBin } from './agent-status.mjs';

const OK_TTL_MS = 5 * 60_000;
const FAIL_TTL_MS = 60_000;
const CALL_TIMEOUT_MS = 8_000;
const HANDSHAKE_TIMEOUT_MS = 8_000;

let cache = { at: 0, ttl: 0, plan: null };

// 窗口归一：只留界面要画的三个数（用量百分比 / 重置时间 / 窗口时长）。
function normWindow(w) {
  if (!w || typeof w !== 'object') return null;
  const pct = Number(w.usedPercent);
  if (!Number.isFinite(pct)) return null;
  const resetsAt = Number(w.resetsAt);
  const mins = Number(w.windowDurationMins);
  return {
    usedPercent: pct,
    resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
    windowMinutes: Number.isFinite(mins) ? mins : null,
  };
}

// 响应 → 归一 plan。缺 rateLimits（API-key 模式 / 未登录）或形状不符 → null。
export function normRateLimits(result) {
  if (!result || typeof result !== 'object') return null;
  const rl = result.rateLimits;
  if (!rl || typeof rl !== 'object') return null;
  const primary = normWindow(rl.primary);
  if (!primary) return null;   // 没有主窗口 = 没有可显示的 plan 额度
  const credits = rl.credits && typeof rl.credits === 'object'
    ? { balance: rl.credits.balance != null ? String(rl.credits.balance) : '', unlimited: !!rl.credits.unlimited }
    : null;
  return {
    planType: rl.planType ? String(rl.planType) : '',
    primary,
    secondary: normWindow(rl.secondary),
    credits: credits && credits.balance ? credits : null,
  };
}

// 一次性子进程：initialize → initialized → account/rateLimits/read（报错回退 account/rate_limits/read），拿到就走。
// 任何一步失败（子命令不存在、超时、坏 JSON、上游 error）都回 null——调用方据此隐藏，不抛。
function askAppServer(bin, env) {
  return new Promise((resolve) => {
    const isJs = /\.(c|m)?js$/i.test(bin);
    let child;
    try {
      child = spawn(isJs ? process.execPath : bin, isJs ? [bin, 'app-server'] : ['app-server'], {
        env: { ...env, NO_COLOR: '1', TERM: 'dumb' },
        stdio: ['pipe', 'pipe', 'ignore'],
        detached: process.platform !== 'win32',
      });
    } catch { resolve(null); return; }

    let settled = false;
    let buf = '';
    let nextId = 1;
    const waiters = new Map();
    const timers = new Set();

    const killTree = () => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { try { child.kill('SIGKILL'); } catch {} }
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      killTree();
      resolve(value);
    };
    const after = (ms, fn) => { const t = setTimeout(fn, ms); t.unref?.(); timers.add(t); return t; };

    const call = (method, params) => new Promise((res) => {
      const id = nextId++;
      waiters.set(id, res);
      try {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }) + '\n');
      } catch { res(null); }
      after(CALL_TIMEOUT_MS, () => { if (waiters.has(id)) { waiters.delete(id); res(null); } });
    });

    child.on('error', () => finish(null));
    child.on('close', () => finish(null));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id != null && waiters.has(msg.id)) {
          const res = waiters.get(msg.id); waiters.delete(msg.id);
          res(msg);   // 整条回给调用方：它要看 error 才能决定要不要回退旧方法名
        }
      }
    });

    after(HANDSHAKE_TIMEOUT_MS, () => finish(null));
    (async () => {
      const init = await call('initialize', { clientInfo: { name: 'muse-bridge', title: 'Muse Bridge', version: '1.0.0' } });
      if (!init || init.error) return finish(null);
      try { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }) + '\n'); } catch {}
      // 先驼峰 account/rateLimits/read（本机 0.149.0 只认这个）；上游 error（unknown variant）
      // 才回退下划线 account/rate_limits/read（0.162.1 的名字）。超时不回退——app-server 挂了
      // 的话重问也一样挂，还多等 8 秒。
      let rl = null;
      const first = await call('account/rateLimits/read', {});
      if (first && !first.error) rl = first.result;
      else if (first && first.error) {
        const legacy = await call('account/rate_limits/read', {});
        if (legacy && !legacy.error) rl = legacy.result;
      }
      finish(normRateLimits(rl));
    })();
  });
}

/**
 * 这个身份的 codex coding plan 用量。读缓存；过期才真起进程。
 * @returns {Promise<object|null>} null = 没有 plan 可显示（没装 / API-key 模式 / 上游不合），前端整行隐藏
 */
export async function codexPlan({ env = process.env, force = false } = {}) {
  const now = Date.now();
  if (!force && cache.at && now - cache.at < cache.ttl) return cache.plan;
  const bin = findCliBin('codex', env);
  if (!bin) { cache = { at: now, ttl: FAIL_TTL_MS, plan: null }; return null; }
  const plan = await askAppServer(bin, env);
  cache = { at: now, ttl: plan ? OK_TTL_MS : FAIL_TTL_MS, plan };
  return plan;
}

// 测试用：丢掉缓存。
export function resetPlanCache() { cache = { at: 0, ttl: 0, plan: null }; }
