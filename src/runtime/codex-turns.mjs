// Codex 后台轮次：手机断开后这一轮在服务器上继续跑，回来能断线重连。
//
// 背景：原来 `POST /api/codex/chat` 把 CLI 子进程的生命周期绑在 HTTP 请求上，
// 客户端一断开就 abort 整棵进程树（routes/agent-cli.mjs 的注释原话）。
// 现在改成跟 Claude 一样——断开只断流，不杀进程。
//
// 实现上直接复用 Claude 那套 `src/runtime/gen.mjs`（事件缓冲 + 订阅 + 保留），
// 它的头注释早就给 codex 留了 'codex:<key>' 的键位。这里只补 codex 特有的三样：
//   ① turn 注册表语义（prompt 摘要 / 审批等待者 / 快照补存）；
//   ② 审批卡的 id 改写与超时（断开后卡片要能重连回来点，超时自动拒绝）；
//   ③ 两条执行路（app-server / exec）的选路与 pump。
//
// zcode 不走这里（本次只动 codex）。

import { randomUUID } from 'node:crypto';
import {
  tryStartGen, genEmit, genSubscribe, genFinish, retireGen, getGens,
} from './gen.mjs';
import { runAppServerTurn, appServerAvailable } from './agent-appserver.mjs';
import { runCliTurn } from './agent-cli.mjs';
import { saveCliSession, listCliSessions, deleteCliSession } from './cli-sessions.mjs';

// ── 取值（理由见各处注释） ──────────────────────────────────────────────────
export const CODEX_MAX_TURNS = 3;                 // 每身份同时在跑的上限（见 startCodexTurn）
export const CODEX_APPROVAL_WAIT_MS = 15 * 60_000; // 审批等 15 分钟，超时按拒绝（见 turnWaitApproval）
export const CODEX_BUFFER_MAX_EVENTS = 2000;     // 单轮事件缓冲上限（见 turnEmit）

// 测试时可用环境变量 CODEX_APPROVAL_WAIT_MS 覆盖审批超时（毫秒，仅测试用）。
function approvalWaitMs() {
  const v = Number(process.env.CODEX_APPROVAL_WAIT_MS);
  return Number.isFinite(v) && v > 0 ? v : CODEX_APPROVAL_WAIT_MS;
}

// gen.mjs 的键位约定：codex 用 'codex:<caller>'，与 Claude 的 'admin' / 'u:<name>'
// 分开——两家的并发上限各算各的，overview 的活动面板也能区分。
export function codexCallerKey(ctx) {
  const who = ctx && ctx.kind === 'user' ? 'u:' + ctx.user : 'admin';
  return 'codex:' + who;
}

// 快照 id 与前端对齐的键：服务端和前端都用 'turn-<turnId>'，upsert 按 id 去重，
// 侧栏不会出现同一轮的两条（见 saveTurnSnapshot 与前端 applyEvent 的 meta 分支）。
export const turnSnapshotId = (turnId) => 'turn-' + turnId;

// 缓冲里永不丢的关键事件：丢了它们，重连回来就看不懂这一轮（审批卡点不了、
// 收尾对不上）。文本增量丢了只是少几行字。
const KEEP_TYPES = new Set(['meta', 'start', 'session', 'approval', 'done', 'error']);

// ── 事件写入（含缓冲上限） ──────────────────────────────────────────────────
// genEmit 会把相邻的 text/reasoning 增量合成 ≤4KB 的块，所以正常一轮缓冲很小；
// 这个上限是防极端情况的（比如工具循环狂吐），超了从头丢最旧的【非关键】事件。
function turnEmit(turn, ev) {
  genEmit(turn, ev);
  while (turn.events.length > CODEX_BUFFER_MAX_EVENTS) {
    const i = turn.events.findIndex((e) => e && !KEEP_TYPES.has(e.type));
    if (i < 0) break;
    turn.events.splice(i, 1);
  }
}

