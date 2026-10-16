// 账户菜单的 coding plan 余额（按所在页显示对应那家）。
//
// 数据源：GET /api/agent/plan?agent=codex|zcode（服务端 runtime/agent-plan-*.mjs，自带
// 成功 5 分钟 / 失败 60 秒的缓存）。plan=null = 没有可显示的（没登录 / API-key 模式 /
// 上游不合）——这里照样存 null，菜单据此整行隐藏，宁可不见也不摆错的。
//
// 多个 portal 实例（中屏同一页渲染两份侧栏）会同时打开菜单：inflight 去重只发一次；
// 前端再叠一层 5 分钟 TTL，翻菜单不刷屏。
import { apiUrl } from './server.js';
import { authHeaders } from './api.js';

export const agentPlan = $state({ codex: null, zcode: null });

const TTL_MS = 5 * 60_000;
const at = { codex: 0, zcode: 0 };
const inflight = {};

export async function loadAgentPlan(agent, force = false) {
  if (agent !== 'codex' && agent !== 'zcode') return null;
  if (!force && agentPlan[agent] && Date.now() - at[agent] < TTL_MS) return agentPlan[agent];
  if (inflight[agent]) return inflight[agent];
  inflight[agent] = (async () => {
    try {
      // force = 连服务端缓存一起绕过（服务端 /api/agent/plan 自带 5 分钟缓存）：
      // 额度/账户变化事件（P4 的 ratelimits/account）要的是真正实时，不是缓存值。
      const r = await fetch(apiUrl('/api/agent/plan?agent=' + agent + (force ? '&force=1' : '')), { headers: authHeaders(), credentials: 'same-origin' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      agentPlan[agent] = j?.plan || null;
    } catch {
      agentPlan[agent] = null;   // 失败 = 不显示，而不是显示旧的
    } finally {
      at[agent] = Date.now();
      delete inflight[agent];
    }
    return agentPlan[agent];
  })();
  return inflight[agent];
}
