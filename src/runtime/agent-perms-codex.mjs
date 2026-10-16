// Codex 权限 profile 清单（官方 app-server 的 permissionProfile/list，只读）。
//
// 探针实测（0.162.1）：
//   · 无自定义 profile 时回 3 个内置的——:read-only、:workspace、:danger-full-access，
//     全是 allowed: true、description: null；cwd 传不传结果一样。
//   · permissionProfile/list 不需要 experimentalApi（initialize 不声明也能调）；
//     但 turn/start / thread/start 带 permissions 需要 experimentalApi（Bridge 的握手已声明）。
// 回包形状：{ data: [{ id, allowed, description }] }。
//
// 探针是一次性子进程（同 agent-skills-codex.mjs）：initialize → initialized →
// permissionProfile/list，拿到就走。任何一步失败都回 null——调用方据此隐藏 profile
// 选择区，不抛。探针进程必须跑在用户的这个工作目录里（同 skills 探针的理由：
// 上游会读 <进程 cwd>/.codex/config.toml，跑在别人的目录下会 EACCES）。
import { spawn } from 'node:child_process';
import { findCliBin } from './agent-status.mjs';

const CALL_TIMEOUT_MS = 8_000;
const HANDSHAKE_TIMEOUT_MS = 8_000;
// profile 列表不常变：5 分钟缓存；force（界面「重新扫描」）绕过缓存。
const CACHE_TTL_MS = 5 * 60_000;
const cache = new Map(); // cwd -> { at, profiles }

function normProfile(p) {
  if (!p || typeof p !== 'object') return null;
  const id = String(p.id || '').trim();
  if (!id) return null;
  return { id, allowed: p.allowed !== false, description: typeof p.description === 'string' ? p.description : null };
}

function askAppServer(bin, env, cwd) {
  return new Promise((resolve) => {
    const isJs = /\.(c|m)?js$/i.test(bin);
    let child;
    try {
      child = spawn(isJs ? process.execPath : bin, isJs ? [bin, 'app-server'] : ['app-server'], {
        cwd: cwd || undefined,
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
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      } catch { waiters.delete(id); res(null); return; }
      after(CALL_TIMEOUT_MS, () => { if (waiters.has(id)) { waiters.delete(id); res(null); } });
    });

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
          const r = waiters.get(msg.id); waiters.delete(msg.id); r(msg);
        }
      }
    });
    child.on('error', () => finish(null));
    child.on('exit', () => finish(null));

    (async () => {
      const init = await call('initialize', { clientInfo: { name: 'muse-bridge', version: '1.0.0' }, capabilities: {} });
      if (!init || !init.result) { finish(null); return; }
      try { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }) + '\n'); } catch { finish(null); return; }
      const r = await call('permissionProfile/list', { cwd: cwd || undefined });
      if (!r || r.error || !r.result || !Array.isArray(r.result.data)) { finish(null); return; }
      finish(r.result.data.map(normProfile).filter(Boolean));
    })();
    after(HANDSHAKE_TIMEOUT_MS + CALL_TIMEOUT_MS * 2, () => finish(null));
  });
}

export async function codexPermissionProfiles({ env = process.env, cwd = '', force = false } = {}) {
  const key = String(cwd || '');
  if (!force) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.profiles;
  }
  const bin = findCliBin('codex', env);
  if (!bin) return null;
  const profiles = await askAppServer(bin, env, cwd);
  if (profiles) cache.set(key, { at: Date.now(), profiles });
  return profiles;
}
