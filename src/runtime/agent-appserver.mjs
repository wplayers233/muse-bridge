// 外部 CLI agent（Codex）的 app-server 传输层。
//
// 【为什么有这一段】
// `codex exec --json` 是官方给脚本用的一次性出口：一轮一个进程、没有审批、没有会话托管、
// 不能插话。官方给富客户端（桌面应用、VS Code 扩展）留的是 `codex app-server`——
// JSON-RPC 2.0 over stdio 的协议，审批、会话、模型、token 用量全在里面。
//
// 【为什么不做常驻进程】
// 每轮起一个进程，会话交给 CLI 托管（thread/start 新建、thread/resume 接上）。
// 实测（0.162.1）：进程 A 建线程并说「记住 PINEAPPLE」，进程 B 用 thread/resume 接上后
// 能答出 PINEAPPLE —— 跨进程续聊成立。所以常驻那套复杂度（谁持有、闲置多久收、崩了怎么拉）
// 在这里没有必要，而且与本项目「一轮一个进程、客户端断开即杀」的既有模型完全一致。
//
// 【产出的还是同一套归一事件】
// 前端（components/cli/CliChat.svelte）只认 lib/cliChat.svelte.js 那一套事件，所以这里
// 刻意吐与 runtime/agent-cli.mjs 相同的词汇（text/reasoning/tool/notice/error/done），
// 外加一个 approval（审批卡）。换传输层不该让界面跟着改。
//
// 协议形状全部来自真机实测与官方 schema（`codex app-server generate-json-schema`），
// 不是照文档猜的——尤其 fileChange.changes[].kind 在这条路上是【对象】{type:'add'}，
// 而 exec 那条路是字符串，照着 exec 写会解析不出来。

import { spawn } from 'node:child_process';
import { findCliBin } from './agent-status.mjs';
import { cliKeyEnv } from './agent-keys.mjs';

// 审批类反向请求 → 界面上那张卡的 kind。
const APPROVAL_METHODS = Object.freeze({
  'item/commandExecution/requestApproval': 'command',
  'item/fileChange/requestApproval': 'fileChange',
  'item/permissions/requestApproval': 'permissions',
  'execCommandApproval': 'command',
  'applyPatchApproval': 'fileChange',
});

export const isApprovalMethod = (m) => Object.prototype.hasOwnProperty.call(APPROVAL_METHODS, m);

// 走「工具行」归一的 ThreadItem 类型（item/started|completed|updated 三相都画）。
const TOOL_ITEMS = new Set([
  'commandExecution', 'fileChange', 'mcpToolCall', 'webSearch',
  'dynamicToolCall', 'collabAgentToolCall', 'subAgentActivity', 'functionCallOutput',
]);

const TOOL_TEXT_MAX = 20_000;
const cut = (s) => String(s).slice(0, TOOL_TEXT_MAX);

// ── 纯函数：协议对象 → 归一事件（可单测，不起进程）─────────────────────────

// fileChange 的 kind 在 app-server 上是对象（{type:'add'|'update'|'delete'}），exec 上是字符串。
// 两种都认，统一成字符串给界面。
export function normChangeKind(kind) {
  if (typeof kind === 'string') return kind;
  if (kind && typeof kind === 'object' && typeof kind.type === 'string') return kind.type;
  return '';
}

// 工具行的标题。与 agent-cli.mjs 的 codexToolName 保持同一套说法（界面不必分两条路）。
export function appToolName(item) {
  switch (item.type) {
    case 'commandExecution': return item.command ? '命令 ' + String(item.command).split('\n')[0].slice(0, 120) : '命令';
    case 'fileChange': {
      const paths = (Array.isArray(item.changes) ? item.changes : []).map((c) => c && c.path).filter(Boolean);
      return '改文件' + (paths.length ? '（' + paths.map((p) => String(p).split('/').pop()).join('、') + '）' : '');
    }
    case 'mcpToolCall': return [item.server, item.tool].filter(Boolean).join(' · ') || 'MCP 工具';
    case 'webSearch': return '联网搜索' + (item.query ? '：' + String(item.query).slice(0, 80) : '');
    case 'dynamicToolCall': return '动态工具' + (item.tool ? '：' + String(item.tool).slice(0, 80) : '');
    case 'collabAgentToolCall': return '协作代理' + (item.tool ? ' · ' + String(item.tool) : '');
    case 'subAgentActivity': {
      const base = String(item.agentPath || '').split(/[\\/]/).pop();
      return '子代理' + (base ? '：' + base.slice(0, 80) : '');
    }
    case 'functionCallOutput': return item.name ? String(item.name).slice(0, 120) : '函数调用';
    default: return item.type ? String(item.type) : '工具';
  }
}

