// 审阅面板的 diff 解析（纯函数，无 Svelte 依赖，可单测；P0/P1 共用）。
//
// parseDiff：单个文件的 unified diff → 文件头 + hunks，每行带新/旧文件行号
//   （行内评论的锚点：+ 行锚新文件行号，− 行锚旧文件行号，上下文行锚新文件行号）。
// parseLastTurnDiff：turn/diff/updated 的整轮聚合 diff（多文件）→ 按 diff --git 切文件，
//   每文件带 add/del 计数、st（M/A/D）、chunk（该文件的完整 diff 文本）。
//   没有 diff --git 头（上游只给了裸 patch）时退回整段当一个文件。

export function parseDiff(text) {
  const lines = String(text || '').split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  const header = [];
  const hunks = [];
  let cur = null;
  let newNo = 0, oldNo = 0;
  for (const l of lines) {
    if (l.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      oldNo = m ? +m[1] : 0;
      newNo = m ? +m[3] : 0;
      cur = { header: l, lines: [] };
      hunks.push(cur);
      continue;
    }
    if (!cur) { header.push(l); continue; }
    if (l.startsWith('+')) cur.lines.push({ cls: 'add', text: l, newNo: newNo++, oldNo: null });
    else if (l.startsWith('-')) cur.lines.push({ cls: 'del', text: l, oldNo: oldNo++, newNo: null });
    else if (l.startsWith('\\')) cur.lines.push({ cls: 'meta', text: l, newNo: null, oldNo: null });
    else cur.lines.push({ cls: 'ctx', text: l, newNo: newNo++, oldNo: oldNo++ });
  }
  return { header, hunks };
}

export function parseLastTurnDiff(diff, fallbackName) {
  const text = String(diff || '');
  if (!text.trim()) return [];
  const lines = text.split('\n');
  const starts = [];
  lines.forEach((l, i) => { if (l.startsWith('diff --git ')) starts.push(i); });
  const chunks = [];
  if (!starts.length) chunks.push({ path: fallbackName, chunk: text });
  else {
    for (let k = 0; k < starts.length; k++) {
      const chunk = lines.slice(starts[k], k + 1 < starts.length ? starts[k + 1] : lines.length).join('\n');
      const plus = /^\+{3} (?:b\/)?(.+)$/m.exec(chunk);
      const minus = /^--- (?:a\/)?(.+)$/m.exec(chunk);
      // 二进制没有 ---/+++ 头，回退到 diff --git a/X b/Y 的 b/ 路径。
      const gitHead = /^diff --git a\/(.*?) b\/(.*?)$/m.exec(chunk);
      const p = plus && plus[1] !== '/dev/null' ? plus[1].trim()
        : minus && minus[1] !== '/dev/null' ? minus[1].trim()
        : gitHead ? gitHead[2].trim()
        : fallbackName;
      chunks.push({ path: p, chunk });
    }
  }
  return chunks.map(({ path: p, chunk }) => {
    let add = 0, del = 0, bin = false, st = 'M';
    for (const l of chunk.split('\n')) {
      if (l.startsWith('Binary files ')) bin = true;
      else if (l.startsWith('+') && !l.startsWith('+++')) add++;
      else if (l.startsWith('-') && !l.startsWith('---')) del++;
    }
    if (/^--- \/dev\/null$/m.test(chunk)) st = 'A';
    else if (/^\+\+\+ \/dev\/null$/m.test(chunk)) st = 'D';
    return { path: p, from: null, add, del, bin, st, chunk };
  });
}
