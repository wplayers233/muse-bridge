// POST /api/zcode/chat 的 worktree 分支（P3）路由级契约：新会话勾 worktree →
// 后端在 <仓库>/.zcode/worktrees/<名> 切 detached worktree、这一轮跑在里面，
// SSE 先吐 meta（cwd = worktree）再吐 worktree 事件；续聊带 body.cwd → 跑在该目录。
//
// 为什么用 zcode 测：codex 那条走后台轮次 + app-server 握手，路由测试要起真 app-server；
// worktree 的创建 / cwd 选路 / worktree 事件都在两家共享的处理器里，zcode 的 exec 路
// 测到同一段代码。codex 的 worktree 事件进 turn 缓冲由 codex-turns 覆盖（见下）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_ROOT = mkdtempSync(path.join(os.tmpdir(), 'bridge-wt-route-'));
process.env.BRIDGE_DATA_ROOT = DATA_ROOT;
process.env.BRIDGE_AGENT_BIN_DIR = '';
delete process.env.OPENAI_API_KEY;
delete process.env.ZAI_API_KEY;

const { registerAgentCliRoutes } = await import('./agent-cli.mjs');
const { setCliCwd } = await import('../runtime/cli-cwd.mjs');

// 假 zcode：吐一轮 stream-json + 把 argv 写到 FAKE_CAPTURE（断言 --cwd 落到 worktree）。
const CAPTURE = path.join(DATA_ROOT, 'zcode-argv.json');
const FAKE_ZCODE = `#!/bin/sh
echo "$@" > "$FAKE_CAPTURE"
echo '{"type":"session.created","sessionId":"sess-wt","eventId":"1"}'
echo '{"type":"turn.started","sessionId":"sess-wt","eventId":"2"}'
echo '{"type":"model.streaming","sessionId":"sess-wt","eventId":"3","payload":{"kind":"text_delta","delta":"在 worktree 里干活。"}}'
echo '{"type":"result","sessionId":"sess-wt","response":"在 worktree 里干活。","projection":{"status":"completed"}}'
`;

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

const adminCtx = { kind: 'admin', dataDir: DATA_ROOT, cwd: process.cwd() };
const adminRoutes = collect(() => ({ kind: 'admin' }));

// 临时仓：1 个提交 + .worktreeinclude（.env 要拷过去，证明复制规则走了）。
const repo = mkdtempSync(path.join(os.tmpdir(), 'bridge-wt-route-repo-'));
{
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString();
  git('init', '-b', 'main');
  git('config', 'user.email', 't@example.local');
  git('config', 'user.name', 't');
  writeFileSync(path.join(repo, 'a.js'), 'const x = 1;\n');
  writeFileSync(path.join(repo, '.gitignore'), '.env\n');
  writeFileSync(path.join(repo, '.env'), 'SECRET=1\n');
  writeFileSync(path.join(repo, '.worktreeinclude'), '.env\n');
  git('add', '-A'); git('commit', '-m', 'init');
  setCliCwd(adminCtx, 'zcode', repo);
}
// 假 zcode 进 PATH（BRIDGE_AGENT_BIN_DIR=''，只认 PATH）。
const binDir = mkdtempSync(path.join(os.tmpdir(), 'bridge-wt-route-bin-'));
{
  const sh = path.join(binDir, 'zcode');
  writeFileSync(sh, FAKE_ZCODE);
  chmodSync(sh, 0o755);
  process.env.PATH = binDir + path.delimiter + (process.env.PATH || '');
  process.env.FAKE_CAPTURE = CAPTURE;
}

test('POST /api/zcode/chat + worktree：新会话切 detached worktree，meta/worktree 事件 + --cwd 落到 worktree', async () => {
  const r = await adminRoutes('POST', '/api/zcode/chat', { body: { prompt: 'hi', worktree: true } });
  assert.equal(r.code, 200, '应为 200：' + r.text.slice(0, 300));
  const meta = r.sse.find((e) => e.type === 'meta');
  assert.ok(meta, '应有 meta 事件');
  assert.ok(meta.cwd.includes(path.join('.zcode', 'worktrees')), 'meta.cwd 是 worktree：' + meta.cwd);
  const wt = r.sse.find((e) => e.type === 'worktree');
  assert.ok(wt, '应有 worktree 事件');
  assert.equal(wt.worktree.cwd, meta.cwd);
  assert.equal(wt.worktree.detached, true);
  assert.equal(wt.worktree.created, true, '本轮刚切的带 created');
  // 假 zcode 的 argv 里 --cwd 就是 worktree（exec 回落的 cwd 选路走了 worktree）
  const argv = readFileSync(CAPTURE, 'utf8');
  assert.ok(argv.includes('--cwd ' + meta.cwd) || argv.includes(meta.cwd), 'zcode 命令行带上 worktree cwd：' + argv);
  // .worktreeinclude 复制规则走了
  assert.equal(existsSync(path.join(meta.cwd, '.env')), true, '.env 拷进了 worktree');
  // 这一轮真在 worktree 里跑（detached HEAD）
  const ref = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: meta.cwd }).toString().trim();
  assert.equal(ref, 'HEAD');
});

test('POST /api/zcode/chat + body.cwd：续聊跑在指定目录（worktree 续聊的选路）', async () => {
  const wtDir = path.join(repo, '.zcode', 'worktrees');
  const subs = existsSync(wtDir) ? (await import('node:fs')).readdirSync(wtDir) : [];
  assert.ok(subs.length >= 1, '上一条已建出 worktree');
  const wtCwd = path.join(wtDir, subs[0]);
  const r = await adminRoutes('POST', '/api/zcode/chat', { body: { prompt: 'hi', sessionId: 'sess-wt', cwd: wtCwd } });
  assert.equal(r.code, 200, '应为 200：' + r.text.slice(0, 300));
  const meta = r.sse.find((e) => e.type === 'meta');
  assert.equal(meta.cwd, wtCwd, '续聊用 body.cwd');
  const wt = r.sse.find((e) => e.type === 'worktree');
  assert.ok(wt, '续聊也要带 worktree 事件（前端据此亮只读指示）');
  assert.equal(wt.worktree.created, undefined, '续聊不是新切的，不带 created');
});

test('POST /api/zcode/chat + worktree 但非 git 仓库：直接报错，不静默跑在主检出', async () => {
  const plain = mkdtempSync(path.join(os.tmpdir(), 'bridge-wt-plain-'));
  try {
    setCliCwd(adminCtx, 'zcode', plain);
    const r = await adminRoutes('POST', '/api/zcode/chat', { body: { prompt: 'hi', worktree: true } });
    assert.equal(r.code, 400);
    assert.match(r.json().error, /不是 git 仓库/);
  } finally {
    setCliCwd(adminCtx, 'zcode', repo);
    rmSync(plain, { recursive: true, force: true });
  }
});