// 状态归一：app-server 用 inProgress/completed/failed，界面认 started/completed/failed。
export function normAppStatus(item, phase) {
  const s = String(item.status || '');
  if (s === 'failed' || s === 'error') return 'failed';
  if (s === 'completed' || s === 'done') return 'completed';
  if (s === 'inProgress' || s === 'running') return 'started';
  return phase === 'completed' ? 'completed' : 'started';
}

// 一件工具（命令 / 改文件）→ 归一事件。phase ∈ started|completed|updated。
export function normAppToolItem(item, phase) {
  const out = { type: 'tool', id: String(item.id || ''), name: appToolName(item), status: normAppStatus(item, phase) };
  if (item.type === 'commandExecution') {
    if (typeof item.command === 'string' && item.command) out.command = cut(item.command);
    const o = item.aggregatedOutput ?? item.aggregated_output;
    if (typeof o === 'string' && o) out.output = cut(o);
    const code = item.exitCode ?? item.exit_code;
    if (code != null && Number.isFinite(Number(code))) out.exitCode = Number(code);
  } else if (item.type === 'fileChange') {
    const list = (Array.isArray(item.changes) ? item.changes : [])
      .map((c) => ({ path: String((c && c.path) || ''), kind: normChangeKind(c && c.kind), diff: c && c.diff ? cut(c.diff) : '' }))
      .filter((c) => c.path);
    if (list.length) out.changes = list;
  } else if (item.type === 'mcpToolCall') {
    if (item.tool) out.tool = String(item.tool).slice(0, 120);
    const txt = mcpResultText(item);
    if (txt) out.output = cut(txt);
  } else if (item.type === 'webSearch') {
    if (item.query) out.summary = String(item.query).slice(0, 400);
  } else if (item.type === 'dynamicToolCall') {
    if (item.tool) out.tool = String(item.tool).slice(0, 120);
    const txt = dynamicOutputText(item);
    if (txt) out.output = cut(txt);
  } else if (item.type === 'collabAgentToolCall') {
    const txt = collabAgentsText(item);
    if (txt) out.output = cut(txt);
  } else if (item.type === 'subAgentActivity') {
    if (item.kind) out.summary = String(item.kind);
    // kind 自带结论：completed/interrupted 比 phase 更权威，直接采信。
    if (item.kind === 'completed') out.status = 'completed';
    else if (item.kind === 'interrupted') out.status = 'failed';
  } else if (item.type === 'functionCallOutput') {
    const txt = functionOutputText(item);
    if (txt) out.output = cut(txt);
  }
  return out;
}

// 一轮的 input：正文 + 本地图片。U1 已按 0.162.1 官方 schema 复核（codex app-server
// generate-json-schema → UserInput）：本地图片变体是【localImage】{path, detail?}（驼峰），
// 不是 exec 文档里的 --image，更不是下划线的 local_image。
export function buildTurnInput(prompt, images = []) {
  const input = [];
  const text = String(prompt ?? '');
  if (text) input.push({ type: 'text', text });
  const list = Array.isArray(images) ? images : [];
  for (const img of list) {
    const p = String(img || '').trim();
    if (p) input.push({ type: 'localImage', path: p });
  }
  // 空轮次兜底：input 不允许为空数组（TextUserInput 的 text 是必填）。
  if (!input.length) input.push({ type: 'text', text: '' });
  return input;
}

