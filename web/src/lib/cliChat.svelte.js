// 外部 CLI agent（codex / zcode）的对话状态 + 流式内核（两个分页共用）。
//
// 会话状态挂在模块级 $state 上，不在组件里：这两个分页不像 Claude 页那样常驻 DOM
// （App.svelte 只 keep-alive claude 页），退回主页再进来组件会重挂——状态放这里，来回走不丢。
//
// 传输：POST /api/<agent>/chat → SSE（归一事件，见服务端 src/runtime/agent-cli.mjs）；
// 用 lib/sse.js 的 pump 读帧。服务端在客户端断开时立刻杀 CLI 子进程，所以「停止」= abort。
import { apiUrl } from './server.js';
import { authHeaders } from './api.js';
import { pump } from './sse.js';
import { noteApiFailure } from './feedback.svelte.js';
import { t } from './i18n.js';

const MAX_ITEMS = 400;   // 一个分页里留着的消息条数上限（流式增量都并进同一条）

const blank = (agent) => ({
  agent,
  items: [],        // { role:'user'|'agent', id, text, reasoning, tools:[], todos:[], notes:[], error, status, usage }
  sessionId: '',    // 续聊用的会话 id（codex: thread_id；zcode: sessionId）
  busy: false,
  error: '',
  cwd: '',          // 服务端这一轮用的工作目录（meta 事件带回）
  seq: 0,
});

export const cliChat = $state({ codex: blank('codex'), zcode: blank('zcode') });
const controls = { codex: null, zcode: null };   // 在飞的请求（abort 用）

// ── 会话列表（每家的侧栏） ────────────────────────────────────────────────────
// cliChat[agent] 永远是【当前正在聊的那条】，列表里存的是其余会话的快照：切走时把当前写回快照、
// 把目标读进 cliChat。做成这样是为了不动上面那一整套流式内核（它只认一个活动会话）。
//
// 会话号是 CLI 自己给的（codex: thread_id，zcode: sessionId），续聊靠它——所以「新会话」=
// 清掉 sessionId 再聊，CLI 会开一段全新的；「切回旧的」就是把它的 sessionId 装回去接着聊。
// 本地持久化（localStorage）：与聊天记录同源，杀后台冷启动还认得出上次聊到哪。
const SKEY = 'bridge-cli-sessions';
const MAX_SESSIONS = 20;      // 每家留最近这么多条
const MAX_SAVE_ITEMS = 80;    // 落盘时每条会话最多存这么多条消息
const MAX_SAVE_TEXT = 4000;   // 单条消息正文落盘时的截断长度
const MAX_SAVE_TOOL_TEXT = 4000;   // 单条工具输出落盘时的截断长度（localStorage 有配额）

export const cliSessions = $state({ codex: [], zcode: [] });
const activeId = { codex: '', zcode: '' };

function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

// 标题 = 第一条用户消息（跟 Claude 页一样，标题从内容来），没有就用时间。
function titleOf(items) {
  const first = (items || []).find((m) => m.role === 'user' && String(m.text || '').trim());
  if (first) return String(first.text).trim().replace(/\s+/g, ' ').slice(0, 60);
  return t('新会话');
}

const trim = (items) => items.map((m) => ({
  ...m,
  text: typeof m.text === 'string' ? m.text.slice(0, MAX_SAVE_TEXT) : m.text,
  reasoning: typeof m.reasoning === 'string' ? m.reasoning.slice(0, MAX_SAVE_TEXT) : m.reasoning,
  // 工具行留 20 条；每条的工具输出另限长（它可能很大，localStorage 有配额）。
  tools: Array.isArray(m.tools) ? m.tools.slice(-20).map((tl) => ({
    ...tl,
    output: typeof tl.output === 'string' ? tl.output.slice(0, MAX_SAVE_TOOL_TEXT) : undefined,
    input: typeof tl.input === 'string' ? tl.input.slice(0, MAX_SAVE_TOOL_TEXT) : undefined,
  })) : [],
  todos: Array.isArray(m.todos) ? m.todos.slice(-40) : [],
  notes: Array.isArray(m.notes) ? m.notes.slice(-20) : [],
  error: m.error || '',
  auth: !!m.auth,   // 「这是登录/套餐问题」的标记（重新打开页面后那句提示还得在）
  status: m.status === 'running' ? 'interrupted' : m.status,   // 冷启动时不该还显示「正在工作」
}));

let saveTimer = 0;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const out = {};
      for (const agent of ['codex', 'zcode']) {
        out[agent] = { active: activeId[agent], list: cliSessions[agent].map((s) => ({
          id: s.id, sessionId: s.sessionId, cwd: s.cwd, at: s.at, title: s.title,
          items: trim(s.items).slice(-MAX_SAVE_ITEMS),
        })) };
      }
      localStorage.setItem(SKEY, JSON.stringify(out));
    } catch {}
  }, 400);
}

