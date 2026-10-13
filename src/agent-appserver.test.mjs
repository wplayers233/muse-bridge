// agent-appserver 纯函数的单测：不起新进程，只验协议归一。
// 形状依据：codex-cli 0.162.1 `app-server generate-json-schema` 导出的官方 schema（U1/U2/U6 已复核）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const mod = await import('./runtime/agent-appserver.mjs');
const { buildTurnInput, appPlanItems, appToolName, normAppToolItem, normAppStatus, runAppServerTurn } = mod;

test('buildTurnInput：无图时只有一条 text', () => {
  assert.deepEqual(buildTurnInput('你好'), [{ type: 'text', text: '你好' }]);
});

test('buildTurnInput：多图时 text 在前、localImage 逐条跟上（驼峰，带 path）', () => {
  const input = buildTurnInput('看看这两张', ['/tmp/a.png', '/tmp/b.jpg']);
  assert.deepEqual(input, [
    { type: 'text', text: '看看这两张' },
    { type: 'localImage', path: '/tmp/a.png' },
    { type: 'localImage', path: '/tmp/b.jpg' },
  ]);
});

test('buildTurnInput：中文路径原样保留；空串图片项被丢弃', () => {
  const input = buildTurnInput('图', ['C:\\用户\\叶壮壮\\桌面\\截图 1.png', '']);
  assert.deepEqual(input, [
    { type: 'text', text: '图' },
    { type: 'localImage', path: 'C:\\用户\\叶壮壮\\桌面\\截图 1.png' },
  ]);
});

test('buildTurnInput：空轮次兜底成一条空 text（input 不允许为空数组）', () => {
  assert.deepEqual(buildTurnInput(''), [{ type: 'text', text: '' }]);
  assert.deepEqual(buildTurnInput('', []), [{ type: 'text', text: '' }]);
  assert.deepEqual(buildTurnInput(null, 'not-array'), [{ type: 'text', text: '' }]);
});

test('appPlanItems：inProgress 映射成 in_progress，空条目过滤', () => {
  const items = appPlanItems([
    { step: '先读代码', status: 'completed' },
    { step: '改实现', status: 'inProgress' },
    { step: '跑测试', status: 'pending' },
    { step: '', status: 'pending' },
    null,
  ]);
  assert.deepEqual(items, [
    { text: '先读代码', status: 'completed' },
    { text: '改实现', status: 'in_progress' },
    { text: '跑测试', status: 'pending' },
  ]);
});

test('appPlanItems：非数组/缺字段不出错', () => {
  assert.deepEqual(appPlanItems(undefined), []);
  assert.deepEqual(appPlanItems('nope'), []);
});

test('appToolName：MCP 用 server · tool，搜索带 query（与 exec 路同一套说法）', () => {
  assert.equal(appToolName({ type: 'mcpToolCall', server: 'fs', tool: 'read_file' }), 'fs · read_file');
  assert.equal(appToolName({ type: 'mcpToolCall' }), 'MCP 工具');
  assert.equal(appToolName({ type: 'webSearch', query: 'rust async book' }), '联网搜索：rust async book');
  assert.equal(appToolName({ type: 'webSearch' }), '联网搜索');
});

test('normAppToolItem：mcpToolCall 取 result.content 的 text 块，失败给 error.message', () => {
  const ok = normAppToolItem({
    type: 'mcpToolCall', id: 'm1', server: 'fs', tool: 'read_file', status: 'completed',
    result: { content: [{ type: 'text', text: '文件内容' }, { type: 'text', text: '第二段' }] },
  }, 'completed');
  assert.equal(ok.name, 'fs · read_file');
  assert.equal(ok.tool, 'read_file');
  assert.equal(ok.status, 'completed');
  assert.equal(ok.output, '文件内容\n第二段');

  const bad = normAppToolItem({
    type: 'mcpToolCall', id: 'm2', server: 'fs', tool: 'boom', status: 'failed',
    error: { message: '工具炸了' },
  }, 'completed');
  assert.equal(bad.status, 'failed');
  assert.equal(bad.output, '工具炸了');
});

test('normAppToolItem：webSearch 无 status 字段时按 phase 兜底', () => {
  const ev = normAppToolItem({ type: 'webSearch', id: 'w1', query: 'test' }, 'started');
  assert.equal(ev.name, '联网搜索：test');
  assert.equal(ev.status, 'started');
  const done = normAppToolItem({ type: 'webSearch', id: 'w1', query: 'test' }, 'completed');
  assert.equal(done.status, 'completed');
});