// MCP 工具结果 → 纯文本（result.content 是块数组，取 text 块拼接；出错给 error.message）。
function mcpResultText(item) {
  if (item.error && item.error.message) return String(item.error.message);
  const r = item.result;
  const content = r && Array.isArray(r.content) ? r.content : [];
  const parts = content
    .map((c) => (c && typeof c === 'object' && typeof c.text === 'string' ? c.text : ''))
    .filter(Boolean);
  return parts.join('\n');
}

// dynamicToolCall 的输出：contentItems 里挑 text 块拼接（inputImage/inputAudio 这类非文本块不展开）。
function dynamicOutputText(item) {
  const items = Array.isArray(item.contentItems) ? item.contentItems : [];
  return items
    .map((c) => (c && c.type === 'inputText' && typeof c.text === 'string' ? c.text : ''))
    .filter(Boolean)
    .join('\n');
}

// collabAgentToolCall 的 agentsStates（{名字: {status, message?}}）→ 「名字：状态」行；
// prompt 有值时放在最前，让人知道这次协作是去干什么。
function collabAgentsText(item) {
  const states = item.agentsStates && typeof item.agentsStates === 'object' ? item.agentsStates : {};
  const lines = Object.entries(states)
    .map(([name, st]) => String(name).slice(0, 80) + '：' + String((st && st.status) || (st && st.message) || ''));
  if (item.prompt) lines.unshift(String(item.prompt).slice(0, 300));
  return lines.join('\n');
}

// functionCallOutput 的 output：字符串，或 content 块数组（取 text 块拼接）。
function functionOutputText(item) {
  const o = item.output;
  if (typeof o === 'string') return o;
  if (Array.isArray(o)) {
    return o.map((c) => (c && typeof c === 'object' && typeof c.text === 'string' ? c.text : '')).filter(Boolean).join('\n');
  }
  return '';
}

// turn/plan/updated 的 plan 步骤 → 待办清单条目（与 exec 路 todo_list 同一形状）。
// 状态词汇差异：app-server 给 inProgress（驼峰），任务卡认 in_progress，这里映射。
export function appPlanItems(plan) {
  const list = Array.isArray(plan) ? plan : [];
  return list
    .map((s) => {
      const status = String((s && s.status) || '');
      return {
        text: String((s && (s.step || s.text)) || '').slice(0, 300),
        status: status === 'inProgress' ? 'in_progress' : status,
      };
    })
    .filter((x) => x.text);
}

// token 用量：app-server 给 {total:{...}, last:{...}}，取 last（这一轮）。
export function appUsage(tokenUsage) {
  const u = tokenUsage && typeof tokenUsage === 'object' ? (tokenUsage.last || tokenUsage.total || tokenUsage) : null;
  if (!u || typeof u !== 'object') return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const out = {
    input_tokens: num(u.inputTokens ?? u.input_tokens),
    output_tokens: num(u.outputTokens ?? u.output_tokens),
    cached_input_tokens: num(u.cachedInputTokens ?? u.cached_input_tokens),
    total: num(u.totalTokens ?? u.total_tokens),
  };
  return Object.values(out).some((v) => v != null) ? out : null;
}

// 审批请求 → 界面那张卡的数据。
// availableDecisions 是上游给的可选项（枚举见 CommandExecutionRequestApprovalResponse）：
// accept / acceptForSession / {acceptWithExecpolicyAmendment} / decline / cancel。
// 界面按它摆按钮——上游要是哪天上新决策，不用改我们的代码。
// id：这一张卡的编号，用户点按钮时原样带回（服务端靠它找到那个还在等的 promise）。
export function approvalCard(method, params) {
  const p = params && typeof params === 'object' ? params : {};
  const kind = APPROVAL_METHODS[method] || 'command';
  const decisions = (Array.isArray(p.availableDecisions) ? p.availableDecisions : [])
    .map((d) => (typeof d === 'string' ? d : (d && typeof d === 'object' ? Object.keys(d)[0] : '')))
    .filter(Boolean);
  const changes = (Array.isArray(p.changes) ? p.changes : [])
    .map((c) => ({ path: String((c && c.path) || ''), kind: normChangeKind(c && c.kind) }))
    .filter((c) => c.path);
  return {
    type: 'approval',
    id: String(p.__approvalId || ''),
    kind,
    reason: String(p.reason || '').slice(0, 600),
    command: p.command ? String(p.command).slice(0, 2000) : '',
    cwd: p.cwd ? String(p.cwd).slice(0, 500) : '',
    changes,
    decisions: decisions.length ? decisions : ['accept', 'acceptForSession', 'decline', 'cancel'],
    itemId: String(p.itemId || ''),
  };
}

