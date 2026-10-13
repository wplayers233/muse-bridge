// agent 开关与状态：每个 agent「勾没勾 / 能不能跑 / 认证了没」的单一真相。
//
//   勾选 switch   —— 管理员在设置「Agent」页里的开关，存 config.json 的 agents 键
//                    （{ claude:true, dimensio:false }，没写的项 = 默认开）。部署脚本按用户在
//                    「只要 Claude / 只要 dimensio / 都要」里的选择写这个键。
//   能跑 runnable —— 这台机器装了：dimensio 要 harness 目录且装好了依赖（只选 Claude 时部署脚本
//                    不装 harness 的依赖）。探测不 spawn，结果缓存 20 秒。
//   认证 authed   —— 凭据配没配（仅作提示）：token 过期这种临时态不该让整个分页消失，
//                    Claude 自己就有「未认证提示卡」，所以【不】参与 enabled 判定。
//
// enabled = runnable && switch !== false。身份层（identity.mjs contextFor）在此之上再与
// 「这个人被授权的名单」取交集，得出每个请求能用哪些 agent。
//
// 开关改动即时生效（下一个请求就按新值走），并经事件总线广播 agents.changed，
// 在线客户端据此刷新可用列表。落盘只改 agents 这一个键（同 claude-account.mjs 的做法）。

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { CONFIG_PATH, config } from '../config/index.mjs';
import { AGENTS, AGENT_IDS, AGENT_BY_ID } from '../config/agents.mjs';
import { agentKeyState, envAgentKey, isKeyAgent, savedAgentKey } from './agent-keys.mjs';
import { busPublishAll } from './bus.mjs';

const HARNESS_DIR = fileURLToPath(new URL('../../harness', import.meta.url));

// ── 开关 ────────────────────────────────────────────────────────────────────
function normSwitches(raw) {
  const out = {};
  if (raw && typeof raw === 'object') for (const id of AGENT_IDS) if (typeof raw[id] === 'boolean') out[id] = raw[id];
  return out;
}
let switches = normSwitches(config.agents);

export function agentSwitches() { return { ...switches }; }

function persist() {
  let raw = {};
  try { raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch {}
  raw.agents = { ...switches };
  try { writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2)); } catch (e) { console.error('[agents] persist failed:', (e && e.message) || e); }
}

export function setAgentSwitch(id, on) {
  if (!AGENT_BY_ID[id]) return { error: '未知 agent：' + id };
  switches = { ...switches, [id]: !!on };
  persist();
  invalidateProbes();
  busPublishAll({ type: 'agents.changed' });
  return { ok: true, id, enabled: agentEnabled(id) };
}

// ── 探测 ────────────────────────────────────────────────────────────────────
// 外部 CLI（codex / zcode）装没装：分页与对话接口随 bridge 自带，命令行工具是外部件，只能现看。
// 只找二进制，不 spawn（探测每 20 秒一次，不能带副作用）。
//
// 查找顺序（先命中先用）：
//   ① 程序自带的 node_modules/.bin —— 与 Claude 用 @anthropic-ai/claude-agent-sdk 同一条思路：
//      codex 官方就是 npm 分发的（包名 @openai/codex，见 package.json 的依赖），装依赖时落在
//      程序自己的 bin 目录里，服务器上不必再单独装一遍；
//   ② PATH —— 运维自己装的、或系统包管理器装的；
//   ③ 用户级兜底目录 —— `~/.local/bin` 是 zcode 官方安装脚本写 shim 的地方，
//      `~/.zcode/runtime/current/bin` 是它解包出来的真身，`~/.codex/bin` 给按官方 tarball 手装的人。
// HOME 每次现取——测试与部署脚本会改它，不在模块加载时定死。
const BIN_NAMES = {
  codex: process.platform === 'win32' ? ['codex.cmd', 'codex.exe', 'codex'] : ['codex'],
  zcode: process.platform === 'win32' ? ['zcode.cmd', 'zcode.exe', 'zcode'] : ['zcode'],
};

