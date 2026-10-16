// CLI worktree 模块（src/cli-worktrees.mjs）的单测：建 worktree / .worktreeinclude 复制 /
// worktreeInfo 判定 / 错误路径。只动临时仓，不碰真实仓库。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { createSessionWorktree, worktreeInfo, listWorktrees, storeFile } = await import('./cli-worktrees.mjs');

function makeRepo({ withInclude = true } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bridge-wt-repo-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString();
  git('init', '-b', 'main');
  git('config', 'user.email', 't@example.local');
  git('config', 'user.name', 't');
  writeFileSync(path.join(dir, 'a.js'), 'const x = 1;\n');
  git('add', '-A'); git('commit', '-m', 'init');
  // 被忽略的本地文件（.env）：.worktreeinclude 命中它时要拷进 worktree。
  writeFileSync(path.join(dir, '.gitignore'), '.env\n');
  writeFileSync(path.join(dir, '.env'), 'SECRET=1\n');
  if (withInclude) writeFileSync(path.join(dir, '.worktreeinclude'), '.env\n');
  return dir;
}

test('createSessionWorktree：detached HEAD + .codex/worktrees/<名> + .worktreeinclude 拷 .env + 记录落表', async () => {
  const repo = makeRepo();
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'bridge-wt-data-'));
  try {
    const entry = await createSessionWorktree({ storeFile: storeFile(dataDir, 'codex'), namespace: 'codex', dir: repo });
    assert.equal(entry.detached, true);
    assert.ok(entry.name.match(/^[a-z]+-[a-z]+-[0-9a-f]{6}$/), '名字是 形容词-名词-6hex：' + entry.name);
    assert.ok(entry.cwd.startsWith(path.join(repo, '.codex', 'worktrees', entry.name)), 'cwd 落在 .codex/worktrees/<名>：' + entry.cwd);
    assert.equal(existsSync(path.join(entry.cwd, 'a.js')), true, '检出里有提交内容');
    assert.equal(readFileSync(path.join(entry.cwd, '.env'), 'utf8'), 'SECRET=1\n', '.worktreeinclude 命中的被忽略文件拷过去了');
    // detached：HEAD 不是分支
    const ref = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: entry.cwd }).toString().trim();
    assert.equal(ref, 'HEAD');
    // 主检出的 info/exclude 多了一行 .codex/worktrees/
    const exclude = readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8');
    assert.ok(exclude.includes('.codex/worktrees/'), 'exclude 里有 .codex/worktrees/');
    // 记录落表
    const listed = listWorktrees(storeFile(dataDir, 'codex'));
    assert.equal(listed.length, 1);
    assert.equal(listed[0].cwd, entry.cwd);
    // worktreeInfo 认得出它
    const info = await worktreeInfo(entry.cwd);
    assert.equal(info.name, entry.name);
    assert.equal(info.detached, true);
    assert.ok(info.branch, 'detached 时 branch 回落短 sha');
  } finally {
    // 删仓即清（worktree 在仓内），无须逐个 worktree remove
    rmSync(repo, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('worktreeInfo：主检出返回 null；无 .worktreeinclude 时不拷被忽略文件', async () => {
  const repo = makeRepo({ withInclude: false });
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'bridge-wt-data-'));
  try {
    assert.equal(await worktreeInfo(repo), null, '主检出不是 worktree');
    const entry = await createSessionWorktree({ storeFile: storeFile(dataDir, 'zcode'), namespace: 'zcode', dir: repo });
    assert.ok(entry.cwd.includes(path.join('.zcode', 'worktrees')), 'zcode 用自己的命名空间');
    assert.equal(existsSync(path.join(entry.cwd, '.env')), false, '没 .worktreeinclude 就不拷 .env');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('createSessionWorktree：非 git 仓库 / 无提交仓库都报错，不静默建', async () => {
  const plain = mkdtempSync(path.join(os.tmpdir(), 'bridge-wt-plain-'));
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'bridge-wt-data-'));
  try {
    await assert.rejects(
      createSessionWorktree({ storeFile: storeFile(dataDir, 'codex'), namespace: 'codex', dir: plain }),
      /不是 git 仓库/,
    );
    const empty = mkdtempSync(path.join(os.tmpdir(), 'bridge-wt-empty-'));
    execFileSync('git', ['init', '-b', 'main'], { cwd: empty, stdio: 'pipe' });
    await assert.rejects(
      createSessionWorktree({ storeFile: storeFile(dataDir, 'codex'), namespace: 'codex', dir: empty }),
      /还没有任何提交/,
    );
    rmSync(empty, { recursive: true, force: true });
  } finally {
    rmSync(plain, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});