// ── 进程部分 ────────────────────────────────────────────────────────────────

// 一条 JSON-RPC 连接：逐行解析、id 配对、通知进队列、反向请求交给回调。
function connect(child, { onServerRequest, logs = [] } = {}) {
  let buf = '';
  let nextId = 1;
  let apSeq = 0;                      // 审批卡的编号（每轮独立，够用）
  const waiters = new Map();          // id -> resolve
  const notes = [];                    // 待取的通知
  let wake = null;                     // 队列空时的等待者

  const push = (msg) => { notes.push(msg); if (wake) { const w = wake; wake = null; w(); } };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && msg.method) {
        // 服务端反向请求（审批）。两件事都要做：
        //   ① 推一条给 generator —— 界面得先看见那张卡片（用户点了才有答案）；
        //   ② 调回调等答案 —— 拿到之后回包。
        // 回调抛错也要回包，否则 CLI 会一直等下去。
        const approvalId = 'ap' + (++apSeq) + '-' + Date.now().toString(36);
        push({ method: '__approval', params: { ...(msg.params || {}), __method: msg.method, __approvalId: approvalId } });
        Promise.resolve()
          .then(() => (onServerRequest ? onServerRequest(msg.method, msg.params, approvalId) : null))
          .then((result) => {
            const payload = { jsonrpc: '2.0', id: msg.id, result: result === undefined || result === null ? { decision: 'decline' } : result };
            try { child.stdin.write(JSON.stringify(payload) + '\n'); } catch {}
          })
          .catch(() => {
            try { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { decision: 'decline' } }) + '\n'); } catch {}
          });
      } else if (msg.id != null && waiters.has(msg.id)) {
        const r = waiters.get(msg.id); waiters.delete(msg.id); r(msg);
      } else if (msg.method) {
        if (msg.method === 'configWarning') logs.push('configWarning: ' + String((msg.params && msg.params.summary) || ''));
        push(msg);
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { for (const l of String(c).split('\n')) if (l.trim()) logs.push(l.trim().slice(0, 400)); });

  const call = (method, params, timeoutMs = 30_000) => new Promise((res) => {
    const id = nextId++;
    waiters.set(id, res);
    try {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }) + '\n');
    } catch { waiters.delete(id); res(null); return; }
    const t = setTimeout(() => { if (waiters.has(id)) { waiters.delete(id); res(null); } }, timeoutMs);
    t.unref?.();
  });
  const notify = (method, params) => {
    try { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }) + '\n'); } catch {}
  };
  // 取下一条通知（没有就等）。
  const next = (timeoutMs = 0) => new Promise((res) => {
    if (notes.length) { res(notes.shift()); return; }
    if (!timeoutMs) { wake = () => res(notes.shift()); return; }
    const t = setTimeout(() => { if (wake) wake = null; res(null); }, timeoutMs);
    t.unref?.();
    wake = () => { clearTimeout(t); res(notes.shift()); };
  });
  return { call, notify, next, logs };
}

// ── 能力探测：这台机器上的 codex 认不认 app-server ───────────────────────────
// 认就让它走新路（有审批、会话托管、流式正文），不认就回落 exec（老路还能用）。
// 探测结果缓存 10 分钟：起一次进程约 1 秒，不该每轮都付这个成本。
let probeCache = { at: 0, ttl: 0, ok: false };

export function resetAppServerProbe() { probeCache = { at: 0, ttl: 0, ok: false }; }