// 程序自己的 bin 目录（由本模块位置反推 Program Root，与 runtime/paths.mjs 的 PROGRAM_ROOT 同义）。
// 可用 BRIDGE_AGENT_BIN_DIR 覆盖：置成别的目录 = 用那份安装；显式置空 = 不用自带的这份
// （测试要钉住「PATH 上有什么就是什么」，运维也能拿它避开随程序走的那一份）。
const BUNDLED_BIN_DIR = fileURLToPath(new URL('../../node_modules/.bin', import.meta.url));

export function bundledBinDir(env = process.env) {
  const declared = env.BRIDGE_AGENT_BIN_DIR;
  if (typeof declared === 'string') return declared.trim();
  return BUNDLED_BIN_DIR;
}

export function cliSearchDirs(env = process.env) {
  const dirs = [];
  const bundled = bundledBinDir(env);
  if (bundled) dirs.push(bundled);
  for (const d of String(env.PATH || '').split(path.delimiter)) if (d) dirs.push(d);
  const home = env.HOME || os.homedir();
  dirs.push(path.join(home, '.local', 'bin'), path.join(home, '.zcode', 'runtime', 'current', 'bin'), path.join(home, '.codex', 'bin'));
  return dirs;
}

// dirs 可显式传入：测试据此钉住查找范围（不跟着开发机的 PATH 与自带目录变）。
export function findCliBin(name, env = process.env, dirs = cliSearchDirs(env)) {
  const names = BIN_NAMES[name] || [name];
  for (const d of dirs) {
    for (const n of names) {
      const p = path.join(d, n);
      try { if (existsSync(p) && statSync(p).isFile()) return resolveWinShim(name, p); } catch {}
    }
  }
  return '';
}

// Windows 的 npm 垫片（.cmd/.bat）不能被直接 spawn：Node ≥ 20 出于 CVE-2024-27980
// 对 .cmd/.bat 一律 EINVAL（除非 shell:true，但那样引号转义就乱了）。垫片背后都是
// node 脚本，找到垫片时优先解析出包内真身（.js）返回——调用方见到 .js 会用
// process.execPath 起，垫片与 shell 全都绕开。解析不到就原样返回（保持旧行为）。
const WIN_SHIM_REAL_JS = {
  codex: ['../@openai/codex/bin/codex.js'],
};

function resolveWinShim(name, found) {
  if (process.platform !== 'win32') return found;
  if (!/\.(cmd|bat)$/i.test(found)) return found;
  for (const rel of WIN_SHIM_REAL_JS[name] || []) {
    const real = path.resolve(path.dirname(found), rel);
    try { if (existsSync(real) && statSync(real).isFile()) return real; } catch {}
  }
  return found;
}

const RUNNABLE = {
  claude: () => true,                    // Agent SDK 自带引擎二进制
  dimensio: () => existsSync(path.join(HARNESS_DIR, 'server', 'index.ts')) && existsSync(path.join(HARNESS_DIR, 'node_modules')),
  // codex / zcode 的分页随 bridge 自带（静态前端），CLI 是外部件：装没装由分页里的「接入」卡自己讲，
  // 不拦整页。真能不能跑，点下去的那一刻由 routes/agent-cli.mjs 现探（没有会明说缺什么）。
  codex: () => true,
  zcode: () => true,
};

const fileHasKey = (file, re) => { try { return re.test(readFileSync(file, 'utf8')); } catch { return false; } };

