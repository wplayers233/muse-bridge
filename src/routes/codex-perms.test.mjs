// P4 路由级契约：GET/POST /api/codex/perms（线程级默认值）与
// GET /api/codex/permissions/profiles（permissionProfile/list 透传）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.BRIDGE_DATA_ROOT = mkdtempSync(path.join(os.tmpdir(), 'bridge-perms-route-'));
process.env.BRIDGE_AGENT_BIN_DIR = '';
delete process.env.OPENAI_API_KEY;

const { registerAgentCliRoutes } = await import('./agent-cli.mjs');

// 假 codex：只认握手 + permissionProfile/list（回 3 个内置 profile）。
const FAKE_CODEX = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => { try { process.stdout.write(JSON.stringify(o) + '\\n'); } catch {} };
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id == null) return;
  if (m.method === 'initialize') { send({ jsonrpc: '2.0', id: m.id, result: {} }); return; }
  if (m.method === 'permissionProfile/list') {
    send({ jsonrpc: '2.0', id: m.id, result: { data: [
      { id: ':read-only', allowed: true, description: null },
      { id: ':workspace', allowed: true, description: null },
      { id: ':danger-full-access', allowed: true, description: null },
    ] } });
    return;
  }
  send({ jsonrpc: '2.0', id: m.id, result: {} });
});
`;

const binDir = mkdtempSync(path.join(os.tmpdir(), 'bridge-perms-route-bin-'));
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
    return { code, text, json: () => JSON.parse(text) };
  };
}

const admin = collect(() => ({ kind: 'admin' }));

test('GET /api/codex/perms：没设过就是默认值', async () => {
  const r = await admin('GET', '/api/codex/perms');
  assert.equal(r.code, 200);
  assert.deepEqual(r.json().perms, { sandbox: 'workspace-write', approval: 'on-request', reviewer: 'user', profile: '' });
});

test('POST /api/codex/perms：保存后读回来是它；非法值回默认值', async () => {
  const r = await admin('POST', '/api/codex/perms', { body: { perms: { sandbox: 'read-only', reviewer: 'auto_review', approval: 'nope' } } });
  assert.equal(r.code, 200);
  assert.equal(r.json().perms.sandbox, 'read-only');
  assert.equal(r.json().perms.reviewer, 'auto_review');
  assert.equal(r.json().perms.approval, 'on-request', '非法 approval 回默认');
  const r2 = await admin('GET', '/api/codex/perms');
  assert.equal(r2.json().perms.sandbox, 'read-only', '保存后读回来还是它');
  // 还原，免得污染别的测试
  await admin('POST', '/api/codex/perms', { body: { perms: { sandbox: 'workspace-write', approval: 'on-request', reviewer: 'user', profile: '' } } });
});

test('GET /api/codex/permissions/profiles：透传 3 个内置 profile', async () => {
  const r = await admin('GET', '/api/codex/permissions/profiles');
  assert.equal(r.code, 200);
  assert.deepEqual(r.json().profiles, [
    { id: ':read-only', allowed: true, description: null },
    { id: ':workspace', allowed: true, description: null },
    { id: ':danger-full-access', allowed: true, description: null },
  ]);
});
