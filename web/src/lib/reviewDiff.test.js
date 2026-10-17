// 审阅面板 diff 解析（web/src/lib/reviewDiff.js）：单文件 hunk 行号、多文件切分。
// 审阅面板跑在浏览器里、这台机器没有浏览器可验，解析抽成纯函数钉住。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseDiff, parseLastTurnDiff } from './reviewDiff.js';

const ONE_FILE = `diff --git a/src/a.js b/src/a.js
index 1111111..2222222 100644
--- a/src/a.js
+++ b/src/a.js
@@ -1,4 +1,5 @@
 ctx1
-old1
+new1
+new2
 ctx2
 ctx3
`;

test('parseDiff：hunk 行带新/旧行号（行内评论锚点）', () => {
  const p = parseDiff(ONE_FILE);
  assert.equal(p.header.length, 4, 'diff --git/index/---/+++ 进文件头');
  assert.equal(p.hunks.length, 1);
  const lines = p.hunks[0].lines;
  // ctx1 = 新1/旧1；-old1 = 旧2；+new1/+new2 = 新2/新3；ctx2 = 新4/旧3；ctx3 = 新5/旧4
  assert.deepEqual(lines.map((l) => [l.cls, l.newNo, l.oldNo]), [
    ['ctx', 1, 1], ['del', null, 2], ['add', 2, null], ['add', 3, null], ['ctx', 4, 3], ['ctx', 5, 4],
  ]);
});

test('parseDiff：\\ No newline 行不占行号，空 diff 不炸', () => {
  const p = parseDiff('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n');
  assert.deepEqual(p.hunks[0].lines.map((l) => [l.cls, l.newNo, l.oldNo]), [
    ['del', null, 1], ['meta', null, null], ['add', 1, null], ['meta', null, null],
  ]);
  assert.deepEqual(parseDiff(''), { header: [], hunks: [] });
});

// 真实载荷夹具：codex 0.162.1 app-server 的 turn/diff/updated 原始 diff（探针抓的，
// 临时仓 + 临时线程，已脱敏：只有通用文件名，无真实项目路径/用户名）。
// 覆盖：修改（M）/ 新增（A，new file mode）/ 删除（D，deleted file mode）/
// 带空格文件名（不引号，原样 a/my note.txt）/ 非 ASCII 文件名（不引号，原样 UTF-8）。
const REAL = readFileSync(new URL('./fixtures/turn-diff-real.txt', import.meta.url), 'utf8');

test('parseLastTurnDiff：真实上游载荷 → 多文件切分 + 计数 + 新增/删除识别', () => {
  const files = parseLastTurnDiff(REAL);
  assert.deepEqual(files.map((f) => f.path), ['a.js', 'b.js', 'd.txt', 'my note.txt', '中文文件.txt']);
  assert.deepEqual([files[0].add, files[0].del, files[0].st], [1, 1, 'M']);
  assert.deepEqual([files[1].add, files[1].del, files[1].st], [1, 0, 'A']);
  assert.deepEqual([files[2].add, files[2].del, files[2].st], [0, 1, 'D']);
  assert.deepEqual([files[3].add, files[3].del, files[3].st], [1, 0, 'A']);
  assert.deepEqual([files[4].add, files[4].del, files[4].st], [1, 0, 'A']);
  assert.match(files[0].chunk, /^diff --git a\/a\.js/m, '每块带自己的文件头（hunk 操作拼 patch 用）');
  assert.doesNotMatch(files[0].chunk, /b\.js/, '块与块不串');
});

// 二进制分支是防御性的：真实 turn-diff 里出不了二进制条目——二进制改动走不了
// apply_patch（只能改文本），而 shell 改动（包括二进制）对上游的 turn-diff 跟踪不可见。
// 所以二进制用一个小的人造用例钉住分支，不冒充真实载荷。
test('parseLastTurnDiff：二进制 diff 识别（防御分支，人造用例）', () => {
  const files = parseLastTurnDiff(`diff --git a/img.png b/img.png\nindex 5555555..6666666 100644\nBinary files a/img.png and b/img.png differ\n`);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, 'img.png');
  assert.equal(files[0].bin, true);
});

test('parseLastTurnDiff：无 diff --git 头 → 整段当一个文件；空 diff → 空', () => {
  const one = parseLastTurnDiff('@@ -1 +1 @@\n-a\n+b\n', 'fallback');
  assert.equal(one.length, 1);
  assert.equal(one[0].path, 'fallback');
  assert.deepEqual(parseLastTurnDiff(''), []);
  assert.deepEqual(parseLastTurnDiff('   \n'), []);
});

test('parseLastTurnDiff：改名 diff 取新路径（防御分支，人造用例）', () => {
  // 真实 turn-diff 里出不了改名条目：改名（git mv）走 shell，对上游的 turn-diff
  // 跟踪不可见（探针里 rename 就没进 diff）。改名分支用小的人造用例钉住。
  const files = parseLastTurnDiff(`diff --git a/old.js b/new.js
similarity index 90%
rename from old.js
rename to new.js
--- a/old.js
+++ b/new.js
@@ -1 +1 @@
-x
+y
`);
  assert.equal(files[0].path, 'new.js');
});

// P4 收口：增删计数按 hunk 头消费，不能用 startsWith('+++')/('---') 排除——
// 内容本身以 ++ 开头的新增行渲染成 +++foo、以 -- 开头的删除行渲染成 ---bar，
// 旧写法会把它们当成文件头漏计。
test('parseLastTurnDiff：内容以 ++/-- 开头的行照常计数（不是文件头）', () => {
  const files = parseLastTurnDiff(`diff --git a/x.js b/x.js
--- a/x.js
+++ b/x.js
@@ -1,2 +1,3 @@
 const a = 1;
+++foo
 const b = 2;
diff --git a/y.js b/y.js
--- a/y.js
+++ b/y.js
@@ -1,3 +1,2 @@
 const a = 1;
---bar
 const b = 2;
`);
  assert.equal(files.length, 2);
  assert.deepEqual([files[0].add, files[0].del], [1, 0], '+++foo 是新增内容行，计 1 增');
  assert.deepEqual([files[1].add, files[1].del], [0, 1], '---bar 是删除内容行，计 1 删');
});

test('parseLastTurnDiff：\\ No newline 行不占行数（不干扰 hunk 头计数）', () => {
  const files = parseLastTurnDiff(`diff --git a/x.js b/x.js
--- a/x.js
+++ b/x.js
@@ -1 +1 @@
-a
\\ No newline at end of file
+b
\\ No newline at end of file
`);
  assert.deepEqual([files[0].add, files[0].del], [1, 1]);
});
