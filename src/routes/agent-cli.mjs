// Codex / ZCode 分页的服务面（外部 CLI agent）。
//
//   GET  /api/agents/status     这台机器上每个 agent 装了没 / 认证了没（登录即可看，分页的「接入」卡用）
//   POST /api/codex/chat        { prompt, sessionId? } → SSE（归一事件流，见 runtime/agent-cli.mjs）
//   POST /api/zcode/chat        同上
//   POST /api/codex/cwd         { path } → 改这个 agent 的工作目录（每个软件一间自己的文件夹）
//   POST /api/zcode/cwd         同上
//   GET  /api/codex/models      codex 能用的模型 + 每个模型的可选思考深度（走官方 app-server 的 model/list）
//   POST /api/codex/model       { model?, effort? } → 记住选定的模型 / 思考深度（空 = 交回 CLI 自己的配置）
//
// 门禁：requireCtx（admin / user，share 与未登录 401）＋ 该身份的 agent 名单（ctx.allowCodex /
// ctx.allowZcode——全局开关 ∩ 按人授权）。这两个 agent 目前 multiUser:false，所以实际只有管理员过。
// 写操作受 server.mjs 全局 Origin 闸保护（POST 在前台，跨站表单发不进来）。
//
// 一轮对话 = 一个 CLI 子进程；客户端断开（req 'close'）立刻 abort，不留孤儿进程。

import { readBody } from '../runtime/body.mjs';
import { requireCtx } from '../runtime/identity.mjs';
import { agentStatusList, findCliBin, refreshAgentProbes } from '../runtime/agent-status.mjs';
import { CLI_AGENTS, CLI_MISSING_NOTE, runCliTurn } from '../runtime/agent-cli.mjs';
import { runAppServerTurn, appServerAvailable } from '../runtime/agent-appserver.mjs';
import { cliCwdMap, getCliPrefs, setCliCwd, setCliAgentPrefs } from '../runtime/cli-cwd.mjs';
import { codexModels } from '../runtime/agent-models.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// 图片附件（codex：官方 exec 的 -i/--image 同款能力）。客户端传来 base64 裸数据，
// 落到工作目录的 .bridge-uploads/ 下再交路径给 CLI。限 6 张、单张解码后 ≤ 10MB。
const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
async function saveImages(cwd, images) {
  const list = Array.isArray(images) ? images.slice(0, MAX_IMAGES) : [];
  if (!list.length) return [];
  const dir = path.join(cwd, '.bridge-uploads');
  await mkdir(dir, { recursive: true });
  const stamp = Date.now().toString(36);
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const raw = String(list[i]?.data || '');
    if (!raw) continue;
    if (raw.length > (MAX_IMAGE_BYTES / 3) * 4) throw Object.assign(new Error('图片太大（单张限 10MB）'), { status: 413 });
    const name = String(list[i]?.name || 'image.png').replace(/[\\/:*?"<>|]/g, '_').slice(-80) || 'image.png';
    const file = path.join(dir, `${stamp}-${i}-${name}`);
    await writeFile(file, Buffer.from(raw, 'base64'));
    out.push(file);
  }
  return out;
}

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };

// ── 审批的往返 ───────────────────────────────────────────────────────────────
// app-server 会反过来问客户端「这条命令能不能跑」，而我们的界面在浏览器里。
// 于是：这一轮跑着的 generator 拿着一个 promise 等，卡片经 SSE 推给界面，
// 用户点按钮 POST 回来，这里 resolve —— 答案才回到 CLI。
//
// 键是 `<这一轮>:<app-server 给的序号>`：app-server 内部的序号每进程从 1 开始数，
// 不加轮次前缀会跨轮撞车。
const pendingApprovals = new Map();     // key -> resolve({decision})
const APPROVAL_WAIT_MS = 5 * 60_000;    // 没人答就按拒绝收（别让 CLI 一直挂着）

// 上游只认这几个决策（见 CommandExecutionRequestApprovalResponse 的枚举）。
// 界面按 availableDecisions 摆按钮，但落库前一律过这道白名单——别让前端随手传个字符串
// 就把任意东西转给 CLI。
const APPROVAL_DECISIONS = new Set(['accept', 'acceptForSession', 'decline', 'cancel']);
export function normApprovalDecision(raw) {
  if (typeof raw === 'string' && APPROVAL_DECISIONS.has(raw)) return raw;
  // 「按此规则放行」那种对象形式：只认这一个键，内容原样带（上游自己定的 execpolicy 形状）。
  if (raw && typeof raw === 'object' && raw.acceptWithExecpolicyAmendment
    && Array.isArray(raw.acceptWithExecpolicyAmendment.execpolicy_amendment)) {
    return { acceptWithExecpolicyAmendment: { execpolicy_amendment: raw.acceptWithExecpolicyAmendment.execpolicy_amendment.map((x) => String(x)) } };
  }
  return null;
}

