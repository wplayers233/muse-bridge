// Codex / ZCode 分页的服务面（外部 CLI agent）。
//
//   GET  /api/agents/status     这台机器上每个 agent 装了没 / 认证了没（登录即可看，分页的「接入」卡用）
//   POST /api/codex/chat        { prompt, sessionId? } → SSE（归一事件流；
//                               这一轮是后台轮次：断开不断进程，见 runtime/codex-turns.mjs）
//   POST /api/zcode/chat        同上（zcode 还是老语义：断开即杀，见下）
//   GET  /api/codex/turns       在跑 + 最近完成的轮次（「后台运行中」列表用）
//   GET  /api/codex/turns/attach ?turnId= → SSE（先吐缓冲再转实时，断线重连用）
//   POST /api/codex/turns/stop  { turnId } → 显式停一轮
//   POST /api/codex/cwd         { path } → 改这个 agent 的工作目录（每个软件一间自己的文件夹）
//   POST /api/zcode/cwd         同上
//   GET  /api/codex/models      codex 能用的模型 + 每个模型的可选思考深度（走官方 app-server 的 model/list）
//   POST /api/codex/model       { model?, effort? } → 记住选定的模型 / 思考深度（空 = 交回 CLI 自己的配置）
//   GET  /api/cli/sessions      ?agent= 侧栏会话列表（?messages=1 连快照一起给）
//   GET  /api/cli/sessions/one  ?agent=&id= 取一条完整快照（跨设备点开侧栏某条）
//   POST /api/cli/sessions/save { agent, id?, sessionId, cwd, title?, messages? } → { ok, id }
//   POST /api/cli/sessions/delete { agent, id } → { ok }（幂等）
//   GET  /api/cli/agent-key     ?agent= 我自己的凭据状态（尾 4 位）
//   POST /api/cli/agent-key     { agent, key } → 存 / 清我自己的 key（<dataDir>/agents/）
//   GET  /api/agent/plan        ?agent=codex|zcode → { ok, plan } coding plan 用量/余额（null = 无可显示）
//
// 门禁：requireCtx（admin / user，share 与未登录 401）＋ 该身份的 agent 名单（ctx.allowCodex /
// ctx.allowZcode——全局开关 ∩ 按人授权）。这两个 agent 目前 multiUser:false，所以实际只有管理员过。
// 写操作受 server.mjs 全局 Origin 闸保护（POST 在前台，跨站表单发不进来）。
//
// 一轮对话 = 一个 CLI 子进程。
//   codex：后台轮次——客户端断开只退订，不断进程（跟 Claude 一样）；
//          停一轮要显式调 POST /api/codex/turns/stop，同会话重发会自动顶掉旧的。
//   zcode：保持老语义——客户端断开（req 'close'）立刻 abort，不留孤儿进程。

import { readBody } from '../runtime/body.mjs';
import { requireCtx } from '../runtime/identity.mjs';
import { agentStatusList, findCliBin, refreshAgentProbes } from '../runtime/agent-status.mjs';
import { runCliTurn, CLI_AGENTS, CLI_MISSING_NOTE } from '../runtime/agent-cli.mjs';
import {
  codexCallerKey, startCodexTurn, attachCodexTurn, stopCodexTurn,
  listCodexTurns, findCodexTurn, answerCodexApproval,
} from '../runtime/codex-turns.mjs';
import { cliCwdMap, getCliPrefs, setCliCwd, setCliAgentPrefs } from '../runtime/cli-cwd.mjs';
import { listCliSessions, getCliSession, saveCliSession, deleteCliSession } from '../runtime/cli-sessions.mjs';
import { cliSpawnKeyEnv, cliDataEnv, keyDirFor, setAgentKey, agentKeyState, isKeyAgent } from '../runtime/agent-keys.mjs';
import { codexModels } from '../runtime/agent-models.mjs';
import { codexSkills } from '../runtime/agent-skills-codex.mjs';
import { readInstalledPlugins, scanCatalog, codexMcpList, codexPluginAdd, codexPluginRemove } from '../runtime/agent-plugins-codex.mjs';
import { codexPlan } from '../runtime/agent-plan-codex.mjs';
import { zcodePlan } from '../runtime/agent-plan-zcode.mjs';
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
// 等答案的 promise 现在挂在 turn 上（runtime/codex-turns.mjs 的 turnWaitApproval），
// 不再活在单次请求的作用域里——手机断开回来，卡片照样能点；15 分钟没人点按拒绝收。
//
// 键是 `<turnId>:<app-server 给的序号>`：app-server 内部的序号每进程从 1 开始数，
// 不加轮次前缀会跨轮撞车；现在前缀是稳定的 turnId（原来是单次请求的 turnKey），
// 重连回来点的还是同一张卡。

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

