// P4 权限档：runAppServerTurn 发包前的参数拼装（假 codex 捕获 thread/start / turn/start）。
//
// 探针结论（0.162.1，真机）：thread/start 带字符串 sandbox + approvalPolicy + approvalsReviewer；
// turn/start 带对象 sandboxPolicy + approvalPolicy + approvalsReviewer；permissions
// （具名 profile）与 sandbox/sandboxPolicy 混用会被上游 -32600 拒掉，所以 profile 赢。
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.env.BRIDGE_DATA_ROOT) process.env.BRIDGE_DATA_ROOT = mkdtempSync(path.join(os.tmpdir(), 'bridge-as-perms-'));
const { runAppServerTurn, toSandboxPolicy } = await import('./agent-appserver.mjs');

// 假 codex：握手 + thread/start + turn/start，turn/start 后吐 turn/started + turn/completed；
// 每次调用的参数写进 $FAKE_CAPTURE_DIR/<method>.json（测试读它断言发包形状）。
const FAKE_CODEX = `
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const dir = process.env.FAKE_CAPTURE_DIR || '';
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => { try { process.stdout.write(JSON.stringify(o) + '\\n'); } catch {} };
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id == null) return;
  if (m.method === 'initialize') { send({ jsonrpc: '2.0', id: m.id, result: {} }); return; }
  if (m.method === 'thread/start') {
    if (dir) fs.writeFileSync(path.join(dir, 'thread-start.json'), JSON.stringify(m.params || {}));
    send({ jsonrpc: '2.0', id: m.id, result: { thread: { id: 'th_perms' } } });
    return;
  }
  if (m.method === 'turn/start') {
    if (dir) fs.writeFileSync(path.join(dir, 'turn-start.json'), JSON.stringify(m.params || {}));
    send({ jsonrpc: '2.0', id: m.id, result: {} });
    send({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'th_perms', turnId: 't1' } });
    send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'th_perms', turnId: 't1', turn: { status: 'completed' } } });
    return;
  }
  send({ jsonrpc: '2.0', id: m.id, result: {} });
});
`;

function fakeBin() {
  const binDir = mkdtempSync(path.join(os.tmpdir(), 'bridge-perms-bin-'));
  const realDir = path.join(binDir, 'real');
  mkdirSync(realDir, { recursive: true });
  writeFileSync(path.join(realDir, 'codex.js'), FAKE_CODEX);
  const sh = path.join(binDir, 'codex');
  writeFileSync(sh, '#!/bin/sh\nexec ' + JSON.stringify(process.execPath) + ' ' + JSON.stringify(path.join(realDir, 'codex.js')) + ' "$@"\n');
  chmodSync(sh, 0o755);
  return binDir;
}

async function runTurn(opts) {
  const capture = mkdtempSync(path.join(os.tmpdir(), 'bridge-perms-cap-'));
  // BRIDGE_AGENT_BIN_DIR 置空 = 不用项目自带的 codex；binDir 前插 PATH = 钉住只找到假货
  // （codex-turns.test.mjs 同款做法；不置空会跑到真 codex，测试变真跑）。
  const env = { ...process.env, BRIDGE_AGENT_BIN_DIR: '', FAKE_CAPTURE_DIR: capture };
  const events = [];
  for await (const ev of runAppServerTurn('codex', { prompt: 'hi', env, binDir: fakeBin(), ...opts })) events.push(ev);
  const read = (name) => {
    try { return JSON.parse(readFileSync(path.join(capture, name), 'utf8')); } catch { return null; }
  };
  return { events, threadStart: read('thread-start.json'), turnStart: read('turn-start.json') };
}

test('toSandboxPolicy：字符串 → 对象形式（turn/start 只认对象，传字符串会被忽略）', () => {
  assert.deepEqual(toSandboxPolicy('read-only'), { type: 'readOnly' });
  assert.deepEqual(toSandboxPolicy('workspace-write'), { type: 'workspaceWrite' });
  assert.deepEqual(toSandboxPolicy('danger-full-access'), { type: 'dangerFullAccess' });
  assert.equal(toSandboxPolicy('nope'), null);
  assert.equal(toSandboxPolicy(''), null);
});

