// P5.2 路由级契约：POST /api/codex/skills/config（启用/停用技能，写全局 config.toml）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.BRIDGE_DATA_ROOT = mkdtempSync(path.join(os.tmpdir(), 'bridge-skills-cfg-route-'));
process.env.BRIDGE_AGENT_BIN_DIR = '';
delete process.env.OPENAI_API_KEY;

const { registerAgentCliRoutes } = await import('./agent-cli.mjs');

// 假 codex：config/write 改内存状态（只认 name），list 照状态回（写+验证同一进程，内存够用）。
const FAKE_CODEX = `
const readline = require('node:readline');
let enabled = { 'alpha': true };
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => { try { process.stdout.write(JSON.stringify(o) + '\\n'); } catch {} };
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id == null) return;
  if (m.method === 'initialize') { send({ jsonrpc: '2.0', id: m.id, result: {} }); return; }
  if (m.method === 'skills/config/write') {
    const p = m.params || {};
    if (p.name && p.name in enabled) enabled[p.name] = !!p.enabled;
    send({ jsonrpc: '2.0', id: m.id, result: { effectiveEnabled: !!p.enabled } });
    return;
  }
  if (m.method === 'skills/list') {
    send({ jsonrpc: '2.0', id: m.id, result: { data: [{ cwd: '/tmp/w', skills: Object.entries(enabled).map(([name, en]) => ({ name, enabled: en, scope: 'user', path: '/w/' + name + '/SKILL.md' })) }] } });
    return;
  }
  send({ jsonrpc: '2.0', id: m.id, result: {} });
});
`;

const binDir = mkdtempSync(path.join(os.tmpdir(), 'bridge-skills-cfg-route-bin-'));
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

test('POST /api/codex/skills/config：禁用已存在的技能，verified=true', async () => {
  const r = await admin('POST', '/api/codex/skills/config', { body: { name: 'alpha', enabled: false } });
  assert.equal(r.code, 200);
  const j = r.json();
  assert.equal(j.ok, true);
  assert.equal(j.effectiveEnabled, false);
  assert.equal(j.verified, true, '重拉验证到 alpha=false');
  assert.equal(j.skill.enabled, false);
});

test('POST /api/codex/skills/config：不存在的 name 不谎称成功（verified=false）', async () => {
  const r = await admin('POST', '/api/codex/skills/config', { body: { name: 'no-such-skill', enabled: false } });
  assert.equal(r.code, 200);
  assert.equal(r.json().verified, false);
});

test('POST /api/codex/skills/config：没 name 直接 400', async () => {
  const r = await admin('POST', '/api/codex/skills/config', { body: { enabled: false } });
  assert.equal(r.code, 400);
});