// ── Codex 后台轮次的 chat 入口 ──────────────────────────────────────────────
// 跟原来（zcode 现在还是）的区别只有一点：这一轮的生命周期跟 HTTP 请求解绑。
// res 断开只退订，不断进程；turn 在后台继续跑，回来调 /api/codex/turns/attach 接上。
// 选路（app-server / exec 回落）、审批等待、事件缓冲全在 runtime/codex-turns.mjs 里。
async function codexChatHandler(req, res, ctx, { prompt, sessionId, images, prefs, cwd, plan }) {
  // env/keyEnv：每身份注入——user 用自己的 key（<dataDir>/agents）+ 自己的 CLI 数据目录
  // （CODEX_HOME，见 runtime/agent-keys.mjs）；admin 不设目录 = 继承宿主。
  const spawnEnv = { ...process.env, ...cliDataEnv(ctx) };
  const keyEnv = cliSpawnKeyEnv(ctx, 'codex');
  const r = await startCodexTurn({
    key: codexCallerKey(ctx), dataDir: ctx.dataDir, prompt, sessionId, images, cwd,
    model: prefs.model, effort: prefs.effort, env: spawnEnv, keyEnv, plan: plan === true,
  });
  if (!r.ok) return json(res, 409, { error: r.error });
  // 挂上 SSE：先 replay 已缓冲的，再转实时。断开只退订（attachCodexTurn 内部处理），
  // 不杀 turn——这就是跟原来不一样的地方。
  await attachCodexTurn(r.turn, res);
}

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
    // user 的凭据是各人自己的（key 在 <dataDir>/agents，codex 登录态在 <dataDir>/cli/codex），
    // 状态要按身份探：传 env + keyDir 让 codexAuthed / agentKeyState 看各自的那份（不走全局缓存）。
    const isUser = ctx.kind === 'user';
    const perIdentity = isUser ? { env: { ...process.env, ...cliDataEnv(ctx) }, keyDir: keyDirFor(ctx) } : {};
    const list = agentStatusList(perIdentity).map((a) => ({
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
    // user 的 zcode 登录是运营操作（网页上点不了，官方浏览器授权要在服务器上跑）：
    // 没登录时把「管理员怎么给你开」写进提示，别让人对着「还没配认证」发呆。
    if (isUser) {
      for (const a of list) {
        if (a.id === 'zcode' && !a.authed && a.installed) {
          a.note = '还没登录：让管理员在这台服务器上跑一次 `ZCODE_DATA_BASE_DIR='
            + path.join(ctx.dataDir, 'cli') + ' zcode login`（浏览器授权，逐用户一次）';
        }
      }
    }
    json(res, 200, { ok: true, agents: list });
  });

  // coding plan 用量/余额（账户菜单里的那一行）。按身份探：user 的凭据/登录态在各人自己的
  // 目录里（cliDataEnv / cliSpawnKeyEnv 与 /api/agents/status 同一套口径），admin 走宿主。
  // plan=null 表示「没有可显示的」（没装 / API-key 模式 / zcode 没登录或接口不合）——前端整行隐藏，
  // 这不是错误，所以不落 4xx。探测自带长缓存（成功 5 分钟 / 失败 60 秒），?force=1 现探。
  router.on('GET', '/api/agent/plan', async (req, res) => {
    const ctx = requireCtx(identify, req, res);
    if (!ctx) return;
    let agent = '';
    let force = false;
    try {
      const u = new URL(req.url, 'http://x');
      agent = String(u.searchParams.get('agent') || '');
      force = u.searchParams.get('force') === '1';
    } catch {}
    if (agent !== 'codex' && agent !== 'zcode') return json(res, 400, { error: 'agent 只认 codex / zcode' });
    if (!allow(ctx, agent)) return json(res, 403, { error: `${agent} 未启用，或你的账号没有使用权限` });
    const env = { ...process.env, ...cliDataEnv(ctx), ...cliSpawnKeyEnv(ctx, agent) };
    let plan = null;
    try {
      plan = agent === 'codex' ? await codexPlan({ env, force }) : await zcodePlan({ env, force });
    } catch { plan = null; }
    json(res, 200, { ok: true, plan });
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
      // 图片附件：codex 官方能力（exec 路 -i / app-server 路 localImage，见 runtime/agent-appserver.mjs）。
      let images = [];
      if (Array.isArray(body.images) && body.images.length) {
        if (agent !== 'codex') return json(res, 400, { error: '这个 agent 暂不支持图片附件' });
        try { images = await saveImages(cwd, body.images); }
        catch (e) { return json(res, (e && e.status) || 500, { error: (e && e.message) || String(e) }); }
      }
      // Codex 走后台轮次（runtime/codex-turns.mjs）：这一轮的生命周期跟 HTTP 请求解绑，
      // 客户端断开只退订、不杀进程，回来调 /api/codex/turns/attach 接上。
      // zcode 保持原样：断开即杀（下面那套）。
      if (agent === 'codex') {
        // 计划模式是单条消息的开关（前端输入框的「计划模式」胶囊），不进 prefs 存量：
        // 只给这一条用，下一条默认回普通模式。
        return codexChatHandler(req, res, ctx, { prompt, sessionId, images, prefs, cwd, plan: body.plan === true });
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
      try {
        // env/keyEnv：每身份注入——user 用自己的 key（<dataDir>/agents）+ 自己的 CLI 数据目录
        // （CODEX_HOME / ZCODE_DATA_BASE_DIR，见 runtime/agent-keys.mjs）；admin 不设目录 = 继承宿主。
        const spawnEnv = { ...process.env, ...cliDataEnv(ctx) };
        const keyEnv = cliSpawnKeyEnv(ctx, agent);
        const stream = runCliTurn(agent, { prompt, sessionId, cwd, model: prefs.model, effort: prefs.effort, images, signal: ac.signal, env: spawnEnv, keyEnv });
        for await (const ev of stream) {
          if (gone) break;
          sseSend(res, ev);
        }
      } catch (e) {
        sseSend(res, { type: 'error', message: (e && e.message) || String(e) });
      } finally {
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

  // 回答一张审批卡。id 是 SSE 里 approval 事件的 id（形如 <turnId>:<序号>，
  // turnId 跟着 turn 走，重连回来点的还是同一张卡）；
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
    const r = answerCodexApproval(codexCallerKey(ctx), id, decision);
    if (!r.ok) return json(res, 404, { error: r.error });
    json(res, 200, { ok: true });
  });

  // ── Codex 后台轮次：列表 / 重连 / 停止 ─────────────────────────────────────
  // 在跑 + 最近完成的轮次（「后台运行中」列表用；轻量，不含事件体）。
  router.on('GET', '/api/codex/turns', (req, res) => {
    const ctx = requireCtx(identify, req, res);
    if (!ctx) return;
    if (!allow(ctx, 'codex')) return json(res, 403, { error: 'codex 未启用，或你的账号没有使用权限' });
    json(res, 200, { ok: true, turns: listCodexTurns(codexCallerKey(ctx)) });
  });

  // 断线重连：先吐这一轮缓冲里的事件，再转实时订阅。turn 已经结束时直接吐完收尾。
  router.on('GET', '/api/codex/turns/attach', async (req, res) => {
    const ctx = requireCtx(identify, req, res);
    if (!ctx) return;
    if (!allow(ctx, 'codex')) return json(res, 403, { error: 'codex 未启用，或你的账号没有使用权限' });
    let turnId = '';
    try { turnId = new URL(req.url, 'http://x').searchParams.get('turnId') || ''; } catch {}
    const turn = findCodexTurn(codexCallerKey(ctx), turnId);
    if (!turn) return json(res, 404, { error: '找不到这一轮（可能已经结束了很久）' });
    await attachCodexTurn(turn, res);
  });

  // 显式停一轮（前端「停止」按钮 / 同会话顶掉 / 并发上限走同一条）。
  router.on('POST', '/api/codex/turns/stop', async (req, res) => {
    const ctx = requireCtx(identify, req, res);
    if (!ctx) return;
    if (!allow(ctx, 'codex')) return json(res, 403, { error: 'codex 未启用，或你的账号没有使用权限' });
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    const r = stopCodexTurn(codexCallerKey(ctx), String(body.turnId || ''));
    if (!r.ok) return json(res, 404, { error: r.error });
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
    // 并集持久化在 <dataDir>/codex-models-union.json：上游 model/list 按灰度桶下发（实测会从
    // 8 个翻到 3 个），见过的模型做并集，翻回精简桶时界面不再丢模型（-m 接受任意 id，选了就能用）。
    const models = await codexModels({
      force,
      store: { path: path.join(ctx.dataDir || '.', 'codex-models-union.json') },
    });
    json(res, 200, { ok: true, models });
  });

  // Codex 技能清单（官方 app-server 的 skills/list，只读；「自定义」页「技能」页签的数据面）。
  // 失败回 skills: null（调用方隐藏技能区），成功回数组（可为空 = 真没技能）。
  router.on('GET', '/api/codex/skills', async (req, res) => {
    const ctx = requireCtx(identify, req, res);
    if (!ctx) return;
    if (!allow(ctx, 'codex')) return json(res, 403, { error: 'codex 未启用，或你的账号没有使用权限' });
    let force = false;
    try { force = new URL(req.url, 'http://x').searchParams.get('refresh') === '1'; } catch {}
    const env = { ...process.env, ...cliDataEnv(ctx), ...cliSpawnKeyEnv(ctx, 'codex') };
    const skills = await codexSkills({ env, cwd: getCliPrefs(ctx, 'codex').cwd, force });
    json(res, 200, { ok: true, skills });
  });

  // —— Codex 插件 / 连接器（官方 PC 端 `codex plugin` / `codex mcp` 的桥接，「自定义」页数据面）——
  router.on('GET', '/api/codex/plugins', async (req, res) => {
    const ctx = requireCtx(identify, req, res);
    if (!ctx) return;
    if (!allow(ctx, 'codex')) return json(res, 403, { error: 'codex 未启用，或你的账号没有使用权限' });
    const env = { ...process.env, ...cliDataEnv(ctx), ...cliSpawnKeyEnv(ctx, 'codex') };
    const [installed, catalog, mcp] = await Promise.all([
      Promise.resolve(readInstalledPlugins(env)),
      Promise.resolve(scanCatalog(env)),
      codexMcpList({ env }),
    ]);
    json(res, 200, { ok: true, installed, catalog, mcp });
  });

  router.on('POST', '/api/codex/plugins/add', async (req, res) => {
    const ctx = requireCtx(identify, req, res);
    if (!ctx) return;
    if (!allow(ctx, 'codex')) return json(res, 403, { error: 'codex 未启用，或你的账号没有使用权限' });
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    const selector = String(body?.selector || '');
    if (!selector) return json(res, 400, { error: '需要 selector（PLUGIN@MARKETPLACE）' });
    const env = { ...process.env, ...cliDataEnv(ctx), ...cliSpawnKeyEnv(ctx, 'codex') };
    const r = await codexPluginAdd({ env, selector });
    json(res, r.ok ? 200 : 500, r.ok ? { ok: true } : { error: r.error || '安装失败' });
  });

  router.on('POST', '/api/codex/plugins/remove', async (req, res) => {
    const ctx = requireCtx(identify, req, res);
    if (!ctx) return;
    if (!allow(ctx, 'codex')) return json(res, 403, { error: 'codex 未启用，或你的账号没有使用权限' });
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    const selector = String(body?.selector || '');
    if (!selector) return json(res, 400, { error: '需要 selector（PLUGIN@MARKETPLACE）' });
    const env = { ...process.env, ...cliDataEnv(ctx), ...cliSpawnKeyEnv(ctx, 'codex') };
    const r = await codexPluginRemove({ env, selector });
    json(res, r.ok ? 200 : 500, r.ok ? { ok: true } : { error: r.error || '移除失败' });
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

  // ── 会话注册表（跨设备同步侧栏与续聊凭据；存储见 runtime/cli-sessions.mjs） ──────
  const agentOf = (req) => {
    try { return new URL(req.url, 'http://x').searchParams.get('agent') || ''; }
    catch { return ''; }
  };

  // 侧栏列表（默认只给元数据；?messages=1 连快照一起给——换设备冷启动一次拉全）。
  router.on('GET', '/api/cli/sessions', (req, res) => {
    const ctx = requireCtx(identify, req, res);
    if (!ctx) return;
    const agent = agentOf(req);
    if (!CLI_AGENTS.includes(agent)) return json(res, 400, { error: '未知 agent' });
    if (!allow(ctx, agent)) return json(res, 403, { error: `${agent} 未启用，或你的账号没有使用权限` });
    let withMessages = false;
    try { withMessages = new URL(req.url, 'http://x').searchParams.get('messages') === '1'; } catch {}
    try { json(res, 200, { ok: true, sessions: listCliSessions(ctx, agent, { withMessages }) }); }
    catch (e) { json(res, (e && e.status) || 500, { error: (e && e.message) || String(e) }); }
  });

  // 取一条完整快照（另一台设备点开侧栏某条时用；列表接口不带正文，省带宽）。
  router.on('GET', '/api/cli/sessions/one', (req, res) => {
    const ctx = requireCtx(identify, req, res);
    if (!ctx) return;
    const agent = agentOf(req);
    if (!CLI_AGENTS.includes(agent)) return json(res, 400, { error: '未知 agent' });
    if (!allow(ctx, agent)) return json(res, 403, { error: `${agent} 未启用，或你的账号没有使用权限` });
    let id = '';
    try { id = new URL(req.url, 'http://x').searchParams.get('id') || ''; } catch {}
    const rec = getCliSession(ctx, agent, id);
    if (!rec) return json(res, 404, { error: '这条会话不存在（可能已在别的设备上删除）' });
    json(res, 200, { ok: true, session: rec });
  });

  // 新增 / 更新一条快照（前端每轮收尾防抖上传；id 不给就由服务端生成）。
  router.on('POST', '/api/cli/sessions/save', async (req, res) => {
    const ctx = requireCtx(identify, req, res);
    if (!ctx) return;
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    const agent = String(body.agent || '');
    if (!CLI_AGENTS.includes(agent)) return json(res, 400, { error: '未知 agent' });
    if (!allow(ctx, agent)) return json(res, 403, { error: `${agent} 未启用，或你的账号没有使用权限` });
    try {
      const id = saveCliSession(ctx, agent, body);
      json(res, 200, { ok: true, id });
    } catch (e) {
      json(res, (e && e.status) || 500, { error: (e && e.message) || String(e) });
    }
  });

  // 删一条（幂等：不存在也算成功）。
  router.on('POST', '/api/cli/sessions/delete', async (req, res) => {
    const ctx = requireCtx(identify, req, res);
    if (!ctx) return;
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    const agent = String(body.agent || '');
    if (!CLI_AGENTS.includes(agent)) return json(res, 400, { error: '未知 agent' });
    if (!allow(ctx, agent)) return json(res, 403, { error: `${agent} 未启用，或你的账号没有使用权限` });
    try {
      deleteCliSession(ctx, agent, body.id);
      json(res, 200, { ok: true });
    } catch (e) {
      json(res, (e && e.status) || 500, { error: (e && e.message) || String(e) });
    }
  });

  // ── 注册用户自己的 key（<dataDir>/agents/，与 admin 的全局那份分开存） ─────────
  // admin 的 dataDir 就是 ROOT，所以他在「设置 → Agent」里存的那把天然落在全局目录、
  // 行为与从前完全一样；用户在这里填的是自己的（各人各一把，互不可见）。
  // 只有 codex 有 key 口子（zcode 只认官方登录，见 runtime/agent-keys.mjs 的说明）。
  router.on('GET', '/api/cli/agent-key', (req, res) => {
    const ctx = requireCtx(identify, req, res);
    if (!ctx) return;
    const agent = agentOf(req);
    if (!CLI_AGENTS.includes(agent)) return json(res, 400, { error: '未知 agent' });
    if (!allow(ctx, agent)) return json(res, 403, { error: `${agent} 未启用，或你的账号没有使用权限` });
    if (!isKeyAgent(agent)) return json(res, 200, { ok: true, has: false, note: '这个 agent 不用填 key（走官方登录）' });
    const st = agentKeyState(agent, process.env, keyDirFor(ctx));
    json(res, 200, { ok: true, id: st.id, has: st.has, source: st.source, keyTail: st.tail, keyEnv: st.env });
  });

  router.on('POST', '/api/cli/agent-key', async (req, res) => {
    const ctx = requireCtx(identify, req, res);
    if (!ctx) return;
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    const agent = String(body.agent || '');
    if (!CLI_AGENTS.includes(agent)) return json(res, 400, { error: '未知 agent' });
    if (!allow(ctx, agent)) return json(res, 403, { error: `${agent} 未启用，或你的账号没有使用权限` });
    const r = setAgentKey(agent, body.key, keyDirFor(ctx));
    if (r.error) return json(res, 400, { error: r.error });
    refreshAgentProbes();                     // 存完立刻重探（接入卡当场变绿）
    console.log(`[agents] ${ctx.kind === 'user' ? ctx.user : 'admin'} 的 ${r.id} 凭据${r.has ? '已保存' : '已清除'}（尾 ${r.tail || '—'}）`);
    json(res, 200, { ok: true, has: r.has, keyTail: r.tail });
  });
}
