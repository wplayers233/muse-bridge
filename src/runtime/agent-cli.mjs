// 外部 CLI agent（codex / zcode）的适配层。
//
// 这两家的分页（web/src/components/CodexPage.svelte、ZcodePage.svelte）共用一套渲染逻辑，
// 靠的就是这里把两家 CLI 各自的 JSONL 事件【归一】成同一套小事件：
//
//   { type:'start',    agent, sessionId }        这一轮开始（会话 id 可能已知、也可能是新建后再报）
//   { type:'session',  sessionId }               会话 id（续聊要带回去）
//   { type:'text',     text }                    助手正文（增量，按到达顺序追加）
//   { type:'reasoning',text }                    思考/推理片段（各家叫法不同）
//   { type:'tool',     name, status, summary }   工具/命令活动（status ∈ started|updated|completed）
//   { type:'notice',   text }                    提示（无害）
//   { type:'error',    message }                 失败
//   { type:'done',     sessionId, usage? }       这一轮收尾
//
// 事实来源（只读官方仓库，别照抄第三方转述）：
//   codex  openai/codex · codex-rs/exec + sdk/typescript/src/events.ts：
//          `codex exec --json` 逐行 JSONL —— thread.started{thread_id} / turn.started /
//          item.started|updated|completed{item} / turn.completed{usage} / turn.failed{error.message}；
//          item.type ∈ agent_message{text} / reasoning{text} / command_execution{command,aggregated_output,status}
//          / file_change{changes,status} / mcp_tool_call{server,tool,status} / web_search{query} / todo_list / error。
//          续聊：`codex exec resume <session_id> "…"`（新会话 id 由 thread.started 报出）。
//   zcode  zai-org/ZCode · apps/zcode-cli/docs/design/v2/commands.md（官方 CLI 设计文档）：
//          全局 `--prompt <text>` = 脚本友好的单轮 headless 入口（未显式给 --mode 时以 yolo 权限档建
//          runtime，会真写文件、跑命令）；`--cwd <path>` 定工作目录；`--resume <sessionId>` 续会话。
//          【注意】官方没有公开「headless 输出的 JSON 契约」（文档里只写了 --prompt 这个入口，
//          没列输出格式；仓库里也搜不到 output-format/stream-json 这类参数）——
//          所以这一侧特意写得宽容：JSON 行按下面这套解，纯文本行就当正文收（见 parseLine）。
//
// 解析函数是纯函数（可单测）；跑进程的部分只负责拼命令行、按行切分、把子进程生命期绑在请求上。

import { spawn } from 'node:child_process';
import { findCliBin } from './agent-status.mjs';
import { cliKeyEnv } from './agent-keys.mjs';

export const CLI_AGENTS = Object.freeze(['codex', 'zcode']);

// 缺 CLI 时给用户的话（分页直接显示；安装命令照官方 README）。
export const CLI_MISSING_NOTE = {
  codex: '这台机器上还没装 Codex CLI。bridge 自带一份（装依赖时 npm install 就装上 @openai/codex）；'
    + '也可以单独装：curl -fsSL https://chatgpt.com/codex/install.sh | sh，然后跑一次 codex login。',
  zcode: '这台机器上还没装 zcode。官方只发 macOS / Windows 安装包，Linux 上要照官方仓库自己构建：'
    + 'bash scripts/server/install-zcode.sh（clone → pnpm install → pnpm build:zcode → 装到 ~/.zcode/runtime，'
    + '并在 ~/.local/bin 建好 zcode 命令），最后跑一次 zcode login bigmodel（智谱国内版）'
    + '或 zcode login zai（Z.ai 国际版）。它不认厂商 API key，登录用的是浏览器授权。',
};

