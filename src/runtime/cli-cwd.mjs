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

import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { readJson, writeJson } from '../jsonfile.mjs';
import { authorizeProjectPath } from '../project-paths.mjs';
import { CLI_AGENTS } from './agent-cli.mjs';

const FILE = 'cli-agents.json';
const storeFile = (ctx) => path.join(ctx.dataDir, FILE);

// 每家的默认目录：工作空间下以自己的名字开一间（zcode / codex）。
export const defaultCliCwd = (ctx, agent) => path.join(ctx.cwd, agent);

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '');

// 存的那一条 → { cwd, model, effort }（老形状是裸字符串，就是 cwd）。
function normEntry(raw) {
  if (typeof raw === 'string') return { cwd: str(raw), model: '', effort: '' };
  if (raw && typeof raw === 'object') return { cwd: str(raw.cwd), model: str(raw.model), effort: str(raw.effort) };
  return { cwd: '', model: '', effort: '' };
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
  return { cwd: getCliCwd(ctx, agent), model: e.model, effort: e.effort };
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
export function setCliAgentPrefs(ctx, agent, { model, effort } = {}) {
  if (!CLI_AGENTS.includes(agent)) throw Object.assign(new Error('未知 agent：' + agent), { status: 400 });
  const patch = {};
  if (model !== undefined) patch.model = str(model).slice(0, 80);
  if (effort !== undefined) patch.effort = str(effort).slice(0, 40);
  const e = write(ctx, agent, patch);
  return { cwd: getCliCwd(ctx, agent), model: e.model, effort: e.effort };
}

// 各家的当前目录（给 /api/agents/status 用，抽屉不必先聊一轮才知道）。
export function cliCwdMap(ctx) {
  const out = {};
  for (const agent of CLI_AGENTS) out[agent] = getCliCwd(ctx, agent);
  return out;
}