// ── 审批等待（断开也有效） ──────────────────────────────────────────────────
// 原来 waitForApproval 活在路由的单次请求作用域里，断开就没了。现在挂在 turn 上：
// 用户关掉手机回来，只要没超时，卡片照样能点。
// 超时 15 分钟：原来 5 分钟是配给「断开即杀」的——反正人不在就杀了；现在人可能只是
// 暂时离开，15 分钟覆盖「切出去回个消息就回来」，又不至于让进程无限占着。
// 超时按【拒绝】收：自动「允许」不安全（命令可能删文件），拒绝后 turn 带着拒绝结果
// 继续跑，不会卡死。
// 挂一个审批 waiter：返回 promise，用户点卡片（或超时）后 resolve { decision }。
// 导出主要供测试用（测「超时按拒绝收」「点卡能 resolve」）；生产调用方是 pump 里的 onServerRequest。
export function turnWaitApproval(turn, approvalId) {
  const id = String(approvalId || '');
  const hit = turn.approvals.get(id);
  if (hit) return hit.promise;
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  const timer = setTimeout(() => {
    if (!turn.approvals.has(id)) return;
    turn.approvals.delete(id);
    // 缓冲里留一句，后面重连回来的人知道这张卡为什么点不了了。
    turnEmit(turn, { type: 'notice', text: '授权等了 15 分钟没人点，已自动拒绝' });
    resolve({ decision: 'decline' });
  }, approvalWaitMs());
  timer.unref?.();
  turn.approvals.set(id, { resolve, timer, promise });
  return promise;
}

// 用户点了卡片（POST /api/codex/approval）：id 形如 <turnId>:<approvalId>。
// 找到 turn，resolve 它的等待者；顺手把缓冲里那张卡标成已回答，重连回来不再显示可点。
export function answerCodexApproval(key, id, decision) {
  const s = String(id || '');
  const i = s.indexOf(':');
  if (i < 0) return { ok: false, error: 'id 格式不对' };
  const turn = findCodexTurn(key, s.slice(0, i));
  if (!turn || turn.done) return { ok: false, error: '这张卡已经过期了（这一轮结束了，或等太久超时了）' };
  const w = turn.approvals.get(s.slice(i + 1));
  if (!w) return { ok: false, error: '这张卡已经过期了（这一轮结束了，或等太久超时了）' };
  turn.approvals.delete(s.slice(i + 1));
  clearTimeout(w.timer);
  w.resolve({ decision });
  const label = typeof decision === 'string' ? decision : 'acceptWithExecpolicyAmendment';
  for (const ev of turn.events) {
    if (ev && ev.type === 'approval' && ev.id === s) { ev.answered = label; break; }
  }
  return { ok: true };
}

// ── turn 的查找与列表 ──────────────────────────────────────────────────────
export function findCodexTurn(key, turnId) {
  if (!turnId) return null;
  return getGens(key).find((g) => g && g.turnId === turnId) || null;
}

// 给「后台运行中」列表用的轻量快照（不含事件体）。
export function listCodexTurns(key) {
  return getGens(key)
    .filter((g) => g && g.agent === 'codex')
    .map((g) => ({
      turnId: g.turnId,
      status: g.status,
      startedAt: g.startedAt,
      elapsedMs: Date.now() - (g.startedAt || Date.now()),
      prompt: String(g.userText || '').slice(0, 120),
      sessionId: g.sessionId || '',
      attached: g.subscribers.size > 0,
      done: !!g.done,
    }))
    .sort((a, b) => b.startedAt - a.startedAt);
}