function hydrate() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(SKEY) || 'null'); } catch {}
  if (!raw) return;
  for (const agent of ['codex', 'zcode']) {
    const saved = raw[agent];
    if (!saved || !Array.isArray(saved.list)) continue;
    cliSessions[agent] = saved.list.map((s) => ({ ...s, items: Array.isArray(s.items) ? s.items : [] }));
    const pick = saved.list.find((s) => s.id === saved.active) || saved.list[0];
    if (pick) {
      activeId[agent] = pick.id;
      const c = cliChat[agent];
      c.items = pick.items; c.sessionId = pick.sessionId || ''; c.cwd = pick.cwd || '';
      c.seq = pick.items.reduce((n, m) => Math.max(n, m.id || 0), 0);
    }
  }
}
hydrate();

// 把当前会话（cliChat[agent]）写回列表里的快照；没有内容就不留痕。
function snapshot(agent) {
  const c = cliChat[agent];
  const id = activeId[agent];
  if (!id) return;
  const list = cliSessions[agent];
  const i = list.findIndex((s) => s.id === id);
  if (!c.items.length) {
    if (i >= 0) list.splice(i, 1);      // 空会话不该在侧栏里占一行
    return;
  }
  const rec = { id, sessionId: c.sessionId || '', cwd: c.cwd || '', at: Date.now(), title: titleOf(c.items), items: c.items.slice() };
  if (i >= 0) list[i] = rec; else list.unshift(rec);
  // 列表按最近使用排，且只留最近的 MAX_SESSIONS 条
  list.sort((a, b) => (b.at || 0) - (a.at || 0));
  if (list.length > MAX_SESSIONS) cliSessions[agent] = list.slice(0, MAX_SESSIONS);
  persist();
}

export const cliActiveId = (agent) => activeId[agent];

// 开一段新会话：先把当前这段收进列表，再把 cliChat 复位（空 = 没聊过）。
export function cliNew(agent) {
  cliStop(agent);
  snapshot(agent);
  activeId[agent] = newId();
  const c = cliChat[agent];
  c.items = []; c.sessionId = ''; c.error = ''; c.cwd = ''; c.seq = 0;
  persist();
}

// 切到列表里的某一条。
export function cliPick(agent, id) {
  if (id === activeId[agent]) return;
  cliStop(agent);
  snapshot(agent);
  const rec = cliSessions[agent].find((s) => s.id === id);
  if (!rec) return;
  activeId[agent] = id;
  const c = cliChat[agent];
  c.items = rec.items.slice();
  c.sessionId = rec.sessionId || '';
  c.cwd = rec.cwd || '';
  c.error = '';
  c.seq = c.items.reduce((n, m) => Math.max(n, m.id || 0), 0);
  persist();
}

// 从列表里删掉一条（删的就是当前这条时，顺势开一段空的）。
export function cliDrop(agent, id) {
  const i = cliSessions[agent].findIndex((s) => s.id === id);
  if (i < 0) return;
  cliSessions[agent].splice(i, 1);
  if (activeId[agent] === id) {
    activeId[agent] = newId();
    const c = cliChat[agent];
    c.items = []; c.sessionId = ''; c.error = ''; c.cwd = ''; c.seq = 0;
  }
  persist();
}

export function cliStop(agent) {
  const ac = controls[agent];
  if (ac) { try { ac.abort(); } catch {} controls[agent] = null; }
  const c = cliChat[agent];
  if (c.busy) c.busy = false;
}

// 工具行的补充载荷：命令输出、退出码、改动文件、搜索词、入参。
// 服务端早就解析出来了，前端以前只留 name/status/summary —— 命令跑出什么都不给用户看。
function toolExtra(ev) {
  const extra = {};
  if (ev.output) extra.output = String(ev.output);
  if (ev.exitCode != null) extra.exitCode = ev.exitCode;
  if (Array.isArray(ev.changes) && ev.changes.length) extra.changes = ev.changes;
  if (ev.query) extra.query = String(ev.query);
  if (ev.input) extra.input = String(ev.input);
  const src = [ev.server, ev.tool].filter(Boolean).join(' · ');
  if (src) extra.source = src;
  return extra;
}

