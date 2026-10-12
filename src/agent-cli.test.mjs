// 外部 CLI agent（codex / zcode）适配层契约。
//
// 这一层是「bridge ↔ 官方 CLI」之间唯一一处靠自己解析对方输出/拼对方命令行的代码，
// 所以要钉住三件事：
//   ① 拼出来的命令行就是官方文档里的形态（codex exec [--json] [resume <id>] prompt；
//      zcode --prompt … --output-format stream-json [--resume <id>]）；
//   ② 两家各自的 JSONL 事件解析成同一套归一事件（分页只认这一套）；
//   ③ 真跑起来（用桩 CLI 冒充 codex/zcode）：逐行 stdout → 事件流 → done；
//      没装的 CLI、非零退出、坏行都要给明确结果，不能把分页晾住。
import { test } from 'node:test';
import assert from 'node:assert';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.env.BRIDGE_DATA_ROOT) process.env.BRIDGE_DATA_ROOT = mkdtempSync(path.join(os.tmpdir(), 'bridge-agentcli-'));
// 测试里钉住「PATH 上有什么就是什么」：显式置空 = 不用随程序自带的那一份（release 的 node_modules/.bin
// 里装着真的 codex，否则下面的桩会被它顶掉）。
process.env.BRIDGE_AGENT_BIN_DIR = '';
const { buildArgs, parseLine, parseCodexEvent, parseZcodeEvent, runCliTurn, stderrMessage, cliFailureNote, isAuthFailure, errorKey, CLI_AGENTS, CLI_MISSING_NOTE } =
  await import('./runtime/agent-cli.mjs');
const { setAgentKey, savedAgentKey } = await import('./runtime/agent-keys.mjs');

// —— ① 命令行 ——
test('codex：exec --json，首轮给 prompt，续聊把 resume <session_id> 放在共享选项之后', () => {
  assert.deepEqual(buildArgs('codex', { prompt: 'hi', cwd: '/w' }),
    ['exec', '--json', '-c', 'sandbox_mode="workspace-write"', '--skip-git-repo-check', '-C', '/w', 'hi']);
  assert.deepEqual(buildArgs('codex', { prompt: 'again', sessionId: 'tid-1', cwd: '/w' }),
    ['exec', '--json', '-c', 'sandbox_mode="workspace-write"', '--skip-git-repo-check', '-C', '/w', 'resume', 'tid-1', 'again']);
  // 没有 cwd 也不塞空参数
  assert.deepEqual(buildArgs('codex', { prompt: 'hi' }),
    ['exec', '--json', '-c', 'sandbox_mode="workspace-write"', '--skip-git-repo-check', 'hi']);
  // 官方默认是只读沙箱；这一页要能改工作目录里的文件，权限档必须是显式的。
  // 用 -c（配置覆盖）而不是 --sandbox：resume 子命令不接受 --sandbox，两种入口都要能用。
  const a = buildArgs('codex', { prompt: 'x' });
  assert.ok(a.includes('sandbox_mode="workspace-write"'));
  assert.ok(a.join(' ').includes('-c sandbox_mode="workspace-write"'));
});

test('codex 模型 / 思考深度：走 -c 覆盖，且放在子命令之前（resume 也认）', () => {
  // 键名 model / model_reasoning_effort 取自官方配置表；-m 只有 exec 认、resume 不认，
  // 所以统一用 -c 覆盖，两种入口都可靠（同 sandbox_mode 的理由）。
  const a = buildArgs('codex', { prompt: 'hi', model: 'gpt-6.1-sol', effort: 'high' });
  assert.ok(a.includes('model="gpt-6.1-sol"'), JSON.stringify(a));
  assert.ok(a.includes('model_reasoning_effort="high"'), JSON.stringify(a));
  // 续聊：这两个覆盖必须在 resume 之前（clap 父级参数只在子命令名之前生效）
  const r = buildArgs('codex', { prompt: 'again', sessionId: 'tid', model: 'm', effort: 'low' });
  assert.ok(r.indexOf('model="m"') < r.indexOf('resume'), JSON.stringify(r));
  assert.ok(r.indexOf('model="reasoning_effort"') === -1);
  // 没选就不塞（空 = 交回 CLI 自己的 config.toml）
  const plain = buildArgs('codex', { prompt: 'hi' });
  assert.ok(!plain.some((x) => x.startsWith('model=')), JSON.stringify(plain));
  assert.deepEqual(plain, ['exec', '--json', '-c', 'sandbox_mode="workspace-write"', '--skip-git-repo-check', 'hi']);
  // zcode 的 headless 入口没有模型 / 思考深度参数：传了也不该出现在命令行里
  const z = buildArgs('zcode', { prompt: 'hi', model: 'x', effort: 'high' });
  assert.ok(!z.join(' ').includes('model'), JSON.stringify(z));
});