// ── 开一轮 ─────────────────────────────────────────────────────────────────
// 返回 { ok:true, turn } 或 { ok:false, error }（409 用）。
// pump 在后台跑（不 await）：调用方只管拿 turn 去挂 SSE。
export async function startCodexTurn({
  key, dataDir, prompt, sessionId = '', images = [], cwd = '',
  model = '', effort = '', env = process.env, keyEnv, binDir = '',
  plan = false, worktree = null,
}) {
  const turn = {
    agent: 'codex',
    key,                          // gen.mjs 的键（retireGen 清理时要）
    turnId: 'ct_' + randomUUID().slice(0, 8),
    sessionId: String(sessionId || ''),
    userText: String(prompt || '').slice(0, 500),
    cwd: String(cwd || ''),
    model: String(model || ''),
    effort: String(effort || ''),
    events: [],
    subscribers: new Set(),
    abort: new AbortController(),
    done: false,
    startedAt: Date.now(),
    endedAt: 0,
    status: 'running',            // running | waiting_approval | done | failed
    approvals: new Map(),         // approvalId -> { resolve, timer, promise }
    dataDir: String(dataDir || ''),
    useAppServer: false,
  };
  // worktree 会话：这一轮跑在 worktree 里——事件进缓冲（attach 时重放，前端据此亮只读指示；
  // 重连重放也带它，幂等）。created=true = 本轮刚切出来的，前端据此给一句提示。
  if (worktree) turn.events.push({ type: 'worktree', worktree });

  // 同会话重发：Claude 的语义——新的一轮顶掉旧的。先停旧的再开新的。
  let r = tryStartGen(key, turn, { maxPerKey: CODEX_MAX_TURNS, singleSession: true });
  if (!r.ok && r.reason === 'session') {
    for (const g of getGens(key)) {
      if (g !== turn && !g.done && g.sessionId && g.sessionId === turn.sessionId) stopTurn(g, '被同一会话的新一轮取代');
    }
    r = tryStartGen(key, turn, { maxPerKey: CODEX_MAX_TURNS, singleSession: true });
  }
  // 到并发上限：停掉最旧的在跑的（这台机器 2 核，不设上限会被后台任务拖死），
  // 前端会在被停的那轮里看到一句通知。
  if (!r.ok && r.reason === 'per-key') {
    const live = getGens(key).filter((g) => g !== turn && !g.done)
      .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
    if (live[0]) stopTurn(live[0], '同时进行的轮次太多，被新的一轮停止');
    r = tryStartGen(key, turn, { maxPerKey: CODEX_MAX_TURNS, singleSession: true });
  }
  if (!r.ok) return { ok: false, error: r.reason === 'session' ? '这一会话还有一轮在跑' : '同时进行的轮次太多了，稍后再试' };

  turn.useAppServer = await appServerAvailable({ env, binDir }).catch(() => false);
  // 后台 pump：跟请求解绑，客户端断不断都不影响它。异常自己吞掉走收尾，
  // 不能让未处理的 rejection 把进程带崩。
  // binDir 只给测试用（钉住 fake codex 桩）；生产调用不传。
  pumpTurn(turn, { prompt, images, env, keyEnv, binDir, plan: !!plan }).catch(() => {});
  return { ok: true, turn };
}

function stopTurn(turn, note) {
  if (!turn || turn.done) return;
  if (note) turnEmit(turn, { type: 'notice', text: String(note) });
  // 同步标记 done：调用方（并发上限/同会话顶掉）停掉旧轮后立刻重试 tryStartGen，
  // 重试只看 done——不等 pump 的 finally（那是异步的），否则重试永远看到"还在跑"。
  // pump 的 finally 里 done=true 是幂等的；status 置 'stopped' 后 finally 不再覆盖。
  turn.done = true;
  turn.status = 'stopped';
  try { turn.abort.abort(); } catch {}
}

// 显式停一轮（POST /api/codex/turns/stop / 同会话顶掉 / 并发上限）。
export function stopCodexTurn(key, turnId) {
  const turn = findCodexTurn(key, turnId);
  if (!turn) return { ok: false, error: '找不到这一轮（可能已经结束了）' };
  if (turn.done) return { ok: true, already: true };
  stopTurn(turn, '已手动停止');
  return { ok: true };
}

