// 外部 CLI agent（codex / zcode）的服务端会话注册表。
//
// 【为什么有这一段】CLI 分页的会话列表原本只存浏览器 localStorage——换设备、清缓存就全丢，
// 而会话号（codex 的 thread_id / zcode 的 sessionId）是续聊的唯一凭据，丢了就只能从头聊。
// Claude 没这个问题：它的注册表（claude-projects.json）本来就存在服务端。这里照同一套办法补齐。
//
// 存储按身份隔离：`<ctx.dataDir>/cli-sessions.json`（admin = 数据根，user = <base>/.bridge），
// 与 cli-agents.json / claude-projects.json 同一处惯例。每 agent 各留最近 MAX_PER_AGENT 条。
//
// 服务端只存【前端 trim 过的快照】（条数/正文本就有上限），不做对话转录：CLI 的完整记录
// 在 CLI 自己的数据目录里，这里只是「侧栏 + 续聊凭据」的跨设备同步。
//
// 纯函数存储层：ctx 由调用方给（真实请求给 requireCtx 的 ctx，测试给 { dataDir: tmp }），
// 本模块不碰任何请求对象。

import path from 'node:path';
import crypto from 'node:crypto';
import { readJson, writeJson } from '../jsonfile.mjs';
import { CLI_AGENTS } from './agent-cli.mjs';

const FILE = 'cli-sessions.json';
const storeFile = (ctx) => path.join(ctx.dataDir, FILE);

export const MAX_PER_AGENT = 20;      // 每 agent 留最近这么多条（超了淘汰最旧）
const MAX_MESSAGES = 120;             // 单条会话快照的消息条数上限（防御性：前端本来就 trim 到 80）
const MAX_TEXT = 8000;                // 单条消息正文/工具输出的防御性截断（前端 trim 到 4000）

const str = (v, max = 500) => (typeof v === 'string' ? v.slice(0, max) : '');

// 前端快照的消息体大体是 { role, id, text, reasoning, tools[], todos[], notes[], status, usage… }。
// 服务端不逐字段理解（呈现归前端），只做防御性修剪：条数上限 + 长字符串截断 + 丢弃非对象。
function normMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  return list.slice(-MAX_MESSAGES).map((m) => {
    if (!m || typeof m !== 'object') return { role: 'agent', text: '' };
    const out = { ...m };
    for (const k of ['text', 'reasoning', 'summary']) {
      if (typeof out[k] === 'string' && out[k].length > MAX_TEXT) out[k] = out[k].slice(0, MAX_TEXT);
    }
    if (Array.isArray(out.tools)) {
      out.tools = out.tools.slice(-20).map((tl) => {
        if (!tl || typeof tl !== 'object') return {};
        const t2 = { ...tl };
        for (const k of ['output', 'input', 'summary', 'diff']) {
          if (typeof t2[k] === 'string' && t2[k].length > MAX_TEXT) t2[k] = t2[k].slice(0, MAX_TEXT);
        }
        return t2;
      });
    }
    return out;
  });
}

function readStore(ctx) {
  const raw = readJson(storeFile(ctx), null);
  // 坏数据（老版本/手改坏）容错：当成空库，下一次写入自然重建成正确形状。
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.sessions)) return { version: 1, sessions: [] };
  return raw;
}

function writeStore(ctx, store) {
  writeJson(storeFile(ctx), store, 0);
}

// 最近使用排前。updatedAt 是毫秒级，连续写入会落在同一毫秒：那时比较器返回 0，
// 而 V8 的 sort 是稳定的，于是排成插入顺序（最旧的排最前）。实测同毫秒写入 200 次里
// 有 152 次顺序错。用单调递增的 seq 做 tie-break——下面淘汰挑「最旧」的同样靠它，
// 否则挤掉的会是该留下的那条。
const byRecent = (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || (b.seq || 0) - (a.seq || 0);

// 某 agent 的会话（最近使用排前）。withMessages=false 时丢掉 messages（侧栏列表用，省带宽）。
export function listCliSessions(ctx, agent, { withMessages = false } = {}) {
  if (!CLI_AGENTS.includes(agent)) return [];
  const sessions = readStore(ctx).sessions.filter((s) => s && s.agent === agent);
  sessions.sort(byRecent);
  if (withMessages) return sessions;
  return sessions.map(({ messages, ...meta }) => meta);
}

// 取一条完整记录（另一台设备点开侧栏某条时用；找不到回 null）。
export function getCliSession(ctx, agent, id) {
  if (!CLI_AGENTS.includes(agent)) return null;
  const idStr = str(id, 100);
  if (!idStr) return null;
  return readStore(ctx).sessions.find((s) => s && s.agent === agent && s.id === idStr) || null;
}

// 新增 / 更新（upsert 按 id）。sessionId 是续聊凭据，空的不收——存了也没法续聊。
// 返回这条记录的 id（调用方没给就由服务端生成）。
export function saveCliSession(ctx, agent, rec = {}) {
  if (!CLI_AGENTS.includes(agent)) throw Object.assign(new Error('未知 agent：' + agent), { status: 400 });
  const sessionId = str(rec.sessionId, 200);
  if (!sessionId) throw Object.assign(new Error('缺少会话号（sessionId），无法跨设备续聊'), { status: 400 });
  const now = Date.now();
  const store = readStore(ctx);
  // 单调递增序号：updatedAt 只有毫秒精度，同毫秒并列时靠它定先后（见 byRecent）。
  const seq = (Number.isInteger(store.seq) ? store.seq : 0) + 1;
  const id = str(rec.id, 100) || crypto.randomUUID();
  const prev = store.sessions.find((s) => s && s.id === id && s.agent === agent);
  const entry = {
    id,
    agent,
    sessionId,
    cwd: str(rec.cwd, 1000),
    title: str(rec.title, 200) || '新会话',
    createdAt: (prev && prev.createdAt) || now,
    updatedAt: now,
    seq,
    messages: normMessages(rec.messages),
  };
  const rest = store.sessions.filter((s) => s && !(s.id === id && s.agent === agent));
  rest.push(entry);
  // 每家各自留最近 MAX_PER_AGENT 条（按 updatedAt 淘汰最旧，同毫秒按 seq）。
  const kept = [];
  for (const a of CLI_AGENTS) {
    const mine = rest.filter((s) => s.agent === a).sort(byRecent);
    kept.push(...mine.slice(0, MAX_PER_AGENT));
  }
  store.version = 1;
  store.seq = seq;
  store.sessions = kept;
  writeStore(ctx, store);
  return id;
}

// 删一条（不存在也回 ok：删除是幂等的，界面只求它消失）。
export function deleteCliSession(ctx, agent, id) {
  if (!CLI_AGENTS.includes(agent)) throw Object.assign(new Error('未知 agent：' + agent), { status: 400 });
  const idStr = str(id, 100);
  if (!idStr) return;
  const store = readStore(ctx);
  store.sessions = store.sessions.filter((s) => s && !(s.id === idStr && s.agent === agent));
  writeStore(ctx, store);
}