// codex 的凭据：① 服务器上存的那把（keyDir 指到哪份就查哪份：admin=全局，user=各人自己的）；
// ② 环境变量；③ 官方 `codex login` 写下的 $CODEX_HOME/auth.json（默认 ~/.codex/auth.json，0600）。
function codexAuthed(env = process.env, keyDir = undefined) {
  if (savedAgentKey('codex', keyDir) || envAgentKey('codex', env)) return true;
  const home = env.CODEX_HOME || path.join(env.HOME || os.homedir(), '.codex');
  const f = path.join(home, 'auth.json');
  try { return !!readFileSync(f, 'utf8').trim() && JSON.parse(readFileSync(f, 'utf8')).auth_mode !== 'none'; } catch { return false; }
}

// zcode 的凭据：只有官方 `zcode login`（浏览器授权）这一条路——它写的是加密的
// `{dataBaseDir}/.zcode/v2/credentials.json`（dataBaseDir = ZCODE_DATA_BASE_DIR，默认 $HOME），
// 里面是 {凭据键: "enc:v1:…"} 的记录，非空即「已登录」。它不认任何厂商 key 环境变量
// （见 runtime/agent-keys.mjs 的说明），所以这里不看 key。
function zcodeAuthed(env = process.env) {
  const home = env.ZCODE_DATA_BASE_DIR || env.HOME || os.homedir();
  const f = path.join(home, '.zcode', 'v2', 'credentials.json');
  try {
    const rec = JSON.parse(readFileSync(f, 'utf8'));
    if (!rec || typeof rec !== 'object') return false;
    // 只要有任意一条非空凭据就算登录过（键名随 provider/账号类型变，别去猜具体键）。
    return Object.values(rec).some((v) => typeof v === 'string' && v.trim().length > 0);
  } catch { return false; }
}

const AUTHED = {
  claude: () => {
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY) return true;
    let accounts = [];
    try { accounts = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')).claudeAccounts || []; } catch {}
    if (accounts.some((a) => a && a.token)) return true;
    const cfgDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    return existsSync(path.join(cfgDir, '.credentials.json'));
  },
  dimensio: () => {
    const KEY_RE = /^\s*(ANTHROPIC|DEEPSEEK|ZHIPU|KIMI|MOONSHOT|QWEN|DASHSCOPE|GEMINI|OPENAI|MIMO)_API_KEY\s*=\s*\S+/m;
    if (Object.keys(process.env).some((k) => /^(ANTHROPIC|DEEPSEEK|ZHIPU|KIMI|MOONSHOT|QWEN|DASHSCOPE|GEMINI|OPENAI|MIMO)_API_KEY$/.test(k) && process.env[k])) return true;
    return fileHasKey(process.env.HARNESS_ENV_FILE || path.join(HARNESS_DIR, '.env'), KEY_RE);
  },
  codex: codexAuthed,
  zcode: zcodeAuthed,
};

// 外部 CLI 装没装：runnable 恒真（见 RUNNABLE），所以按「二进制在不在」讲清楚，
// 「认证了没」才有意义。装好了没登录只算提示，不挡分页。
const INSTALLED = {
  codex: () => !!findCliBin('codex'),
  zcode: () => !!findCliBin('zcode'),
};

const PROBE_TTL = 20_000;
let probeCache = null;   // { at, runnable:{}, authed:{}, installed:{} }
function invalidateProbes() { probeCache = null; }

// 探一次。opts 缺省 = 全局探测（有 20 秒缓存，status 轮询与 enabledAgents 都走它）；
// 给了 { env, keyDir } = 每身份探测（user 的 CODEX_HOME / 凭据目录各是各的），现算不进缓存
// ——每个身份的结果不同，缓存只对全局那份有意义。
function probes(opts = {}) {
  const { env = process.env, keyDir = undefined } = opts;
  if (opts.env === undefined && opts.keyDir === undefined) {
    if (probeCache && Date.now() - probeCache.at < PROBE_TTL) return probeCache;
  }
  const runnable = {}, authed = {}, installed = {};
  for (const id of AGENT_IDS) {
    try { runnable[id] = !!RUNNABLE[id](); } catch { runnable[id] = false; }
    // installed 只对「跑外部 CLI」的 agent 有意义；其余（claude / dimensio 自带）恒算装好。
    try { installed[id] = INSTALLED[id] ? !!INSTALLED[id]() : runnable[id]; } catch { installed[id] = false; }
    try { authed[id] = runnable[id] && (id === 'codex' ? !!codexAuthed(env, keyDir) : !!AUTHED[id]()); } catch { authed[id] = false; }
  }
  const result = { at: Date.now(), runnable, authed, installed };
  if (opts.env === undefined && opts.keyDir === undefined) probeCache = result;
  return result;
}