// 命令行拼装（纯函数，可单测）。sessionId 非空 = 续聊。
//
// codex 的权限档（官方 docs/noninteractive：默认是【只读】沙箱）：
//   这一页是「在自己的工作目录里干活」的工作台，跟 Claude 页同级的信任（Claude 页也是直接读写、
//   不逐条问批准），所以要显式给 workspace-write。写法用 `-c sandbox_mode="workspace-write"`
//   而不是 `--sandbox`：`codex exec resume` 那条子命令不接受 `--sandbox`（0.15x 起实测如此，
//   官方 issue 里也有同样报告），而配置覆盖 exec / resume 都认——同一条参数两种入口都可靠。
//   放开工作目录里的读写，但仍不下探到工作目录之外、也不放开网络（要更宽得自己改成
//   danger-full-access）。
export function buildArgs(agent, { prompt, sessionId = '', cwd = '', model = '', effort = '', images = [] } = {}) {
  if (agent === 'codex') {
    // 共享选项要写在 exec 的子命令（resume）之前 —— clap 的父级参数只在子命令名之前生效。
    const args = ['exec', '--json', '-c', 'sandbox_mode="workspace-write"', '--skip-git-repo-check'];
    // 图片附件（PC 端 -i/--image 的同款能力，官方 exec 原生参数）：写在子命令之前。
    if (Array.isArray(images) && images.length) for (const p of images) args.push('-i', String(p));
    // 模型 / 思考深度：用户在分页里选的那一份（存 runtime/cli-cwd.mjs，空 = 交回 CLI 自己的配置）。
    // 两个都用 -c 覆盖而不是命令行开关：`-m` 只有 exec 认、resume 不认，而 -c 两种入口都吃
    // （同上面 sandbox_mode 的理由）。键名 model / model_reasoning_effort 取自官方配置表。
    if (model) args.push('-c', `model=${JSON.stringify(model)}`);
    if (effort) args.push('-c', `model_reasoning_effort=${JSON.stringify(effort)}`);
    if (cwd) args.push('-C', cwd);
    if (sessionId) args.push('resume', sessionId);
    args.push(String(prompt ?? ''));
    return args;
  }
  if (agent === 'zcode') {
    // 参数全部来自官方参数表 apps/zcode-cli/packages/cli/src/arguments.ts（node:util parseArgs）：
    //   --prompt / -p <text>   单轮 headless 入口（run.ts：有 prompt 就走 runPrompt）
    //   --cwd <dir>            工作目录
    //   --resume <sessionId>   续聊（会话号从上一轮 result 行拿）
    //   --output-format <fmt>  text | json | stream-json —— 只有 stream-json 是「一行一个事件 +
    //                          末行 result」的机器可读流（run.ts 的 OUTPUT_FORMATS 与
    //                          prompt-command.ts 的写法都证实了）。不传就只吐最终回答的纯文本，
    //                          这个页面就没有增量、也拿不到会话号。
    // 权限档不用自己传：headless 的默认模式是 yolo（run.ts 的 DEFAULT_HEADLESS_PROMPT_MODE），
    // 不会停下来问批准。
    const args = ['--output-format', 'stream-json', '--prompt', String(prompt ?? '')];
    if (cwd) args.push('--cwd', cwd);
    if (sessionId) args.push('--resume', sessionId);
    return args;
  }
  throw new Error('未知 agent：' + agent);
}

// ── CLI 失败时的说明 ────────────────────────────────────────────────────────
// 退出码非零时不能把 stderr 原样倒给用户。实测 zcode 会往 stderr 吐这样的东西：
//   Symbol(vercel.ai.error.AI_APICallError): true } Error: Turn execution failed (traceId: …)
// 前半段是它内部对象倾倒（Symbol 包装 + 半个 JSON），照着显示就是一屏天书。这里只留人话：
//   ① 剥 ANSI；② 丢掉 JS 堆栈帧（`    at foo (/x.js:1:2)`）；③ 从 `SomeError:` 处切开，
//   砍掉它前面的对象残渣；④ 折掉多余空白、限长。
// 纯函数（可单测）：喂原始 stderr 字符串，回一句能显示的话（没有可读内容就回 ''）。
const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g;
export function stderrMessage(raw) {
  const lines = String(raw || '').replace(ANSI_RE, '')
    .split('\n').map((l) => l.trim()).filter(Boolean)
    .filter((l) => !/^at\s/.test(l));                       // 堆栈帧
  if (!lines.length) return '';
  const noisy = /(error|failed|failure|refused|denied|not found|no such|invalid|unable|无法|失败|错误|没找到)/i;
  const picked = (lines.filter((l) => noisy.test(l)).slice(-1)[0]) || lines[lines.length - 1];
  let s = picked.replace(/Symbol\([^)]*\):?/g, ' ');        // 内部符号包装
  // 从最后一个 `XxxError:` / `Error:` 处起头，砍掉它前面的对象残渣（`true }` 之类）
  const m = s.match(/.*?((?:[A-Z]\w*)?Error):\s*(\S.*)$/);
  if (m) s = m[2];
  s = s.replace(/\s+/g, ' ').replace(/^[->:;,\s]+/, '').trim();
  return s.slice(0, 300);
}

