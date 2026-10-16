// 外部 CLI agent（codex / zcode）的每身份设置：工作目录 + （codex）模型与思考深度。
//
// 为什么不是「一切都在 ctx.cwd」：那个根是 Claude 的项目目录（admin = 工作空间），
// 三家挤在一个目录里——zcode 写的文件会跑进 Claude 的项目列表，谁也分不清是谁的。
// 这里给每家一个默认子目录（<ctx.cwd>/<agent>），落盘记住用户改过的选择。
//
// 与 claude-projects 的分工：那边是【Claude 的项目】（可多个、侧栏列出来、会话按目录归属）；
// 这边是【每个 CLI agent 一个 cwd】，概念不同，所以不共用那份存储，也不进 Claude 的项目列表。
//
// 存储按身份隔离（ctx.dataDir：admin = 数据根，user = <base>/.bridge），与 claude-projects.json 同处。
//
// 值有两种形状：老的（一个字符串 = 只有 cwd）和新的（{ cwd, model, effort }）。读的时候两种都认，
// 写的时候一律写成新的——升级路上不会把用户已经选好的目录弄丢。
//
// 模型 / 思考深度只有 codex 有（zcode 的 headless 入口没有对应参数，见 agent-cli.mjs 的 buildArgs）。
//
// 权限档（P4，仅 codex）：官方 app-server 的四个正交维度，不要混成一个开关——
//   sandbox  沙箱：'read-only' | 'workspace-write' | 'danger-full-access'（线程级走字符串
//              SandboxMode；当轮覆盖走对象 SandboxPolicy，runtime/agent-appserver.mjs 换算）
//   approval 审批策略：'on-request' | 'never' | 'untrusted'（granular 对象形式本轮不做界面，
//              探针 schema 里有，需要时再接）
//   reviewer 审批人：'user'（默认，审批卡回客户端）| 'auto_review'（子审阅员按风险框架代批，
//              探针实测：审批卡不到客户端，autoApprovalReview/* 事件 + 批完继续）
//   profile  具名 permissions profile id（字符串，只能是 permissionProfile/list 回来的 id；
//              与 sandbox 互斥——选了 profile，sandbox 不生效；不存在的 id 上游报配置错）
// 默认值 = 当前行为（workspace-write + on-request + user + 无 profile）。

import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { readJson, writeJson } from '../jsonfile.mjs';
import { authorizeProjectPath } from '../project-paths.mjs';
import { CLI_AGENTS } from './agent-cli.mjs';

const FILE = 'cli-agents.json';
const storeFile = (ctx) => path.join(ctx.dataDir, FILE);

// 权限档默认值（= 当前行为）：改这里会改所有没显式设过的会话，小心。
export const DEFAULT_PERMS = Object.freeze({
  sandbox: 'workspace-write',
  approval: 'on-request',
  reviewer: 'user',
  profile: '',
});

const PERMS_SANDBOX = ['read-only', 'workspace-write', 'danger-full-access'];
const PERMS_APPROVAL = ['on-request', 'never', 'untrusted'];
const PERMS_REVIEWER = ['user', 'auto_review'];

// 校验一份 perms（线程级默认值 / 当轮覆盖都走这里）：只认白名单里的值，其余回默认值；
// profile 只做 trim + 截长（合法性由 permissionProfile/list 的结果定，界面只给 list 回来的 id）。
export function normCliPerms(raw) {
  const out = { ...DEFAULT_PERMS };
  if (raw && typeof raw === 'object') {
    if (PERMS_SANDBOX.includes(raw.sandbox)) out.sandbox = raw.sandbox;
    if (PERMS_APPROVAL.includes(raw.approval)) out.approval = raw.approval;
    if (PERMS_REVIEWER.includes(raw.reviewer)) out.reviewer = raw.reviewer;
    if (typeof raw.profile === 'string' && raw.profile.trim()) out.profile = raw.profile.trim().slice(0, 200);
  }
  return out;
}

// 校验一份当轮覆盖：只保留调用方显式给出的维度，不补默认值（没给的维度 = 不覆盖，
// 线程当前设置保持——续聊线程可能已被上一轮的覆盖改过，补默认会把它重置回去）。
// 返回 {} = 没有任何有效维度 = 不覆盖。
export function normCliPermsOverride(raw) {
  const out = {};
  if (raw && typeof raw === 'object') {
    if (PERMS_SANDBOX.includes(raw.sandbox)) out.sandbox = raw.sandbox;
    if (PERMS_APPROVAL.includes(raw.approval)) out.approval = raw.approval;
    if (PERMS_REVIEWER.includes(raw.reviewer)) out.reviewer = raw.reviewer;
    if (typeof raw.profile === 'string' && raw.profile.trim()) out.profile = raw.profile.trim().slice(0, 200);
  }
  return out;
}
export function isDefaultPerms(perms) {
  if (!perms || typeof perms !== 'object') return true;
  const n = normCliPerms(perms);
  return n.sandbox === DEFAULT_PERMS.sandbox && n.approval === DEFAULT_PERMS.approval
    && n.reviewer === DEFAULT_PERMS.reviewer && n.profile === DEFAULT_PERMS.profile;
}

