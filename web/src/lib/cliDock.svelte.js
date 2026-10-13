// CLI 分页（Codex / ZCode）的右侧工作台状态：终端 / 审阅 / 文件 / 任务四张卡。
//
// 【为什么不复用 lib/dock.svelte.js 那份单例】
// 那份绑死了 Claude 的会话与 ClaudePage 的生命周期：ClaudePage 是 keep-alive 常驻挂载的
// （App.svelte 的 .keep.dormant），它的 `$effect(() => setDockWs(dockWs))` 只要 Claude 那边
// 会话/项目一变就会把 dock.ws 写回【Claude 的工作空间】——而 ClaudePage 挂起来的时候，即使
// 用户正在 Codex 页上，那个 effect 照样在跑。两个宿主抢同一个 dock.ws 会互相踩：用户在 Codex
// 页开着终端，Claude 那边一个状态变化就把面板指到别的目录去了。
//
// 另起一份的好处是它只含三个面板真正读的东西：`ws`（见 dock/ReviewPanel.svelte 与
// dock/TermPanel.svelte 的 `let { dockState = dock } = $props()` —— 面板本来就是按 props
// 参数化的，TermPanel 用的 readDockSse 也是独立函数，不依赖那份单例）。
//
// 每个 agent 各记一份：codex 与 zcode 的工作目录不同，开着哪几张卡也该各记各的。
// 状态挂在模块级（同 lib/cliChat.svelte.js 的理由）：这两个分页退回主页就卸载，放组件里会丢。

import { api } from './api.js';
import { closeView, openView } from './cliDockViews.js';

export const CLI_DOCK_TOOLS = Object.freeze(['review', 'term', 'files', 'tasks']);

// 每个 agent 一份：{ open, views, view, meta }
const make = () => ({ open: false, views: [], view: 'review', meta: null });
export const cliDock = $state({ codex: make(), zcode: make() });

// 工作空间元信息（能不能开终端、在不在文件根里、是什么分支）：按 ws 缓存，
// 并发去重。与 lib/dock.svelte.js 的 ensureDockMeta 同一件事，只是作用在 CLI 的分页上。
const metaCache = {};    // agent -> { ws, value, inflight }

export function ensureCliDockMeta(agent, ws) {
  const st = cliDock[agent];
  if (!ws) return Promise.resolve(null);
  const slot = metaCache[agent] || (metaCache[agent] = { ws: '', value: null, inflight: null });
  if (slot.value && slot.ws === ws) return Promise.resolve(slot.value);
  if (slot.inflight && slot.ws === ws) return slot.inflight;
  slot.ws = ws;
  slot.value = null;
  slot.inflight = (async () => {
    let m;
    // 走 api.get 而不是裸 fetch：网络层失败要亮离线态（同 dock.svelte.js 的理由）。
    try { m = await api.get(`/api/claude/dock/meta?ws=${encodeURIComponent(ws)}`); } catch { m = null; }
    if (!m) m = { rel: null, git: false, branch: null, worktree: false, shell: false };
    slot.inflight = null;
    if (metaCache[agent] && metaCache[agent].ws === ws) { slot.value = m; if (cliDock[agent]) cliDock[agent].meta = m; }
    return m;
  })();
  return slot.inflight;
}

// 换工作目录（换 agent 的 cwd，或来回切分页）：meta 要重取，文件卡的定位也要清掉。
// 这里立刻把 slot.ws 推到新值：正在飞的那次请求回来时会撞上「slot.ws !== 当时的 ws」这道闸，
// 结果不会盖到新工作空间头上（ensureCliDockMeta 里那个判断）。
export function setCliDockWs(agent, ws) {
  const st = cliDock[agent];
  if (!st) return;
  const next = ws || '';
  const slot = metaCache[agent];
  if (slot && slot.ws !== next) { slot.ws = next; slot.value = null; slot.inflight = null; st.meta = null; }
  if (!st.open) st.meta = null;
}

export function cliDockOpen(agent, view) {
  const st = cliDock[agent];
  if (!st) return;
  const key = CLI_DOCK_TOOLS.includes(view) ? view : 'review';
  const next = openView(st.views, key);
  // 点的是已经开着的那张 → openView 把它关掉；关掉最后一张 = 整个工作台收起。
  if (!next.length) { cliDockClose(agent); return; }
  st.views = next;
  st.view = key;
  st.open = true;
}

export function cliDockCloseView(agent, view) {
  const st = cliDock[agent];
  if (!st) return;
  const next = closeView(st.views, view);
  if (next === st.views) return;         // 没开着这张：什么也没发生
  if (!next.length) { cliDockClose(agent); return; }
  st.views = next;
  if (st.view === view) st.view = next[next.length - 1];
}

export function cliDockClose(agent) {
  const st = cliDock[agent];
  if (!st) return;
  st.open = false; st.views = []; st.meta = null;
  const slot = metaCache[agent];
  if (slot) { slot.value = null; slot.inflight = null; }
}