// 退出码非零时给前端的那一句。hadError = 这一轮已经推过带细节的 error 事件（如 zcode 的
// turn.failed / codex 的 item.error）——那种情况下 CLI 给的结构化错误才是权威，stderr 里
// 通常是同一件事的对象倾倒（实测就是这么成对的），补一句只会让人看到两行重复的错。
export function cliFailureNote(code, stderr, hadError = false) {
  if (hadError) return '';
  const msg = stderrMessage(stderr);
  if (!msg) return 'CLI 退出码 ' + code;
  // 换证类失败也常从这里吐出来（stderr 里裸一行短码，见 explainZcodeCode），一并翻成人话。
  const mapped = explainZcodeCode(msg);
  return 'CLI 退出码 ' + code + '：' + (mapped ? mapped.text : msg);
}

// ── 认证类失败：给前端一个标记 ──────────────────────────────────────────────
// CLI 报「没登录 / 登录失效 / 套餐没生效」时，它自己那句话对用户没有下一步（实测 zcode 只说
// 'Provider authentication failed.'，z.ai 那边是 401 auth_failed）。这里只做判定、不下结论：
// 前端据此多显示一句「怎么办」（重新跑哪条登录命令），两边的文案分开维护。
const AUTH_RE = /(auth(?:entication)?[ _-]?fail|unauthoriz|invalid[ _-]?(?:auth|api[ _-]?key|token)|token (?:expired|invalid)|not (?:logged|signed) in|no credentials|401|provider_not_configured|登录|未授权|认证失败|凭据)/i;
export function isAuthFailure(message) { return AUTH_RE.test(String(message || '')); }

// ── zcode 的换证机器码 → 人话 ───────────────────────────────────────────────
// 这些码来自 zcode 自己的换证 adapter（apps/zcode-cli/packages/adapters/src/auth/coding-plan-api-key.ts）：
// 它把「登录 OAuth → 业务 JWT → 项目令牌」这条链上的失败都收成几个短码，headless 下就原样吐出来。
// 直接显示 `project_token_login_failed` 这种串，用户既不知道哪里错、也不知道下一步做什么——实测
// 最常撞上的那一种，就是「这个账号没有生效中的 Coding Plan」（Z.ai 国际版 / 智谱国内版都算）。
// 只翻见过的码；没见过的原样透出，CLI 升级后新增的码不至于被吞掉。
const ZCODE_CODE_TEXT = {
  project_token_login_required: {
    auth: true,
    text: '这台机器上的 zcode 还没登录。',
  },
  project_token_login_failed: {
    auth: true,
    text: '登录换证被拒：多半是这个账号没有生效中的 Coding Plan（订阅后再登录一次）；'
      + '也可能只是登录态失效，重跑一次就好。',
  },
  project_token_request_failed: {
    auth: false,
    text: '换证请求失败（上游返回了错误）：稍后重试；反复失败就重跑一次 zcode login。',
  },
  project_token_scope_invalidated: {
    auth: false,
    text: '登录态在请求途中被刷新了：重发一次这一句即可。',
  },
};

// 纯函数：喂一个短码，回 { text, auth }；不是已知的码就回 null。
export function explainZcodeCode(raw) {
  const hit = ZCODE_CODE_TEXT[String(raw || '').trim()];
  return hit ? { text: hit.text, auth: hit.auth } : null;
}

