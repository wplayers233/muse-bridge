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
import { existsSync, readFileSync, writeFile } from 'node:fs';
import { findCliBin } from './agent-status.mjs';

const OK_TTL_MS = 10 * 60_000;
const FAIL_TTL_MS = 60_000;
const CALL_TIMEOUT_MS = 8_000;
const HANDSHAKE_TIMEOUT_MS = 8_000;

// 思考深度的取值来自 model/list 的 supportedReasoningEfforts（实测 0.162.1 的六个档）。
// 这里只作为「上游没给全时」的兜底顺序参考，实际可用档位以每个模型自己报的为准。
export const EFFORT_ORDER = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

let cache = { at: 0, ttl: 0, models: [] };

// —— 目录并集：对抗上游灰度翻动 ——
// model/list 的目录由 OpenAI 服务端按灰度桶下发（实测同一台机器几分钟内从 8 个翻到 3 个，
// 与登录态 / API key / clientInfo 均无关）。上游翻到「精简桶」时，见过的模型不该从界面上消失：
// codex 的 -m 接受任意模型 id，目录没下发 ≠ 不能用。所以把【历次见过的】模型做并集：
// 一旦见过就一直在列表里；上游下次发全量时字段（说明 / 思考深度档）自动补全。
let union = null;          // Map<id, model> | null（null = 还没从磁盘懒加载过）
let unionLoadedFrom = '';  // 记录懒加载来源路径，路径变了（换 dataDir）就重载

// 纯函数：把 latest 合进 stored，返回并集数组（first-seen 顺序；latest 字段优先，新条目追加尾部）。
export function mergeUnion(stored, latest) {
  const out = new Map();
  for (const m of Array.isArray(stored) ? stored : []) {
    if (m && typeof m === 'object' && m.id) out.set(m.id, m);
  }
  for (const m of Array.isArray(latest) ? latest : []) {
    if (m && typeof m === 'object' && m.id) out.set(m.id, m);   // Map.set = 覆盖字段 + 保留原位置
  }
  return [...out.values()];
}

function loadUnion(storePath) {
  if (union && unionLoadedFrom === storePath) return union;
  unionLoadedFrom = storePath;
  let seed = [];
  try {
    if (existsSync(storePath)) {
      const j = JSON.parse(readFileSync(storePath, 'utf8'));
      if (Array.isArray(j?.models)) seed = j.models;
    }
  } catch { seed = []; }   // 坏文件当没有，下次成功拉取会重写
  union = new Map(seed.filter((m) => m && m.id).map((m) => [m.id, m]));
  return union;
}

function persistUnion(storePath) {
  if (!union) return;
  // fire-and-forget：单管理员场景没有并发竞争，写失败也不影响主流程
  writeFile(storePath, JSON.stringify({ savedAt: new Date().toISOString(), models: [...union.values()] }), (err) => {
    if (err) console.error('[agent-models] union 持久化失败:', err.message);
  });
}

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
 * 这台机器上 codex 能用的模型清单（历次见过的并集）。读缓存；过期才真起进程。
 * @param {{ env?: object, force?: boolean, store?: { path: string } }} opts
 *   store 给了就把并集持久化到那个文件（重启不丢）；不传 = 纯内存（测试用）。
 * @returns {Promise<Array>} 失败时回已知的并集（界面据此不摆空的选择器）
 */
export async function codexModels({ env = process.env, force = false, store = null } = {}) {
  const now = Date.now();
  if (!force && cache.at && now - cache.at < cache.ttl) return cache.models;
  const bin = findCliBin('codex', env);
  if (!bin) {
    cache = { at: now, ttl: FAIL_TTL_MS, models: [] };
    return [];
  }
  const models = await askAppServer(bin, env);
  if (!models || !models.length) {
    // 拉取失败也回并集：上游抖一下不该把界面清空
    const known = store ? [...loadUnion(store.path).values()] : (cache.models || []);
    cache = { at: now, ttl: FAIL_TTL_MS, models: known };
    return known;
  }
  let list = models;
  if (store) {
    const u = loadUnion(store.path);
    list = mergeUnion([...u.values()], models);
    for (const m of list) u.set(m.id, m);
    persistUnion(store.path);
  }
  cache = { at: now, ttl: OK_TTL_MS, models: list };
  return list;
}

// 测试与「重新检测」用：丢掉缓存（内存并集一并清；磁盘文件保留——它是「见过的」历史）。
export function resetModelCache() {
  cache = { at: 0, ttl: 0, models: [] };
  union = null;
  unionLoadedFrom = '';
}
