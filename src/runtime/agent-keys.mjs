// 外部 CLI agent（codex / zcode）的 API key：在服务器上存一把，跑 CLI 时注进子进程 env。
//
// 为什么要有它：codex 的登录（`codex login`）是【交互式】流程，网页上点不了；而它认
// OPENAI_API_KEY，所以在服务器上存一把 key 就等于「已登录」。Claude 那边的等价物是控制台
// 「Claude 账号」页里存的 setup-token（runtime/claude-account.mjs），这里照同一套思路做。
//
// **只有 codex**：zcode 不读厂商 key 环境变量（Z.ai 自家是 Coding Plan 账号制，登录态是加密的
// `~/.zcode/v2/credentials.json`，只能由官方浏览器登录写），所以 zcode 不给填 key 的口子，
// 一律走 `zcode login`。
//
// 存储复用 extension-secrets.mjs（AES-256-GCM 密文 + 0600 数据密钥，Windows 上用 DPAPI 包住），
// 放在 <DATA_ROOT>/agents/ 下——和扩展中心凭据同源同格式，接口只回尾 4 位。
//
// 与进程环境变量的关系：**存的那把压过 env**（界面上刚填的必须生效），env 里没有才回落到
// OPENAI_API_KEY 这类厂商变量（运维在 unit 文件里配的做法照旧可用）。
import path from 'node:path';
import { readSecrets, writeSecrets } from '../extension-secrets.mjs';
import { ROOT } from '../config/index.mjs';
import { AGENT_BY_ID } from '../config/agents.mjs';

export const AGENT_KEYS_DIR = path.join(ROOT, 'agents');

// 厂商各自认的环境变量名（第一个是主名 = 表里的 keyEnv，其余是这家 CLI 也读的别名）。
//
// 只有 codex 在这里：它是 npm 分发的 CLI，认 OPENAI_API_KEY / CODEX_API_KEY（实测：带上
// OPENAI_API_KEY 起得来 thread，不带就要求先登录）；而 **zcode 不读任何厂商 key 环境变量**
// （源码里只认 ANTHROPIC_API_KEY / OPENAI_API_KEY / AI_GATEWAY_API_KEY 这三个给「自带 key 的
// 第三方 provider」用，Z.ai 自家是 Coding Plan 账号制），它的凭据是加密的
// `~/.zcode/v2/credentials.json`，只能由官方 `zcode login` 的浏览器授权写。
// 所以 zcode 一律走登录态，不给它开填 key 的口子——填了也不生效，反而误导。
const ENV_NAMES = {
  codex: ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN'],
};

export const KEY_AGENTS = Object.freeze(Object.keys(ENV_NAMES));

export function isKeyAgent(id) { return KEY_AGENTS.includes(id); }

// 读盘（解不开 / 没存过都当「没有」，绝不因为读不了盘就让分页起不来）。整表读一次，进程内不缓存
// ——密文只有几百字节，而 extension-secrets 内部已按文件 mtime + 数据密钥做了缓存。
function readKeys() {
  try { return readSecrets(AGENT_KEYS_DIR); } catch (e) {
    console.warn('[agent-keys] 读凭据失败：', (e && e.message) || e);
    return {};
  }
}

// 存着的那把（没有 = ''）。
export function savedAgentKey(id) {
  const rec = readKeys()[id];
  const k = rec && rec.headers && rec.headers.apiKey;
  return typeof k === 'string' ? k : '';
}

// env 里已有的那把（厂商变量，按别名顺序取第一个非空的）。
export function envAgentKey(id, env = process.env) {
  for (const name of ENV_NAMES[id] || []) if (env && env[name]) return { name, value: String(env[name]) };
  return null;
}

// 这把 key 现在算不算有：存的那把优先，其次 env。
export function agentKeyState(id, env = process.env) {
  const stored = savedAgentKey(id);
  if (stored) return { id, source: 'store', env: (AGENT_BY_ID[id] || {}).keyEnv || '', tail: stored.slice(-4), has: true };
  const e = envAgentKey(id, env);
  if (e) return { id, source: 'env', env: e.name, tail: e.value.slice(-4), has: true };
  return { id, source: '', env: (AGENT_BY_ID[id] || {}).keyEnv || '', tail: '', has: false };
}

// 跑一轮时注进子进程 env 的那几个变量。存的那把压过 env（见文件头）；没存过就返回 {}，
// 让 CLI 直接继承进程环境（`codex login` / `zcode login` 的登录态照旧可用）。
export function cliKeyEnv(id) {
  const stored = savedAgentKey(id);
  if (!stored) return {};
  const name = (AGENT_BY_ID[id] || {}).keyEnv || (ENV_NAMES[id] || [])[0];
  return name ? { [name]: stored } : {};
}

// 存 / 清（管理员面调用）。key 为空 = 清掉这一家的凭据。
export function setAgentKey(id, key) {
  if (!isKeyAgent(id)) {
    return {
      error: id === 'zcode'
        ? 'zcode 不走 API key：它认的是 Z.ai 账号登录（在服务器上跑一次 zcode login，授权一次即可）'
        : '这个 agent 不用填 key：' + id,
    };
  }
  const value = String(key || '').trim();
  const map = readKeys();
  const next = { ...map };
  if (!value) delete next[id];
  else next[id] = { headers: { apiKey: value } };
  try { writeSecrets(AGENT_KEYS_DIR, next); } catch (e) { return { error: (e && e.message) || String(e) }; }
  return { ok: true, id, has: !!value, tail: value ? value.slice(-4) : '' };
}

// 给管理面（设置 → Agent）的视图：只给尾 4 位，不外泄整把 key。
export function agentKeyList(env = process.env) {
  return KEY_AGENTS.map((id) => ({ ...agentKeyState(id, env), label: (AGENT_BY_ID[id] || {}).label || id }));
}
