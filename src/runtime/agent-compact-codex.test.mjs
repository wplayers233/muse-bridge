// P5.1 手动压缩（runtime/agent-compact-codex.mjs）：
//   resume 接上 → compact/start → 等 contextCompaction item/completed。
// 假 codex：compact/start 后发 started|completed 两个 compaction item；
// 空线程模式（FAKE_COMPACT_MODE=empty）不发 item，走 settle 收尾。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.BRIDGE_AGENT_BIN_DIR = '';
delete process.env.OPENAI_API_KEY;

const { compactCodexThread } = await import('./agent-compact-codex.mjs');

const FAKE_CODEX = `
const readline = require('node:readline');
const mode = process.env.FAKE_COMPACT_MODE || 'ok';
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => { try { process.stdout.write(JSON.stringify(o) + '\\n'); } catch {} };
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id == null) return;
  if (m.method === 'initialize') { send({ jsonrpc: '2.0', id: m.id, result: {} }); return; }
  if (m.method === 'thread/resume') { send({ jsonrpc: '2.0', id: m.id, result: { thread: { id: m.params.threadId } } }); return; }
  if (m.method === 'thread/compact/start') {
    send({ jsonrpc: '2.0', id: m.id, result: {} });
    if (mode === 'ok') {
      const item = { type: 'contextCompaction', id: 'cc-1' };
      setTimeout(() => send({ jsonrpc: '2.0', method: 'item/started', params: { item } }), 10);
      setTimeout(() => send({ jsonrpc: '2.0', method: 'item/completed', params: { item } }), 30);
    }
    return;
  }
  send({ jsonrpc: '2.0', id: m.id, result: {} });
});
`;

function makeFake(mode) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-compact-'));
  const realDir = path.join(tmp, 'real');
  mkdirSync(realDir, { recursive: true });
  writeFileSync(path.join(realDir, 'codex.js'), FAKE_CODEX);
  const sh = path.join(tmp, 'codex');
  writeFileSync(sh, '#!/bin/sh\nexec ' + JSON.stringify(process.execPath) + ' ' + JSON.stringify(path.join(realDir, 'codex.js')) + ' "$@"\n');
  chmodSync(sh, 0o755);
  const env = { ...process.env, BRIDGE_AGENT_BIN_DIR: '', FAKE_COMPACT_MODE: mode, PATH: tmp + path.delimiter + (process.env.PATH || '') };
  return { tmp, env };
}

test('compact：resume → compact/start → compaction item 完成，start/end 事件都发', async () => {
  const { env } = makeFake('ok');
  const events = [];
  const r = await compactCodexThread({
    sessionId: 'th-1', cwd: '/tmp', env, keyEnv: {},
    settleMs: 500, completeMs: 5000,
    onEvent: (ev) => events.push(ev),
  });
  assert.equal(r.ok, true);
  assert.equal(r.compacted, true);
  assert.deepEqual(events.map((e) => e.phase), ['start', 'end']);
  assert.equal(events[1].ok, true);
  assert.equal(events[1].compacted, true);
});

test('compact：空线程（没 compaction item）→ settle 后 compacted=false', async () => {
  const { env } = makeFake('empty');
  const events = [];
  const r = await compactCodexThread({
    sessionId: 'th-1', cwd: '/tmp', env, keyEnv: {},
    settleMs: 100, completeMs: 5000,
    onEvent: (ev) => events.push(ev),
  });
  assert.equal(r.ok, true);
  assert.equal(r.compacted, false);
  assert.deepEqual(events.map((e) => e.phase), ['start', 'end']);
  assert.equal(events[1].compacted, false);
});

test('compact：没 sessionId 直接失败', async () => {
  const { env } = makeFake('ok');
  const r = await compactCodexThread({ sessionId: '', cwd: '/tmp', env, keyEnv: {} });
  assert.equal(r.ok, false);
});