test('zcode：只用官方参数表里有的参数，且必须带 --output-format stream-json', () => {
  // 参数与官方源码对齐（apps/zcode-cli/packages/cli/src/arguments.ts）：
  // --prompt / --cwd / --resume 都在表里；--output-format 只在 text|json|stream-json 三值里取。
  assert.deepEqual(buildArgs('zcode', { prompt: 'hi', cwd: '/w' }),
    ['--output-format', 'stream-json', '--prompt', 'hi', '--cwd', '/w']);
  assert.deepEqual(buildArgs('zcode', { prompt: 'again', sessionId: 's1' }),
    ['--output-format', 'stream-json', '--prompt', 'again', '--resume', 's1']);
  assert.deepEqual(buildArgs('zcode', { prompt: 'again', sessionId: 's1', cwd: '/w' }),
    ['--output-format', 'stream-json', '--prompt', 'again', '--cwd', '/w', '--resume', 's1']);
  // 不传 --output-format 就只吐最终回答的纯文本：没有增量、也拿不到会话号，续聊就断了。
  assert.ok(buildArgs('zcode', { prompt: 'x' }).join(' ').includes('--output-format stream-json'));
  // 权限档不自己传：headless 默认就是 yolo（run.ts 的 DEFAULT_HEADLESS_PROMPT_MODE）
  assert.ok(!buildArgs('zcode', { prompt: 'x' }).includes('--mode'), '别自己塞 --mode：默认已经是 yolo');
  assert.throws(() => buildArgs('nope', { prompt: 'x' }), /未知 agent/);
});

// —— ② 事件解析：codex ——
test('codex 事件：thread.started 给会话 id，item 映射成正文/思考/工具，turn.completed 收尾', () => {
  assert.deepEqual(parseCodexEvent({ type: 'thread.started', thread_id: 't1' }), [{ type: 'session', sessionId: 't1' }]);
  assert.deepEqual(parseCodexEvent({ type: 'item.completed', item: { type: 'agent_message', text: 'hello' } }), [{ type: 'text', text: 'hello' }]);
  assert.deepEqual(parseCodexEvent({ type: 'item.updated', item: { type: 'reasoning', text: 'why' } }), [{ type: 'reasoning', text: 'why' }]);
  const cmd = parseCodexEvent({ type: 'item.completed', item: { type: 'command_execution', command: 'npm test', exit_code: 1, aggregated_output: 'x' } });
  assert.equal(cmd[0].type, 'tool');
  assert.equal(cmd[0].status, 'completed');
  assert.ok(cmd[0].name.includes('npm test'));
  assert.deepEqual(cmd[1], { type: 'notice', text: '命令退出码 1' }, '非零退出码要提一句');
  assert.deepEqual(parseCodexEvent({ type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'a.ts' }] } })[0].name, '改文件（a.ts）');
  assert.deepEqual(parseCodexEvent({ type: 'turn.completed', usage: { input_tokens: 3 } }), [{ type: 'done', usage: { input_tokens: 3 } }]);
  assert.equal(parseCodexEvent({ type: 'turn.failed', error: { message: 'nope' } })[0].message, 'nope');
  assert.deepEqual(parseCodexEvent({ type: 'unknown.thing' }), []);   // 不认识的类型安静跳过
});

// —— ② 事件解析：zcode ——
// 契约来自官方源码（session-mapper.ts 的 mapSessionEventType / mapSessionEventPayload、run.ts 的
// OUTPUT_FORMATS、prompt-command.ts 的 result 行）。
test('zcode 事件：末行 result 带 sessionId + response + usage，且它是流的终止符', () => {
  const evs = parseZcodeEvent({ type: 'result', sessionId: 's1', response: 'done!', projection: { status: 'completed' }, usage: { total: 1 } });
  assert.deepEqual(evs[0], { type: 'session', sessionId: 's1' });
  assert.deepEqual(evs[1], { type: 'text', text: 'done!', final: true });
  assert.deepEqual(evs[2], { type: 'done', usage: { total: 1 }, sessionId: 's1' });
  // 上游状态不是 completed / idle：多一句提示
  assert.ok(parseZcodeEvent({ type: 'result', sessionId: 's', response: 'x', projection: { status: 'incomplete' } })
    .some((e) => e.type === 'notice'));
  assert.ok(!parseZcodeEvent({ type: 'result', sessionId: 's', response: 'x', projection: { status: 'idle' } })
    .some((e) => e.type === 'notice'), 'idle 是正常收尾，不该报状态');
});