test('normAppStatus：MCP 的 inProgress/completed/failed 与界面词汇对齐', () => {
  assert.equal(normAppStatus({ status: 'inProgress' }), 'started');
  assert.equal(normAppStatus({ status: 'completed' }), 'completed');
  assert.equal(normAppStatus({ status: 'failed' }), 'failed');
});

// ── 9 种 ThreadItem 归一（P2 补遗，字段名对照 0.162.1 v2 schema）──────────────

test('appToolName：动态/协作/子代理/函数输出四类的标题', () => {
  assert.equal(appToolName({ type: 'dynamicToolCall', tool: 'browser' }), '动态工具：browser');
  assert.equal(appToolName({ type: 'dynamicToolCall' }), '动态工具');
  assert.equal(appToolName({ type: 'collabAgentToolCall', tool: 'spawnAgent' }), '协作代理 · spawnAgent');
  // 子代理取 agentPath 的基名（Windows 反斜杠也认）。
  assert.equal(appToolName({ type: 'subAgentActivity', agentPath: 'C:\\work\\researcher' }), '子代理：researcher');
  assert.equal(appToolName({ type: 'subAgentActivity', agentPath: '/home/u/planner' }), '子代理：planner');
  assert.equal(appToolName({ type: 'functionCallOutput', name: 'run_query' }), 'run_query');
  assert.equal(appToolName({ type: 'functionCallOutput' }), '函数调用');
});

test('normAppToolItem：dynamicToolCall 取 contentItems 的 inputText 块，非文本块忽略', () => {
  const ev = normAppToolItem({
    type: 'dynamicToolCall', id: 'd1', tool: 'browser', status: 'completed',
    contentItems: [{ type: 'inputText', text: '页面标题' }, { type: 'inputImage', imageUrl: 'x.png' }],
  }, 'completed');
  assert.equal(ev.name, '动态工具：browser');
  assert.equal(ev.tool, 'browser');
  assert.equal(ev.output, '页面标题');
  assert.equal(ev.status, 'completed');
});

test('normAppToolItem：collabAgentToolCall 拼 prompt 与 agentsStates', () => {
  const ev = normAppToolItem({
    type: 'collabAgentToolCall', id: 'c1', tool: 'spawnAgent', status: 'completed',
    prompt: '帮我查一下', agentsStates: { researcher: { status: 'completed' } },
  }, 'completed');
  assert.equal(ev.name, '协作代理 · spawnAgent');
  assert.equal(ev.output, '帮我查一下\nresearcher：completed');
});

test('normAppToolItem：subAgentActivity 的 kind 自带结论（completed/interrupted）', () => {
  const ok = normAppToolItem({ type: 'subAgentActivity', id: 's1', agentPath: '/a/researcher', agentThreadId: 't1', kind: 'completed' }, 'started');
  assert.equal(ok.status, 'completed');
  assert.equal(ok.summary, 'completed');
  const bad = normAppToolItem({ type: 'subAgentActivity', id: 's2', agentPath: '/a/planner', agentThreadId: 't2', kind: 'interrupted' }, 'started');
  assert.equal(bad.status, 'failed');
  const mid = normAppToolItem({ type: 'subAgentActivity', id: 's3', agentPath: '/a/worker', agentThreadId: 't3', kind: 'interacted' }, 'started');
  assert.equal(mid.status, 'started');
});

test('normAppToolItem：functionCallOutput 的 output 字符串与块数组两种形状都认', () => {
  const s = normAppToolItem({ type: 'functionCallOutput', id: 'f1', name: 'run_query', output: 'rows: 3' }, 'completed');
  assert.equal(s.output, 'rows: 3');
  const arr = normAppToolItem({ type: 'functionCallOutput', id: 'f2', name: 'run_blocks', output: [{ type: 'text', text: '块一' }, { type: 'other' }] }, 'completed');
  assert.equal(arr.output, '块一');
  const empty = normAppToolItem({ type: 'functionCallOutput', id: 'f3', name: 'nope', output: null }, 'completed');
  assert.equal(empty.output, undefined);
});

