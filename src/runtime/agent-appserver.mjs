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

// 审批类反向请求 → 界面上那张卡的 kind。
const APPROVAL_METHODS = Object.freeze({
  'item/commandExecution/requestApproval': 'command',
  'item/fileChange/requestApproval': 'fileChange',
  'item/permissions/requestApproval': 'permissions',
  'execCommandApproval': 'command',
  'applyPatchApproval': 'fileChange',
});

export const isApprovalMethod = (m) => Object.prototype.hasOwnProperty.call(APPROVAL_METHODS, m);

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
  }
  return out;
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
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'muse-bridge', title: 'Muse Bridge', version: '1.0.0' } } }) + '\n');
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
 * @param {string} [o.threadId]          已有的会话 id（空 = 新建）
 * @param {string} [o.cwd]               工作目录
 * @param {string} [o.model]             模型（空 = CLI 自己的配置）
 * @param {string} [o.effort]            思考深度（空 = CLI 自己的配置）
 * @param {string} [o.approvalPolicy]    on-request（默认）| never | untrusted | on-failure
 * @param {string} [o.sandbox]           workspace-write（默认）| read-only | danger-full-access
 * @param {(m:string,p:object)=>Promise<object>} [o.onServerRequest] 审批回调，回 {decision}
 * @param {AbortSignal} [o.signal]
 * @param {object} [o.env]
 * @param {string} [o.binDir]
 */
export async function* runAppServerTurn(agent, o = {}) {
  const {
    prompt, threadId = '', cwd = '', model = '', effort = '',
    approvalPolicy = 'on-request', sandbox = 'workspace-write',
    onServerRequest = null, signal = null, env = process.env, binDir = '',
  } = o;
  if (agent !== 'codex') { yield { type: 'error', message: 'app-server 这条路只给 codex 用' }; return; }
  const searchEnv = binDir ? { ...env, PATH: binDir + ':' + (env.PATH || '') } : env;
  const bin = findCliBin('codex', searchEnv);
  if (!bin) { yield { type: 'error', message: '这台机器上还没装 Codex CLI' }; return; }

  // 自带的那份是 .js 启动器；直接指向平台二进制时才是可执行文件。
  const isJs = /\.(c|m)?js$/i.test(bin);
  const child = spawn(isJs ? process.execPath : bin, isJs ? [bin, 'app-server'] : ['app-server'], {
    cwd: cwd || undefined,
    env: { ...searchEnv, NO_COLOR: '1', TERM: 'dumb' },
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
    const init = await rpc.call('initialize', { clientInfo: { name: 'muse-bridge', title: 'Muse Bridge', version: '1.0.0' } }, 15_000);
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

    const turnParams = { threadId: sessionId, input: [{ type: 'text', text: String(prompt ?? '') }] };
    // 模型 / 思考深度：只有显式选了才覆盖（空 = 用 CLI 自己的 config.toml）。
    if (model) turnParams.model = model;
    if (effort) turnParams.effort = effort;
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
      if (m === 'item/reasoning/delta' || m === 'item/reasoningSummary/delta') {
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
          if (phase === 'completed' && item.text && !sawReasoningDelta) yield { type: 'reasoning', text: String(item.text) };
          if (phase === 'started') sawReasoningDelta = false;
          continue;
        }
        if (item.type === 'userMessage') continue;
        if (item.type === 'commandExecution' || item.type === 'fileChange') {
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