export function agentRunnable(id) { return !!probes().runnable[id]; }
export function agentAuthed(id) { return !!probes().authed[id]; }
export function agentInstalled(id) { return !!probes().installed[id]; }
export function agentEnabled(id) { return !!AGENT_BY_ID[id] && agentRunnable(id) && switches[id] !== false; }
export function enabledAgents() { return AGENT_IDS.filter(agentEnabled); }

// 现在重探一次（丢掉缓存）。用户在服务器上刚装好 / 刚登录完，点分页里的「重新检测」走它——
// 否则要等 PROBE_TTL 到期，界面会一直停在旧状态。
export function refreshAgentProbes() { invalidateProbes(); return probes(); }

const NOT_RUNNABLE_NOTE = {
  dimensio: '部署时没装 dimensio（让部署助手重新选择要装的 agent）',
};

// 装了没 / 认证了没：两句话讲清这台机器上缺什么（分页的「接入」卡与设置页共用）。
export function agentInstallNote(id) {
  if (id === 'codex') {
    return '这台机器上没找到 codex（bridge 自带一份：装依赖时 npm install 会装上 @openai/codex；'
      + '也可以单独装，官方安装：curl -fsSL https://chatgpt.com/codex/install.sh | sh）';
  }
  if (id === 'zcode') {
    return '这台机器上没找到 zcode。官方只发 macOS / Windows 安装包，Linux 上要照官方仓库自己构建：'
      + 'bash scripts/server/install-zcode.sh（clone → pnpm install → pnpm build:zcode → 落地并建好 zcode 命令）。';
  }
  return '这台机器上不可用';
}

// 给设置「Agent」页（管理员）的完整视图；opts（env / keyDir）给每身份视图用
// （/api/agents/status 对 user 传各人自己的凭据目录与 CODEX_HOME，见 routes/agent-cli.mjs）。
export function agentStatusList(opts = {}) {
  const p = probes(opts);
  const keyDir = opts.keyDir;
  return AGENTS.map((a) => {
    const runnable = !!p.runnable[a.id];
    const installed = !!p.installed[a.id];
    const authed = !!p.authed[a.id];
    // 没装的外部 CLI：仍列出、开关照旧可点（装上就生效），只是讲清缺什么。
    const note = !runnable
      ? (NOT_RUNNABLE_NOTE[a.id] || '这台机器上不可用')
      : INSTALLED[a.id] && !installed ? agentInstallNote(a.id)
        : (!authed ? (isKeyAgent(a.id) ? '还没配认证（填一把 key 或先登录 CLI）' : '还没配认证') : '');
    const key = isKeyAgent(a.id) ? agentKeyState(a.id, opts.env || process.env, keyDir) : null;
    return {
      id: a.id,
      label: a.label,
      multiUser: a.multiUser,
      switch: switches[a.id] !== false,
      runnable,
      installed,
      authed,
      enabled: agentEnabled(a.id),
      note,
      // 外部 CLI 的凭据面：codex 有 keyEnv（填 key），zcode 只有 login（跑一次官方登录）。
      // keyTail 只有尾 4 位，整把 key 不出网。
      login: a.login || '',
      ...(key ? { keyEnv: a.keyEnv || '', keySource: key.source, keyTail: key.tail, hasKey: key.has } : {}),
      install: a.install || '',
      docs: a.docs || '',
    };
  });
}
