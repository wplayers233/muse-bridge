// POST /api/codex/review（P2：review/start，新线程 + inline，SSE 流回正文）的路由级契约。
//
// 为什么单有这一份：runtime 层的 runCodexReview 测的是假 app-server 的协议归一，
// 路由处理器本身（门禁 / ws 授权 / target 校验 / SSE 组装）没人跑过——少一个 import
// 或顺序错了，只在真机上点「开始审阅」时才炸。这里把处理器直接请出来跑一遍。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.BRIDGE_DATA_ROOT = mkdtempSync(path.join(os.tmpdir(), 'bridge-review-'));
process.env.BRIDGE_AGENT_BIN_DIR = '';        // 不认随程序自带的那份，断言只看 PATH 里的假货
delete process.env.OPENAI_API_KEY;

const { registerAgentCliRoutes } = await import('./agent-cli.mjs');

// 假 codex：只认 app-server 握手 + thread/start + review/start，吐一轮审阅事件。
const FAKE_CODEX = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => { try { process.stdout.write(JSON.stringify(o) + '\\n'); } catch {} };
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id == null) return;
  if (m.method === 'initialize') { send({ jsonrpc: '2.0', id: m.id, result: { model: 'fake' } }); return; }
  if (m.method === 'thread/start') { send({ jsonrpc: '2.0', id: m.id, result: { thread: { id: 'th_route' } } }); return; }
  if (m.method === 'review/start') {
    send({ jsonrpc: '2.0', id: m.id, result: { reviewThreadId: 'th_route' } });
    const n = (method, params) => send({ jsonrpc: '2.0', method, params });
    n('item/agentMessage/delta', { threadId: 'th_route', turnId: 't1', itemId: 'a1', delta: '路由级审阅正文。' });
    n('turn/completed', { threadId: 'th_route', turnId: 't1', turn: { status: 'completed' } });
    return;
  }
  send({ jsonrpc: '2.0', id: m.id, result: {} });
});
`;

// 假 router + 假 res（EventEmitter，支持 res.on('close')；write 累积 SSE 文本）。
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
    const sse = text.split('\n\n').filter(Boolean).map((frame) => {
      const line = frame.split('\n').find((l) => l.startsWith('data:'));
      return line ? JSON.parse(line.slice(5)) : null;
    }).filter(Boolean);
    return { code, text, sse, json: () => JSON.parse(text) };
  };
}

const repo = mkdtempSync(path.join(os.tmpdir(), 'bridge-review-repo-'));
const binDir = mkdtempSync(path.join(os.tmpdir(), 'bridge-review-bin-'));
{
  const realDir = path.join(binDir, 'real');
  mkdirSync(realDir, { recursive: true });
  writeFileSync(path.join(realDir, 'codex.js'), FAKE_CODEX);
  const sh = path.join(binDir, 'codex');
  writeFileSync(sh, '#!/bin/sh\nexec ' + JSON.stringify(process.execPath) + ' ' + JSON.stringify(path.join(realDir, 'codex.js')) + ' "$@"\n');
  chmodSync(sh, 0o755);
  process.env.PATH = binDir + path.delimiter + (process.env.PATH || '');
}

const adminRoutes = collect(() => ({ kind: 'admin' }));
const snapRoutes = collect(() => ({ kind: 'snap', token: 't-snap', dir: repo }));
const anonRoutes = collect(() => ({ kind: 'none' }));

test('POST /api/codex/review：uncommittedChanges → SSE 流回 start + 正文 + done', async () => {
  const r = await adminRoutes('POST', '/api/codex/review', { body: { ws: repo, target: { type: 'uncommittedChanges' } } });
  assert.equal(r.code, 200, '应为 200：' + r.text.slice(0, 200));
  assert.deepEqual(r.sse.map((e) => e.type), ['start', 'text', 'done']);
  assert.equal(r.sse[0].reviewThreadId, 'th_route');
  assert.equal(r.sse[1].text, '路由级审阅正文。');
  assert.equal(r.sse[2].failed, false);
});

test('POST /api/codex/review：非法 target → 400（不进 SSE）', async () => {
  const r = await adminRoutes('POST', '/api/codex/review', { body: { ws: repo, target: { type: 'commit', sha: 'zzz' } } });
  assert.equal(r.code, 400);
  assert.equal(r.json().error, '提交号不合法');
});

test('POST /api/codex/review：不存在的 ws → 404（authorizeProjectPath 拦）', async () => {
  const r = await adminRoutes('POST', '/api/codex/review', { body: { ws: '/no/such/dir-xyz', target: { type: 'uncommittedChanges' } } });
  assert.equal(r.code, 404);
});

test('POST /api/codex/review：未登录 → 401；快照访客 → 403（审阅花额度，不是只读查询）', async () => {
  const anon = await anonRoutes('POST', '/api/codex/review', { body: { ws: repo, target: { type: 'uncommittedChanges' } } });
  assert.equal(anon.code, 401);
  const snap = await snapRoutes('POST', '/api/codex/review', { body: { ws: repo, target: { type: 'uncommittedChanges' } } });
  assert.equal(snap.code, 403);
});