// ── 后台 pump：把选出来的 generator 的事件全部写进 turn 缓冲 ────────────────
async function pumpTurn(turn, { prompt, images, env, keyEnv, binDir = '', plan = false }) {
  const opts = {
    prompt: String(prompt || ''),
    cwd: turn.cwd,
    model: turn.model,
    effort: turn.effort,
    images: Array.isArray(images) ? images : [],
    signal: turn.abort.signal,   // 跟请求解绑：断开不断这个 signal，只显式 stop 才 abort
    env,
    keyEnv,
    binDir,
  };
  // 计划模式是 app-server 协议的能力：老版本走 exec 回落时没这个字段，
  // 别静默当普通轮跑了——先给一句提示，用户才知道这轮没进计划。
  if (plan && !turn.useAppServer) turnEmit(turn, { type: 'notice', text: '当前 Codex 版本不支持计划模式（走的是旧版回落），这一轮按普通模式跑' });
  const stream = turn.useAppServer
    ? runAppServerTurn('codex', {
      ...opts,
      threadId: turn.sessionId,
      planMode: !!plan,
      // 审批回调：等答案的 promise 挂在 turn 上（不断开失效），超时 15 分钟自动拒绝。
      onServerRequest: (method, params, approvalId) => turnWaitApproval(turn, approvalId),
    })
    : runCliTurn('codex', { ...opts, sessionId: turn.sessionId });
  try {
    for await (const ev of stream) {
      if (!ev || typeof ev !== 'object') continue;
      // 审批卡的 id 改成 <turnId>:<approvalId>：原来是 <单次请求>:<序号>，
      // 请求断了 id 就没意义了；现在 id 跟着 turn 走，重连回来照样能点。
      if (ev.type === 'approval') {
        ev.id = turn.turnId + ':' + String(ev.id || '');
        turn.status = 'waiting_approval';
      } else if (turn.status === 'waiting_approval' && ev.type !== 'notice') {
        turn.status = 'running';
      }
      // 新开的会话号在这里才知道（thread.started），记下来供续聊与快照。
      // app-server 路发的是 'start'（agent-appserver.mjs），exec 回落发的是 'session'
      // （agent-cli.mjs）——两边都是「会话建好了」，都要认；只认 'session' 的话
      // app-server 路的 turn.sessionId 永远是空，后台快照存不上会话号、续聊断线。
      if ((ev.type === 'session' || ev.type === 'start') && ev.sessionId && !turn.sessionId) turn.sessionId = String(ev.sessionId);
      // 显式停掉的轮保持 'stopped'（stopTurn 置的），别被后面的 done 盖成 'done'。
      if (ev.type === 'done' && turn.status !== 'stopped') turn.status = ev.failed ? 'failed' : 'done';
      turnEmit(turn, ev);
      if (ev.type === 'done') break;
    }
  } catch (e) {
    if (!turn.done) turnEmit(turn, { type: 'error', message: (e && e.message) || String(e) });
  } finally {
    turn.done = true;
    turn.endedAt = Date.now();
    if (turn.status === 'running' || turn.status === 'waiting_approval') turn.status = 'failed';
    // 还挂着的审批一律按拒绝收掉（原来路由 finally 里做的事，搬到这里——
    // turn 的生命周期不再跟着请求走了）。
    for (const [id, w] of turn.approvals) {
      turn.approvals.delete(id);
      clearTimeout(w.timer);
      w.resolve({ decision: 'decline' });
    }
    genFinish(turn);            // 结束所有订阅者的 SSE
    retireGen(turn.key, turn);  // 保留策略走 gen.mjs（每 key 8 轮、6 小时）
    // 前端不在场时（纯后台跑完），服务端把快照补上，保证侧栏和续聊不断。
    // 前端在场时它自己也会存——id 都按 'turn-<turnId>' 对齐，upsert 去重，不会出两条。
    saveTurnSnapshot(turn).catch(() => {});
  }
}