test('zcode 事件：model.streaming 按 kind 分流（正文 / 思考 / 工具参数不进正文）', () => {
  const ev = (payload) => parseZcodeEvent({ type: 'model.streaming', sessionId: 's', payload });
  assert.deepEqual(ev({ kind: 'text_delta', delta: '你好' }), [{ type: 'text', text: '你好' }]);
  assert.deepEqual(ev({ kind: 'reasoning_delta', delta: '想一下' }), [{ type: 'reasoning', text: '想一下' }]);
  // 工具参数预览是 model.streaming 的另一类 kind：不能当正文吐出去
  assert.deepEqual(ev({ kind: 'tool_input_delta', delta: '{"path"' }), []);
  assert.deepEqual(ev({ kind: 'tool_call' }), []);
  assert.deepEqual(ev({ kind: 'text_delta', delta: '' }), [], '空 delta 不上抛');
});

test('zcode 事件：tool.updated 按 kind 落成工具卡的开始 / 完成 / 失败', () => {
  const t = (payload) => parseZcodeEvent({ type: 'tool.updated', sessionId: 's', payload });
  assert.equal(t({ kind: 'started', name: 'bash' })[0].status, 'started');
  assert.equal(t({ kind: 'result', name: 'bash', output: 'ok' })[0].status, 'completed');
  assert.equal(t({ kind: 'error', name: 'bash', output: 'boom' })[0].status, 'failed');
  assert.deepEqual(t({ kind: 'progress', name: 'bash' }), [], '进度是噪音，只留生命周期');
});

test('zcode 事件：turn.failed 落成错误；内部状态事件（session.updated 等）不进正文', () => {
  assert.equal(parseZcodeEvent({ type: 'turn.failed', payload: { message: '模型报错' } })[0].type, 'error');
  assert.deepEqual(parseZcodeEvent({ type: 'turn.completed', payload: {} }), [], '收口交给随后的 result 行');
  assert.deepEqual(parseZcodeEvent({ type: 'session.updated', payload: { 任意: 1 } }), [], '兜底类型不能当正文');
  assert.deepEqual(parseZcodeEvent({ type: 'checkpoint.created', payload: {} }), []);
  assert.equal(parseZcodeEvent({ type: 'session.created', sessionId: 's7' })[0].sessionId, 's7');
  assert.equal(parseZcodeEvent({ type: 'permission.requested', payload: { name: 'bash' } })[0].type, 'notice');
});

test('codex 事件：tool 行要带上细节（命令输出 / 退出码 / 改动文件 / 搜索词）', () => {
  // 这些字段服务端一直都解析出来了，但以前适配层只留一个名字，界面什么都看不到。
  const cmd = parseCodexEvent({
    type: 'item.completed',
    item: { id: 'item_1', type: 'command_execution', command: 'npm test', exit_code: 0, aggregated_output: 'ok\n3 passing' },
  })[0];
  assert.equal(cmd.id, 'item_1', 'id 要透出来：同一行的三拍靠它对上');
  assert.equal(cmd.command, 'npm test');
  assert.equal(cmd.output, 'ok\n3 passing', '命令输出要能到界面：' + JSON.stringify(cmd));
  assert.equal(cmd.exitCode, 0);

  const ch = parseCodexEvent({ type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'a.ts', kind: 'update' }] } })[0];
  assert.deepEqual(ch.changes, [{ path: 'a.ts', kind: 'update' }]);
  assert.equal(ch.name, '改文件（a.ts）', '标题照旧（老路径的兼容）');

  const ws = parseCodexEvent({ type: 'item.completed', item: { type: 'web_search', query: 'svelte 5 runes' } })[0];
  assert.equal(ws.query, 'svelte 5 runes');

  // 同一件工具的三拍（同一个 id）→ 前端就地更新那一行，不压三行
  const started = parseCodexEvent({ type: 'item.started', item: { id: 'x1', type: 'command_execution', command: 'ls' } })[0];
  const done = parseCodexEvent({ type: 'item.completed', item: { id: 'x1', type: 'command_execution', command: 'ls', exit_code: 0, aggregated_output: 'a b' } })[0];
  assert.equal(started.id, done.id);
  assert.equal(started.status, 'started');
  assert.equal(done.status, 'completed');
  // 没有 id 的老形状也不炸（退回按名字配对）
  assert.equal(parseCodexEvent({ type: 'item.completed', item: { type: 'command_execution', command: 'ls' } })[0].id, '');
});