function probeOnce(bin, env) {
  return new Promise((resolve) => {
    const isJs = /\.(c|m)?js$/i.test(bin);
    let child;
    try {
      child = spawn(isJs ? process.execPath : bin, isJs ? [bin, 'app-server'] : ['app-server'], {
        env: { ...env, NO_COLOR: '1', TERM: 'dumb' },
        stdio: ['pipe', 'pipe', 'ignore'],
        detached: process.platform !== 'win32',
      });
    } catch { resolve(false); return; }
    let settled = false;
    let buf = '';
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { try { child.kill('SIGKILL'); } catch {} }
      resolve(ok);
    };
    child.on('error', () => finish(false));
    child.on('close', () => finish(false));
    const t = setTimeout(() => finish(false), 10_000);
    t.unref?.();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        // 握手回包 = 这个版本认 app-server。reply 后立刻收工。
        if (msg.id === 1 && msg.result) { clearTimeout(t); finish(true); return; }
      }
    });
    try {
      // 探测也带上 capabilities，与正式握手一致（只判回包有无 result，不影响判定）。
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'muse-bridge', title: 'Muse Bridge', version: '1.0.0' }, capabilities: { experimentalApi: true } } }) + '\n');
    } catch { finish(false); }
  });
}

/**
 * 这台机器的 codex 支持 app-server 吗（结果缓存 10 分钟；失败只缓存 1 分钟）。
 * @returns {Promise<boolean>}
 */
export async function appServerAvailable({ env = process.env, binDir = '' } = {}) {
  const now = Date.now();
  if (probeCache.at && now - probeCache.at < probeCache.ttl) return probeCache.ok;
  const searchEnv = binDir ? { ...env, PATH: binDir + ':' + (env.PATH || '') } : env;
  const bin = findCliBin('codex', searchEnv);
  if (!bin) { probeCache = { at: now, ttl: 60_000, ok: false }; return false; }
  const ok = await probeOnce(bin, searchEnv);
  probeCache = { at: now, ttl: ok ? 10 * 60_000 : 60_000, ok };
  return ok;
}

/**
 * 跑一轮 Codex 对话（app-server 路径）。产出与 runtime/agent-cli.mjs 同一套归一事件。
 *
 * @param {object} o
 * @param {string} o.prompt              这一轮要说的话
 * @param {string[]} [o.images]          本地图片绝对路径（turn input 的 localImage 项）
 * @param {string} [o.threadId]          已有的会话 id（空 = 新建）
 * @param {string} [o.cwd]               工作目录
 * @param {string} [o.model]             模型（空 = CLI 自己的配置）
 * @param {string} [o.effort]            思考深度（空 = CLI 自己的配置）
 * @param {string} [o.approvalPolicy]    on-request（默认）| never | untrusted | on-failure
 * @param {string} [o.sandbox]           workspace-write（默认）| read-only | danger-full-access
 * @param {(m:string,p:object)=>Promise<object>} [o.onServerRequest] 审批回调，回 {decision}
 * @param {AbortSignal} [o.signal]
 * @param {object} [o.env]
 * @param {object} [o.keyEnv]    key 注入的显式覆盖（每身份：路由层传 cliSpawnKeyEnv(ctx,'codex')；
 *                               不给 = 全局那份，admin / 老调用方行为不变）
 * @param {string} [o.binDir]
 */