// 归一事件 → 落到当前那条回复上（服务端已经保证事件语义一致，这里只做呈现）。
function applyEvent(agent, itemId, ev) {
  const c = cliChat[agent];
  const m = c.items.find((i) => i.id === itemId);
  if (!m) return;
  switch (ev.type) {
    case 'meta': if (ev.cwd) c.cwd = ev.cwd; break;
    case 'start': if (ev.sessionId) c.sessionId = ev.sessionId; break;
    case 'session': if (ev.sessionId) c.sessionId = ev.sessionId; break;
    case 'text': m.text += String(ev.text || ''); break;
    case 'reasoning': m.reasoning += (m.reasoning ? '\n\n' : '') + String(ev.text || ''); break;
    case 'todo': m.todos = Array.isArray(ev.items) ? ev.items.slice() : []; break;
    case 'tool': {
      const name = String(ev.name || t('工具'));
      const extra = toolExtra(ev);
      // 同一个工具会有 started/updated/completed 三拍。优先按服务端给的 item id 对上同一行；
      // 没有 id 的老路径退回「同名且还没收尾的最后一行」。
      let row = null;
      if (ev.id) row = m.tools.find((x) => x.id === ev.id);
      if (!row) {
        const last = m.tools[m.tools.length - 1];
        if (last && last.name === name && last.status !== 'completed') row = last;
      }
      if (row) {
        if (ev.status) row.status = ev.status;
        if (ev.summary) row.summary = ev.summary;
        Object.assign(row, extra);
        if (ev.id && !row.id) row.id = ev.id;
      } else {
        m.tools.push({ id: ev.id || '', name, status: ev.status || 'started', summary: ev.summary || '', ...extra });
      }
      break;
    }
    case 'notice': m.notes.push(String(ev.text || '')); break;
    // 上游要授权：一张卡片挂在当前这条回复上，等用户点。id 由服务端给（回答时要原样带回）。
    case 'approval': {
      if (!Array.isArray(m.approvals)) m.approvals = [];
      m.approvals.push({
        id: String(ev.id || ''),
        kind: String(ev.kind || 'command'),
        reason: String(ev.reason || ''),
        command: String(ev.command || ''),
        cwd: String(ev.cwd || ''),
        changes: Array.isArray(ev.changes) ? ev.changes : [],
        decisions: Array.isArray(ev.decisions) ? ev.decisions : [],
        answer: '',      // 用户选了什么（空 = 还没答）
        err: '',
      });
      break;
    }
    case 'error': m.error = String(ev.message || t('出错')); m.auth = !!ev.auth; c.error = m.error; break;
    case 'done': {
      if (ev.sessionId) c.sessionId = ev.sessionId;
      if (ev.usage) m.usage = ev.usage;
      m.status = ev.failed ? 'failed' : 'done';
      // 这一轮收尾了：还挂着的审批卡不会再被接受（服务端已按「拒绝」收掉那个 promise），
      // 标成过期，别让用户点了却得到一个 404。
      for (const ap of (m.approvals || [])) if (!ap.answer) ap.expired = true;
      break;
    }
    default: break;
  }
}

export async function cliSend(agent, prompt) {
  const text = String(prompt || '');
  const c = cliChat[agent];
  if (c.busy || !text.trim()) return;
  c.error = '';
  c.items.push({ role: 'user', id: ++c.seq, text, status: 'done' });
  const itemId = ++c.seq;
  c.items.push({ role: 'agent', id: itemId, text: '', reasoning: '', tools: [], todos: [], notes: [], approvals: [], error: '', auth: false, status: 'running', usage: null });
  if (c.items.length > MAX_ITEMS) c.items.splice(0, c.items.length - MAX_ITEMS);
  c.busy = true;
  const ac = new AbortController();
  controls[agent] = ac;
  try {
    const res = await fetch(apiUrl('/api/' + agent + '/chat'), {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ prompt: text, sessionId: c.sessionId || undefined }),
      credentials: 'same-origin',
      signal: ac.signal,
    });
    if (!res.ok) {
      noteApiFailure('POST', '/api/' + agent + '/chat', res.status);
      let msg = 'HTTP ' + res.status;
      try { const j = await res.json(); if (j && j.error) msg = String(j.error); } catch {}
      c.error = msg;
      applyEvent(agent, itemId, { type: 'error', message: msg });
      return;
    }
    await pump(res, (ev) => applyEvent(agent, itemId, ev), ac.signal);
  } catch (e) {
    if (e && e.name !== 'AbortError') {
      c.error = (e && e.message) || String(e);
      applyEvent(agent, itemId, { type: 'error', message: c.error });
    }
  } finally {
    if (controls[agent] === ac) controls[agent] = null;
    c.busy = false;
    const m = c.items.find((i) => i.id === itemId);
    if (m && m.status === 'running') m.status = 'interrupted';
    snapshot(agent);   // 这一轮收尾后写回侧栏列表（标题取第一条用户消息、会话号存下来供续聊）
  }
}

// ── 接入状态（装了没 / 认证了没）：分页的「接入」卡与设置页共用 ─────────────────
export const cliStatus = $state({ list: null, err: '', loading: false });