test('codex 待办清单落成 todo 事件（逐条），不再压成一行「待办清单」', () => {
  const evs = parseCodexEvent({
    type: 'item.completed',
    item: { type: 'todo_list', items: [{ text: '读代码', status: 'completed' }, { text: '写测试', status: 'in_progress' }] },
  });
  assert.deepEqual(evs, [{ type: 'todo', items: [{ text: '读代码', status: 'completed' }, { text: '写测试', status: 'in_progress' }] }]);
  // 空清单不出事件（不摆一个空框）
  assert.deepEqual(parseCodexEvent({ type: 'item.completed', item: { type: 'todo_list', items: [] } }), []);
  // 条目认 text / title / content 三种写法，status 缺省空串
  const alt = parseCodexEvent({ type: 'item.completed', item: { type: 'todo_list', items: [{ content: 'C' }, { title: 'T' }] } })[0];
  assert.deepEqual(alt.items, [{ text: 'C', status: '' }, { text: 'T', status: '' }]);
});

test('zcode 事件：tool.updated 带上工具输出与 id（以前只有名字与尾部摘要）', () => {
  const t = (payload) => parseZcodeEvent({ type: 'tool.updated', sessionId: 's', payload })[0];
  const started = t({ kind: 'started', name: 'bash', toolCallId: 'tc-1' });
  assert.equal(started.id, 'tc-1');
  assert.equal(started.status, 'started');
  const done = t({ kind: 'result', name: 'bash', toolCallId: 'tc-1', output: 'total 3\nfile.txt' });
  assert.equal(done.id, 'tc-1');
  assert.equal(done.status, 'completed');
  assert.equal(done.output, 'total 3\nfile.txt', '工具输出要能到界面');
  // 参数预览也带上（tool_input_delta 那条路不进正文，但入参有地方放）
  assert.equal(t({ kind: 'started', name: 'write', input: '{"path":"a"}' }).input, '{"path":"a"}');
  // 没有输出时不塞空串（避免界面摆一个空块）
  assert.ok(!('output' in t({ kind: 'started', name: 'bash' })));
});

test('zcode 事件：permission.requested 仍是 notice，但带上工具名与入参', () => {
  const ev = parseZcodeEvent({ type: 'permission.requested', payload: { name: 'bash', input: '{"cmd":"rm -rf /"}' } })[0];
  assert.equal(ev.type, 'notice', 'headless 这条路没有回传批准的口子，先照旧当一条提示');
  assert.ok(ev.text.includes('bash'));
  assert.deepEqual(ev.permission, { name: 'bash', input: '{"cmd":"rm -rf /"}' });
});

test('zcode 换证短码翻成人话：用户看到的得是「没订阅 Coding Plan」，不是一串 project_token_*', () => {
  // 真机形状（zcode 0.16.9，2026-10-12 实测）：turn.failed 的 payload.error 里 message 就是一个短码。
  // 实测撞到的就是它——账号（Z.ai / 智谱）没有生效中的 Coding Plan 时，换证被上游拒绝。
  const ev = (error) => parseZcodeEvent({ type: 'turn.failed', payload: { error } })[0];
  const failed = ev({ code: 'project_token_login_failed', message: 'project_token_login_failed' });
  assert.equal(failed.type, 'error');
  assert.ok(!failed.message.includes('project_token_'), '短码不该原样摆给用户看：' + failed.message);
  assert.match(failed.message, /Coding Plan/, '要说清多半是没订阅（这是最常见的那一种）');
  assert.equal(failed.auth, true, '带 auth 标记，前端才会补一句「怎么办」');
  // message 缺、只有 code 时也认
  assert.equal(ev({ code: 'project_token_login_required' }).auth, true);
  // 认不出来的错原样透出（CLI 升级后新增的错不该被吞），marker 留给 runCliTurn 去判
  const other = ev({ message: '模型报错' });
  assert.equal(other.message, '模型报错');
  assert.equal(other.auth, undefined);
});