// 判重用的归一化键：抹掉重试计数（2/5）、cf-ray、十六进制 id、空白，并把 CLI 套在外面的
// 播报壳剥掉——实测 codex 一次鉴权失败会推来 8 条，全是同一个 401：
//   'Reconnecting... 2/5 (unexpected status 401 …)'、'Falling back from WebSockets to HTTPS
//   transport. unexpected status 401 …'、最后一条裸的 'unexpected status 401 …'。
// 剥掉壳、抹掉计数之后它们才指向同一件事。返回 '' 表示没有可比对的内容（那就放行，宁可多说）。
export function errorKey(message) {
  let s = String(message || '').trim();
  const wrapped = s.match(/^Reconnecting\.\.\.\s*\d+\s*\/\s*\d+\s*\(([\s\S]*)\)$/);
  if (wrapped) s = wrapped[1];
  s = s.replace(/^Falling back from WebSockets to HTTPS transport\.\s*/i, '');
  s = s
    .replace(/\b\d+\s*\/\s*\d+\b/g, '#')
    .replace(/cf-ray:\s*\S+/gi, '')
    .replace(/request\s*id:\s*\S*/gi, '')   // 尾部这段每次都不同（实测 req_ 前缀让纯 hex 规则漏掉）
    .replace(/[0-9a-f]{8,}/gi, '')
    // 同一次失败在重试里会换传输：WebSocket 那条 url 是 wss://、回退后是 https://（实测同一轮里
    // 两种都出现）。协议头抹掉，剩下的才是同一件事。
    .replace(/\b(wss?|https?):\/\//gi, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*(?=,|$)/g, '')          // 抹掉字段后留的悬空逗号
    .replace(/[\s,;]+$/, '')
    .trim();
  return s.length < 12 ? '' : s;
}

// ── codex 事件 → 归一事件 ───────────────────────────────────────────────────
const codexToolName = (item) => {
  switch (item.type) {
    case 'command_execution': return item.command ? '命令 ' + String(item.command).split('\n')[0].slice(0, 120) : '命令';
    case 'file_change': return '改文件' + (Array.isArray(item.changes) && item.changes.length ? '（' + item.changes.map((c) => c.path).filter(Boolean).join('、') + '）' : '');
    case 'mcp_tool_call': return [item.server, item.tool].filter(Boolean).join(' · ') || '工具';
    case 'web_search': return '联网搜索' + (item.query ? '：' + String(item.query).slice(0, 80) : '');
    case 'todo_list': return '待办清单';
    default: return item.type ? String(item.type) : '工具';
  }
};

// 工具行的稳定标识：同一个 item 的 started/updated/completed 三拍靠它对上，
// 前端据此就地更新那一行（而不是同一条命令压三行）。
const codexItemId = (item) => {
  const id = item.id ?? item.item_id ?? item.itemId;
  return id == null ? '' : String(id);
};

// 单个工具行的补充载荷。以前只留一个名字，命令输出 / 退出码 / 改动的文件 / 搜索词
// 全都解析出来了却又在适配层丢掉——界面上什么都看不到。这里把它们带上（有长度上限）。
const TOOL_TEXT_MAX = 20_000;
export function codexToolData(item) {
  const out = {};
  const cut = (s) => String(s).slice(0, TOOL_TEXT_MAX);
  if (item.type === 'command_execution') {
    if (typeof item.command === 'string' && item.command) out.command = cut(item.command);
    if (typeof item.aggregated_output === 'string' && item.aggregated_output) out.output = cut(item.aggregated_output);
    if (item.exit_code != null && Number.isFinite(Number(item.exit_code))) out.exitCode = Number(item.exit_code);
  } else if (item.type === 'file_change') {
    const list = (Array.isArray(item.changes) ? item.changes : [])
      .map((c) => ({ path: String((c && c.path) || ''), kind: String((c && c.kind) || '') }))
      .filter((c) => c.path);
    if (list.length) out.changes = list;
  } else if (item.type === 'web_search') {
    if (typeof item.query === 'string' && item.query) out.query = cut(item.query);
  } else if (item.type === 'mcp_tool_call') {
    if (item.server) out.server = String(item.server).slice(0, 120);
    if (item.tool) out.tool = String(item.tool).slice(0, 120);
    const r = item.result ?? item.output;
    if (typeof r === 'string' && r) out.output = cut(r);
  }
  return out;
}

// 待办清单是独立一类（不是工具行）：条目要逐条画出来，用户才知道还剩什么没做。
export function codexTodoItems(item) {
  const items = Array.isArray(item.items) ? item.items : [];
  return items
    .map((x) => ({
      text: String((x && (x.text || x.title || x.content)) || '').slice(0, 300),
      status: String((x && x.status) || ''),
    }))
    .filter((x) => x.text);
}

export function parseCodexEvent(line) {
  if (!line || typeof line !== 'object') return [];
  const t = String(line.type || '');
  if (t === 'thread.started') {
    // 只报会话 id：这一轮的「开始」由 runCliTurn 统一发（它知道是哪个 agent、跑在哪个目录）
    const id = line.thread_id || line.threadId || '';
    return id ? [{ type: 'session', sessionId: id }] : [];
  }
  if (t === 'turn.started') return [];
  if (t === 'turn.completed') return [{ type: 'done', usage: line.usage || null }];
  if (t === 'turn.failed') return [{ type: 'error', message: String(line.error?.message || line.error || '这一轮失败了') }];
  if (t.startsWith('item.')) {
    const item = line.item || {};
    if (item.type === 'agent_message') return item.text ? [{ type: 'text', text: String(item.text) }] : [];
    if (item.type === 'reasoning') return item.text ? [{ type: 'reasoning', text: String(item.text) }] : [];
    if (item.type === 'error') return [{ type: 'error', message: String(item.message || '出错') }];
    // 待办清单：条目逐条上抛（画成清单，不再压成一行「待办清单」）。
    if (item.type === 'todo_list') {
      const items = codexTodoItems(item);
      return items.length ? [{ type: 'todo', items }] : [];
    }
    const out = [{
      type: 'tool',
      id: codexItemId(item),
      name: codexToolName(item),
      status: t.slice(5),
      summary: String(item.aggregated_output || '').slice(-400),
      ...codexToolData(item),
    }];
    if (item.type === 'command_execution' && item.exit_code != null && item.exit_code !== 0) out.push({ type: 'notice', text: '命令退出码 ' + item.exit_code });
    return out;
  }
  if (t === 'error') return [{ type: 'error', message: String(line.message || '出错') }];
  return [];
}

// ── zcode 事件 → 归一事件 ───────────────────────────────────────────────────
// 契约来自官方源码（apps/zcode-cli/packages/cli + packages/bootstrap/src/zcode-protocol/session-mapper.ts）：
//   --output-format stream-json 时，stdout 是「一行一个 JSON」：
//     事件行  { deliveryKind?, eventId, payload, seq, sessionId, timestamp, traceId, turnId?, type }
//     末行    { type: 'result', sessionId, traceId, turnId?, response, turnResponses?, usage?, eventCount, projection }
//   type 取值（session-mapper.ts 的 mapSessionEventType 全表）：
//     session.created / session.resumed / session.titleUpdated / session.closed
//     turn.started / turn.steerQueued / turn.steerDrained / turn.completed / turn.failed
//     message.upserted / model.streaming / tool.updated
//     permission.requested / permission.resolved / checkpoint.created / rewind.triggered
//     streamRecovery.updated / session.updated（兜底）
//
// model.streaming 的 payload 是 { kind, delta, ... }：kind = text_delta | reasoning_delta |
//   tool_input_start | tool_input_delta | tool_input_end | tool_call（shouldExposeSessionEventToProtocol
//   只放行这几类；text/reasoning 的 delta 非空才放行）。
// tool.updated 的 payload 在原字段上补一个 kind = scheduled | started | progress | result | error | batch。
const zcDelta = (payload, kind) => {
  const p = payload && typeof payload === 'object' ? payload : {};
  return p.kind === kind && typeof p.delta === 'string' ? p.delta : '';
};

export function parseZcodeEvent(line) {
  if (!line || typeof line !== 'object') return [];
  const t = String(line.type || '');
  const p = (line.payload && typeof line.payload === 'object') ? line.payload : {};
  const out = [];

  // 末行：整轮的收口（会话号、最终回答、用量都在这里）。事件行之后不会再有任何行。
  if (t === 'result') {
    if (line.sessionId) out.push({ type: 'session', sessionId: String(line.sessionId) });
    // response 是「最终回答」全文。逐字增量已经流过了，这里只在没流过正文时补一次，
    // 免得同一段话在页面上出现两遍（见下面 runCliTurn 里的 sawText）。
    if (typeof line.response === 'string' && line.response)
      out.push({ type: 'text', text: line.response, final: true });
    const status = line.projection && line.projection.status;
    if (status && status !== 'completed' && status !== 'idle') out.push({ type: 'notice', text: '上游状态：' + status });
    out.push({ type: 'done', usage: line.usage || null, sessionId: line.sessionId ? String(line.sessionId) : '' });
    return out;
  }

  if (t === 'turn.failed') {
    // 真机上这一行的形状（zcode 0.16.9 实测）：
    //   payload.error = { type, attribution:{retryable}, code, message, detail, underlyingErrorMessage, stack }
    // 人话在 error.message，而 error.stack 很长——不挑字段就会把整段堆栈倒给用户。
    const err = p.error;
    const pick = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '');
    const msg = pick(err && typeof err === 'object' ? (err.message || err.underlyingErrorMessage) : err)
      || pick(p.message) || pick(line.message)
      || (err && typeof err === 'object' ? pick(err.code) : '')
      || '这一轮失败了';
    // 换证类失败吐的是短码（见 explainZcodeCode），先翻成人话再给前端；其它错误原样透出。
    const mapped = explainZcodeCode(msg) || explainZcodeCode(err && typeof err === 'object' ? err.code : '');
    if (mapped) out.push({ type: 'error', message: mapped.text, auth: mapped.auth });
    else out.push({ type: 'error', message: msg.slice(0, 800) });
    return out;
  }
  if (t === 'turn.completed') return [];          // 收口交给随后的 result 行
  if (t === 'session.created' || t === 'session.resumed') {
    if (line.sessionId) out.push({ type: 'session', sessionId: String(line.sessionId) });
    return out;
  }

  if (t === 'model.streaming') {
    const text = zcDelta(p, 'text_delta');
    if (text) return [{ type: 'text', text }];
    const think = zcDelta(p, 'reasoning_delta');
    if (think) return [{ type: 'reasoning', text: think }];
    // tool_input_* / tool_call：工具参数预览，不进正文（工具卡另由 tool.updated 画）
    return [];
  }

  if (t === 'tool.updated') {
    const kind = String(p.kind || '');
    if (kind === 'progress') return [];           // 进度噪音，只留生命周期
    const name = p.name || p.toolName || p.tool || p.toolId || '工具';
    const summary = p.output ?? p.result ?? p.summary ?? '';
    const status = kind === 'error' ? 'failed' : kind === 'result' || kind === 'batch' ? 'completed' : 'started';
    return [{
      type: 'tool',
      id: String(p.toolCallId || p.toolCallID || p.id || p.toolId || ''),
      name: String(name).slice(0, 140),
      status,
      summary: (typeof summary === 'string' ? summary : JSON.stringify(summary)).slice(-400),
      // 工具输出画出来：以前只留名字与尾部摘要，用户看不到命令到底跑了什么。
      ...(typeof summary === 'string' && summary ? { output: summary.slice(0, TOOL_TEXT_MAX) } : {}),
      ...(p.input != null ? { input: typeof p.input === 'string' ? p.input.slice(0, TOOL_TEXT_MAX) : JSON.stringify(p.input).slice(0, TOOL_TEXT_MAX) } : {}),
    }];
  }

  // 上游请求授权：仍是一条 notice（headless 这条路没有回传批准的口子），但带上工具名与参数，
  // 界面才能把「在问什么」讲清楚。真正可批准的授权卡要等 app-server 那条路（阶段 B）。
  if (t === 'permission.requested') {
    const name = String(p.name || p.toolName || p.tool || p.kind || '');
    return [{
      type: 'notice',
      text: '上游请求授权：' + name,
      permission: {
        name: name.slice(0, 140),
        input: p.input != null ? (typeof p.input === 'string' ? p.input.slice(0, TOOL_TEXT_MAX) : JSON.stringify(p.input).slice(0, TOOL_TEXT_MAX)) : '',
      },
    }];
  }
  // session.updated / checkpoint / rewind / streamRecovery / permission.resolved 等：
  // 界面不画，别当正文吐出去（否则会把 JSON 片段显示成回答）。
  return out;
}

