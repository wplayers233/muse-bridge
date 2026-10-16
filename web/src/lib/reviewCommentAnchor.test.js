// 行内评论的锚点校验（reviewCommentAnchor.js）：该行已变化 / 孤儿评论。
import test from 'node:test';
import assert from 'node:assert/strict';
import { isReviewCommentStale, orphanReviewComments } from './reviewCommentAnchor.js';
import { parseDiff } from './reviewDiff.js';

test('stale：同行文本一致不判，变了判，无 lineText 不判', () => {
  assert.equal(isReviewCommentStale({ lineText: '+x' }, '+x'), false);
  assert.equal(isReviewCommentStale({ lineText: '+x' }, '+y'), true);
  assert.equal(isReviewCommentStale({ lineText: '' }, '+y'), false);
  assert.equal(isReviewCommentStale(null, '+y'), false);
  assert.equal(isReviewCommentStale({ lineText: '+x' }, undefined), true, '行没了也算 stale');
});

test('孤儿：锚点行号还在 diff 里 → 不是孤儿；不在了 → 是孤儿', () => {
  const parsed = parseDiff('diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1,2 +1,2 @@\n-old1\n+new1\n ctx\n');
  const comments = [
    { file: 'f.txt', side: 'new', no: 1, text: '对 new1' },
    { file: 'f.txt', side: 'old', no: 1, text: '对 old1' },
    { file: 'f.txt', side: 'new', no: 99, text: '行号已没' },
    { file: 'other.txt', side: 'new', no: 1, text: '别的文件' },
  ];
  const orphans = orphanReviewComments(comments, 'f.txt', parsed);
  assert.deepEqual(orphans.map((c) => c.text), ['行号已没']);
});

test('孤儿：meta 行（\\ No newline）不占行号，不算锚点', () => {
  const parsed = parseDiff('diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n');
  const comments = [{ file: 'f.txt', side: 'new', no: 1, text: '对 new' }];
  assert.deepEqual(orphanReviewComments(comments, 'f.txt', parsed), []);
});