test('一行 stdout → 事件：codex 只认 JSON 行；zcode 的纯文本行就是正文', () => {
  assert.deepEqual(parseLine('codex', ''), []);
  assert.deepEqual(parseLine('codex', 'npm WARN something'), [], 'codex 的进度/警告不进正文');
  assert.deepEqual(parseLine('codex', '{oops'), []);
  assert.deepEqual(parseLine('nope', '{"type":"result"}'), []);
  assert.deepEqual(parseLine('codex', JSON.stringify({ type: 'thread.started', thread_id: 'x' })).map((e) => e.type), ['session']);
  // zcode 传了 --output-format stream-json 时是 NDJSON；纯文本行只在没传那参数时才出现在 stdout
  // （警告/进度多半走 stderr）。收成 text 是保守做法：宁可多显示一行，也别把回答吞了。
  assert.deepEqual(parseLine('zcode', '你好，我是 ZCode。'), [{ type: 'text', text: '你好，我是 ZCode。' }]);
  assert.deepEqual(parseLine('zcode', '{oops'), [], '坏 JSON 照样丢');
  assert.deepEqual(parseLine('zcode', ''), []);
});

// —— ③ 真跑一轮（桩 CLI）——
function stubBin(dir, name, script) {
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  writeFileSync(p, script);
  chmodSync(p, 0o755);
  return dir;
}