export async function* runAppServerTurn(agent, o = {}) {
  const {
    prompt, images = [], threadId = '', cwd = '', model = '', effort = '',
    approvalPolicy = 'on-request', sandbox = 'workspace-write',
    onServerRequest = null, signal = null, env = process.env, keyEnv, binDir = '',
  } = o;
  if (agent !== 'codex') { yield { type: 'error', message: 'app-server 这条路只给 codex 用' }; return; }
  const searchEnv = binDir ? { ...env, PATH: binDir + ':' + (env.PATH || '') } : env;
  const bin = findCliBin('codex', searchEnv);
  if (!bin) { yield { type: 'error', message: '这台机器上还没装 Codex CLI' }; return; }

  // 自带的那份是 .js 启动器；直接指向平台二进制时才是可执行文件。
  const isJs = /\.(c|m)?js$/i.test(bin);
  const child = spawn(isJs ? process.execPath : bin, isJs ? [bin, 'app-server'] : ['app-server'], {
    cwd: cwd || undefined,
    // 存过的 key 注进去（agent-keys）：没登录只存了 key 的机器，这条路也能起来——
    // 与 exec 路（agent-cli.mjs runCliTurn）同一待遇。keyEnv：每身份显式覆盖（见上文）。
    env: { ...searchEnv, ...(keyEnv !== undefined ? keyEnv : cliKeyEnv('codex')), NO_COLOR: '1', TERM: 'dumb' },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  const logs = [];
  const rpc = connect(child, { onServerRequest, logs });

  const kill = () => {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch { try { child.kill('SIGKILL'); } catch {} }
  };
  const onAbort = () => kill();
  signal?.addEventListener('abort', onAbort, { once: true });

  let sessionId = threadId;
  let usage = null;
  let sawError = false;
  let turnSeen = false;
  // 这一轮的状态，全部放 generator 内部（放模块级会跨轮污染：输出缓冲会无限长、
  // 正文与思考的「已按增量流过」标记会串到别人的请求上）。
  let sawAgentDelta = false;
  let sawReasoningDelta = false;
  const outBuf = new Map();      // itemId -> 累积的命令输出

  try {
    // 声明实验性 API 能力：不声明时，turn/start 带 collaborationMode（计划模式）会被上游
    // 直接拒掉（-32600 turn/start.collaborationMode requires experimentalApi capability）。
    // 打开后可能多收实验性字段/事件，不认识的方法名按现有兜底忽略，不污染正常流程。
    const init = await rpc.call('initialize', { clientInfo: { name: 'muse-bridge', title: 'Muse Bridge', version: '1.0.0' }, capabilities: { experimentalApi: true } }, 15_000);
    if (!init || !init.result) { yield { type: 'error', message: 'app-server 握手失败' + (logs.length ? '：' + logs[logs.length - 1] : '') }; return; }
    rpc.notify('initialized', {});

    // 会话：有 id 就接上（CLI 托管着历史），没有就新建。
    const th = threadId
      ? await rpc.call('thread/resume', { threadId }, 20_000)
      : await rpc.call('thread/start', { cwd: cwd || undefined, approvalPolicy, sandbox }, 20_000);
    const id = th && th.result && (th.result.thread?.id || th.result.threadId || (th.result.thread && th.result.thread.sessionId));
    if (!id) { yield { type: 'error', message: (threadId ? '接不上这个会话：' : '开不了会话：') + JSON.stringify((th && th.error) || '') }; return; }
    sessionId = id;
    yield { type: 'start', agent, sessionId, resumed: !!threadId };

    const turnParams = { threadId: sessionId, input: buildTurnInput(prompt, images) };
    // 模型 / 思考深度：只有显式选了才覆盖（空 = 用 CLI 自己的 config.toml）。
    if (model) turnParams.model = model;
    if (effort) turnParams.effort = effort;
    // 思考摘要：不显式要，上游默认一条都不发（实测不传 = reasoning 事件 0 条），于是下面那些
    // item/reasoning/* 的处理分支永远等不到东西——界面上的「思考」是空的。官方 schema 的
    // TurnStartParams.summary 正是这个开关（auto | concise | detailed | none，说明是
    // 「Override the reasoning summary for this turn and subsequent turns」）。老版本不认这个
    // 字段也不要紧：实测 app-server 忽略不认识的参数，不报错。
    turnParams.summary = 'detailed';
    const started = await rpc.call('turn/start', turnParams, 30_000);
    if (!started || started.error) { yield { type: 'error', message: '这一轮没发出去：' + JSON.stringify((started && started.error) || '') }; return; }

    // 消费通知直到这一轮收尾。120 秒没有任何消息就当卡住（正常一轮不会静默这么久）。
    for (;;) {
      if (signal?.aborted) { yield { type: 'notice', text: '已中断' }; break; }
      const msg = await rpc.next(turnSeen ? 120_000 : 60_000);
      if (!msg) { yield { type: 'error', message: '等不到 Codex 的回应（连接断了或它卡住了）' }; break; }
      const m = msg.method;
      const p = msg.params || {};

      if (m === 'turn/started') { turnSeen = true; continue; }

      // 上游要授权：先把卡片推给界面（用户点了，路由那边 resolve 回调的 promise，
      // 回包由 connect 负责），generator 继续往下跑等后续通知。
      if (m === '__approval') {
        yield approvalCard(p.__method, p);
        continue;
      }

      // 流式正文：这是「逐字出现」的来源。
      if (m === 'item/agentMessage/delta' || m === 'item/agent_message/delta') {
        if (p.delta) { sawAgentDelta = true; yield { type: 'text', text: String(p.delta) }; }
        continue;
      }
      // 思考增量的方法名以官方协议为准：`codex app-server generate-json-schema` 导出的
      // ServerNotification.json 里，item/reasoning/* 只有三个 ——
      //   item/reasoning/textDelta         思考正文增量（ReasoningTextDeltaNotification，
      //                                   字段：contentIndex, delta, itemId, threadId, turnId）
      //   item/reasoning/summaryTextDelta  思考摘要增量（ReasoningSummaryTextDeltaNotification，
      //                                   字段：delta, itemId, summaryIndex, threadId, turnId）
      //   item/reasoning/summaryPartAdded  每段摘要开始的边界标记（无 delta，不带文本）
      // 以前这里监听的是 item/reasoning/delta 与 item/reasoningSummary/delta，
      // 两个名字在官方协议里根本不存在，是死分支——思考增量一条都收不到。
      // 载荷字段确实是 delta，不用动。
      if (m === 'item/reasoning/textDelta' || m === 'item/reasoning/summaryTextDelta') {
        if (p.delta) { sawReasoningDelta = true; yield { type: 'reasoning', text: String(p.delta) }; }
        continue;
      }
      // 命令输出增量：累积起来，收尾时随 tool 事件一起给（同 exec 路径的 aggregated_output）。
      if (m === 'item/commandExecution/outputDelta' || m === 'item/commandExecution/output_delta') {
        if (p.delta && p.itemId) {
          const prev = outBuf.get(String(p.itemId)) || '';
          outBuf.set(String(p.itemId), prev + String(p.delta));
        }
        continue;
      }

      // 文件补丁实时更新：fileChange 的 diff 会在编辑过程中多次刷新
      // （schema：{changes:[{path,kind,diff}], itemId, threadId, turnId}），
      // 按 itemId 重组一条 updated 的工具行，前端 diff 卡跟着动。
      if (m === 'item/fileChange/patchUpdated') {
        const item = { id: String(p.itemId || ''), type: 'fileChange', changes: Array.isArray(p.changes) ? p.changes : [] };
        yield normAppToolItem(item, 'updated');
        continue;
      }

      // 命令在终端里等交互输入（比如装依赖时弹的确认提示）。注意这是【通知】不是
      // 审批请求——schema 里没有对应 request 变体，也没有可回的 id，做不了审批卡；
      // 给一条提示让用户知道卡在哪，交互本身留给 CLI 托管的终端。
      if (m === 'item/commandExecution/terminalInteraction') {
        yield { type: 'notice', text: '命令在等待终端输入：' + String(p.stdin || '').slice(0, 200) };
        continue;
      }

      if (m === 'item/started' || m === 'item/completed' || m === 'item/updated') {
        const item = p.item || {};
        const phase = m.slice(5);   // started|completed|updated
        // 正文与思考在 item 上再补一次：delta 没有时（比如非流式）不至于丢内容。
        if (item.type === 'agentMessage' && phase === 'completed' && item.text) {
          // 已经按 delta 流过了就跳过（否则同一段话会出现两遍）。
          if (!sawAgentDelta) yield { type: 'text', text: String(item.text) };
          continue;
        }
        if (item.type === 'agentMessage' && phase === 'started') { sawAgentDelta = false; continue; }
        if (item.type === 'reasoning') {
          // 回退：增量没流出来时（比如非流式一轮），用 item/completed 里的 reasoning item 兜底。
          // 别读 text 字段 —— 官方 schema 里 ReasoningThreadItem 只有 type/id/summary/content
          // 四个顶层字段，summary 与 content 都是字符串数组，根本没有 text；以前读了个不存在的
          // 字段，值永远是 undefined，这个回退形同虚设。两个数组有文本就拼起来（元素按 schema 是字符串；
          // 顺手兼容对象形式的 {text}，免得上游哪天换形状又哑火）。
          if (phase === 'completed' && !sawReasoningDelta) {
            const parts = [...(Array.isArray(item.summary) ? item.summary : []), ...(Array.isArray(item.content) ? item.content : [])]
              .map((b) => (typeof b === 'string' ? b : (b && typeof b.text === 'string' ? b.text : '')))
              .filter(Boolean);
            if (parts.length) yield { type: 'reasoning', text: parts.join('\n') };
          }
          if (phase === 'started') sawReasoningDelta = false;
          continue;
        }
        if (item.type === 'userMessage' || item.type === 'hookPrompt') continue;
        // plan ThreadItem 只是计划文本快照，权威版在 turn/plan/updated（上面已画 todo），
        // 这里重复画会闪两遍——明确跳过。
        if (item.type === 'plan') continue;
        if (item.type === 'sleep') {
          // clock.sleep 工具的展示项：started 给一条「暂停 N 秒」，completed 不用再说。
          if (phase === 'started') {
            const sec = Math.max(1, Math.round((Number(item.durationMs) || 0) / 1000));
            yield { type: 'notice', text: '暂停 ' + sec + ' 秒…' };
          }
          continue;
        }
        if (item.type === 'enteredReviewMode' || item.type === 'exitedReviewMode') {
          yield { type: 'notice', text: (item.type === 'enteredReviewMode' ? '进入评审模式' : '退出评审模式')
            + (item.review ? '：' + String(item.review).slice(0, 120) : '') };
          continue;
        }
        if (TOOL_ITEMS.has(item.type)) {
          const ev = normAppToolItem(item, phase);
          // 命令输出：优先用增量攒下来的（app-server 早中期不给 aggregatedOutput）。
          if (!ev.output) {
            const acc = outBuf.get(ev.id);
            if (acc) ev.output = cut(acc);
          }
          yield ev;
          if (ev.status === 'failed' && ev.exitCode != null && ev.exitCode !== 0) {
            yield { type: 'notice', text: '命令退出码 ' + ev.exitCode };
          }
          continue;
        }
        if (item.type === 'contextCompaction') {
          // schema 里这一项只有 id：started = 开始压，completed = 压完，各给一条提示。
          yield { type: 'notice', text: phase === 'started' ? '正在压缩上下文…' : '上下文已压缩' };
          continue;
        }
        continue;
      }

      // 计划清单（U2 已按 0.162.1 schema 复核：{plan:[{step,status}], threadId, turnId}）。
      // 状态词汇 inProgress → in_progress（任务卡认 exec 路的 TodoWrite 惯例）。
      if (m === 'turn/plan/updated') {
        const items = appPlanItems(p.plan);
        if (items.length) yield { type: 'todo', items };
        continue;
      }

      if (m === 'thread/tokenUsage/updated' || m === 'turn/tokenUsage/updated') {
        usage = appUsage(p.tokenUsage) || usage;
        continue;
      }

      if (m === 'turn/completed' || m === 'turn/failed' || m === 'turn/aborted') {
        const t = p.turn || {};
        const st = String(t.status || (m === 'turn/completed' ? 'completed' : 'failed'));
        if (st === 'failed' && t.error) { sawError = true; yield { type: 'error', message: String(t.error.message || t.error || '这一轮失败了') }; }
        yield { type: 'done', sessionId, usage, failed: st === 'failed', interrupted: st === 'interrupted' };
        return;
      }
      if (m === 'error') {
        sawError = true;
        yield { type: 'error', message: String((p.error && p.error.message) || p.message || 'Codex 报错') };
        continue;
      }
      // configWarning / account/* / mcpServer/* / thread/status/* 等：界面不画。
    }

    // 走到这儿说明是 break 出来的（中断 / 超时），也要给一个收尾，前端才知道这一轮结束。
    yield { type: 'done', sessionId, usage, failed: sawError, interrupted: true };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    kill();
  }
}
