// Codex / ZCode 分页的「worktree 会话」——输入框 worktree 勾选框（照 Claude 侧 WorkspaceChips）。
// 勾上再开新对话：先从当前工作目录切一个 git worktree，会话整轮以 worktree 为 cwd 运行，
// 主检出一个字节都不碰。
//
// 形制照 Claude 侧（src/claude-worktrees.mjs），两处按官方 Codex 的约定改：
//   位置 <主仓库根>/.<agent>/worktrees/<名>（codex → .codex，zcode → .zcode，各家各的命名空间）；
//   HEAD 是 detached（官方 Codex 默认就是 detached HEAD），不新建分支——Claude 侧建 claude/<名> 分支。
// 其余照搬 Claude 侧：名字 = 形容词-名词-6 位 hex；`.<agent>/worktrees/` 写进
// <common-dir>/info/exclude（不碰仓库的 .gitignore）；仓库根有 .worktreeinclude 时，
// 把命中它、且被 git 忽略的未跟踪文件（.env 之类）拷进新 worktree。
//
// 归属：worktree 的 cwd 与 agent 的工作目录不同。这里按身份记一张小表
// （<dataDir>/<agent>-worktrees.json：worktree → 归属），只做记录与上限（500 条），
// 不自动删——保留 / 清理策略以 Claude 侧现有实现为准（它也不自动删）。
// 会话本身存在 cli-sessions 里（cwd 就是 worktree 的 cwd），续聊时前端把会话 cwd
// 随消息带上（过 authorizeProjectPath 门禁），后端据此跑在 worktree 里；
// worktreeInfo 再验一遍 cwd 是不是 linked worktree，供前端亮只读指示。

import crypto from 'node:crypto';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, appendFileSync, copyFileSync, statSync, realpathSync } from 'node:fs';
import { readJson, writeJson } from './jsonfile.mjs';

const MAX_RECORDS = 500;
const MAX_INCLUDE_FILES = 2000;
const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };

const real = (p) => { try { return realpathSync.native ? realpathSync.native(p) : realpathSync(p); } catch { return path.resolve(p); } };
const fold = (p) => process.platform === 'win32' ? p.toLowerCase() : p;
const samePath = (a, b) => fold(path.resolve(a || '')) === fold(path.resolve(b || ''));
const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });

export function storeFile(dataDir, namespace) {
  return path.join(dataDir || '.', `${namespace}-worktrees.json`);
}

function readStore(file) {
  const data = readJson(file, { worktrees: [] });
  return {
    worktrees: (Array.isArray(data.worktrees) ? data.worktrees : [])
      .filter((w) => w && typeof w.cwd === 'string'),
  };
}

// 某身份记着的全部 worktree（{ namespace, name, root, cwd, base, detached, created }）
export function listWorktrees(file) {
  return readStore(file).worktrees;
}

function record(file, entry) {
  const store = readStore(file);
  store.worktrees = store.worktrees.filter((w) => !samePath(w.cwd, entry.cwd));
  store.worktrees.push(entry);
  if (store.worktrees.length > MAX_RECORDS) store.worktrees.splice(0, store.worktrees.length - MAX_RECORDS);
  writeJson(file, store, 2);
}

function git(cwd, args, { timeout = 60_000 } = {}) {
  return new Promise((resolve) => {
    execFile('git', ['-c', 'core.quotepath=false', ...args], { cwd, env: GIT_ENV, timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve(err ? { ok: false, out: '', err: String(stderr || err.message || err).trim() } : { ok: true, out: String(stdout ?? ''), err: '' });
    });
  });
}

// 官方名字表的同款做法（与 claude-worktrees.mjs 同一套词表 + randomBytes(3)）。
const ADJ = ['amber', 'brave', 'calm', 'clever', 'crisp', 'eager', 'fuzzy', 'gentle', 'happy', 'jolly', 'keen', 'lively', 'lucky', 'mellow', 'nimble', 'quiet', 'rapid', 'shiny', 'snowy', 'sunny', 'swift', 'tidy', 'vivid', 'witty'];
const NOUN = ['badger', 'beacon', 'cedar', 'comet', 'falcon', 'fern', 'harbor', 'heron', 'lantern', 'maple', 'meadow', 'otter', 'pebble', 'pine', 'quartz', 'raven', 'river', 'sparrow', 'summit', 'thistle', 'tulip', 'walrus', 'willow', 'zephyr'];
const pick = (arr) => arr[crypto.randomInt(arr.length)];
const genName = () => `${pick(ADJ)}-${pick(NOUN)}-${crypto.randomBytes(3).toString('hex')}`;

// <common-dir>/info/exclude 里补一行 `.<namespace>/worktrees/`——否则主检出的 git status
// 会把整棵 worktree 目录当成未跟踪文件端上来（审阅面板第一眼就是一片噪音）。
function ensureExcluded(commonDir, namespace) {
  const file = path.join(commonDir, 'info', 'exclude');
  const line = `.${namespace}/worktrees`;
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch {}
  if (text.split(/\r?\n/).some((l) => l.trim().replace(/\/$/, '') === line)) return;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, (text && !text.endsWith('\n') ? '\n' : '') + line + '/\n');
  } catch {}
}

