// Claude 分页右侧工作台（dock）的后端三组接口：
//   审阅  GET  /api/claude/review, /api/claude/review/diff   — worktree 概览（git 变更清单 + 单文件 diff）
//   终端  GET  /api/claude/term/stream + POST input/resize/kill — 工作空间 PTY（ctx.shell 门禁）
//   元信息 GET /api/claude/dock/meta — 工作空间相对路径（文件页跳转）+ git 归属（分支 / 是否
//          linked worktree，供输入框上方的归属状态栏芯片）+ 能力位
//
// 命名说明：/api/claude/* 是历史遗留（面板先随 Claude 工作台出生），审阅面板三家共用
// （Claude / Codex / ZCode），为兼容现有调用不另开 /api/dock/*，别把 Codex 逻辑写死进这里。
//
// 工作空间路径一律经 authorizeProjectPath 圈定（admin 任意本地目录、Pro 限自己空间、
// share 走 requireCtx 直接 401），全局 Origin CSRF 闸已覆盖所有 POST。
//
// 聊天快照（kind:'snap'，公开 /c/ 链接的匿名访客）拿到的是【阉割版工作台】：
//   审阅 ✓ / 文件 ✓ / 终端 ✗
// ws 参数对 snap 一律忽略、强制取 ctx.cwd（快照桶），前端传什么都改不了作用域。

import path from 'node:path';
import { execFile } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { readBody } from '../runtime/body.mjs';
import { requireCtx } from '../runtime/identity.mjs';
import { withinRoot } from '../runtime/http-file.mjs';
import { authorizeProjectPath } from '../claude-projects.mjs';
import { writeSseHeaders, sseWrite, startHeartbeat } from '../runtime/sse.mjs';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'; // git 恒定空树 hash
const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const fail = (res, e) => json(res, e?.status || 500, { error: e?.message || String(e) });

function git(ws, args, { maxBuffer = 16 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    execFile('git', ['-c', 'core.quotepath=false', ...args], { cwd: ws, env: GIT_ENV, timeout: 15_000, maxBuffer, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : String(stdout ?? ''));
    });
  });
}

// 带错误详情的 git（破坏性操作要把失败原因说清，不能只回 null）。
function git2(ws, args, { timeout = 15_000, input = null } = {}) {
  return new Promise((resolve) => {
    const child = execFile('git', ['-c', 'core.quotepath=false', ...args], { cwd: ws, env: GIT_ENV, timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve(err ? { ok: false, out: String(stdout ?? ''), err: String(stderr || err.message || err).trim() } : { ok: true, out: String(stdout ?? ''), err: '' });
    });
    if (input != null) {
      try { child.stdin.write(input); child.stdin.end(); } catch {}
    }
  });
}

// 工作空间在仓库里的相对前缀（仓库根 → ''，子目录 → 'a/b/'）。
// 工作空间是某个仓库的【子目录】时（快照桶就落在 claude-bridge 仓里！），不加限定的
// git diff/status 会把【整个仓库】的变更端上来——对公开快照访客等于泄露整份源码工作树。
// 所以下面所有 git 调用一律 `-- .` 限定到本目录子树，并把输出路径拉回工作空间相对：
// diff 用 --relative（git 自己按 cwd 剥前缀），status 只认仓库相对路径、手工剥 prefix。
async function gitPrefix(ws) {
  return ((await git(ws, ['rev-parse', '--show-prefix'])) || '').trim();
}

// 基线选择：在分支上且存在 main/master → merge-base（分支全部工作+未提交都算变更）；
// 否则 HEAD（只看未提交）；无任何提交的新仓库 → 空树。label 是「X → working tree」里的 X。
async function reviewBase(ws) {
  const branch = ((await git(ws, ['rev-parse', '--abbrev-ref', 'HEAD'])) || '').trim() || 'HEAD';
  const hasHead = (await git(ws, ['rev-parse', '--verify', '-q', 'HEAD'])) != null;
  if (!hasHead) return { base: EMPTY_TREE, label: branch, branch };
  for (const main of ['main', 'master']) {
    if (branch === main) break;
    if ((await git(ws, ['rev-parse', '--verify', '-q', 'refs/heads/' + main])) == null) continue;
    const mb = await git(ws, ['merge-base', 'HEAD', main]);
    if (mb) return { base: mb.trim(), label: main, branch };
    break;
  }
  return { base: 'HEAD', label: branch, branch };
}

