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
    // 二进制：整块搜（Binary 行只在文件头区，没有 @@ hunk）。
    if (/^Binary files /m.test(chunk)) bin = true;
    // 增删计数按 hunk 头消费（@@ -a,b +c,d @@ 里 b 个旧行、d 个新行），不能用
    // startsWith('+++')/('---') 排除——内容本身以 ++ 开头的新增行渲染成 +++foo、
    // 以 -- 开头的删除行渲染成 ---bar，旧写法会把它们当成文件头漏计。
    // 区分文件头与内容行靠位置：---/+++ 文件头在第一个 @@ 之前，不计；@@ 之后的
    // +++foo / ---bar 是内容行，照常计。b/d 省略时默认 1；\ No newline 行不占行数。
    const lines = chunk.split('\n');
    let i = 0;
    while (i < lines.length && !lines[i].startsWith('@@')) i++;
    while (i < lines.length) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i]);
      if (!m) { i++; continue; }
      let oldLeft = m[2] === undefined ? 1 : +m[2];
      let newLeft = m[4] === undefined ? 1 : +m[4];
      i++;
      while (i < lines.length && (oldLeft > 0 || newLeft > 0)) {
        const l = lines[i];
        if (l.startsWith('\\')) { i++; continue; } // \ No newline，不占行
        if (l.startsWith('@@')) break; // 下一个 hunk（防御：行数对不上时）
        if (l.startsWith('+') && newLeft > 0) { add++; newLeft--; i++; }
        else if (l.startsWith('-') && oldLeft > 0) { del++; oldLeft--; i++; }
        // 上下文行：' ' 开头；裸空行是内容为空的上下文行（git 有时会省略尾空格），也当上下文。
        else if ((l.startsWith(' ') || l === '') && oldLeft > 0 && newLeft > 0) { oldLeft--; newLeft--; i++; }
        else i++; // 行数对不上（截断/畸形 diff）时跳过，不死循环
      }
    }
    if (/^--- \/dev\/null$/m.test(chunk)) st = 'A';
    else if (/^\+\+\+ \/dev\/null$/m.test(chunk)) st = 'D';
    return { path: p, from: null, add, del, bin, st, chunk };
  });
}