// .worktreeinclude：列出「被 git 忽略、又命中这份清单」的未跟踪文件，原样拷进新 worktree。
// 与 claude-worktrees.mjs 的 copyWorktreeIncludes 同款逻辑（两边各管各家的命名空间，不合并不重构）。
async function copyWorktreeIncludes(srcTop, dstTop) {
  const list = path.join(srcTop, '.worktreeinclude');
  if (!existsSync(list)) return 0;
  const r = await git(srcTop, ['ls-files', '-z', '--others', '--ignored', '--exclude-from=' + list]);
  if (!r.ok) return 0;
  let n = 0;
  for (const rel of r.out.split('\0').filter(Boolean).slice(0, MAX_INCLUDE_FILES)) {
    const from = path.join(srcTop, rel);
    const to = path.join(dstTop, rel);
    if (!path.resolve(to).startsWith(path.resolve(dstTop) + path.sep)) continue;
    try {
      if (!statSync(from).isFile() || existsSync(to)) continue;
      mkdirSync(path.dirname(to), { recursive: true });
      copyFileSync(from, to);
      n++;
    } catch {}
  }
  return n;
}

// 给工作目录 dir（已过 authorizeProjectPath）切一个会话 worktree。
// 返回 { namespace, name, root, cwd, base, detached: true, created }；cwd = worktree 里
// 对应项目目录的位置（工作目录是仓库子目录时同样落在子目录）。失败抛带 status 的 Error。
export async function createSessionWorktree({ storeFile: file, namespace, dir }) {
  const top = await git(dir, ['rev-parse', '--show-toplevel']);
  if (!top.ok) throw fail('这个工作空间不是 git 仓库，无法创建 worktree');
  const toplevel = path.resolve(top.out.trim());
  const common = await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!common.ok) throw fail('读取 git 仓库信息失败：' + common.err);
  const commonDir = path.resolve(common.out.trim());
  const head = await git(dir, ['rev-parse', '--verify', '-q', 'HEAD']);
  if (!head.ok || !head.out.trim()) throw fail('仓库还没有任何提交，无法从当前分支创建 worktree');
  const base = ((await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).out.trim()) || head.out.trim().slice(0, 7);

  // 主仓库根：common-dir 是 <根>/.git 时取其父；裸仓库等异形退回当前 toplevel。
  const mainRoot = path.basename(commonDir).toLowerCase() === '.git' ? path.dirname(commonDir) : toplevel;
  const parent = path.join(mainRoot, `.${namespace}`, 'worktrees');
  let name = '';
  for (let i = 0; i < 8; i++) {
    const n = genName();
    if (existsSync(path.join(parent, n))) continue;
    name = n; break;
  }
  if (!name) throw fail('生成 worktree 名字失败，请重试', 500);
  const root = path.join(parent, name);
  mkdirSync(parent, { recursive: true });
  ensureExcluded(commonDir, namespace);
  // detached HEAD（官方 Codex 默认）：不新建分支，会话跑完想留分支自己建（Create branch here 是延期项）。
  const add = await git(dir, ['worktree', 'add', '--detach', root, 'HEAD'], { timeout: 180_000 });
  if (!add.ok) throw fail('git worktree add 失败：' + (add.err.split(/\r?\n/).filter(Boolean).pop() || '未知错误'), 500);

  await copyWorktreeIncludes(toplevel, root);
  const rel = path.relative(toplevel, path.resolve(dir));
  let cwd = rel && !rel.startsWith('..') ? path.join(root, rel) : root;
  if (!existsSync(cwd)) mkdirSync(cwd, { recursive: true });   // 工作目录全是被忽略文件时，检出里没有它
  cwd = real(cwd);
  const entry = { namespace, name, root: real(root), cwd, base, detached: true, created: Date.now() };
  if (file) record(file, entry);
  return entry;
}

// cwd 是不是 linked worktree？是 → { name, cwd, detached, branch }；不是 → null。
// 判据与 dock/meta 同款：--absolute-git-dir 与 resolve(cwd, --git-common-dir) 不同即是。
// name 取 git-dir 的最后一级（linked worktree 的 git-dir 是 <common>/.git/worktrees/<名>）。
export async function worktreeInfo(cwd) {
  if (!cwd) return null;
  const gitDir = (await git(cwd, ['rev-parse', '--absolute-git-dir'])).out.trim();
  const commonRaw = (await git(cwd, ['rev-parse', '--git-common-dir'])).out.trim();
  if (!gitDir || !commonRaw) return null;
  if (path.resolve(gitDir) === path.resolve(cwd, commonRaw)) return null;
  const branchRaw = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).out.trim();
  const detached = branchRaw === 'HEAD' || !branchRaw;
  const branch = detached
    ? ((await git(cwd, ['rev-parse', '--short', 'HEAD'])).out.trim() || null)
    : branchRaw;
  return { name: path.basename(gitDir), cwd: real(cwd), detached, branch };
}