// 每家的默认目录：工作空间下以自己的名字开一间（zcode / codex）。
export const defaultCliCwd = (ctx, agent) => path.join(ctx.cwd, agent);

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '');

// 存的那一条 → { cwd, model, effort, perms }（老形状是裸字符串，就是 cwd；
// 老的 { cwd, model, effort } 没有 perms，读出来补默认值——升级路上不丢已存的选择）。
function normEntry(raw) {
  if (typeof raw === 'string') return { cwd: str(raw), model: '', effort: '', perms: { ...DEFAULT_PERMS } };
  if (raw && typeof raw === 'object') return { cwd: str(raw.cwd), model: str(raw.model), effort: str(raw.effort), perms: normCliPerms(raw.perms) };
  return { cwd: '', model: '', effort: '', perms: { ...DEFAULT_PERMS } };
}

// CLI 的 cwd 必须真实存在（spawn 会直接 ENOENT），所以给之前先确保它在。
// 失败就退回工作空间根：开局跑不起来比「落在别处」严重得多。
function ensure(dir, fallback) {
  try { mkdirSync(dir, { recursive: true }); return dir; }
  catch { return fallback; }
}

// 这一家在磁盘上存的那一条（没存过就是空）。
function entryOf(ctx, agent) {
  if (!CLI_AGENTS.includes(agent)) return { cwd: '', model: '', effort: '' };
  return normEntry(readJson(storeFile(ctx), {})[agent]);
}

export function getCliCwd(ctx, agent) {
  if (!CLI_AGENTS.includes(agent)) return ctx.cwd;
  const dir = entryOf(ctx, agent).cwd || defaultCliCwd(ctx, agent);
  return ensure(dir, ctx.cwd);
}

// 这一家的完整设置（抽屉一打开就要显示，所以跟着 /api/agents/status 一起给前端）。
export function getCliPrefs(ctx, agent) {
  const e = entryOf(ctx, agent);
  return { cwd: getCliCwd(ctx, agent), model: e.model, effort: e.effort, perms: e.perms };
}

function write(ctx, agent, patch) {
  const data = readJson(storeFile(ctx), {});
  data[agent] = { ...normEntry(data[agent]), ...patch };
  writeJson(storeFile(ctx), data, 2);
  return data[agent];
}

// 改工作目录：授权尺与 Claude 新建项目完全同一把（admin 任意本地目录、Pro 限自己空间内），
// 所以一个账号能选的范围不会因为「换了个 agent」而变宽。
export function setCliCwd(ctx, agent, requested) {
  if (!CLI_AGENTS.includes(agent)) throw Object.assign(new Error('未知 agent：' + agent), { status: 400 });
  const dir = authorizeProjectPath(ctx, requested);
  return write(ctx, agent, { cwd: dir }).cwd;
}

// 改模型 / 思考深度。空串 = 交回 CLI 自己的配置（用户在 ~/.codex/config.toml 里选的那个）。
// 不做白名单校验：这份清单由 CLI 自己给（agent-models.mjs），上游加一个模型不该要我们改代码；
// 真填错了 CLI 会报错，那句话原样带回给用户。
export function setCliAgentPrefs(ctx, agent, { model, effort, perms } = {}) {
  if (!CLI_AGENTS.includes(agent)) throw Object.assign(new Error('未知 agent：' + agent), { status: 400 });
  const patch = {};
  if (model !== undefined) patch.model = str(model).slice(0, 80);
  if (effort !== undefined) patch.effort = str(effort).slice(0, 40);
  // perms（仅 codex 用；zcode 的 headless 入口没有权限档概念，前端只在 Codex 页给权限设置，
  // 后端聊天路由也只给 codex 拼 perms）。部分对象 = 只改给出的键（同 model/effort 的语义），
  // 不是整对象替换——否则只改 profile 会把 sandbox 重置回默认。
  if (perms !== undefined) patch.perms = normCliPerms({ ...entryOf(ctx, agent).perms, ...perms });
  const e = write(ctx, agent, patch);
  return { cwd: getCliCwd(ctx, agent), model: e.model, effort: e.effort, perms: e.perms };
}

// 各家的当前目录（给 /api/agents/status 用，抽屉不必先聊一轮才知道）。
export function cliCwdMap(ctx) {
  const out = {};
  for (const agent of CLI_AGENTS) out[agent] = getCliCwd(ctx, agent);
  return out;
}