function waitForApproval(turnKey, approvalId) {
  const key = turnKey + ':' + approvalId;
  return new Promise((resolve) => {
    pendingApprovals.set(key, resolve);
    const t = setTimeout(() => {
      if (pendingApprovals.has(key)) { pendingApprovals.delete(key); resolve({ decision: 'decline' }); }
    }, APPROVAL_WAIT_MS);
    t.unref?.();
  });
}

// 归一事件 → SSE 行。
const sseOpen = (res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
};
const sseSend = (res, ev) => { try { res.write('data: ' + JSON.stringify(ev) + '\n\n'); } catch {} };

export function registerAgentCliRoutes(router, { identify }) {
  const allow = (ctx, agent) => (agent === 'codex' ? ctx.allowCodex : ctx.allowZcode);

  // 分页与设置页共用的状态：只讲「装了没 / 认证了没」，不含任何令牌内容。
  // ?refresh=1 = 分页里的「重新检测」：丢掉 20 秒探测缓存，现探一次（刚装好 / 刚登录完立刻可见）。
  router.on('GET', '/api/agents/status', (req, res) => {
    const ctx = requireCtx(identify, req, res);
    if (!ctx) return;
    let refresh = false;
    try { refresh = new URL(req.url, 'http://x').searchParams.get('refresh') === '1'; } catch {}
    if (refresh) refreshAgentProbes();
    const cwds = cliCwdMap(ctx);
    const list = agentStatusList().map((a) => ({
      id: a.id, label: a.label, installed: a.installed, authed: a.authed, enabled: a.enabled,
      allowed: a.id === 'claude' ? ctx.allowClaude : a.id === 'dimensio' ? ctx.allowDimensio : allow(ctx, a.id),
      note: a.note,
      // 外部 CLI 的凭据面与安装信息：分页的「接入」卡据此把「怎么认证」「装在哪」讲清楚。
      // codex 有 keyEnv（可填 key）；zcode 只有 login（官方浏览器登录）。keyTail 只有尾 4 位。
      keyEnv: a.keyEnv, keySource: a.keySource, keyTail: a.keyTail, hasKey: a.hasKey,
      login: a.login, install: a.install, docs: a.docs,
      // 这个 agent 现在在哪个目录里干活（每家一间自己的文件夹，可在分页里换）。
      // 放在状态里：抽屉一打开就要显示，不能等聊过一轮（那才有 meta 事件）。
      cwd: cwds[a.id] || '',
      // codex 的模型 / 思考深度（分页里的选择器读它；空 = 用 CLI 自己的配置）。
      model: a.id === 'codex' ? getCliPrefs(ctx, 'codex').model : '',
      effort: a.id === 'codex' ? getCliPrefs(ctx, 'codex').effort : '',
    }));
    json(res, 200, { ok: true, agents: list });
  });

  for (const agent of CLI_AGENTS) {
    router.on('POST', `/api/${agent}/chat`, async (req, res) => {
      const ctx = requireCtx(identify, req, res);
      if (!ctx) return;
      if (!allow(ctx, agent)) {
        json(res, 403, { error: `${agent} 未启用，或你的账号没有使用权限` });
        return;
      }
      let body = {};
      try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
      const prompt = String(body.prompt || '').slice(0, 100_000);
      if (!prompt.trim()) return json(res, 400, { error: '没写要问什么' });
      const sessionId = String(body.sessionId || '').slice(0, 200);
      if (!findCliBin(agent)) return json(res, 409, { error: CLI_MISSING_NOTE[agent] });

      // cwd：这个 agent 自己的工作目录（每家在身份工作空间里有一间自己的文件夹，
      // 可在分页的「工作目录」里换；见 runtime/cli-cwd.mjs）。
      // model / effort：codex 的模型与思考深度（分页的选择器里选的；zcode 没有这两个参数）。
      const prefs = getCliPrefs(ctx, agent);
      const cwd = prefs.cwd;
      // 图片附件：codex 走官方 -i；有图时强制走 exec 路（app-server 这条传输还不收附件）。
      let images = [];
      if (Array.isArray(body.images) && body.images.length) {
        if (agent !== 'codex') return json(res, 400, { error: '这个 agent 暂不支持图片附件' });
        try { images = await saveImages(cwd, body.images); }
        catch (e) { return json(res, (e && e.status) || 500, { error: (e && e.message) || String(e) }); }
      }
      const ac = new AbortController();
      let gone = false;
      // 客户端断开 → 立刻 abort（generator 那边按进程组杀 CLI 的整棵树）。
      // 判据用 res 的 close 而不是 req 的：req 的 close 在【请求体读完】就发了，而我们在读体
      // 之后才挂监听——那一刻早过了，压根收不到（实测客户端断了 CLI 还挂着）。res 的 close
      // 才是「响应提前断了」（同 harness.mjs 里 upstream.destroy 的 `!writableFinished` 判据）。
      res.on('close', () => { if (!res.writableFinished && !gone) { gone = true; ac.abort(); } });

      sseOpen(res);
      sseSend(res, { type: 'meta', agent, cwd, sessionId });
      // 这一轮的审批等待者（用户点卡片时 POST 回来 resolve；见 /api/codex/approval）。
      const turnKey = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      try {
        // codex 有 app-server 就走新路：审批、会话托管、流式正文全在里面（见 runtime/agent-appserver.mjs）。
        // 老版本没有这个子命令就回落 exec（老路还能用，只是没有审批卡）。带图片时走 exec（-i 是它的原生参数）。
        const useAppServer = agent === 'codex' && !images.length && await appServerAvailable();
        const stream = useAppServer
          ? runAppServerTurn(agent, {
            prompt, threadId: sessionId, cwd, model: prefs.model, effort: prefs.effort, signal: ac.signal,
            onServerRequest: (method, params, approvalId) => waitForApproval(turnKey, approvalId),
          })
          : runCliTurn(agent, { prompt, sessionId, cwd, model: prefs.model, effort: prefs.effort, images, signal: ac.signal });
        for await (const ev of stream) {
          if (gone) break;
          // 审批卡的 id 加上这一轮的前缀：同名 id 在不同轮之间不会撞（app-server 内部从 1 开始数）。
          if (ev.type === 'approval') ev.id = turnKey + ':' + ev.id;
          sseSend(res, ev);
        }
      } catch (e) {
        sseSend(res, { type: 'error', message: (e && e.message) || String(e) });
      } finally {
        // 这一轮结束（或客户端断了）：还挂着的审批一律按「拒绝」收掉，别把 promise 留在表里。
        for (const [k, r] of pendingApprovals) {
          if (k.startsWith(turnKey + ':')) { pendingApprovals.delete(k); r({ decision: 'decline' }); }
        }
        try { res.end(); } catch {}
      }
    });

    // 换这个 agent 的工作目录。授权尺与 Claude 新建项目完全同一把（authorizeProjectPath：
    // admin 任意本地目录、Pro 限自己空间内），所以换个 agent 不会变宽能选的范围。
    router.on('POST', `/api/${agent}/cwd`, async (req, res) => {
      const ctx = requireCtx(identify, req, res);
      if (!ctx) return;
      if (!allow(ctx, agent)) {
        json(res, 403, { error: `${agent} 未启用，或你的账号没有使用权限` });
        return;
      }
      let body = {};
      try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
      try {
        json(res, 200, { ok: true, cwd: setCliCwd(ctx, agent, body && body.path) });
      } catch (e) {
        json(res, (e && e.status) || 500, { error: (e && e.message) || String(e) });
      }
    });
  }

  // 回答一张审批卡。id 是 SSE 里 approval 事件的 id（形如 <这一轮>:<序号>）；
  // decision 是上游枚举里的一个（accept / acceptForSession / decline / cancel），
  // 或 {acceptWithExecpolicyAmendment:{…}}。找不到那一条就回 404（多半是这一轮已经收尾了）。
  router.on('POST', '/api/codex/approval', async (req, res) => {
    const ctx = requireCtx(identify, req, res);
    if (!ctx) return;
    if (!allow(ctx, 'codex')) return json(res, 403, { error: 'codex 未启用，或你的账号没有使用权限' });
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    const id = String(body.id || '');
    const decision = normApprovalDecision(body.decision);
    if (!id) return json(res, 400, { error: '缺 id' });
    if (!decision) return json(res, 400, { error: '这个决定上游不认' });
    const resolve = pendingApprovals.get(id);
    if (!resolve) return json(res, 404, { error: '这张卡已经过期了（这一轮结束了，或等太久超时了）' });
    pendingApprovals.delete(id);
    resolve({ decision });
    json(res, 200, { ok: true });
  });

  // codex 能用的模型 + 每个模型的可选思考深度。官方桌面应用那个模型下拉框就是这条数据。
  // 读它不需要登录（未认证时上游照样给完整列表），所以没配 key 的机器上也看得见要选什么。
  router.on('GET', '/api/codex/models', async (req, res) => {
    const ctx = requireCtx(identify, req, res);
    if (!ctx) return;
    if (!allow(ctx, 'codex')) return json(res, 403, { error: 'codex 未启用，或你的账号没有使用权限' });
    let force = false;
    try { force = new URL(req.url, 'http://x').searchParams.get('refresh') === '1'; } catch {}
    // 拿不到就回空清单：界面据此不摆选择器（而不是摆一个空的下拉框），仍然可用 CLI 自己的配置。
    const models = await codexModels({ force });
    json(res, 200, { ok: true, models });
  });

  // 记住选定的模型 / 思考深度。传空串 = 清掉，交回 CLI 自己的配置（~/.codex/config.toml）。
  router.on('POST', '/api/codex/model', async (req, res) => {
    const ctx = requireCtx(identify, req, res);
    if (!ctx) return;
    if (!allow(ctx, 'codex')) return json(res, 403, { error: 'codex 未启用，或你的账号没有使用权限' });
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    try {
      const prefs = setCliAgentPrefs(ctx, 'codex', { model: body && body.model, effort: body && body.effort });
      json(res, 200, { ok: true, model: prefs.model, effort: prefs.effort });
    } catch (e) {
      json(res, (e && e.status) || 500, { error: (e && e.message) || String(e) });
    }
  });
}
