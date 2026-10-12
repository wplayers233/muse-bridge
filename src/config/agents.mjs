// agent 的统一 id 与各子系统叫法的对照表——前后端共用的【纯数据】（前端编译期直接 import，
// 同 capabilities.mjs），这里不许 import 任何 node 模块。
//
// 统一 id：claude / dimensio / codex / zcode。
//   页面 ui.screen      claude / harness / codex / zcode
//   聊天 agent 字段      claude（dimensio 有自己的聊天接口，经 /api/harness/* 反代）
//   扩展中心的勾选列     claude / dimensio
//   对话接口            /api/codex/chat、/api/zcode/chat（见 routes/agent-cli.mjs）
// 新代码一律用统一 id；要落到某个子系统时查这张表，别再各写一份。
//
// multiUser：这个 agent 能不能开给注册用户。dimensio 是每人一个进程、锁在自己文件夹里的
//   租户实例，所以可以。codex / zcode 现在只跑本机的 CLI（用宿主的登录态与 `~/.codex`、
//   `~/.zcode`），每身份隔离还没做，所以 multiUser:false —— 只对管理员开。
//
// 外部 CLI agent（codex / zcode）比前两家多三个服务端元数据字段（前端经 /api/agents/status 拿到）：
//   keyEnv   这把 key 注进哪个环境变量（设置 → Agent 里填的那一把，见 runtime/agent-keys.mjs）；
//   install  官方安装命令——分页「接入」卡与 POST /api/admin/agent-install 用的是同一句；
//   docs     官方仓库 / 文档地址。
export const AGENTS = Object.freeze([
  { id: 'claude', label: 'Claude', screen: 'claude', chat: 'claude', multiUser: true },
  { id: 'dimensio', label: 'dimensio', screen: 'harness', chat: null, multiUser: true },
  {
    id: 'codex', label: 'Codex', screen: 'codex', chat: null, multiUser: false,
    keyEnv: 'OPENAI_API_KEY',
    login: 'codex login',
    install: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
    docs: 'https://github.com/openai/codex',
  },
  {
    id: 'zcode', label: 'ZCode', screen: 'zcode', chat: null, multiUser: false,
    // 没有 keyEnv：zcode 不认厂商 key 环境变量（Z.ai 自家是 Coding Plan 账号制，凭据由官方
    // 浏览器登录写进加密的 ~/.zcode/v2/）。它的「认证」= 在服务器上跑过一次 zcode login。
    login: 'zcode login',
    // 官方 Linux 没有一行装好的脚本：release 资产只有 .dmg / .exe（zai-org/ZCode v3.14.3），
    // 官网的 install.sh 已经 404，官方 README 给的 Linux 路径就是源码构建。所以这里指向
    // 本程序自带的那个脚本（clone → pnpm install → pnpm build:zcode → 落地 + 建命令）。
    install: 'bash scripts/server/install-zcode.sh',
    installTimeoutMs: 45 * 60_000,   // 全量构建慢，给足时间（见 runtime/agent-install.mjs）
    docs: 'https://github.com/zai-org/ZCode',
  },
]);

export const AGENT_IDS = Object.freeze(AGENTS.map((a) => a.id));
export const AGENT_BY_ID = Object.freeze(Object.fromEntries(AGENTS.map((a) => [a.id, a])));

// 注册用户没被单独设置过名单时的默认：只有 Claude（dimensio 要在「用户」页按人放行）。
export const USER_DEFAULT_AGENTS = Object.freeze(['claude']);

// 名单归一：只留认识的 id、去重、按表内顺序。
export function normAgentList(list) {
  const want = new Set((Array.isArray(list) ? list : []).map((x) => String(x || '').trim().toLowerCase()));
  return AGENT_IDS.filter((id) => want.has(id));
}

// 某个页面（ui.screen）由哪些 agent 撑着：任一可用，这一页就该出现。
export function screenAgents(screen) {
  return AGENTS.filter((a) => a.screen === screen).map((a) => a.id);
}

// 聊天请求里的 agent 字段 → 统一 id。
export function agentOfChat(chat) {
  const hit = AGENTS.find((a) => a.chat === chat);
  return hit ? hit.id : null;
}