// ── 审阅范围（P0：官方 PC 端的五种范围；Last turn 不走后端，见 P1）─────────────
// 返回 git diff 要拼的那组 range 参数 + 展示用标签 + 是否带未跟踪文件。
//   unstaged：工作区 vs 暂存区（git diff）+ 未跟踪
//   staged：暂存区 vs HEAD（git diff --cached），不带未跟踪
//   commit：该提交相对其父提交（根提交对空树），不带未跟踪
//   branch：工作区 vs 基线（merge-base(HEAD, base) 或自动基线）+ 未跟踪
// base 参数只在 branch 范围下用（选定的基线分支名）；sha 只在 commit 范围下用。
// 抛带 status 的 Error（400 = 参数不合法，调用方直接回给前端）。
const SHA_RE = /^[0-9a-f]{4,40}$/i;
const REF_RE = /^[A-Za-z0-9._/-]+$/;
async function scopeRange(ws, { scope = 'branch', sha = '', base = '' } = {}) {
  if (scope === 'unstaged') return { args: [], label: '工作区', untracked: true, scope };
  if (scope === 'staged') return { args: ['--cached'], label: '暂存区', untracked: false, scope };
  if (scope === 'commit') {
    const s = String(sha || '').trim();
    if (!SHA_RE.test(s)) throw Object.assign(new Error('提交号不合法'), { status: 400 });
    const full = await git(ws, ['rev-parse', '--verify', '-q', s + '^{commit}']);
    if (!full) throw Object.assign(new Error('找不到这个提交'), { status: 400 });
    const commit = full.trim();
    const parent = await git(ws, ['rev-parse', '--verify', '-q', commit + '^']);
    const subject = ((await git(ws, ['log', '-1', '--format=%s', commit])) || '').trim();
    return { args: [parent ? parent.trim() : EMPTY_TREE, commit], label: subject || commit.slice(0, 7), untracked: false, scope, sha: commit, subject };
  }
  if (scope === 'branch') {
    const b = String(base || '').trim();
    if (b) {
      if (!REF_RE.test(b)) throw Object.assign(new Error('分支名不合法'), { status: 400 });
      const ref = await git(ws, ['rev-parse', '--verify', '-q', 'refs/heads/' + b]);
      if (!ref) throw Object.assign(new Error('找不到这个分支'), { status: 400 });
      const mb = await git(ws, ['merge-base', 'HEAD', b]);
      return { args: [mb ? mb.trim() : b], label: b, untracked: true, scope, base: b };
    }
    const auto = await reviewBase(ws);
    return { args: [auto.base], label: auto.label, untracked: true, scope, branch: auto.branch };
  }
  throw Object.assign(new Error('未知的审阅范围'), { status: 400 });
}

// 解析 `git diff --numstat -z -M` ：常规记录 "add\tdel\tpath\0"，改名记录 "add\tdel\t\0old\0new\0"。
function parseNumstatZ(out) {
  const files = [];
  const tok = String(out || '').split('\0');
  for (let i = 0; i < tok.length; i++) {
    const t = tok[i];
    if (!t) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(t);
    if (!m) continue;
    const bin = m[1] === '-';
    const add = bin ? 0 : +m[1];
    const del = bin ? 0 : +m[2];
    if (m[3] === '') {
      const from = tok[++i] ?? '';
      const to = tok[++i] ?? '';
      files.push({ path: to, from, add, del, bin });
    } else {
      files.push({ path: m[3], add, del, bin });
    }
  }
  return files;
}

// 解析 `git diff --name-status -z -M`：R/C 后跟两个路径，其余一个。
function parseNameStatusZ(out) {
  const map = new Map();
  const tok = String(out || '').split('\0');
  for (let i = 0; i < tok.length; i++) {
    const st = tok[i];
    if (!st) continue;
    const letter = st[0];
    if (letter === 'R' || letter === 'C') {
      i += 2;
      map.set(tok[i] ?? '', letter);
    } else {
      i += 1;
      map.set(tok[i] ?? '', letter);
    }
  }
  return map;
}

const looksBinary = (buf) => buf.subarray(0, 8000).includes(0);

