// Codex 技能清单（官方 app-server 的 skills/list，只读）。
//
// 方法名已按本机 codex 0.149.0 重新导出核对（`codex app-server generate-json-schema
// --out <dir> --experimental` 的 ClientRequest.json）：
//   skills/list            { cwds?: string[], forceReload?: boolean }
//   skills/extraRoots/set  { extraRoots: AbsolutePathBuf[] }（P3 后续，未接）
//   skills/config/write    { enabled: boolean, name?: string|null, path?: AbsolutePathBuf|null }（P3 后续，未接）
// 回包形状：{ data: [{ cwd, skills: [{ name, description, shortDescription?,
//   interface: { displayName, shortDescription, ... }, path, scope, enabled }] }] }。
// 技能按 cwd 分组：这里按调用方给的 cwd 拼 cwds，压平成一维清单。
//
// 探针是一次性子进程（同 agent-models.mjs 的 askAppServer）：initialize → initialized →
// skills/list，拿到就走。任何一步失败都回 null——调用方据此隐藏技能区，不抛。
import { spawn } from 'node:child_process';
import { findCliBin } from './agent-status.mjs';

const CALL_TIMEOUT_MS = 8_000;
const HANDSHAKE_TIMEOUT_MS = 8_000;
// 技能装/卸不频繁：5 分钟缓存；force（界面「重新扫描」）绕过缓存并让上游重扫磁盘。
const CACHE_TTL_MS = 5 * 60_000;
const cache = new Map(); // cwd -> { at, skills }

// 归一：显示用短描述优先（shortDescription 没有就退回 interface 里的，再退回完整 description）。
function normSkill(s) {
  if (!s || typeof s !== 'object') return null;
  const name = String(s.name || '').trim();
  if (!name) return null;
  const iface = (s.interface && typeof s.interface === 'object') ? s.interface : {};
  return {
    name,
    displayName: String(iface.displayName || name),
    description: String(s.shortDescription || iface.shortDescription || s.description || ''),
    path: String(s.path || ''),
    scope: String(s.scope || ''),
    enabled: s.enabled !== false,
  };
}

function askAppServer(bin, env, cwd, force) {
  return new Promise((resolve) => {
    const isJs = /\.(c|m)?js$/i.test(bin);
    let child;
    try {
      child = spawn(isJs ? process.execPath : bin, isJs ? [bin, 'app-server'] : ['app-server'], {
        // 探针进程必须跑在用户的这个工作目录里：skills/list 会触发上游重读配置，
        // 它会读 <进程 cwd>/.codex/config.toml——跑在别人的目录下（如服务端 cwd）
        // 那个 config.toml 读不了（EACCES），skills/list 直接报 -32603。
        // （model/list 不重读配置，所以 agent-models.mjs 的探针不用这招。）
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
      const init = await call('initialize', {
        clientInfo: { name: 'muse-bridge', title: 'Muse Bridge', version: '1.0.0' },
        capabilities: { experimentalApi: true },
      });
      if (!init) return finish(null);
      try { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }) + '\n'); } catch {}
      const list = await call('skills/list', { cwds: cwd ? [cwd] : [], forceReload: !!force });
      if (!list || !Array.isArray(list.data)) return finish(null);
      const out = [];
      for (const g of list.data) {
        if (!g || !Array.isArray(g.skills)) continue;
        for (const s of g.skills) {
          const n = normSkill(s);
          if (n) out.push(n);
        }
      }
      finish(out);
    })();
  });
}

/**
 * 这台机器上 codex 在给定工作目录下能用的技能清单（只读）。
 * @param {{ env?: object, cwd?: string, force?: boolean }} opts
 * @returns {Promise<Array|null>} 失败时 null（调用方隐藏技能区）；成功时数组（可为空）
 */
export async function codexSkills({ env = process.env, cwd = '', force = false } = {}) {
  const key = String(cwd || '');
  const now = Date.now();
  if (!force && cache.has(key)) {
    const hit = cache.get(key);
    if (hit && now - hit.at < CACHE_TTL_MS) return hit.skills;
  }
  const bin = findCliBin('codex', env);
  if (!bin) return null;
  const skills = await askAppServer(bin, env, key, force);
  // 只缓存成功结果：失败不缓存（瞬时失败不应把技能区藏 5 分钟），界面「重新扫描」也能重试。
  if (Array.isArray(skills)) cache.set(key, { at: now, skills });
  return skills;
}
