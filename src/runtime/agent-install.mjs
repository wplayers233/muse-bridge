// 外部 CLI agent（codex / zcode）的「在这台机器上装它」。
//
// 为什么有这一段：codex 官方是 npm 分发的（@openai/codex，已进 package.json，装依赖就自带）；
// zcode 官方是仓库 + 自建分发包（`pnpm build:zcode` 的产物里有 install.sh，装到 ~/.zcode/runtime），
// 没有 npm 包可依赖。这一页给不想手动上机的人一个按钮：照 config/agents.mjs 里那一句官方安装命令
// 跑一遍，输出逐行进日志环（控制台「服务控制 → 日志」能看），装完自动重探。
//
// 只认【表里写死】的命令——接口不接受调用方传命令，免得变成「以服务身份跑任意 shell」（管理员本来
// 也能经 Claude 页跑命令，但这里没有理由再开一个口子）。网络不通时把 CLI 的报错原样带回去，不吞。
import { spawn } from 'node:child_process';
import { AGENT_BY_ID } from '../config/agents.mjs';
import { refreshAgentProbes } from './agent-status.mjs';
import { busPublishAll } from './bus.mjs';

const INSTALL_TIMEOUT_MS = 5 * 60_000;
const TAIL_MAX = 40;              // 回给前端 / 日志环的末尾行数
let running = '';                 // 同时只允许一个（安装脚本写自己的 HOME，并行跑会互相踩）

export function installable(id) { return !!(AGENT_BY_ID[id] && AGENT_BY_ID[id].install); }

export async function runAgentInstall(id, { env = process.env, timeoutMs = 0 } = {}) {
  const agent = AGENT_BY_ID[id];
  if (!agent) return { error: '未知 agent：' + id };
  if (!agent.install) return { error: '这个 agent 没有安装命令（自带 / 由部署脚本负责）：' + id };
  if (running) return { error: `已经在装 ${running} 了，等它跑完` };
  running = id;
  // 每家的安装耗时差着量级：codex 一句 curl 就完事，zcode 是整个 monorepo 的构建。
  // 超时按表里的 installTimeoutMs 走（见 config/agents.mjs），调用方传了就用它的。
  const limit = timeoutMs || agent.installTimeoutMs || INSTALL_TIMEOUT_MS;
  console.log(`[agents] 开始安装 ${id}（上限 ${Math.round(limit / 60000)} 分钟）：${agent.install}`);
  const tail = [];
  const eat = (buf) => {
    for (const raw of String(buf).split('\n')) {
      const line = raw.replace(/\s+$/, '');
      if (!line) continue;
      tail.push(line);
      if (tail.length > TAIL_MAX) tail.shift();
      console.log(`[agents:${id}] ${line.slice(0, 400)}`);
    }
  };
  try {
    const r = await new Promise((resolve) => {
      let child;
      try {
        child = spawn('bash', ['-lc', agent.install], {
          env: { ...env, CI: '1', NO_COLOR: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
        });
      } catch (e) { resolve({ error: (e && e.message) || String(e) }); return; }
      child.stdout.setEncoding('utf8'); child.stdout.on('data', eat);
      child.stderr.setEncoding('utf8'); child.stderr.on('data', eat);
      const timer = setTimeout(() => {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
      }, limit);
      child.on('error', (e) => { clearTimeout(timer); resolve({ error: (e && e.message) || String(e) }); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ code: code == null ? -1 : code }); });
    });
    // 装完（退出码非零也）重探一次：装上了是真，没装上界面上讲的也是真话。
    const p = refreshAgentProbes();
    busPublishAll({ type: 'agents.changed' });
    const installed = !!p.installed[id];
    if (r.error) return { error: r.error, installed, log: tail };
    if (!installed && r.code !== 0) {
      return { error: `安装脚本退出码 ${r.code}，${id} 仍然没装上`, installed, code: r.code, log: tail };
    }
    return { ok: true, installed, code: r.code, log: tail };
  } finally {
    running = '';
  }
}
