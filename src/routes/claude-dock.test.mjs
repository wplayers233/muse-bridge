// 审阅面板后端（routes/claude-dock.mjs）：范围 + 三级 git 操作 + 身份门禁。
//
// 破坏性操作（stage / unstage / revert）只断言「返回 200」不够——每个用例都拿
// 临时 git 仓，操作前后跑 git status / git diff 对照（tmp 仓用完删）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.BRIDGE_DATA_ROOT = mkdtempSync(path.join(os.tmpdir(), 'bridge-dock-'));
const { registerClaudeDockRoutes } = await import('./claude-dock.mjs');

// 假 router + 假 req/res（照 agent-routes.test.mjs 的 collect）。
function collect(identify) {
  const routes = new Map();
  const router = { on: (m, p, fn) => routes.set(m + ' ' + p, fn) };
  registerClaudeDockRoutes(router, { identify });
  return async (method, url, { body = null } = {}) => {
    const fn = routes.get(method + ' ' + new URL(url, 'http://x').pathname);
    assert.ok(fn, '没注册 ' + method + ' ' + url);
    const req = new EventEmitter();
    req.headers = {}; req.socket = { remoteAddress: '127.0.0.1' }; req.url = url;
    let code = 200, text = '';
    const res = { writeHead(c) { code = c; }, write(chunk) { text += chunk; }, end(chunk) { if (chunk) text += chunk; } };
    const p = fn(req, res, new URL(url, 'http://x'));
    if (body != null) { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end'); }
    await p;
    return { code, text, json: () => JSON.parse(text) };
  };
}
const admin = collect(() => ({ kind: 'admin', cwd: '' }));
const nobody = collect(() => null);

const g = (dir, ...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString();
const gitStatus = (dir) => g(dir, 'status', '--porcelain=v1', '--', '.');
const gitDiff = (dir, ...args) => g(dir, 'diff', ...args);
const read = (dir, f) => readFileSync(path.join(dir, f), 'utf8');

// 标准夹具：main 上两个提交 + 工作区「a.txt 一处暂存改动 + 一处未暂存改动」+ 未跟踪 c.txt。
// topic 分支指在第一个提交上（branch 范围显式基线的靶子）。
function makeRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bridge-dock-repo-'));
  g(dir, 'init', '-b', 'main');
  g(dir, 'config', 'user.email', 't@t.t');
  g(dir, 'config', 'user.name', 't');
  writeFileSync(path.join(dir, 'a.txt'), 'a1\na2\na3\na4\na5\na6\na7\na8\n');
  writeFileSync(path.join(dir, 'b.txt'), 'b1\nb2\n');
  g(dir, 'add', '-A');
  g(dir, 'commit', '-m', 'init');
  const sha1 = g(dir, 'rev-parse', 'HEAD').trim();
  writeFileSync(path.join(dir, 'b.txt'), 'b1\nb2-changed\n');
  g(dir, 'add', '-A');
  g(dir, 'commit', '-m', 'change b');
  const sha2 = g(dir, 'rev-parse', 'HEAD').trim();
  g(dir, 'branch', 'topic', sha1);
  writeFileSync(path.join(dir, 'a.txt'), 'a1\na2-staged\na3\na4\na5\na6\na7\na8\n');
  g(dir, 'add', 'a.txt');
  writeFileSync(path.join(dir, 'a.txt'), 'a1\na2-staged\na3\na4\na5\na6-unstaged\na7\na8\n');
  writeFileSync(path.join(dir, 'c.txt'), 'untracked\n');
  return { dir, sha1, sha2, done: () => rmSync(dir, { recursive: true, force: true }) };
}

// 20 行文件、两处远隔改动（两 hunks 不合并）：hunk 操作的夹具。
function makeHunkRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bridge-dock-hunk-'));
  g(dir, 'init', '-b', 'main');
  g(dir, 'config', 'user.email', 't@t.t');
  g(dir, 'config', 'user.name', 't');
  const lines = Array.from({ length: 20 }, (_, i) => `L${i + 1}`).join('\n') + '\n';
  writeFileSync(path.join(dir, 'h.txt'), lines);
  g(dir, 'add', '-A');
  g(dir, 'commit', '-m', 'init');
  const changed = lines.replace('L2\n', 'L2-changed\n').replace('L18\n', 'L18-changed\n');
  writeFileSync(path.join(dir, 'h.txt'), changed);
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

// diff 文本 → 第一个 hunk 的独立 patch（文件头 + 该 hunk），与前端 hunkPatch 同构。
function firstHunkPatch(diffText) {
  const lines = String(diffText || '').split('\n');
  const first = lines.findIndex((l) => l.startsWith('@@'));
  assert.ok(first >= 0, 'diff 里没有 hunk');
  let end = lines.findIndex((l, i) => i > first && l.startsWith('@@'));
  if (end < 0) end = lines.length;
  return lines.slice(0, end).join('\n') + '\n';
}
function hunkPatchAt(diffText, idx) {
  const lines = String(diffText || '').split('\n');
  const starts = lines.map((l, i) => (l.startsWith('@@') ? i : -1)).filter((i) => i >= 0);
  assert.ok(starts.length > idx, 'diff 里 hunk 不够');
  const from = starts[idx];
  const end = idx + 1 < starts.length ? starts[idx + 1] : lines.length;
  const headEnd = starts[0];
  return [...lines.slice(0, headEnd), ...lines.slice(from, end)].join('\n') + '\n';
}
const q = (dir, extra) => `/api/claude/review?ws=${encodeURIComponent(dir)}${extra || ''}`;

test('范围 unstaged：只含未暂存改动 + 未跟踪，不含已提交的', async () => {
  const r = makeRepo();
  try {
    const j = (await admin('GET', q(r.dir, '&scope=unstaged'))).json();
    assert.equal(j.scope, 'unstaged');
    const byPath = Object.fromEntries(j.files.map((f) => [f.path, f]));
    assert.ok(byPath['a.txt'], 'a.txt 有未暂存改动');
    assert.equal(byPath['a.txt'].add, 1);
    assert.equal(byPath['a.txt'].del, 1);
    assert.equal(byPath['c.txt'].st, 'U', '未跟踪文件在 unstaged 里');
    assert.ok(!byPath['b.txt'], 'b.txt 的改动已提交，不该出现在 unstaged');
  } finally { r.done(); }
});

test('范围 staged：只含暂存改动，不含未暂存与未跟踪', async () => {
  const r = makeRepo();
  try {
    const j = (await admin('GET', q(r.dir, '&scope=staged'))).json();
    const paths = j.files.map((f) => f.path);
    assert.deepEqual(paths, ['a.txt']);
    assert.equal(j.files[0].add, 1);
  } finally { r.done(); }
});

test('范围 commit：某提交 vs 其父，只含该提交的改动', async () => {
  const r = makeRepo();
  try {
    const j = (await admin('GET', q(r.dir, `&scope=commit&sha=${r.sha2}`))).json();
    assert.deepEqual(j.files.map((f) => f.path), ['b.txt']);
    assert.equal(j.subject, 'change b');
  } finally { r.done(); }
});

test('范围 branch：自动基线 = HEAD（main 上），含暂存+未暂存+未跟踪', async () => {
  const r = makeRepo();
  try {
    const j = (await admin('GET', q(r.dir, '&scope=branch'))).json();
    const paths = j.files.map((f) => f.path).sort();
    assert.deepEqual(paths, ['a.txt', 'c.txt']);
  } finally { r.done(); }
});

test('范围 branch + 显式基线 topic：含基线之后的提交改动', async () => {
  const r = makeRepo();
  try {
    const j = (await admin('GET', q(r.dir, '&scope=branch&base=topic'))).json();
    const paths = j.files.map((f) => f.path).sort();
    assert.deepEqual(paths, ['a.txt', 'b.txt', 'c.txt'], 'b.txt 是 topic 之后的提交改动');
  } finally { r.done(); }
});

// diff 里的 +/- 变更行（不含 ---/+++ 文件头，也不含 @@ 头里的函数上下文行——
// git 会把 hunk 上方的行文本塞进 @@ 头，比如 a2-staged，整段匹配会误判）。
const changedLines = (text) => String(text || '').split('\n').filter((l) => (l.startsWith('+') && !l.startsWith('+++')) || (l.startsWith('-') && !l.startsWith('---'))).join('\n');

test('单文件 diff 按范围切：unstaged 不含暂存行，staged 不含未暂存行', async () => {
  const r = makeRepo();
  try {
    const un = (await admin('GET', `/api/claude/review/diff?ws=${encodeURIComponent(r.dir)}&scope=unstaged&file=a.txt`)).json();
    assert.match(changedLines(un.text), /a6-unstaged/);
    assert.doesNotMatch(changedLines(un.text), /a2-staged/);
    const st = (await admin('GET', `/api/claude/review/diff?ws=${encodeURIComponent(r.dir)}&scope=staged&file=a.txt`)).json();
    assert.match(changedLines(st.text), /a2-staged/);
    assert.doesNotMatch(changedLines(st.text), /a6-unstaged/);
  } finally { r.done(); }
});

test('commits / branches：下拉数据', async () => {
  const r = makeRepo();
  try {
    const cs = (await admin('GET', `/api/claude/review/commits?ws=${encodeURIComponent(r.dir)}`)).json();
    assert.deepEqual(cs.commits.map((c) => c.subject), ['change b', 'init']);
    const bs = (await admin('GET', `/api/claude/review/branches?ws=${encodeURIComponent(r.dir)}`)).json();
    const names = bs.branches.map((b) => b.name).sort();
    assert.deepEqual(names, ['main', 'topic']);
    assert.equal(bs.branches.find((b) => b.name === 'main').current, true);
  } finally { r.done(); }
});

test('git 操作：stage 文件 → 进暂存区；unstage 文件 → 回工作区', async () => {
  const r = makeRepo();
  try {
    // a.txt 的未暂存改动暂存：unstaged 里消失，staged 里多一行
    const st1 = await admin('POST', '/api/claude/review/git', { body: { ws: r.dir, op: 'stage', level: 'file', file: 'a.txt' } });
    assert.equal(st1.code, 200, st1.text);
    assert.equal(gitStatus(r.dir).trim(), 'M  a.txt\n?? c.txt', 'a.txt 全进暂存区');
    assert.match(gitDiff(r.dir, '--cached', '--', 'a.txt'), /a6-unstaged/);
    // 再取消暂存：暂存区空，工作区恢复两处改动
    const st2 = await admin('POST', '/api/claude/review/git', { body: { ws: r.dir, op: 'unstage', level: 'file', file: 'a.txt' } });
    assert.equal(st2.code, 200, st2.text);
    assert.equal(gitDiff(r.dir, '--cached').trim(), '', '暂存区空了');
    assert.match(gitDiff(r.dir, '--', 'a.txt'), /a2-staged/);
    assert.match(gitDiff(r.dir, '--', 'a.txt'), /a6-unstaged/);
  } finally { r.done(); }
});

test('git 操作：revert 文件 → 回到 HEAD（暂存+未暂存都丢）', async () => {
  const r = makeRepo();
  try {
    const st = await admin('POST', '/api/claude/review/git', { body: { ws: r.dir, op: 'revert', level: 'file', file: 'a.txt' } });
    assert.equal(st.code, 200, st.text);
    assert.equal(read(r.dir, 'a.txt'), 'a1\na2\na3\na4\na5\na6\na7\na8\n', '回到 HEAD 内容');
    assert.equal(gitStatus(r.dir).trim(), '?? c.txt', 'a.txt 干净了，未跟踪 c.txt 还在');
  } finally { r.done(); }
});

test('git 操作：stage hunk → 只有该 hunk 进暂存区', async () => {
  const r = makeHunkRepo();
  try {
    const diff = (await admin('GET', `/api/claude/review/diff?ws=${encodeURIComponent(r.dir)}&scope=unstaged&file=h.txt`)).json();
    assert.equal((diff.text.match(/^@@ /gm) || []).length, 2, '夹具必须有两个 hunk');
    const patch = firstHunkPatch(diff.text);
    const st = await admin('POST', '/api/claude/review/git', { body: { ws: r.dir, op: 'stage', level: 'hunk', file: 'h.txt', patch } });
    assert.equal(st.code, 200, st.text);
    assert.match(gitDiff(r.dir, '--cached', '--', 'h.txt'), /L2-changed/, '第一个 hunk 进了暂存区');
    assert.doesNotMatch(gitDiff(r.dir, '--cached', '--', 'h.txt'), /L18-changed/);
    assert.match(gitDiff(r.dir, '--', 'h.txt'), /L18-changed/, '第二个 hunk 还在工作区');
    assert.doesNotMatch(gitDiff(r.dir, '--', 'h.txt'), /L2-changed/);
    // 同一个 hunk 再暂存一次 → 已过期，409
    const st2 = await admin('POST', '/api/claude/review/git', { body: { ws: r.dir, op: 'stage', level: 'hunk', file: 'h.txt', patch } });
    assert.equal(st2.code, 409);
  } finally { r.done(); }
});

test('git 操作：revert hunk → 只还原该 hunk', async () => {
  const r = makeHunkRepo();
  try {
    const diff = (await admin('GET', `/api/claude/review/diff?ws=${encodeURIComponent(r.dir)}&scope=unstaged&file=h.txt`)).json();
    const patch = hunkPatchAt(diff.text, 1);
    const st = await admin('POST', '/api/claude/review/git', { body: { ws: r.dir, op: 'revert', level: 'hunk', file: 'h.txt', patch } });
    assert.equal(st.code, 200, st.text);
    const content = read(r.dir, 'h.txt');
    assert.match(content, /L2-changed/, '第一个 hunk 的改动还在');
    assert.doesNotMatch(content, /L18-changed/, '第二个 hunk 被还原');
    assert.match(content, /^L18$/m);
  } finally { r.done(); }
});

test('git 操作：stage all / unstage all / revert all + revert-all 清未跟踪', async () => {
  const r = makeRepo();
  try {
    const s1 = await admin('POST', '/api/claude/review/git', { body: { ws: r.dir, op: 'stage', level: 'all' } });
    assert.equal(s1.code, 200, s1.text);
    assert.equal(gitDiff(r.dir).trim(), '', '全部暂存后工作区干净');
    const s2 = await admin('POST', '/api/claude/review/git', { body: { ws: r.dir, op: 'unstage', level: 'all' } });
    assert.equal(s2.code, 200, s2.text);
    assert.equal(gitDiff(r.dir, '--cached').trim(), '', '全部取消暂存后暂存区空');
    const s3 = await admin('POST', '/api/claude/review/git', { body: { ws: r.dir, op: 'revert', level: 'all' } });
    assert.equal(s3.code, 200, s3.text);
    assert.equal(gitStatus(r.dir).trim(), '', '全部还原后干净（含未跟踪删除）');
    assert.equal(existsSync(path.join(r.dir, 'c.txt')), false, '未跟踪 c.txt 被 revert-all 删除');
  } finally { r.done(); }
});

test('git 操作：非法输入与门禁', async () => {
  const r = makeRepo();
  try {
    // 路径穿越
    const esc = await admin('POST', '/api/claude/review/git', { body: { ws: r.dir, op: 'stage', level: 'file', file: '../escape.txt' } });
    assert.equal(esc.code, 400);
    // patch 与文件不匹配
    const mis = await admin('POST', '/api/claude/review/git', { body: { ws: r.dir, op: 'stage', level: 'hunk', file: 'a.txt', patch: 'diff --git a/other.txt b/other.txt\n--- a/other.txt\n+++ b/other.txt\n@@ -1 +1 @@\n-x\n+y\n' } });
    assert.equal(mis.code, 400);
    // 无身份 → 401（门禁与读接口同一套）
    const anon = await nobody('POST', '/api/claude/review/git', { body: { ws: r.dir, op: 'stage', level: 'all' } });
    assert.equal(anon.code, 401);
    // 无效范围
    const bad = await admin('GET', q(r.dir, '&scope=nope'));
    assert.equal(bad.code, 400);
    // 无效提交号
    const badSha = await admin('GET', q(r.dir, '&scope=commit&sha=zzz'));
    assert.equal(badSha.code, 400);
  } finally { r.done(); }
});

// 快照访客只读：GET 审阅带 readOnly，POST git 一律 403，工作树原样不动。
test('git 操作：快照访客只读（POST git 403，工作树不动）', async () => {
  const r = makeRepo();
  try {
    const before = gitStatus(r.dir);
    assert.ok(before.includes('a.txt'), '夹具：工作树有改动');
    const snapFor = (dir) => collect(() => ({ kind: 'snap', token: 't-snap', dir }));
    const j = (await snapFor(r.dir)('GET', q(r.dir, '&scope=branch'))).json();
    assert.equal(j.readOnly, true, 'snap 的审阅概览带 readOnly');
    const jAdmin = (await admin('GET', q(r.dir, '&scope=branch'))).json();
    assert.equal(jAdmin.readOnly, false, 'admin 不是只读');
    const s = await snapFor(r.dir)('POST', '/api/claude/review/git', { body: { ws: r.dir, op: 'stage', level: 'all' } });
    assert.equal(s.code, 403, s.text);
    assert.equal(gitStatus(r.dir), before, '403 后工作树原样不动');
    const s2 = await snapFor(r.dir)('POST', '/api/claude/review/git', { body: { ws: r.dir, op: 'revert', level: 'all' } });
    assert.equal(s2.code, 403, s2.text);
    assert.equal(gitStatus(r.dir), before, 'revert 也被拦下');
  } finally { r.done(); }
});

// 分支范围的 revert 回到基线（baseRef = merge-base），不是 HEAD、不是基线分支尖端：
// feature 在 sha2 上分支、又提交了一笔，再改工作区；revert-all(base=baseRef) 后
// a.txt 回到 sha2 时的内容（分支提交的改动也丢），未跟踪 c.txt 也被清掉。
test('git 操作：分支 revert 回到 baseRef（merge-base），不是 HEAD', async () => {
  const r = makeRepo();
  try {
    g(r.dir, 'checkout', '-b', 'feature');
    writeFileSync(path.join(r.dir, 'a.txt'), 'a1\na2-feature\na3\na4\na5\na6-unstaged\na7\na8\n');
    g(r.dir, 'add', 'a.txt');
    g(r.dir, 'commit', '-m', 'feature work');
    writeFileSync(path.join(r.dir, 'a.txt'), 'a1\na2-feature\na3\na4\na5\na6-work\na7\na8\n');
    const j = (await admin('GET', q(r.dir, '&scope=branch'))).json();
    assert.ok(j.baseRef, 'branch 概览带 baseRef');
    assert.equal(j.baseRef, g(r.dir, 'merge-base', 'HEAD', 'main').trim(), 'baseRef = merge-base(HEAD, main)');
    const s = await admin('POST', '/api/claude/review/git', { body: { ws: r.dir, op: 'revert', level: 'all', base: j.baseRef } });
    assert.equal(s.code, 200, s.text);
    assert.equal(read(r.dir, 'a.txt'), g(r.dir, 'show', `${j.baseRef}:a.txt`), 'a.txt 回到基线内容');
    assert.equal(existsSync(path.join(r.dir, 'c.txt')), false, '未跟踪 c.txt 被 revert-all 删除');
  } finally { r.done(); }
});
