// 审阅面板 diff 解析（web/src/lib/reviewDiff.js）：单文件 hunk 行号、多文件切分。
// 审阅面板跑在浏览器里、这台机器没有浏览器可验，解析抽成纯函数钉住。
import test from 'node:test';
import assert from 'node:assert/strict';
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

const MULTI = `diff --git a/src/a.js b/src/a.js
index 1111111..2222222 100644
--- a/src/a.js
+++ b/src/a.js
@@ -1,2 +1,2 @@
-old
+new
 keep
diff --git a/src/new.txt b/src/new.txt
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/new.txt
@@ -0,0 +1,2 @@
+line1
+line2
diff --git a/src/gone.js b/src/gone.js
deleted file mode 100644
index 4444444..0000000
--- a/src/gone.js
+++ /dev/null
@@ -1,2 +0,0 @@
-gone1
-gone2
diff --git a/img.png b/img.png
index 5555555..6666666 100644
Binary files a/img.png and b/img.png differ
`;

test('parseLastTurnDiff：多文件切分 + 计数 + 新增/删除/二进制识别', () => {
  const files = parseLastTurnDiff(MULTI);
  assert.deepEqual(files.map((f) => f.path), ['src/a.js', 'src/new.txt', 'src/gone.js', 'img.png']);
  assert.deepEqual([files[0].add, files[0].del, files[0].st], [1, 1, 'M']);
  assert.deepEqual([files[1].add, files[1].del, files[1].st], [2, 0, 'A']);
  assert.deepEqual([files[2].add, files[2].del, files[2].st], [0, 2, 'D']);
  assert.equal(files[3].bin, true);
  assert.match(files[0].chunk, /^diff --git a\/src\/a\.js/m, '每块带自己的文件头（hunk 操作拼 patch 用）');
  assert.doesNotMatch(files[0].chunk, /src\/new\.txt/, '块与块不串');
});

test('parseLastTurnDiff：无 diff --git 头 → 整段当一个文件；空 diff → 空', () => {
  const one = parseLastTurnDiff('@@ -1 +1 @@\n-a\n+b\n', 'fallback');
  assert.equal(one.length, 1);
  assert.equal(one[0].path, 'fallback');
  assert.deepEqual(parseLastTurnDiff(''), []);
  assert.deepEqual(parseLastTurnDiff('   \n'), []);
});

test('parseLastTurnDiff：改名 diff 取新路径', () => {
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