// ── 重连：先吐缓冲，再转实时 ────────────────────────────────────────────────
// 给 GET /api/codex/turns/attach 用的。meta 先行（带 turnId 与 prompt 摘要，
// 前端靠它把快照 id 对齐成 'turn-<turnId>'），然后把缓冲按序重放，最后挂上实时订阅。
export async function attachCodexTurn(turn, res) {
  sseOpen(res);
  sseSend(res, {
    type: 'meta', agent: 'codex', cwd: turn.cwd, sessionId: turn.sessionId || '',
    turnId: turn.turnId, prompt: String(turn.userText || '').slice(0, 200),
  });
  for (const ev of turn.events) sseSend(res, ev);
  if (turn.done) {
    try { res.end(); } catch {}
    return;
  }
  genSubscribe(turn, res);
  await new Promise((resolve) => {
    res.on('close', () => { resolve(); });
  });
}

// sse 小工具（与 routes/agent-cli.mjs 里那份同语义，抽出来避免循环依赖）。
function sseOpen(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}
function sseSend(res, ev) { try { res.write('data: ' + JSON.stringify(ev) + '\n\n'); } catch {} }

// ── 快照补存 ────────────────────────────────────────────────────────────────
// 前端在场时它自己存（pushSession）；纯后台跑完时前端不在，服务端按缓冲里的事件
// 拼一份快照存上。id 取 'turn-<turnId>' 与前端对齐；同 sessionId 已有记录时复用
// 它的 id（比如续聊的旧快照），并把同 sessionId 的其它 id 清掉——一个会话在侧栏
// 里永远只占一行。
function turnToMessages(turn) {
  const items = [{ role: 'user', id: 1, text: String(turn.userText || ''), status: 'done' }];
  const m = {
    role: 'agent', id: 2, text: '', reasoning: '', tools: [], todos: [],
    notes: [], error: '', status: 'done', usage: null,
  };
  for (const ev of turn.events) {
    if (!ev || typeof ev !== 'object') continue;
    switch (ev.type) {
      case 'text': m.text += String(ev.text || ''); break;
      case 'reasoning': m.reasoning += (m.reasoning ? '\n\n' : '') + String(ev.text || ''); break;
      case 'tool':
        m.tools.push({
          id: ev.id || '', name: String(ev.name || ''), status: ev.status || 'started',
          summary: typeof ev.summary === 'string' ? ev.summary.slice(0, 4000) : '',
          output: typeof ev.output === 'string' ? ev.output.slice(0, 4000) : undefined,
          input: typeof ev.input === 'string' ? ev.input.slice(0, 4000) : undefined,
        });
        break;
      case 'todo': if (Array.isArray(ev.items)) m.todos = ev.items.slice(0, 40); break;
      case 'notice': m.notes.push(String(ev.text || '')); break;
      case 'error': m.error = String(ev.message || ''); break;
      case 'done':
        if (ev.usage) m.usage = ev.usage;
        if (ev.failed) m.status = 'failed';
        break;
      default: break;
    }
  }
  m.tools = m.tools.slice(-20);
  m.notes = m.notes.slice(-20);
  items.push(m);
  return items;
}

async function saveTurnSnapshot(turn) {
  const threadId = turn.sessionId;
  if (!threadId || !turn.dataDir) return;
  const ctx = { dataDir: turn.dataDir };
  let id = turnSnapshotId(turn.turnId);
  try {
    const same = listCliSessions(ctx, 'codex', {}).filter((s) => s && s.sessionId === threadId && s.id !== id);
    if (same.length) {
      // 复用已有的快照 id（续聊场景），多出来的删掉，一个会话只留一行。
      id = same[0].id;
      for (const s of same.slice(1)) { try { deleteCliSession(ctx, 'codex', s.id); } catch {} }
    }
  } catch {}
  const title = String(turn.userText || '').trim().replace(/\s+/g, ' ').slice(0, 60) || '新会话';
  try {
    saveCliSession(ctx, 'codex', {
      id, sessionId: threadId, cwd: turn.cwd, title, messages: turnToMessages(turn),
    });
  } catch {}
}
