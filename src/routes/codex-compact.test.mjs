// P5.1 路由级契约：POST /api/codex/compact（手动压缩，SSE 流回 compact 事件）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.BRIDGE_DATA_ROOT = mkdtempSync(path.join(os.tmpdir(), 'bridge-compact-route-'));
process.env.BRIDGE_AGENT_BIN_DIR = '';
delete process.env.OPENAI_API_KEY;

const { registerAgentCliRoutes } = await import('./agent-cli.mjs');

// 假 codex：resume 回 thread，compact/start 后发 started|completed 两个 compaction item。
const FAKE_CODEX = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => { try { process.stdout.write(JSON.stringify(o) + '\\n'); } catch {} };
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id == null) return;
  if (m.method === 'initialize') { send({ jsonrpc: '2.0', id: m.id, result: {} }); return; }
  if (m.method === 'thread/resume') { send({ jsonrpc: '2.0', id: m.id, result: { thread: { id: m.params.threadId } } }); return; }
  if (m.method === 'thread/compact/start') {
    send({ jsonrpc: '2.0', id: m.id, result: {} });
    const item = { type: 'contextCompaction', id: 'cc-1' };
    setTimeout(() => send({ jsonrpc: '2.0', method: 'item/started', params: { item } }), 10);
    setTimeout(() => send({ jsonrpc: '2.0', method: 'item/completed', params: { item } }), 30);
    return;
  }
  send({ jsonrpc: '2.0', id: m.id, result: {} });
});
`;

const binDir = mkdtempSync(path.join(os.tmpdir(), 'bridge-compact-route-bin-'));
{
  const realDir = path.join(binDir, 'real');
  mkdirSync(realDir, { recursive: true });
  writeFileSync(path.join(realDir, 'codex.js'), FAKE_CODEX);
  const sh = path.join(binDir, 'codex');
  writeFileSync(sh, '#!/bin/sh\nexec ' + JSON.stringify(process.execPath) + ' ' + JSON.stringify(path.join(realDir, 'codex.js')) + ' "$@"\n');
  chmodSync(sh, 0o755);
  process.env.PATH = binDir + path.delimiter + (process.env.PATH || '');
}

function collect(identify) {
  const routes = new Map();
  const router = { on: (m, p, fn) => routes.set(m + ' ' + p, fn) };
  registerAgentCliRoutes(router, { identify });
  return async (method, url, { body = null } = {}) => {
    const fn = routes.get(method + ' ' + new URL(url, 'http://x').pathname);
    assert.ok(fn, '没注册 ' + method + ' ' + url);
    const req = new EventEmitter();
    req.headers = {}; req.socket = { remoteAddress: '127.0.0.1' }; req.url = url;
    const res = new EventEmitter();
    let code = 200, text = '';
    res.writableFinished = false;
    res.writeHead = (c) => { code = c; };
    res.write = (chunk) => { text += chunk; };
    res.end = (chunk) => { if (chunk) text += chunk; res.writableFinished = true; };
    const p = fn(req, res, new URL(url, 'http://x'));
    if (body != null) { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end'); }
    await p;
    return { code, text, json: () => JSON.parse(text), sse: () => text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6))) };
  };
}

const admin = collect(() => ({ kind: 'admin' }));
const snap = collect(() => ({ kind: 'snap', token: 't-snap', dir: mkdtempSync(path.join(os.tmpdir(), 'bridge-compact-snap-')) }));

test('POST /api/codex/compact：SSE 流回 compact start → end（compacted=true）', async () => {
  const r = await admin('POST', '/api/codex/compact', { body: { sessionId: 'th-1' } });
  assert.equal(r.code, 200);
  const evs = r.sse();
  assert.deepEqual(evs.map((e) => e.phase), ['start', 'end']);
  assert.equal(evs[1].ok, true);
  assert.equal(evs[1].compacted, true);
});

test('POST /api/codex/compact：没 sessionId 直接 400', async () => {
  const r = await admin('POST', '/api/codex/compact', { body: {} });
  assert.equal(r.code, 400);
});

test('POST /api/codex/compact：快照访客 403（压缩是改写线程的操作）', async () => {
  const r = await snap('POST', '/api/codex/compact', { body: { sessionId: 'th-1' } });
  assert.equal(r.code, 403);
});