// 未跟踪文件行数（读上限 1MB 内数 \n；二进制不数）。
function untrackedStat(abs) {
  let st;
  try { st = statSync(abs); } catch { return null; }
  if (!st.isFile()) return null;
  if (st.size === 0) return { add: 0, bin: false };
  let buf;
  try {
    buf = readFileSync(abs);
  } catch { return null; }
  if (looksBinary(buf)) return { add: 0, bin: true };
  const slice = buf.length > 1024 * 1024 ? buf.subarray(0, 1024 * 1024) : buf;
  let lines = 0;
  for (let i = 0; i < slice.length; i++) if (slice[i] === 10) lines++;
  if (slice.length && slice[slice.length - 1] !== 10) lines++;
  return { add: lines, bin: false };
}

// 未跟踪清单：status -z --untracked-files=all 里的 "?? path" 记录。
// `-- .` 只看本工作空间子树；status 输出恒为仓库相对路径，按 prefix 剥回本地相对。
async function untrackedFiles(ws, prefix) {
  const out = await git(ws, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.']);
  if (out == null) return [];
  const files = [];
  const tok = out.split('\0');
  for (let i = 0; i < tok.length; i++) {
    const t = tok[i];
    if (!t || t.length < 4) continue;
    const st = t.slice(0, 2);
    if (st[0] === 'R' || st[0] === 'C') i += 1; // rename 的第二段路径跳过
    if (st !== '??') continue;
    const p = t.slice(3);
    if (prefix && !p.startsWith(prefix)) continue;   // 子树外的一律丢掉（`-- .` 之外的兜底）
    files.push(prefix ? p.slice(prefix.length) : p);
    if (files.length >= 500) break;
  }
  return files;
}

// 相对路径护栏：rel 必须落在 ws 内（拒绝绝对路径与 .. 穿越）。
function insideWs(ws, rel) {
  const raw = String(rel || '');
  if (!raw || path.isAbsolute(raw)) return null;
  const abs = path.resolve(ws, raw);
  const root = path.resolve(ws);
  if (!withinRoot(root, abs)) return null;
  return abs;
}

export function registerClaudeDockRoutes(router, { identify }) {
  // 统一守卫：登录 → ctx；ws 参数 → 授权后的绝对路径。失败已回响应，返回 null。
  //   shell:true = 需要完整权限（终端）——snap/普通 user 403。
  const dockCtx = (req, res, wsRaw, { shell = false } = {}) => {
    const ctx = requireCtx(identify, req, res);
    if (!ctx) return null;
    const isSnap = ctx.kind === 'snap';
    if (shell && !ctx.shell) { json(res, 403, { error: '该功能仅对完整权限用户开放' }); return null; }
    let ws;
    // 快照身份忽略客户端传来的 ws，一律锁死在自己的桶：作用域不由前端说了算。
    try { ws = authorizeProjectPath(ctx, isSnap ? ctx.cwd : wsRaw); } catch (e) { fail(res, e); return null; }
    return { ctx, ws };
  };

  // ── 元信息：文件页跳转用的相对路径 + git 仓库判定 + 能力位 ──────────────────
  router.on('GET', '/api/claude/dock/meta', async (req, res, url) => {
    const g = dockCtx(req, res, url.searchParams.get('ws'));
    if (!g) return;
    const { ctx, ws } = g;
    const root = path.resolve(ctx.cwd || '');
    const relRaw = path.relative(root, ws);
    const rel = relRaw === '' ? '' : (!relRaw.startsWith('..') && !path.isAbsolute(relRaw) ? relRaw.split(path.sep).join('/') : null);
    const isGit = (await git(ws, ['rev-parse', '--is-inside-work-tree'])) != null;
    // 输入框上方的「归属状态栏」芯片要的两项——只在 git 仓库里才多跑这几条：
    //   branch   分支名；detached HEAD 回落短 sha（芯片总得有字可显）
    //   worktree 本目录是不是 linked worktree（--git-dir 落在主仓 .git/worktrees/<名>，
    //            与 --git-common-dir 不同即是）。--git-common-dir 在主检出里返回相对路径、
    //            在 worktree 里返回绝对路径，故一律 resolve(ws, …) 后再比。
    let branch = null;
    let worktree = false;
    if (isGit) {
      branch = ((await git(ws, ['rev-parse', '--abbrev-ref', 'HEAD'])) || '').trim() || null;
      if (branch === 'HEAD') branch = ((await git(ws, ['rev-parse', '--short', 'HEAD'])) || '').trim() || null;
      const gitDir = ((await git(ws, ['rev-parse', '--absolute-git-dir'])) || '').trim();
      const commonRaw = ((await git(ws, ['rev-parse', '--git-common-dir'])) || '').trim();
      worktree = !!gitDir && !!commonRaw && path.resolve(gitDir) !== path.resolve(ws, commonRaw);
    }
    // snap = 快照访客：前端据此只摆 审阅/文件两件，并藏掉工作空间路径。
    // wtNew = 本服务端能在这里开 worktree 会话（git 主检出、非快照）——输入栏 worktree 勾选框只认它：
    // 前端先于服务端上线时勾选框不出现，不会勾了却悄悄跑在主检出里。
    json(res, 200, { rel, git: isGit, branch, worktree, wtNew: isGit && !worktree && ctx.kind !== 'snap', shell: !!ctx.shell, snap: ctx.kind === 'snap' });
  });

  // ── 审阅：变更概览（scope：unstaged / staged / commit / branch；缺省 branch 保持老行为） ──
  router.on('GET', '/api/claude/review', async (req, res, url) => {
    const g = dockCtx(req, res, url.searchParams.get('ws'));
    if (!g) return;
    const { ctx, ws } = g;
    if ((await git(ws, ['rev-parse', '--is-inside-work-tree'])) == null) return json(res, 200, { git: false });
    let range;
    try {
      range = await scopeRange(ws, {
        scope: url.searchParams.get('scope') || 'branch',
        sha: url.searchParams.get('sha') || '',
        base: url.searchParams.get('base') || '',
      });
    } catch (e) { return fail(res, e); }
    const branch = ((await git(ws, ['rev-parse', '--abbrev-ref', 'HEAD'])) || '').trim() || 'HEAD';
    const prefix = await gitPrefix(ws);
    const [numstat, nameStatus] = await Promise.all([
      git(ws, ['diff', '--numstat', '-z', '-M', '--relative', ...range.args, '--', '.']),
      git(ws, ['diff', '--name-status', '-z', '-M', '--relative', ...range.args, '--', '.']),
    ]);
    const stMap = parseNameStatusZ(nameStatus);
    const files = parseNumstatZ(numstat).map((f) => ({ ...f, st: stMap.get(f.path) || 'M' }));
    const seen = new Set(files.map((f) => f.path));
    let truncated = false;
    if (range.untracked) {
      for (const rel of await untrackedFiles(ws, prefix)) {
        if (seen.has(rel)) continue;
        const abs = insideWs(ws, rel);
        if (!abs) continue;
        const stat = untrackedStat(abs);
        if (!stat) continue;
        files.push({ path: rel, add: stat.add, del: 0, bin: stat.bin, st: 'U' });
        if (files.length >= 800) { truncated = true; break; }
      }
    }
    const total = files.reduce((a, f) => ({ add: a.add + (f.add || 0), del: a.del + (f.del || 0) }), { add: 0, del: 0 });
    // readOnly：快照访客只看不写（前端据此藏掉 Git 操作按钮，后端 git 接口也要拦）。
    // baseRef：branch 范围的解析后基线（merge-base SHA / 自动基线 / 无 merge-base 时的分支名）——
    // 分支范围的 revert 要回到它，不是 HEAD、也不是基线分支的尖端。
    json(res, 200, { git: true, branch, base: range.label, scope: range.scope, sha: range.sha || null, subject: range.subject || null, files, total, truncated, readOnly: ctx.kind === 'snap', ...(range.scope === 'branch' ? { baseRef: range.args[0] } : {}) });
  });

  // ── 审阅：最近提交（commit 范围的下拉）──────────────────────────────────────
  router.on('GET', '/api/claude/review/commits', async (req, res, url) => {
    const g = dockCtx(req, res, url.searchParams.get('ws'));
    if (!g) return;
    const { ws } = g;
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '30', 10) || 30));
    const out = await git(ws, ['log', `--format=%H%x1f%h%x1f%s%x1f%an%x1f%cI`, '-z', '-n', String(limit)]);
    if (out == null) return json(res, 200, { commits: [] });
    const commits = out.split('\0').filter(Boolean).map((line) => {
      const [sha, short, subject, author, date] = line.split('\x1f');
      return { sha, short, subject, author, date };
    });
    json(res, 200, { commits });
  });

  // ── 审阅：本地分支（branch 范围的基线下拉）──────────────────────────────────
  router.on('GET', '/api/claude/review/branches', async (req, res, url) => {
    const g = dockCtx(req, res, url.searchParams.get('ws'));
    if (!g) return;
    const { ws } = g;
    const out = await git(ws, ['branch', '--format=%(refname:short)%09%(HEAD)']);
    if (out == null) return json(res, 200, { branches: [] });
    const branches = out.split('\n').filter(Boolean).map((line) => {
      const [name, head] = line.split('\t');
      return { name, current: head === '*' };
    });
    json(res, 200, { branches });
  });

  // ── 审阅：单文件 diff（懒加载展开）──────────────────────────────────────────
  router.on('GET', '/api/claude/review/diff', async (req, res, url) => {
    const g = dockCtx(req, res, url.searchParams.get('ws'));
    if (!g) return;
    const { ws } = g;
    const rel = String(url.searchParams.get('file') || '');
    const from = String(url.searchParams.get('from') || '');
    const abs = insideWs(ws, rel);
    if (!abs) return json(res, 400, { error: 'bad file path' });
    // S4：from=重命名旧路径（组 diff 用），与 file 同规矩过 insideWs——否则公开 /c/ 快照
    // 访客可用 ../../ 把 git pathspec 指到工作空间子树之外，读整个仓库任意文件的 diff。
    if (from && from !== rel && !insideWs(ws, from)) return json(res, 400, { error: 'bad from path' });
    // 未跟踪标记用 u=1——st/ct 是身份系统的保留查询参数（share/snap 能力 token），
    // 带 st=U 会被 identify 当成过期分享 token 解析成 none → 401。
    const untracked = String(url.searchParams.get('u') || '') === '1';
    if (untracked) {
      // 未跟踪：合成整篇新增的伪 diff（git diff 不含未跟踪文件）。
      let buf;
      try { buf = readFileSync(abs); } catch { return json(res, 404, { error: '文件不存在' }); }
      if (looksBinary(buf)) return json(res, 200, { bin: true, text: '' });
      let text = buf.toString('utf8');
      let truncated = false;
      if (text.length > 400 * 1024) { text = text.slice(0, 400 * 1024); truncated = true; }
      let lines = text.split('\n');
      if (lines.length && lines[lines.length - 1] === '') lines.pop();
      if (lines.length > 4000) { lines = lines.slice(0, 4000); truncated = true; }
      const body = `@@ -0,0 +1,${lines.length} @@\n` + lines.map((l) => '+' + l).join('\n');
      return json(res, 200, { text: body, truncated });
    }
    // 范围与概览接口同一套：unstaged/staged/commit/branch 各自的 range（见 scopeRange）。
    // commit 范围的单文件 diff 也是「提交 vs 其父」，不是「文件 vs 基线」。
    let range;
    try {
      range = await scopeRange(ws, {
        scope: url.searchParams.get('scope') || 'branch',
        sha: url.searchParams.get('sha') || '',
        base: url.searchParams.get('base') || '',
      });
    } catch (e) { return fail(res, e); }
    // pathspec 本就以 cwd 为基准，--relative 让输出头部路径也回到工作空间相对——
    // 与上面清单里的路径同一套坐标系（工作空间=仓库子目录时尤其关键）。
    const spec = from && from !== rel ? [from, rel] : [rel];
    let out = await git(ws, ['diff', '--no-ext-diff', '--unified=3', '-M', '--relative', ...range.args, '--', ...spec]);
    if (out == null) return json(res, 500, { error: 'git diff 失败' });
    let truncated = false;
    if (out.length > 1024 * 1024) {
      out = out.slice(0, 1024 * 1024);
      const cut = out.lastIndexOf('\n');
      if (cut > 0) out = out.slice(0, cut);
      truncated = true;
    }
    json(res, 200, { text: out, truncated, bin: /^Binary files /m.test(out) });
  });

  // ── 审阅：Git 操作（P0：三级 stage / unstage / revert）───────────────────────
  // 破坏性操作，门禁与读接口同一套（dockCtx + authorizeProjectPath），不另开新口子。
  // body：{ ws, op: stage|unstage|revert, level: all|file|hunk, file?, patch?, base? }
  //   level=all：整 diff（stage-all = add -A；unstage-all = reset；revert-all = 恢复到 base + 清未跟踪）
  //   level=file：单个文件（stage = add；unstage = reset；revert = 恢复到 base，未跟踪则删除）
  //   level=hunk：单个 hunk（patch = 带文件头的独立 patch 文本；先 --check 再 apply）
  // base 只在 branch 范围的 revert 下传（恢复到基线 = 概览接口返回的 baseRef，merge-base SHA）；缺省 HEAD。
  // patch 校验：恰好一个 diff --git 块、目标路径必须等于 file，防止一份 patch 改多个文件。
  // 快照访客（ctx.kind === 'snap'）只读：一切 POST git 操作后端直接 403，前端也藏按钮。
  router.on('POST', '/api/claude/review/git', async (req, res) => {
    let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    const g = dockCtx(req, res, body.ws);
    if (!g) return;
    const { ctx, ws } = g;
    if (ctx.kind === 'snap') return json(res, 403, { error: '快照访客只读，无法执行 Git 操作' });
    const op = String(body.op || '');
    const level = String(body.level || '');
    if (!['stage', 'unstage', 'revert'].includes(op)) return json(res, 400, { error: '未知的操作' });
    if (!['all', 'file', 'hunk'].includes(level)) return json(res, 400, { error: '未知的层级' });
    const file = level === 'all' ? '' : String(body.file || '');
    if (level !== 'all' && !insideWs(ws, file)) return json(res, 400, { error: 'bad file path' });
    // revert 的恢复目标：缺省 HEAD；branch 范围传基线分支名/提交。
    let base = 'HEAD';
    if (op === 'revert' && body.base) {
      const b = String(body.base).trim();
      if (!REF_RE.test(b) && !SHA_RE.test(b)) return json(res, 400, { error: '恢复目标不合法' });
      if ((await git(ws, ['rev-parse', '--verify', '-q', b]))) base = b;
      else return json(res, 400, { error: '找不到恢复目标' });
    }
    // 无提交的新仓库没有 HEAD：checkout HEAD / cat-file -e HEAD:... 都会炸，改用空树
    // （revert 表现为清掉暂存的新增、恢复不出任何文件；unstage 仍正常工作）。
    if (op === 'revert' && !body.base && (await git(ws, ['rev-parse', '--verify', '-q', 'HEAD'])) == null) base = EMPTY_TREE;
    const run = async (args, input = null) => {
      const r = await git2(ws, args, { input });
      if (!r.ok) return json(res, 409, { error: r.err || 'git 操作失败' });
      return json(res, 200, { ok: true });
    };
    if (level === 'all') {
      if (op === 'stage') return run(['add', '-A', '--', '.']);
      if (op === 'unstage') return run(['reset', '-q', '--', '.']);
      // revert-all：先恢复到 base，再清相对 base 新增的路径（checkout 只更新 base 里已有的
      // 路径；新增文件既不在 base、又不是未跟踪，clean 清不掉），最后清未跟踪。
      // （未跟踪文件删除不可恢复，前端需二次确认。）
      const r1 = await git2(ws, ['checkout', base, '--', '.']);
      // checkout 的 pathspec 在「索引与 base 在 ws 下都无路径」时报错（无提交新仓库、
      // 索引已空）——那就是没东西可恢复，继续往下走（diff 为空、clean 清未跟踪），
      // 不是真失败。其他 checkout 错误仍按 409。
      if (!r1.ok && !r1.err.includes('did not match any file')) return json(res, 409, { error: r1.err || 'git 操作失败' });
      // 相对 base 新增 = 索引里有、base 里没有（--no-renames 防重命名漏报 A）。
      // diff 输出是仓库相对路径（git diff 默认不剥前缀），按 prefix 剥回工作区相对。
      const addedOut = await git(ws, ['diff', '--cached', '--name-only', '--diff-filter=A', '--no-renames', base, '--', '.']);
      if (addedOut == null) return json(res, 409, { error: 'git 操作失败' });
      const prefix = await gitPrefix(ws);
      const added = addedOut.split('\n').map((l) => l.trim()).filter(Boolean)
        .map((p) => (prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p))
        .filter((p) => p && insideWs(ws, p));
      if (added.length) {
        const r2 = await git2(ws, ['rm', '-f', '--', ...added]);
        if (!r2.ok) return json(res, 409, { error: r2.err || 'git 操作失败' });
      }
      return run(['clean', '-fd', '--', '.']);
    }
    if (level === 'file') {
      if (op === 'stage') return run(['add', '--', file]);
      if (op === 'unstage') return run(['reset', '-q', '--', file]);
      // revert-file：按四态分发，不能只看「在不在索引里」：
      //   在 base + 在索引 → checkout base -- file
      //   在 base + 不在索引（暂存删除）→ checkout base -- file 恢复
      //   不在 base + 在索引（新增已暂存）→ git rm -f（索引+工作区一起删）
      //   不在 base + 不在索引（未跟踪）→ clean -f
      // 「在不在 base」用 cat-file -e <base>:<仓库相对路径>（ls-files 看的是索引，不是 base）；
      // cat-file 的路径必须是仓库相对（gitPrefix + 工作区相对），checkout/rm/clean 的
      // pathspec 是相对 cwd 的，用工作区相对路径即可。
      const repoPath = (await gitPrefix(ws)) + file;
      const inBase = (await git(ws, ['cat-file', '-e', base + ':' + repoPath])) != null;
      if (inBase) return run(['checkout', base, '--', file]);
      const inIndex = (await git(ws, ['ls-files', '--error-unmatch', '--', file])) != null;
      if (inIndex) return run(['rm', '-f', '--', file]);
      return run(['clean', '-f', '--', file]);
    }
    // level=hunk：patch 校验 + --check + apply。
    const patch = String(body.patch || '');
    if (!patch.trim()) return json(res, 400, { error: '缺少 hunk 内容' });
    if (!patch.trimStart().startsWith('diff --git ')) return json(res, 400, { error: 'hunk 内容必须带 diff --git 文件头' });
    const blocks = patch.split(/^diff --git /m).filter(Boolean);
    if (blocks.length !== 1) return json(res, 400, { error: 'hunk 内容必须恰好是一个文件的 diff' });
    const mPlus = /^\+{3} (?:b\/)?(.+)$/m.exec(patch);
    const mMinus = /^--- (?:a\/)?(.+)$/m.exec(patch);
    const target = mPlus && mPlus[1] !== '/dev/null' ? mPlus[1].trim() : (mMinus ? mMinus[1].trim() : '');
    if (target !== file) return json(res, 400, { error: 'hunk 内容与文件不匹配' });
    if (!/^@@ /m.test(patch)) return json(res, 400, { error: 'hunk 内容缺少 @@ 头' });
    const applyArgs = op === 'stage' ? ['apply', '--cached', '-']
      : op === 'unstage' ? ['apply', '--cached', '--reverse', '-']
      : ['apply', '--reverse', '-'];
    const chk = await git2(ws, [...applyArgs.slice(0, -1), '--check', '-'], { input: patch });
    if (!chk.ok) return json(res, 409, { error: chk.err || 'hunk 已过期或冲突，无法应用' });
    return run(applyArgs, patch);
  });

  // ── 终端：SSE 流（自动开壳 + 快照重放 + 实时增量）───────────────────────────
  router.on('GET', '/api/claude/term/stream', async (req, res, url) => {
    const g = dockCtx(req, res, url.searchParams.get('ws'), { shell: true });
    if (!g) return;
    const { ws } = g;
    let term;
    try {
      const svc = await import('../runtime/claude-term.mjs');
      const t = svc.ensureTerm(ws, url.searchParams.get('cols'), url.searchParams.get('rows'));
      term = { svc, t };
    } catch (e) { return fail(res, e); }
    writeSseHeaders(res);
    sseWrite(res, { type: 'hello', cols: term.t.cols, rows: term.t.rows, exited: term.t.exited });
    const snap = term.svc.snapshotTerm(term.t);
    if (snap) sseWrite(res, { type: 'snapshot', d: snap });
    term.svc.subscribeTerm(term.t, res);
    const hb = startHeartbeat(res);
    req.on('close', () => clearInterval(hb));
  });

  router.on('POST', '/api/claude/term/input', async (req, res) => {
    let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    const g = dockCtx(req, res, body.ws, { shell: true });
    if (!g) return;
    const svc = await import('../runtime/claude-term.mjs');
    json(res, 200, { ok: svc.writeTerm(g.ws, String(body.d ?? '')) });
  });

  router.on('POST', '/api/claude/term/resize', async (req, res) => {
    let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    const g = dockCtx(req, res, body.ws, { shell: true });
    if (!g) return;
    const svc = await import('../runtime/claude-term.mjs');
    json(res, 200, { ok: svc.resizeTerm(g.ws, body.cols, body.rows) });
  });

  router.on('POST', '/api/claude/term/kill', async (req, res) => {
    let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    const g = dockCtx(req, res, body.ws, { shell: true });
    if (!g) return;
    const svc = await import('../runtime/claude-term.mjs');
    json(res, 200, { ok: svc.killTerm(g.ws) });
  });
}
