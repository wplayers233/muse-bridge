// Codex app-server 传输层的纯函数：协议对象 → 归一事件。
//
// 这一层的形状全部来自真机实测（2026-10-12，codex 0.162.1）与官方 schema，
// 而且**与 exec 那条路不同**——最典型的是 fileChange.changes[].kind 在 app-server 上是
// 对象 {type:'add'}、在 exec 上是字符串。所以这里逐个钉住，防止有人照着 exec 那套改坏。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.env.BRIDGE_DATA_ROOT) process.env.BRIDGE_DATA_ROOT = mkdtempSync(path.join(os.tmpdir(), 'bridge-as-'));
const {
  normChangeKind, appToolName, normAppStatus, normAppToolItem, appUsage, approvalCard, isApprovalMethod,
} = await import('./agent-appserver.mjs');

test('normChangeKind：app-server 给对象 {type}，exec 给字符串，两种都认', () => {
  assert.equal(normChangeKind({ type: 'add' }), 'add');
  assert.equal(normChangeKind({ type: 'update' }), 'update');
  assert.equal(normChangeKind('delete'), 'delete', 'exec 那条路的字符串形状不能丢');
  assert.equal(normChangeKind(null), '');
  assert.equal(normChangeKind({}), '');
});

test('normAppStatus：inProgress→started、completed→completed、failed→failed', () => {
  assert.equal(normAppStatus({ status: 'inProgress' }, 'started'), 'started');
  assert.equal(normAppStatus({ status: 'completed' }, 'completed'), 'completed');
  assert.equal(normAppStatus({ status: 'failed' }, 'completed'), 'failed');
  // 上游没给 status 时按阶段推
  assert.equal(normAppStatus({}, 'started'), 'started');
  assert.equal(normAppStatus({}, 'completed'), 'completed');
});

test('appToolName：命令取首行、改文件列文件名', () => {
  assert.equal(appToolName({ type: 'commandExecution', command: 'npm test\n--watch' }), '命令 npm test');
  assert.equal(appToolName({ type: 'fileChange', changes: [{ path: '/a/b/x.ts' }, { path: '/a/b/y.ts' }] }), '改文件（x.ts、y.ts）');
  assert.equal(appToolName({ type: 'fileChange' }), '改文件');
  assert.equal(appToolName({}), '工具');
});

test('normAppToolItem：命令带 id/command/output/exitCode', () => {
  const ev = normAppToolItem({
    type: 'commandExecution', id: 'exec-1', command: 'ls -la', status: 'completed',
    aggregatedOutput: 'total 3\nfile.txt', exitCode: 0, cwd: '/w',
  }, 'completed');
  assert.deepEqual(ev, {
    type: 'tool', id: 'exec-1', name: '命令 ls -la', status: 'completed',
    command: 'ls -la', output: 'total 3\nfile.txt', exitCode: 0,
  });
  // 还在跑的时候没有 output/exitCode —— 不该塞 undefined 进去
  const running = normAppToolItem({ type: 'commandExecution', id: 'e2', command: 'sleep 1', status: 'inProgress' }, 'started');
  assert.equal(running.status, 'started');
  assert.ok(!('output' in running));
  assert.ok(!('exitCode' in running));
});

test('normAppToolItem：改文件把 kind 归一成字符串、带上 diff', () => {
  const ev = normAppToolItem({
    type: 'fileChange', id: 'fc-1', status: 'completed',
    changes: [{ path: '/w/out.txt', kind: { type: 'add' }, diff: 'hello\n' }],
  }, 'completed');
  assert.equal(ev.name, '改文件（out.txt）');
  assert.deepEqual(ev.changes, [{ path: '/w/out.txt', kind: 'add', diff: 'hello\n' }]);
  // 没路径的条目丢掉
  assert.deepEqual(normAppToolItem({ type: 'fileChange', changes: [{ kind: { type: 'add' } }] }, 'completed').changes, undefined);
});

test('appUsage：取 last（这一轮），认 camelCase 与 snake_case', () => {
  assert.deepEqual(appUsage({ total: { inputTokens: 99 }, last: { inputTokens: 12868, outputTokens: 7 } }),
    { input_tokens: 12868, output_tokens: 7, cached_input_tokens: null, total: null });
  assert.deepEqual(appUsage({ total: { input_tokens: 5, output_tokens: 6 } }),
    { input_tokens: 5, output_tokens: 6, cached_input_tokens: null, total: null });
  assert.equal(appUsage(null), null);
  assert.equal(appUsage({}), null, '一个数字都没有就别摆一行用量');
});

test('approvalCard：命令审批 → 界面卡片（含 id / reason / command / decisions）', () => {
  const card = approvalCard('item/commandExecution/requestApproval', {
    reason: 'May I write hello.txt',
    command: '/bin/bash -lc "printf hi > hello.txt"',
    cwd: '/tmp/x',
    itemId: 'exec-9',
    availableDecisions: ['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['a'] } }, 'cancel'],
    __approvalId: 'ap1-zz',
  });
  assert.equal(card.type, 'approval');
  assert.equal(card.id, 'ap1-zz');
  assert.equal(card.kind, 'command');
  assert.equal(card.reason, 'May I write hello.txt');
  assert.ok(card.command.includes('hello.txt'));
  assert.equal(card.cwd, '/tmp/x');
  // 对象形式的决策取它的键名，界面才知道按钮该显示什么
  assert.deepEqual(card.decisions, ['accept', 'acceptWithExecpolicyAmendment', 'cancel']);
  // 上游一个都没给时给一套兜底，别摆一排空按钮
  assert.deepEqual(approvalCard('item/commandExecution/requestApproval', {}).decisions, ['accept', 'acceptForSession', 'decline', 'cancel']);
});

test('approvalCard：改文件审批带上改动清单；认得出三类审批方法', () => {
  const card = approvalCard('item/fileChange/requestApproval', {
    reason: 'write', changes: [{ path: '/w/a.ts', kind: { type: 'update' } }],
  });
  assert.equal(card.kind, 'fileChange');
  assert.deepEqual(card.changes, [{ path: '/w/a.ts', kind: 'update' }]);
  assert.equal(approvalCard('item/permissions/requestApproval', {}).kind, 'permissions');
  assert.ok(isApprovalMethod('item/commandExecution/requestApproval'));
  assert.ok(isApprovalMethod('item/fileChange/requestApproval'));
  assert.ok(!isApprovalMethod('item/agentMessage/delta'), '普通通知不是审批');
  assert.ok(!isApprovalMethod('__approval'), '内部标记不是协议方法');
});