// generator 级集成测试：用假 codex（.cmd 垫片 → 包内 .js，与真机布局一致）喂一整轮通知，
// 验 sleep / 评审模式 / plan 跳过 / patchUpdated / terminalInteraction 这些挂在消息循环里的分支。
const FAKE_CODEX = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => { try { process.stdout.write(JSON.stringify(o) + '\\n'); } catch {} };
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id == null) return;
  if (m.method === 'initialize') { send({ jsonrpc: '2.0', id: m.id, result: { model: 'fake' } }); return; }
  if (m.method === 'thread/start') { send({ jsonrpc: '2.0', id: m.id, result: { thread: { id: 'th_fake' } } }); return; }
  if (m.method === 'turn/start') {
    send({ jsonrpc: '2.0', id: m.id, result: { turn: { id: 't1' } } });
    const n = (method, params) => send({ jsonrpc: '2.0', method, params });
    n('item/started', { threadId: 'th_fake', turnId: 't1', item: { type: 'sleep', id: 's1', durationMs: 1500 } });
    n('item/completed', { threadId: 'th_fake', turnId: 't1', item: { type: 'sleep', id: 's1', durationMs: 1500 } });
    n('item/started', { item: { type: 'enteredReviewMode', id: 'r1', review: '检查刚写的代码' } });
    n('item/started', { item: { type: 'exitedReviewMode', id: 'r2', review: '' } });
    n('item/started', { item: { type: 'plan', id: 'p1', text: '纯文本计划快照不应出现' } });
    n('item/fileChange/patchUpdated', { threadId: 'th_fake', turnId: 't1', itemId: 'fc1', changes: [{ path: 'src/a.js', kind: 'update', diff: '@@ -1 +1 @@' }] });
    n('item/commandExecution/terminalInteraction', { threadId: 'th_fake', turnId: 't1', itemId: 'ce1', processId: 'p9', stdin: 'Continue? [y/N]' });
    n('turn/completed', { threadId: 'th_fake', turnId: 't1', turn: { status: 'completed' } });
    return;
  }
  send({ jsonrpc: '2.0', id: m.id, result: {} });
});
`;

test('runAppServerTurn：消息循环里 sleep/评审/plan/patchUpdated/terminalInteraction 分支', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'bridge-fake-codex-'));
  try {
    const binDir = path.join(tmp, 'node_modules', '.bin');
    const realDir = path.join(tmp, 'node_modules', '@openai', 'codex', 'bin');
    mkdirSync(realDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(path.join(binDir, 'codex.cmd'), '@echo off\r\nnode "%~dp0\\..\\@openai\\codex\\bin\\codex.js" %*\r\n');
    writeFileSync(path.join(realDir, 'codex.js'), FAKE_CODEX);
    // BRIDGE_AGENT_BIN_DIR 置空 = 不用项目自带的 codex；PATH 前插 = 钉住只找到假货。
    const env = { ...process.env, BRIDGE_AGENT_BIN_DIR: '', PATH: binDir + path.delimiter + (process.env.PATH || '') };
    const events = [];
    for await (const ev of runAppServerTurn('codex', { prompt: '走一轮', env, keyEnv: {} })) {
      events.push(ev);
    }
    const kinds = (t) => events.filter((e) => e.type === t);

    assert.equal(kinds('start')[0].sessionId, 'th_fake');
    // sleep：started 给一条「暂停 N 秒」，completed 不再说。
    const pauses = kinds('notice').filter((e) => e.text.startsWith('暂停'));
    assert.deepEqual(pauses.map((e) => e.text), ['暂停 2 秒…']);
    // 评审模式进/出。
    assert.ok(kinds('notice').some((e) => e.text === '进入评审模式：检查刚写的代码'));
    assert.ok(kinds('notice').some((e) => e.text === '退出评审模式'));
    // plan ThreadItem 明确跳过（不出现任何含其文本的事件）。
    assert.ok(!events.some((e) => JSON.stringify(e).includes('纯文本计划快照')));
    // patchUpdated → 按 itemId 的 fileChange updated 工具行（status 停在 started，diff 实时）。
    const patch = kinds('tool').find((e) => e.id === 'fc1');
    assert.equal(patch.name, '改文件（a.js）');
    assert.equal(patch.status, 'started');
    assert.deepEqual(patch.changes, [{ path: 'src/a.js', kind: 'update', diff: '@@ -1 +1 @@' }]);
    // terminalInteraction：通知不是审批请求——给提示，不出 approval 卡。
    assert.ok(kinds('notice').some((e) => e.text === '命令在等待终端输入：Continue? [y/N]'));
    assert.ok(!events.some((e) => e.type === 'approval'));
    // 正常收尾。
    assert.equal(kinds('done')[0].sessionId, 'th_fake');
    assert.equal(kinds('done')[0].failed, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