export const PARSERS = { codex: parseCodexEvent, zcode: parseZcodeEvent };

// 一行 stdout → 归一事件。
//   codex：官方明确是 JSONL（非 JSON 行只是 CLI 混出来的进度/警告），安静扔掉。
//   zcode：官方没给 headless 的输出契约——纯文本行【就是正文】（headless 单轮多半直接打最终回答），
//          所以这里不丢，收成 text；坏 JSON（{ 开头但解析失败）才丢。
export function parseLine(agent, rawLine) {
  const s = String(rawLine ?? '');
  const trimmed = s.trim();
  if (!trimmed) return [];
  if (trimmed[0] !== '{') return agent === 'zcode' ? [{ type: 'text', text: trimmed }] : [];
  let obj;
  try { obj = JSON.parse(trimmed); } catch { return []; }
  const fn = PARSERS[agent];
  if (!fn) return [];
  try { return fn(obj) || []; } catch { return []; }
}

// ── 跑一轮 ─────────────────────────────────────────────────────────────────
// 异步生成器：yield 归一事件。子进程生命期绑在 signal 上（客户端断开就杀——这类 CLI 会一直跑）。
// 抛错都在事件里给前端说明白，不 reject（调用方只管往 SSE 里写）。
export async function* runCliTurn(agent, { prompt, sessionId = '', cwd = '', model = '', effort = '', images = [], signal = null, env = process.env, keyEnv, binDir = '' } = {}) {
  if (!CLI_AGENTS.includes(agent)) { yield { type: 'error', message: '未知 agent：' + agent }; return; }
  const searchEnv = binDir ? { ...env, PATH: binDir + ':' + (env.PATH || '') } : env;
  const bin = findCliBin(agent, searchEnv);
  if (!bin) { yield { type: 'error', message: CLI_MISSING_NOTE[agent] || ('没找到 ' + agent + ' 命令') }; return; }

  let args;
  try { args = buildArgs(agent, { prompt, sessionId, cwd, model, effort, images }); }
  catch (e) { yield { type: 'error', message: (e && e.message) || String(e) }; return; }

  yield { type: 'start', agent, sessionId: sessionId || '' };
  // detached: 让 CLI 自成进程组——它跑的命令（sleep、构建…）是它的子进程，只 SIGTERM 它自己，
  // 子进程会继续攥着 stdout，客户端断开后这一轮要拖到子进程结束才算完（实测 30s 的 sleep 就是）。
  // 按进程组杀，整棵树一起收。
  //
  // env：进程环境 + 服务器上存的那把 key（设置 → Agent，见 runtime/agent-keys.mjs；存的那把压过
  // 环境变量）+ 两句让 CLI 别说废话的输出选项。没存过 key 就原样继承进程环境（`codex login` /
  // `zcode login` 的登录态照旧可用）。keyEnv 是给【每身份隔离】准备的显式覆盖（路由层按
  // cliSpawnKeyEnv(ctx, agent) 传各人自己的那把）；不给就用全局那份（admin / 老调用方行为不变）。
  //
  // 自带的 codex 是个 Node ESM shim（node_modules/.bin/codex → @openai/codex/bin/codex.js，
  // 由它用绝对路径拉起平台包里的真身）：这类 .js 用 node 起，不依赖 shebang 里那句
  // `#!/usr/bin/env node`——服务器上 node 不在 PATH 时（systemd 单元、精简镜像）也照样能跑。
  const childEnv = { ...env, ...(keyEnv !== undefined ? keyEnv : cliKeyEnv(agent)), NO_COLOR: '1', TERM: 'dumb' };
  const isJs = /\.(c|m)?js$/i.test(bin);
  const child = spawn(isJs ? process.execPath : bin, isJs ? [bin, ...args] : args, {
    cwd: cwd || undefined,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  let killed = false;
  const killTree = (sig) => {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, sig);
      else child.kill(sig);
    } catch { try { child.kill(sig); } catch {} }
  };
  const onAbort = () => { killed = true; killTree('SIGTERM'); };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  let buf = '';
  const queue = [];
  let waiter = null, done = false, failure = '', sawDone = false;
  const wake = () => { const w = waiter; waiter = null; if (w) w(); };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      for (const ev of parseLine(agent, line)) queue.push(ev);
    }
    wake();
  });
  let stderrTail = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { stderrTail = (stderrTail + c).slice(-2000); });
  child.on('error', (e) => { failure = (e && e.message) || String(e); done = true; wake(); });
  child.on('close', (code) => {
    if (code !== 0 && !killed) {
      // 这一轮已经推过带细节的 error（zcode 的 turn.failed / codex 的 item.error）时，
      // cliFailureNote 只补 stderr 里更有用的那句，避免同一件事说两遍（见它的注释）。
      const note = cliFailureNote(code, stderrTail, sawError);
      if (note) failure = failure || note;
    }
    done = true; wake();
  });

  let lastSession = sessionId || '';
  let sawText = false;
  let sawError = false;   // 这一轮有没有推过带细节的 error 事件（决定退出码那句要不要说，见 cliFailureNote）
  const sawErrKeys = new Set();   // 这一轮已经播报过的错（归一化后判重，见 errorKey）
  while (!done || queue.length) {
    // 中断了就不再等子进程收尾：直接把已到手的事件放完（下面统一收「已中断」+ done）。
    if (killed && !queue.length) break;
    if (!queue.length) { await new Promise((r) => { waiter = r; }); continue; }
    const ev = queue.shift();
    // 会话号只上报一次（同一轮里 zcode 的 session.created 与末行 result 都带，重复推给前端没意义）。
    if (ev.type === 'session') {
      if (ev.sessionId === lastSession) continue;
      lastSession = ev.sessionId;
    }
    // zcode 的末行 result 带着最终回答全文；逐字增量已经流过了就别再补一遍
    // （同一段话在页面上出现两遍）。没流过增量时才拿它兜底。
    if (ev.type === 'text' && ev.final) { if (sawText) continue; }
    if (ev.type === 'text' && !ev.final) sawText = true;
    // 同一件错的重复播报只留第一遍：实测 codex 的鉴权失败会连推 8 条
    // （Reconnecting 2/5…5/5 + WebSocket→HTTPS 回退 + 最后一条裸的），页面上就是一片一样的字。
    // 一轮内每个「归一化后相同」的错各显示一次；不同的事照旧各显示各的。
    if (ev.type === 'error') {
      const key = errorKey(ev.message);
      if (key) { if (sawErrKeys.has(key)) continue; sawErrKeys.add(key); }
    }
    if (ev.type === 'done') { sawDone = true; if (!ev.sessionId) ev.sessionId = lastSession; }
    if (ev.type === 'error') { sawError = true; if (ev.auth === undefined) ev.auth = isAuthFailure(ev.message); }
    yield ev;
  }
  if (signal) signal.removeEventListener?.('abort', onAbort);
  if (killed) { yield { type: 'notice', text: '已中断' }; yield { type: 'done', sessionId: lastSession }; return; }
  if (failure) { yield { type: 'error', message: failure, auth: isAuthFailure(failure) }; if (!sawDone) yield { type: 'done', sessionId: lastSession, failed: true }; return; }
  if (!sawDone) yield { type: 'done', sessionId: lastSession };
}
