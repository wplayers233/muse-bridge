// Codex 的模型清单：问一次 `codex app-server` 的 model/list，缓存结果。
//
// 为什么走 app-server：官方 CLI 没有 `codex models` 这类子命令（exec --help 里只有 -m <model> 一个
// 裸参数，没有任何「可选模型」的来源），而 app-server 的 model/list 恰恰是官方桌面应用与 IDE 扩展
// 用来填那个模型下拉框的同一条接口——displayName / supportedReasoningEfforts / defaultReasoningEffort
// 全在里面。这边只借用它读一次清单，进程用完即收：不托管会话、不留常驻进程。
//
// 起进程的成本（实测约 1 秒）与它带来的价值不匹配每次请求都跑，所以缓存 10 分钟；
// 失败也缓存（短一些），免得后端版本不合时把每一次开页面都拖成一个超时。
//
// 读清单【不需要登录】：未认证时 model/list 照样返回完整列表（实测），所以这个接口在没登录的
// 机器上也给得出模型名——用户至少能看见自己要选的是哪个，而不是一个空下拉框。

import { spawn } from 'node:child_process';
import { findCliBin } from './agent-status.mjs';

const OK_TTL_MS = 10 * 60_000;
const FAIL_TTL_MS = 60_000;
const CALL_TIMEOUT_MS = 8_000;
const HANDSHAKE_TIMEOUT_MS = 8_000;

// 思考深度的取值来自 model/list 的 supportedReasoningEfforts（实测 0.162.1 的六个档）。
// 这里只作为「上游没给全时」的兜底顺序参考，实际可用档位以每个模型自己报的为准。
export const EFFORT_ORDER = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

let cache = { at: 0, ttl: 0, models: [] };

// 归一成界面要的形状：id / 显示名 / 说明 / 可选思考深度 / 默认深度 / 是否默认。
function normModel(m) {
  if (!m || typeof m !== 'object') return null;
  const id = String(m.model || m.id || '').trim();
  if (!id) return null;
  const efforts = (Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts : [])
    .map((e) => (e && typeof e === 'object' ? String(e.reasoningEffort || '') : String(e || '')))
    .filter(Boolean);
  return {
    id,
    label: String(m.displayName || id),
    description: String(m.description || ''),
    efforts,
    defaultEffort: m.defaultReasoningEffort ? String(m.defaultReasoningEffort) : '',
    isDefault: !!m.isDefault,
    hidden: !!m.hidden,
  };
}

// 一次性子进程：initialize → initialized → model/list，拿到就走。
// 任何一步失败（子命令不存在、超时、坏 JSON）都回 null——调用方据此回落，不抛。
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
          res(msg.error ? null : msg.result);
        }
      }
    });

    after(HANDSHAKE_TIMEOUT_MS, () => finish(null));
    (async () => {
      const init = await call('initialize', { clientInfo: { name: 'muse-bridge', title: 'Muse Bridge', version: '1.0.0' } });
      if (!init) return finish(null);
      try { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }) + '\n'); } catch {}
      const list = await call('model/list', {});
      if (!list || !Array.isArray(list.data)) return finish(null);
      finish(list.data.map(normModel).filter(Boolean));
    })();
  });
}

/**
 * 这台机器上 codex 能用的模型清单。读缓存；过期才真起进程。
 * @returns {Promise<Array>} 失败时回空数组（界面据此不摆选择器，而不是摆一个空的）
 */
export async function codexModels({ env = process.env, force = false } = {}) {
  const now = Date.now();
  if (!force && cache.at && now - cache.at < cache.ttl) return cache.models;
  const bin = findCliBin('codex', env);
  if (!bin) { cache = { at: now, ttl: FAIL_TTL_MS, models: [] }; return []; }
  const models = await askAppServer(bin, env);
  if (!models || !models.length) {
    cache = { at: now, ttl: FAIL_TTL_MS, models: cache.models || [] };
    return cache.models || [];
  }
  cache = { at: now, ttl: OK_TTL_MS, models };
  return models;
}

// 测试与「重新检测」用：丢掉缓存。
export function resetModelCache() { cache = { at: 0, ttl: 0, models: [] }; }
