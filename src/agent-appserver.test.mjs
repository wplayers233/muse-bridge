// agent-appserver 纯函数的单测：不起新进程，只验协议归一。
// 形状依据：codex-cli 0.162.1 `app-server generate-json-schema` 导出的官方 schema（U1/U2/U6 已复核）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
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
  if (m.method === 'model/list') { send({ jsonrpc: '2.0', id: m.id, result: { data: [{ model: 'fake-model', isDefault: true }] } }); return; }
  if (m.method === 'thread/start') { send({ jsonrpc: '2.0', id: m.id, result: { thread: { id: 'th_fake' } } }); return; }
  if (m.method === 'turn/start') {
    send({ jsonrpc: '2.0', id: m.id, result: { turn: { id: 't1' } } });
    const n = (method, params) => send({ jsonrpc: '2.0', method, params });
    // 抓包：测试读这个文件断言 turn/start 到底带了什么（planMode 的 collaborationMode）。
    if (process.env.FAKE_CAPTURE) { try { require('node:fs').writeFileSync(process.env.FAKE_CAPTURE, JSON.stringify(m.params || {})); } catch {} }
    // 计划模式才有 plan 增量（真机行为：普通轮没有 item/plan/delta）。
    if (m.params && m.params.collaborationMode) {
      n('item/plan/delta', { threadId: 'th_fake', turnId: 't1', itemId: 'pl1', delta: '第一步：读代码' });
      n('item/plan/delta', { threadId: 'th_fake', turnId: 't1', itemId: 'pl1', delta: '第二步：改实现' });
    }
    n('item/started', { threadId: 'th_fake', turnId: 't1', item: { type: 'sleep', id: 's1', durationMs: 1500 } });
    n('item/completed', { threadId: 'th_fake', turnId: 't1', item: { type: 'sleep', id: 's1', durationMs: 1500 } });
    n('item/started', { item: { type: 'enteredReviewMode', id: 'r1', review: '检查刚写的代码' } });
    n('item/started', { item: { type: 'exitedReviewMode', id: 'r2', review: '' } });
    n('item/started', { item: { type: 'plan', id: 'p1', text: '纯文本计划快照不应出现' } });
    n('item/fileChange/patchUpdated', { threadId: 'th_fake', turnId: 't1', itemId: 'fc1', changes: [{ path: 'src/a.js', kind: 'update', diff: '@@ -1 +1 @@' }] });
    n('item/commandExecution/terminalInteraction', { threadId: 'th_fake', turnId: 't1', itemId: 'ce1', processId: 'p9', stdin: 'Continue? [y/N]' });
    // P4：之前被丢掉的通知（形状按本机 codex 0.149.0 的 ServerNotification.json）。
    n('configWarning', { summary: '配置警告摘要', details: '详情' });
    n('warning', { message: '通用警告' });
    n('guardianWarning', { message: '守护警告', threadId: 'th_fake' });
    n('deprecationNotice', { summary: '某功能已废弃', details: '请迁移' });
    n('model/rerouted', { fromModel: 'gpt-5.6-terra', toModel: 'gpt-5.6', reason: 'highRiskCyberActivity', threadId: 'th_fake', turnId: 't1' });
    n('mcpServer/startupStatus/updated', { name: 'mcp-a', status: 'failed', error: '连不上', failureReason: null, threadId: null });
    n('mcpServer/startupStatus/updated', { name: 'mcp-b', status: 'ready', error: null, failureReason: null, threadId: null });
    n('thread/name/updated', { threadId: 'th_fake', threadName: '自动命名标题' });
    n('turn/diff/updated', { diff: 'diff --git a/x b/x', threadId: 'th_fake', turnId: 't1' });
    // 超长 diff：后端截到 20_000 并带 truncated 标记（审阅面板「上一轮」靠它提示截断）。
    n('turn/diff/updated', { diff: 'y'.repeat(20001), threadId: 'th_fake', turnId: 't1' });
    n('project/changed', { changeType: 'updated', projectId: 'p1' });
    n('skills/changed', {});
    n('item/mcpToolCall/progress', { itemId: 'mcp1', message: '正在查…', threadId: 'th_fake', turnId: 't1' });
    n('thread/settings/updated', { threadId: 'th_fake', threadSettings: { model: 'gpt-5.6-terra', effort: 'high' } });
    n('thread/status/changed', { threadId: 'th_fake', status: { type: 'active', activeFlags: ['waitingOnApproval'] } });
    n('remoteControl/status/changed', { installationId: 'i1', serverName: 'htch-runtime', status: 'connected', environmentId: null });
    n('account/rateLimits/updated', { rateLimits: {} });
    n('account/updated', { planType: 'plus', authMode: 'chatgpt' });
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
    // 桩要两个平台都能跑：BIN_NAMES 在非 win32 上只找【无扩展名】的 codex，而 resolveWinShim
    // 非 win32 直接原样返回、不解析上面的 .cmd —— 只写 .cmd 的话这个用例在 Linux 上必挂。
    const sh = path.join(binDir, 'codex');
    writeFileSync(sh, '#!/bin/sh\nexec ' + JSON.stringify(process.execPath) + ' ' + JSON.stringify(path.join(realDir, 'codex.js')) + ' "$@"\n');
    chmodSync(sh, 0o755);
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

// ── 计划模式（P2）：turn/start 带 collaborationMode，plan 增量成 plan 事件 ─────
// 假 codex 复用上面的 FAKE_CODEX（model/list + turn/start 抓包 + 计划模式才发 plan 增量）。
async function withFakeCodex(fn) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'bridge-fake-codex-'));
  try {
    const binDir = path.join(tmp, 'node_modules', '.bin');
    const realDir = path.join(tmp, 'node_modules', '@openai', 'codex', 'bin');
    mkdirSync(realDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(path.join(binDir, 'codex.cmd'), '@echo off\r\nnode "%~dp0\\..\\@openai\\codex\\bin\\codex.js" %*\r\n');
    writeFileSync(path.join(realDir, 'codex.js'), FAKE_CODEX);
    const sh = path.join(binDir, 'codex');
    writeFileSync(sh, '#!/bin/sh\nexec ' + JSON.stringify(process.execPath) + ' ' + JSON.stringify(path.join(realDir, 'codex.js')) + ' "$@"\n');
    chmodSync(sh, 0o755);
    const capture = path.join(tmp, 'turn-start.json');
    const env = { ...process.env, BRIDGE_AGENT_BIN_DIR: '', PATH: binDir + path.delimiter + (process.env.PATH || ''), FAKE_CAPTURE: capture };
    await fn({ env, capture });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

test('runAppServerTurn：planMode 时 turn/start 带 collaborationMode，plan 增量成 plan 事件', async () => {
  await withFakeCodex(async ({ env, capture }) => {
    const events = [];
    for await (const ev of runAppServerTurn('codex', { prompt: '做个计划', env, keyEnv: {}, planMode: true, model: 'gpt-5.6-terra' })) events.push(ev);
    const params = JSON.parse(readFileSync(capture, 'utf8'));
    assert.deepEqual(params.collaborationMode, { mode: 'plan', settings: { model: 'gpt-5.6-terra' } });
    assert.deepEqual(events.filter((e) => e.type === 'plan').map((e) => e.text), ['第一步：读代码', '第二步：改实现']);
    assert.equal(events.find((e) => e.type === 'done').failed, false);
  });
});

test('runAppServerTurn：不带 planMode 时 turn/start 不带 collaborationMode，也不发 plan 事件', async () => {
  await withFakeCodex(async ({ env, capture }) => {
    const events = [];
    for await (const ev of runAppServerTurn('codex', { prompt: '普通一轮', env, keyEnv: {} })) events.push(ev);
    const params = JSON.parse(readFileSync(capture, 'utf8'));
    assert.ok(!('collaborationMode' in params));
    assert.equal(events.filter((e) => e.type === 'plan').length, 0);
  });
});

test('runAppServerTurn：P4 被丢的通知现在都有分支（警告/改派/MCP/命名/diff/项目/技能/进度/设置/状态/额度/账户）', async () => {
  await withFakeCodex(async ({ env }) => {
    const events = [];
    for await (const ev of runAppServerTurn('codex', { prompt: '走一轮', env, keyEnv: {} })) events.push(ev);
    const notices = events.filter((e) => e.type === 'notice').map((e) => e.text);
    assert.ok(notices.includes('配置警告摘要：详情'));
    assert.ok(notices.includes('通用警告'));
    assert.ok(notices.includes('守护警告'));
    assert.ok(notices.includes('某功能已废弃：请迁移'));
    assert.ok(notices.includes('模型已由 gpt-5.6-terra 改派为 gpt-5.6'));
    assert.ok(notices.includes('MCP 服务 mcp-a 启动失败：连不上'));
    const kinds = (t) => events.filter((e) => e.type === t);
    assert.deepEqual(kinds('mcp'), [{ type: 'mcp', name: 'mcp-b', status: 'ready' }]);
    assert.deepEqual(kinds('sessionName'), [{ type: 'sessionName', sessionId: 'th_fake', name: '自动命名标题' }]);
    assert.deepEqual(kinds('diff')[0], { type: 'diff', diff: 'diff --git a/x b/x', truncated: false });
    assert.deepEqual(kinds('projectChanged'), [{ type: 'projectChanged', changeType: 'updated', projectId: 'p1' }]);
    assert.equal(kinds('skillsChanged').length, 1);
    assert.deepEqual(kinds('toolProgress'), [{ type: 'toolProgress', id: 'mcp1', message: '正在查…' }]);
    assert.deepEqual(kinds('settings'), [{ type: 'settings', model: 'gpt-5.6-terra', effort: 'high' }]);
    assert.deepEqual(kinds('threadStatus'), [{ type: 'threadStatus', status: 'active', flags: ['waitingOnApproval'] }]);
    assert.deepEqual(kinds('remoteControl'), [{ type: 'remoteControl', status: 'connected', serverName: 'htch-runtime' }]);
    assert.equal(kinds('ratelimits').length, 1);
    assert.deepEqual(kinds('account'), [{ type: 'account', planType: 'plus', authMode: 'chatgpt' }]);
    assert.equal(events.find((e) => e.type === 'done').failed, false);
  });
});

test('runAppServerTurn：turn/diff/updated 超过 20000 字截断并带 truncated 标记', async () => {
  await withFakeCodex(async ({ env }) => {
    const events = [];
    for await (const ev of runAppServerTurn('codex', { prompt: '走一轮', env, keyEnv: {} })) events.push(ev);
    const diffs = events.filter((e) => e.type === 'diff');
    assert.equal(diffs.length, 2);
    assert.equal(diffs[1].truncated, true, '超长 diff 带 truncated 标记');
    assert.equal(diffs[1].diff.length, 20000, '超长 diff 截到 20_000');
    assert.equal(diffs[1].diff, 'y'.repeat(20000));
  });
});

test('runAppServerTurn：planMode 且没选模型时从 model/list 拿默认模型', async () => {
  await withFakeCodex(async ({ env, capture }) => {
    const events = [];
    for await (const ev of runAppServerTurn('codex', { prompt: '做个计划', env, keyEnv: {}, planMode: true })) events.push(ev);
    const params = JSON.parse(readFileSync(capture, 'utf8'));
    assert.equal(params.collaborationMode.settings.model, 'fake-model');
    assert.equal(events.find((e) => e.type === 'done').failed, false);
  });
});