test('默认：thread/start 带 workspace-write + on-request，不带 reviewer；turn/start 不带权限字段', async () => {
  const { threadStart, turnStart, events } = await runTurn({});
  assert.equal(threadStart.sandbox, 'workspace-write');
  assert.equal(threadStart.approvalPolicy, 'on-request');
  assert.ok(!('approvalsReviewer' in threadStart), '默认 reviewer=user 不用发');
  assert.ok(!('permissions' in threadStart));
  assert.ok(!('sandboxPolicy' in turnStart));
  assert.ok(!('permissions' in turnStart));
  assert.ok(events.some((e) => e.type === 'done'), '轮次正常走完');
});

test('线程级 perms：sandbox/approval/reviewer 进 thread/start；profile 替掉 sandbox', async () => {
  const { threadStart } = await runTurn({
    perms: { sandbox: 'read-only', approval: 'never', reviewer: 'auto_review', profile: '' },
  });
  assert.equal(threadStart.sandbox, 'read-only');
  assert.equal(threadStart.approvalPolicy, 'never');
  assert.equal(threadStart.approvalsReviewer, 'auto_review');
  const { threadStart: withProfile } = await runTurn({
    perms: { sandbox: 'workspace-write', approval: 'on-request', reviewer: 'user', profile: ':read-only' },
  });
  assert.equal(withProfile.permissions, ':read-only');
  assert.ok(!('sandbox' in withProfile), '有 profile 就不带 sandbox（上游混用直接 -32600）');
});

test('当轮覆盖：sandboxPolicy 对象 + approvalPolicy + reviewer 进 turn/start；thread/start 不受影响', async () => {
  const { threadStart, turnStart } = await runTurn({
    turnPerms: { sandbox: 'read-only', approval: 'never', reviewer: 'auto_review' },
  });
  assert.equal(threadStart.sandbox, 'workspace-write', '没改线程级默认值');
  assert.deepEqual(turnStart.sandboxPolicy, { type: 'readOnly' });
  assert.equal(turnStart.approvalPolicy, 'never');
  assert.equal(turnStart.approvalsReviewer, 'auto_review');
});

test('当轮覆盖 profile 优先于 sandbox；reviewer 显式回 user 也要发（线程可能正跑 auto_review）', async () => {
  const { turnStart } = await runTurn({
    turnPerms: { sandbox: 'danger-full-access', profile: ':workspace', reviewer: 'user' },
  });
  assert.equal(turnStart.permissions, ':workspace');
  assert.ok(!('sandboxPolicy' in turnStart), 'profile 赢，sandbox 不发');
  assert.equal(turnStart.approvalsReviewer, 'user', '不发就切不回来');
});

test('当轮覆盖只带改过的维度：只改 sandbox 时不带 approvalPolicy/reviewer', async () => {
  const { turnStart } = await runTurn({ turnPerms: { sandbox: 'read-only' } });
  assert.deepEqual(turnStart.sandboxPolicy, { type: 'readOnly' });
  assert.ok(!('approvalPolicy' in turnStart));
  assert.ok(!('approvalsReviewer' in turnStart));
});

test('非法值不发包：白名单外的值当没给（不让一个拼错的值把整轮拒掉）', async () => {
  const { threadStart, turnStart } = await runTurn({
    perms: { sandbox: 'nope', approval: 'nope', reviewer: 'nope', profile: '' },
    turnPerms: { sandbox: 'nope', approval: 'nope', reviewer: 'nope' },
  });
  assert.equal(threadStart.sandbox, 'workspace-write', '线程级非法值回落到老参数默认值');
  assert.equal(threadStart.approvalPolicy, 'on-request');
  assert.ok(!('sandboxPolicy' in turnStart));
  assert.ok(!('approvalPolicy' in turnStart));
  assert.ok(!('approvalsReviewer' in turnStart));
});
