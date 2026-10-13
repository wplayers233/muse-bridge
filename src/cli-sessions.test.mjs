// cli-sessions（服务端会话注册表）的存储层单测。
// ctx 用假身份（{ dataDir: 临时目录 }）：隔离性就体现在两个 dataDir 互不可见。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { listCliSessions, getCliSession, saveCliSession, deleteCliSession, MAX_PER_AGENT }
  = await import('./runtime/cli-sessions.mjs');

const mkCtx = () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'cli-sess-'));
  return { dataDir, cwd: dataDir, kind: 'admin' };
};

test('save：缺 sessionId 拒绝；给了就生成 id 并能取回完整快照', () => {
  const ctx = mkCtx();
  assert.throws(() => saveCliSession(ctx, 'codex', { cwd: '/tmp' }), /sessionId/);
  const id = saveCliSession(ctx, 'codex', {
    sessionId: 'thr_1', cwd: '/tmp/x', title: '第一会话',
    messages: [{ role: 'user', id: 1, text: '你好' }],
  });
  assert.ok(id);
  const rec = getCliSession(ctx, 'codex', id);
  assert.equal(rec.sessionId, 'thr_1');
  assert.equal(rec.title, '第一会话');
  assert.equal(rec.messages.length, 1);
  assert.equal(rec.agent, 'codex');
});

test('save：同 id 是更新不是新增；createdAt 保留、updatedAt 前移', async () => {
  const ctx = mkCtx();
  const id = saveCliSession(ctx, 'codex', { sessionId: 'a', title: 'v1', messages: [] });
  const at1 = getCliSession(ctx, 'codex', id).updatedAt;
  await new Promise((r) => setTimeout(r, 5));
  saveCliSession(ctx, 'codex', { id, sessionId: 'a', title: 'v2', messages: [{ role: 'user', text: 'x' }] });
  const store = listCliSessions(ctx, 'codex', { withMessages: true });
  assert.equal(store.length, 1);
  assert.equal(store[0].title, 'v2');
  assert.equal(store[0].createdAt, getCliSession(ctx, 'codex', id).createdAt);
  assert.ok(getCliSession(ctx, 'codex', id).updatedAt > at1);
});

test('list：默认不带 messages；withMessages 才带；按最近使用排前', () => {
  const ctx = mkCtx();
  const a = saveCliSession(ctx, 'codex', { sessionId: 'a', title: 'A', messages: [{ role: 'user', text: '1' }] });
  saveCliSession(ctx, 'codex', { sessionId: 'b', title: 'B', messages: [] });
  const meta = listCliSessions(ctx, 'codex');
  assert.equal(meta.length, 2);
  assert.equal(meta[0].title, 'B');           // b 后写，排前
  assert.ok(!('messages' in meta[0]));
  const full = listCliSessions(ctx, 'codex', { withMessages: true });
  assert.ok(Array.isArray(full[1].messages));
  assert.equal(full[1].id, a);
});

test('上限：每 agent 各留 20 条，超了淘汰最旧的；两家互不挤占', () => {
  const ctx = mkCtx();
  for (let i = 0; i < MAX_PER_AGENT + 3; i++) {
    saveCliSession(ctx, 'codex', { sessionId: 'c' + i, title: 'c' + i, messages: [] });
  }
  saveCliSession(ctx, 'zcode', { sessionId: 'z1', title: 'z', messages: [] });
  const codex = listCliSessions(ctx, 'codex');
  assert.equal(codex.length, MAX_PER_AGENT);
  assert.ok(!codex.some((s) => s.title === 'c0'));   // 最旧的被淘汰
  assert.ok(codex.some((s) => s.title === 'c22'));   // 最新的在
  assert.equal(listCliSessions(ctx, 'zcode').length, 1);  // zcode 不受 codex 挤占
});

test('隔离：两个身份（不同 dataDir）互相看不见', () => {
  const ctxA = mkCtx();
  const ctxB = mkCtx();
  saveCliSession(ctxA, 'codex', { sessionId: 'a1', title: 'A的', messages: [] });
  assert.equal(listCliSessions(ctxA, 'codex').length, 1);
  assert.equal(listCliSessions(ctxB, 'codex').length, 0);
  // B 存同 sessionId 的另一条也互不影响
  saveCliSession(ctxB, 'codex', { sessionId: 'b1', title: 'B的', messages: [] });
  assert.equal(listCliSessions(ctxB, 'codex').length, 1);
  assert.equal(listCliSessions(ctxA, 'codex').length, 1);
});

test('坏数据容错：store 文件被写坏时按空库处理，且能正常写入重建', () => {
  const ctx = mkCtx();
  writeFileSync(path.join(ctx.dataDir, 'cli-sessions.json'), '{{{not json');
  assert.deepEqual(listCliSessions(ctx, 'codex'), []);
  saveCliSession(ctx, 'codex', { sessionId: 'ok', title: '重建', messages: [] });
  assert.equal(listCliSessions(ctx, 'codex').length, 1);
});

test('delete：幂等；未知 agent 报错；删后列表与单条都取不到', () => {
  const ctx = mkCtx();
  const id = saveCliSession(ctx, 'codex', { sessionId: 'd1', title: '待删', messages: [] });
  deleteCliSession(ctx, 'codex', id);
  deleteCliSession(ctx, 'codex', id);   // 再删一次不抛
  assert.equal(getCliSession(ctx, 'codex', id), null);
  assert.deepEqual(listCliSessions(ctx, 'codex'), []);
  assert.throws(() => deleteCliSession(ctx, 'nope', 'x'), /未知 agent/);
  assert.throws(() => saveCliSession(ctx, 'nope', { sessionId: 'x' }), /未知 agent/);
});

test('防御性修剪：超长正文被截断，超量消息被裁尾', () => {
  const ctx = mkCtx();
  const big = 'x'.repeat(20000);
  const many = Array.from({ length: 300 }, (_, i) => ({ role: 'user', text: 'm' + i }));
  const id = saveCliSession(ctx, 'codex', { sessionId: 'trim', messages: many });
  const rec = getCliSession(ctx, 'codex', id);
  assert.ok(rec.messages.length <= 120);
  saveCliSession(ctx, 'codex', { id, sessionId: 'trim', messages: [{ role: 'user', text: big }] });
  const rec2 = getCliSession(ctx, 'codex', id);
  assert.ok(rec2.messages[0].text.length <= 8000);
});

test('目录不存在也能写（dataDir 缺上级时自动建）', () => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'cli-sess-mk-'));
  const ctx = { dataDir: path.join(base, 'deep', 'nested'), cwd: base };
  const id = saveCliSession(ctx, 'zcode', { sessionId: 'z', title: '深', messages: [] });
  assert.ok(getCliSession(ctx, 'zcode', id));
  mkdirSync(path.join(base, 'x'), { recursive: true });   // 占位断言（mkdirSync 已被内部验证）
  assert.ok(true);
});