async function collect(gen) {
  const out = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

test('跑桩 codex：逐行 JSONL → 归一事件流（含会话 id 与收尾）', async () => {
  const dir = stubBin(mkdtempSync(path.join(os.tmpdir(), 'stub-codex-')), 'codex', `#!/bin/sh
echo '{"type":"thread.started","thread_id":"tid-42"}'
echo '{"type":"turn.started"}'
echo '{"type":"item.completed","item":{"type":"agent_message","text":"hello "}}'
echo '{"type":"item.completed","item":{"type":"command_execution","command":"ls","exit_code":0}}'
echo 'not json at all'
echo '{"type":"item.completed","item":{"type":"agent_message","text":"world"}}'
echo '{"type":"turn.completed","usage":{"output_tokens":7}}'
`);
  const evs = await collect(runCliTurn('codex', { prompt: 'hi', cwd: dir, env: { ...process.env, PATH: dir + ':' + process.env.PATH } }));
  assert.deepEqual(evs.map((e) => e.type), ['start', 'session', 'text', 'tool', 'text', 'done']);
  assert.equal(evs[1].sessionId, 'tid-42');
  assert.equal(evs.find((e) => e.type === 'done').sessionId, 'tid-42', 'done 要带上会话 id 供续聊');
  assert.equal(evs.filter((e) => e.type === 'text').map((e) => e.text).join(''), 'hello world');
});

test('跑桩 zcode：真实 stream-json 形状（事件行 + 末行 result）→ 归一事件流', async () => {
  // 形状照官方 session-mapper.ts 的 mapSessionEvent：{eventId,payload,sessionId,traceId,type}。
  const dir = stubBin(mkdtempSync(path.join(os.tmpdir(), 'stub-zcode-')), 'zcode', `#!/bin/sh
echo '{"type":"session.created","sessionId":"sess-9","eventId":"1"}'
echo '{"type":"turn.started","sessionId":"sess-9","eventId":"2"}'
echo '{"type":"model.streaming","sessionId":"sess-9","eventId":"3","payload":{"kind":"reasoning_delta","delta":"想一下"}}'
echo '{"type":"model.streaming","sessionId":"sess-9","eventId":"4","payload":{"kind":"text_delta","delta":"读完了"}}'
echo '{"type":"tool.updated","sessionId":"sess-9","eventId":"5","payload":{"kind":"started","name":"bash"}}'
echo '{"type":"tool.updated","sessionId":"sess-9","eventId":"6","payload":{"kind":"result","name":"bash","output":"ok"}}'
echo '{"type":"model.streaming","sessionId":"sess-9","eventId":"7","payload":{"kind":"text_delta","delta":"三个文件。"}}'
echo '{"type":"turn.completed","sessionId":"sess-9","eventId":"8","payload":{"response":"读完了三个文件。"}}'
echo '{"type":"result","sessionId":"sess-9","response":"读完了三个文件。","usage":{"total":9},"projection":{"status":"completed"}}'
`);
  const evs = await collect(runCliTurn('zcode', { prompt: 'hi', env: { ...process.env, PATH: dir + ':' + process.env.PATH } }));
  assert.deepEqual(evs.map((e) => e.type),
    ['start', 'session', 'reasoning', 'text', 'tool', 'tool', 'text', 'done']);
  assert.equal(evs.find((e) => e.type === 'session').sessionId, 'sess-9');
  // 逐字增量拼起来就是完整回答；末行 result 的 response 不该再重复一遍
  const body = evs.filter((e) => e.type === 'text').map((e) => e.text).join('');
  assert.equal(body, '读完了三个文件。');
  assert.equal(evs.at(-1).sessionId, 'sess-9', 'done 要带会话 id 供续聊');
  assert.deepEqual(evs.find((e) => e.type === 'done').usage, { total: 9 });
});

test('跑桩 zcode：没流增量时，用末行 result 的 response 兜底（不留空回复）', async () => {
  const dir = stubBin(mkdtempSync(path.join(os.tmpdir(), 'stub-zcode2-')), 'zcode', `#!/bin/sh
echo '{"type":"result","sessionId":"sess-1","response":"答案：读完了三个文件。","projection":{"status":"completed"}}'
`);
  const evs = await collect(runCliTurn('zcode', { prompt: 'hi', env: { ...process.env, PATH: dir + ':' + process.env.PATH } }));
  assert.deepEqual(evs.map((e) => e.type), ['start', 'session', 'text', 'done']);
  assert.equal(evs[2].text, '答案：读完了三个文件。');
  assert.equal(evs.at(-1).sessionId, 'sess-1');
});

test('跑桩 zcode：CLI 报 turn.failed → 落成错误事件（不静默）', async () => {
  const dir = stubBin(mkdtempSync(path.join(os.tmpdir(), 'stub-zcode3-')), 'zcode', `#!/bin/sh
echo '{"type":"turn.failed","sessionId":"s1","payload":{"message":"模型不可用"}}'
`);
  const evs = await collect(runCliTurn('zcode', { prompt: 'hi', env: { ...process.env, PATH: dir + ':' + process.env.PATH } }));
  assert.equal(evs[1].type, 'error');
  assert.ok(evs[1].message.includes('模型不可用'));
});

test('CLI 不在 PATH 上：给一句能照做的说明，而不是抛错', async () => {
  const empty = mkdtempSync(path.join(os.tmpdir(), 'stub-empty-'));
  const evs = await collect(runCliTurn('codex', { prompt: 'hi', env: { PATH: empty, HOME: empty, BRIDGE_AGENT_BIN_DIR: '' } }));
  assert.equal(evs.length, 1);
  assert.equal(evs[0].type, 'error');
  assert.ok(evs[0].message.includes('还没装'), evs[0].message);
  assert.ok(CLI_MISSING_NOTE.codex.includes('chatgpt.com/codex/install.sh'));
  assert.ok(CLI_MISSING_NOTE.zcode.includes('zcode login'));
});

// —— ④ 凭据：存的那把 key 注进子进程 env ——
// 这两家的登录都是交互式的（网页上点不了），所以服务器上存一把 key 是主要接法（设置 → Agent）。
test('存下的 key 注进子进程 env（桩把 OPENAI_API_KEY 打出来），空 key = 回落进程环境', async () => {
  setAgentKey('codex', 'sk-test-1234');
  assert.equal(savedAgentKey('codex'), 'sk-test-1234');
  const dir = stubBin(mkdtempSync(path.join(os.tmpdir(), 'stub-key-')), 'codex', `#!/bin/sh
echo "{\\"type\\":\\"item.completed\\",\\"item\\":{\\"type\\":\\"agent_message\\",\\"text\\":\\"key=$OPENAI_API_KEY\\"}}"
echo '{"type":"turn.completed"}'
`);
  const env = { ...process.env, PATH: dir + ':' + process.env.PATH, BRIDGE_AGENT_BIN_DIR: '', OPENAI_API_KEY: 'sk-from-env' };
  const withKey = await collect(runCliTurn('codex', { prompt: 'hi', env }));
  assert.ok(withKey.some((e) => e.type === 'text' && e.text === 'key=sk-test-1234'),
    '服务器上存的那把要压过环境变量：' + JSON.stringify(withKey));
  // 清掉之后回落环境变量（运维在单元文件里配 key 的做法照旧可用）
  setAgentKey('codex', '');
  assert.equal(savedAgentKey('codex'), '');
  const fallback = await collect(runCliTurn('codex', { prompt: 'hi', env }));
  assert.ok(fallback.some((e) => e.type === 'text' && e.text === 'key=sk-from-env'), JSON.stringify(fallback));
  setAgentKey('codex', '');   // 收尾：别把凭据留在测试数据根里
});

test('未知 agent 没有 key 可存', () => {
  assert.ok(setAgentKey('claude', 'x').error);
  assert.ok(setAgentKey('nope', 'x').error);
});

test('CLI 非零退出：说明里带退出码（分页显示错误，不静默）', async () => {
  const dir = stubBin(mkdtempSync(path.join(os.tmpdir(), 'stub-fail-')), 'codex', `#!/bin/sh
echo '{"type":"thread.started","thread_id":"t"}' 
echo "boom: not logged in" >&2
exit 3
`);
  const evs = await collect(runCliTurn('codex', { prompt: 'hi', env: { ...process.env, PATH: dir + ':' + process.env.PATH } }));
  const err = evs.find((e) => e.type === 'error');
  assert.ok(err, '要有 error 事件');
  assert.ok(err.message.includes('3'), err.message);
  assert.ok(err.message.includes('not logged in'), 'stderr 尾巴要带上，' + err.message);
  assert.equal(evs.at(-1).type, 'done');
  assert.equal(evs.at(-1).failed, true);
});

test('stderr 里那片天书要收拾成人话（Symbol 包装 / 对象残渣 / 堆栈帧都不给用户看）', () => {
  // 2026-10-12 实测 zcode 登录后报错时的真实 stderr 形状（截图里页面上那行就是它）
  const raw = '\u001b[31mSymbol(vercel.ai.error.AI_APICallError): true } Error: Turn execution failed (traceId: 1747c477-4e31-498e-b13b-3d3e0dcfbee5)\u001b[0m\n'
    + '    at async runTurn (/app/agent/zcode.cjs:48122:19)\n'
    + '    at async main (/app/agent/zcode.cjs:9:1)';
  const s = stderrMessage(raw);
  assert.ok(!s.includes('Symbol('), '内部符号包装不该露出来：' + s);
  assert.ok(!s.includes('true }'), '对象残渣不该露出来：' + s);
  assert.ok(!s.includes('at async'), '堆栈帧不该露出来：' + s);
  assert.ok(!s.includes('\u001b'), 'ANSI 颜色码要剥掉：' + JSON.stringify(s));
  assert.ok(s.includes('Turn execution failed'), s);
  // 退出码那一句挂着它
  assert.equal(cliFailureNote(1, raw), 'CLI 退出码 1：' + s);
  // 没东西可读时只说退出码
  assert.equal(cliFailureNote(3, ''), 'CLI 退出码 3');
  assert.equal(stderrMessage(''), '');
});

test('换证短码从 stderr / 退出码那条路来时也翻成人话（那条路最常撞上）', () => {
  const raw = 'some wrapper junk\nproject_token_login_failed\n';
  const note = cliFailureNote(1, raw);
  assert.ok(!note.includes('project_token_login_failed'), '短码不该原样摆给用户看：' + note);
  assert.match(note, /Coding Plan/);
  assert.match(note, /^CLI 退出码 1：/, '退出码还是要说');
});

test('认证类失败要打标记（前端据此给「怎么办」），普通失败不误标', () => {
  // 实测：zcode 登录失败时就这一句，z.ai 那边是 401 auth_failed
  assert.equal(isAuthFailure('Provider authentication failed.'), true);
  assert.equal(isAuthFailure('CLI 退出码 1：Unauthorized'), true);
  assert.equal(isAuthFailure('invalid api key'), true);
  assert.equal(isAuthFailure('token expired'), true);
  assert.equal(isAuthFailure('还没登录'), true);
  // 不是认证问题的一律别标（否则用户被指去重新登录，白折腾）
  assert.equal(isAuthFailure('命令退出码 2'), false);
  assert.equal(isAuthFailure('ENOENT: no such file'), false);
  assert.equal(isAuthFailure(''), false);
  assert.equal(isAuthFailure(undefined), false);
});

test('同一件错连报多次只留第一遍（codex 的重试播报，页面上别刷五行）', () => {
  // 线上抓到的真实一轮：8 条同义播报（重试计数、cf-ray、request id、wss/https 各不相同）
  const I = 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: ';
  const raws = [
    'Reconnecting... 2/5 (' + I + 'wss://api.openai.com/v1/responses, cf-ray: a494057e3ad0b20a-ATL)',
    'Reconnecting... 1/5 (' + I + 'https://api.openai.com/v1/responses, cf-ray: a49405ad8f2423ef-SEA, request id: req_1a)',
    'Reconnecting... 2/5 (' + I + 'https://api.openai.com/v1/responses, cf-ray: a49405b20a2cc991-IAD, request id: req_2b)',
    'Reconnecting... 3/5 (' + I + 'https://api.openai.com/v1/responses, cf-ray: a49405b6eb37fc0f-DEN, request id: req_3c)',
    'Reconnecting... 4/5 (' + I + 'https://api.openai.com/v1/responses, cf-ray: a49405be7a4d5027-LAX, request id: req_4d)',
    'Reconnecting... 5/5 (' + I + 'https://api.openai.com/v1/responses, cf-ray: a49405cbee281ee0-LAX, request id: req_5e)',
    'Falling back from WebSockets to HTTPS transport. ' + I + 'https://api.openai.com/v1/responses, cf-ray: a49405e11a6afda5-LAX, request id: req_6f',
    'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses, cf-ray: a49405e11a6afda5-LAX, request id: req_ee93e2b8855c4dc1',
  ];
  const keys = new Set(raws.map(errorKey));
  assert.equal(keys.size, 1, '这 8 条是同一件事，必须归成一个键，实际 ' + keys.size);
  assert.ok([...keys][0].includes('unexpected status 401'), '留下的该是那句人话：' + [...keys][0]);
  // 不同的错必须还能区分开
  assert.notEqual(errorKey('ENOENT: no such file or directory, open /nope'), [...keys][0]);
  assert.equal(errorKey('短'), '', '太短的没有比对价值 → 放行（宁可多说也不许误吞）');
});

test('已经推过具体的 error 事件时，不再补一句「CLI 退出码」（同一件事不说两遍）', () => {
  // zcode 的 turn.failed 已经把原因说清楚了，stderr 里又是那段对象倾倒 → 一行就够
  const junk = 'Symbol(vercel.ai.error.AI_APICallError): true } Error: Model creation failed (traceId: x)';
  assert.equal(cliFailureNote(1, junk, true), '', '有具体错误时不该再补一句');
  // 没有结构化错误兜底时，才轮到 stderr 说话
  assert.equal(cliFailureNote(1, junk, false), 'CLI 退出码 1：Model creation failed (traceId: x)');
  assert.equal(cliFailureNote(1, 'Error: fetch failed', false), 'CLI 退出码 1：fetch failed');
});

test('中断（abort）：按进程组杀掉整棵树，立刻收「已中断」（不等它的子进程）', async () => {
  const dir = stubBin(mkdtempSync(path.join(os.tmpdir(), 'stub-slow-')), 'codex', `#!/bin/sh
echo '{"type":"thread.started","thread_id":"slow"}'
sleep 30
echo '{"type":"turn.completed"}'
`);
  const ac = new AbortController();
  const evs = [];
  const t0 = Date.now();
  const gen = runCliTurn('codex', { prompt: 'hi', signal: ac.signal, env: { ...process.env, PATH: dir + ':' + process.env.PATH } });
  setTimeout(() => ac.abort(), 250);
  for await (const ev of gen) evs.push(ev);
  const ms = Date.now() - t0;
  assert.ok(evs.some((e) => e.type === 'notice' && e.text === '已中断'), JSON.stringify(evs));
  assert.equal(evs.at(-1).type, 'done');
  // 桩里还有个 sleep 30：只杀 CLI 自己而不杀进程组的话，这里会拖满 30 秒
  assert.ok(ms < 5000, `中断应当立刻收尾，实际 ${ms}ms`);
});

test('只处理认识的 agent（白名单）', () => {
  assert.deepEqual([...CLI_AGENTS], ['codex', 'zcode']);
});

// —— ⑤ 一步安装（管理员）：只认表里写死的官方命令 ——
test('安装：认得出的 agent 才给装；命令取自表里那一句，不接受调用方传命令', async () => {
  const { installable, runAgentInstall } = await import('./runtime/agent-install.mjs');
  assert.equal(installable('codex'), true);
  assert.equal(installable('zcode'), true);
  assert.equal(installable('claude'), false, '自带的 agent 没有安装命令');
  assert.ok((await runAgentInstall('nope')).error);
  assert.ok((await runAgentInstall('claude')).error, 'claude 走部署脚本，不在这里装');
  // 跑不起来（这个 PATH 上连 bash 都没有）要把失败原样报回来，不能静默「装好了」。
  // 真去跑 curl 那一句是联网安装，测试不碰——这里只钉「失败会说话」。
  const dir = stubBin(mkdtempSync(path.join(os.tmpdir(), 'stub-install-')), 'codex', '#!/bin/sh\nexit 1\n');
  const r = await runAgentInstall('codex', { env: { ...process.env, PATH: dir, BRIDGE_AGENT_BIN_DIR: '' } });
  assert.ok(r.error, '要报错而不是吞掉：' + JSON.stringify(r));
  assert.equal(typeof r.installed, 'boolean');
});