export async function loadCliStatus(force = false) {
  if (cliStatus.loading) return cliStatus.list;
  if (cliStatus.list && !force) return cliStatus.list;
  cliStatus.loading = true;
  try {
    const r = await fetch(apiUrl('/api/agents/status' + (force ? '?refresh=1' : '')), { headers: authHeaders(), credentials: 'same-origin' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    cliStatus.list = Array.isArray(j?.agents) ? j.agents : [];
    cliStatus.err = '';
  } catch (e) {
    cliStatus.err = (e && e.message) || String(e);
  } finally {
    cliStatus.loading = false;
  }
  return cliStatus.list;
}

export const statusOf = (agent) => (cliStatus.list || []).find((a) => a.id === agent) || null;

// ── codex 的模型 / 思考深度 ───────────────────────────────────────────────────
// 清单来自官方 app-server 的 model/list（服务端 runtime/agent-models.mjs，缓存 10 分钟）：
// displayName + 每个模型自己的可选思考深度档。拿不到就是空数组，界面不摆选择器。
export const cliModels = $state({ list: null, err: '', loading: false });

export async function loadCliModels(force = false) {
  if (cliModels.loading) return cliModels.list;
  if (cliModels.list && !force) return cliModels.list;
  cliModels.loading = true;
  try {
    const r = await fetch(apiUrl('/api/codex/models' + (force ? '?refresh=1' : '')), { headers: authHeaders(), credentials: 'same-origin' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    cliModels.list = Array.isArray(j?.models) ? j.models : [];
    cliModels.err = '';
  } catch (e) {
    cliModels.err = (e && e.message) || String(e);
    if (!cliModels.list) cliModels.list = [];
  } finally {
    cliModels.loading = false;
  }
  return cliModels.list;
}

// 选定的模型 / 思考深度（'' = 用 CLI 自己的配置）。
export const modelOf = (agent) => (statusOf(agent) || {}).model || '';
export const effortOf = (agent) => (statusOf(agent) || {}).effort || '';

// 换模型 / 思考深度。空串 = 清掉，交回 CLI 自己的 config.toml。
export async function setCliModel(agent, { model, effort } = {}) {
  const r = await fetch(apiUrl(`/api/${agent}/model`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    credentials: 'same-origin',
    body: JSON.stringify({ model, effort }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error || ('HTTP ' + r.status));
  // 状态面就地更新（宽屏面板与抽屉都读 statusOf，不必再拉一次网络）。
  if (cliStatus.list) {
    const a = cliStatus.list.find((x) => x.id === agent);
    if (a) { a.model = j.model || ''; a.effort = j.effort || ''; }
  }
  return j;
}

// 这个 agent 现在在哪个目录里干活。状态里有就以它为准（抽屉打开即可显示，不必先聊一轮）；
// 还没拿到状态时退回这一轮 meta 带回来的（聊过至少一轮的老页面）。
export function cwdOf(agent) {
  const c = cliChat[agent];
  return (statusOf(agent) || {}).cwd || c.cwd || '';
}

// 回答一张审批卡。decision 是上游枚举里的一个（accept / acceptForSession / decline / cancel）。
// 卡片上记下选了哪个（答完仍留在流里，用户回头能看见当时批了什么）。
export async function answerApproval(agent, itemId, approvalId, decision) {
  const c = cliChat[agent];
  const m = c.items.find((i) => i.id === itemId);
  const ap = m && (m.approvals || []).find((a) => a.id === approvalId);
  if (!ap || ap.answer) return;      // 已经答过 / 找不到：不重复提交
  ap.sending = true;
  ap.err = '';
  try {
    const r = await fetch(apiUrl('/api/codex/approval'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      credentials: 'same-origin',
      body: JSON.stringify({ id: approvalId, decision }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error || ('HTTP ' + r.status));
    ap.answer = typeof decision === 'string' ? decision : 'acceptWithExecpolicyAmendment';
  } catch (e) {
    ap.err = (e && e.message) || String(e);
  } finally {
    ap.sending = false;
  }
}

// 换工作目录（每个软件一间自己的文件夹）。服务端用与 Claude 新建项目同一把尺子授权，
// 越界 / 不存在会抛出带 status 的错，交给调用方显示。
export async function setCliCwd(agent, path) {
  const r = await fetch(apiUrl(`/api/${agent}/cwd`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    credentials: 'same-origin',
    body: JSON.stringify({ path }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(j?.error || ('HTTP ' + r.status));
    err.body = j;
    throw err;
  }
  // 状态面就地更新：抽屉里的「工作目录」与宽屏面板都读 statusOf，不必再拉一次网络。
  if (cliStatus.list) {
    const a = cliStatus.list.find((x) => x.id === agent);
    if (a) a.cwd = j.cwd;
  }
  cliChat[agent].cwd = j.cwd;
  return j.cwd;
}
