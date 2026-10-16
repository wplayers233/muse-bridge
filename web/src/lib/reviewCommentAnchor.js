// 行内评论的锚点校验（纯函数，无 Svelte 依赖，可单测；审阅面板用）。
//
// 评论锚在（文件 + 行号 + 写评论时那行的文本）上；diff 一变，锚点可能漂移：
//   · 同行号的行文本对不上 → 该行已变化（stale），面板显示提示、允许单条删除；
//   · 行号在当前 diff 里已不存在 → 孤儿评论，单独列在文件末尾，同样可单条删除。
// lineText 为空的老评论不判 stale（没有锚点可比）。

export function isReviewCommentStale(comment, currentLineText) {
  return !!(comment && comment.lineText) && comment.lineText !== String(currentLineText ?? '');
}

export function orphanReviewComments(comments, file, parsed) {
  const seen = new Set();
  for (const h of parsed?.hunks || []) for (const ln of h.lines || []) {
    if (!ln.newNo && !ln.oldNo) continue;
    seen.add((ln.cls === 'del' ? 'old' : 'new') + ':' + (ln.cls === 'del' ? ln.oldNo : ln.newNo));
  }
  return (comments || []).filter((c) => c.file === file && !seen.has(c.side + ':' + c.no));
}
