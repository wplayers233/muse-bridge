// agent-appserver 纯函数的单测：不起新进程，只验协议归一。
// 形状依据：codex-cli 0.162.1 `app-server generate-json-schema` 导出的官方 schema（U1/U2/U6 已复核）。
import test from 'node:test';
import assert from 'node:assert/strict';
const { buildTurnInput, appPlanItems, appToolName, normAppToolItem, normAppStatus }
  = await import('./runtime/agent-appserver.mjs');

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
