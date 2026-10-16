<script>
  // 审阅面板：工作空间变更清单 + 单文件 diff 展开（+绿 −红），三家共用（Claude / Codex / ZCode）。
  //
  // 范围（官方 PC 端五种；Last turn 不走后端，P1 从聊天快照的 m.diff 喂）：
  //   未暂存 unstaged（工作区 vs 暂存区 + 未跟踪）/ 已暂存 staged（暂存区 vs HEAD）/
  //   提交 commit（某提交 vs 其父）/ 分支 branch（工作区 vs 基线）/ 上一轮 lastturn
  //
  // Git 操作（三级 stage / unstage / revert，走 POST /api/claude/review/git）：
  //   整 diff / 单文件 / 单 hunk。hunk 用 git apply --cached/--reverse 落盘，
  //   先 --check 再 apply，过期 hunk 会 409。还原是破坏性操作，按钮要点两次确认。
  //   提交范围只读（历史 diff，没有可 stage 的东西）；分支范围的还原回到基线。
  //
  // 行内评论：悬停某行点 + 写反馈，存进 reviewComments（按 ws 分桶）；下一条聊天消息
  // 发送时由 cliSend 取走、拼成指令块注入给模型。评论只活在内存里，刷新页面丢掉
  // （diff 一变行号就可能对不上，持久化反而会带过期锚点）。
  import { api } from '../../lib/api.js';
  import { dock } from '../../lib/dock.svelte.js';
  import { t, tc, tr } from '../../lib/i18n.js';
  import { showToast } from '../../lib/toast.svelte.js';
  import { cliChat } from '../../lib/cliChat.svelte.js';
  import { parseDiff, parseLastTurnDiff } from '../../lib/reviewDiff.js';
  import { reviewComments, addReviewComment, dropReviewComment, dropAllReviewComments, reviewCommentCount } from '../../lib/reviewComments.svelte.js';
  import { isReviewCommentStale, orphanReviewComments } from '../../lib/reviewCommentAnchor.js';
  let { dockState = dock, agent = '' } = $props();

  let loading = $state(true);
  let err = $state('');
  let data = $state(null);          // { git, branch, base, scope, sha, subject, files:[{path,from,add,del,bin,st}], total, truncated }
  let open = $state({});            // path -> { loading, text, bin, truncated, err, parsed }
  let scope = $state('branch');
  let sha = $state('');
  let baseBranch = $state('');
  let commits = $state(null);
  let branches = $state(null);
  let confirmKey = $state('');
  let busyKey = $state('');
  let commenting = $state(null);    // { file, side, no, lineText }
  let commentDraft = $state('');

  const enc = encodeURIComponent;
  const ws = $derived(dockState.ws || '');
  const pendingCount = $derived(reviewCommentCount(ws));

  // ── unified diff 解析与上一轮 diff 切文件：见 lib/reviewDiff.js（纯函数，可单测）──

  function scopeQuery() {
    if (scope === 'commit') return `&scope=commit&sha=${enc(sha)}`;
    if (scope === 'branch' && baseBranch) return `&scope=branch&base=${enc(baseBranch)}`;
    return `&scope=${scope}`;
  }

  // ── 上一轮（P1）：当前对话里最后一条带 diff 的 agent 消息（turn/diff/updated 的整轮聚合 diff）──
  // 最后一条带 diff 的 agent 消息（新一轮的空条目不算——上一轮仍是上一条有 diff 的）。
  const lastTurnItem = $derived(agent && cliChat[agent]?.items
    ? [...cliChat[agent].items].reverse().find((m) => m.role === 'agent' && String(m.diff || '').trim())
    : null);
  const lastTurnFiles = $derived(lastTurnItem ? parseLastTurnDiff(lastTurnItem.diff, t('上一轮改动')) : []);
  const lastTurnTotal = $derived(lastTurnFiles.reduce((a, f) => ({ add: a.add + (f.add || 0), del: a.del + (f.del || 0) }), { add: 0, del: 0 }));
  // 上一轮 diff 截断（快照层 4000 / 上游层 20000 任一截过）：顶部警告横幅用它，
  // 不用 view.truncated（git 范围的 truncated 是“文件清单超 800 截断”，另一回事）。
  const lastTurnTruncated = $derived(scope === 'lastturn' && !!lastTurnItem?.diffTruncated);
  // 渲染统一走 view：git 范围用后端 data，上一轮用本地算的（不走后端；截断标记来自快照）。
  const view = $derived(scope === 'lastturn'
    ? { git: true, scope: 'lastturn', branch: '', base: t('上一轮'), files: lastTurnFiles, total: lastTurnTotal, truncated: !!lastTurnItem?.diffTruncated }
    : data);

  async function refresh() {
    loading = true; err = '';
    try {
      // 上一轮不走后端：view 直接从当前对话的 m.diff 派生（cliChat 是 $state，diff 到来自动刷新）。
      if (scope === 'lastturn') { open = {}; }
      else {
        data = await api.get(`/api/claude/review?ws=${enc(ws)}${scopeQuery()}`);
        open = {};
      }
    } catch (e) { err = tr(e?.body?.error || e?.body) || t('加载失败'); data = null; }
    loading = false;
  }
  $effect(() => { if (ws) refresh(); });

  async function loadCommits() {
    if (commits) return;
    try { const d = await api.get(`/api/claude/review/commits?ws=${enc(ws)}`); commits = d.commits || []; }
    catch { commits = []; }
  }
  async function loadBranches() {
    if (branches) return;
    try { const d = await api.get(`/api/claude/review/branches?ws=${enc(ws)}`); branches = d.branches || []; }
    catch { branches = []; }
  }
  function setScope(s) {
    scope = s; confirmKey = ''; commenting = null;
    if (s === 'commit') loadCommits();
    if (s === 'branch') loadBranches();
    refresh();
  }
  function pickCommit(v) { sha = v; refresh(); }
  function pickBase(v) { baseBranch = v; refresh(); }

  async function toggle(f) {
    if (open[f.path]) { const { [f.path]: _, ...rest } = open; open = rest; return; }
    // 上一轮：chunk 已在本地，直接解析，不调后端。
    if (scope === 'lastturn') {
      open = { ...open, [f.path]: { loading: false, text: f.chunk || '', bin: !!f.bin, truncated: false, parsed: parseDiff(f.chunk || '') } };
      return;
    }
    open = { ...open, [f.path]: { loading: true } };
    try {
      // 注意别用 st= 传状态——st/ct 是身份系统保留参数（share/snap token），会被识别成假身份 401。
      const q = `ws=${enc(ws)}&file=${enc(f.path)}${f.st === 'U' ? '&u=1' : ''}${f.from ? `&from=${enc(f.from)}` : ''}${scopeQuery()}`;
      const d = await api.get(`/api/claude/review/diff?${q}`);
      open = { ...open, [f.path]: { loading: false, text: d.text || '', bin: !!d.bin, truncated: !!d.truncated, parsed: parseDiff(d.text || '') } };
    } catch (e) {
      open = { ...open, [f.path]: { loading: false, err: tr(e?.body?.error) || t('加载失败') } };
    }
  }

  // ── Git 操作：op=stage|unstage|revert，level=all|file|hunk ──
  // 还原要点两次确认（第一次只武装按钮，第二次才执行）；hunk 的 patch = 文件头 + 该 hunk。
  // 分支范围的 revert 回到基线：传概览接口返回的 baseRef（merge-base SHA），不是基线分支的
  // 尖端、也不是 HEAD——尖端可能含基线之后的新提交，还原到它会带进不该有的改动。
  async function gitOp(op, level, file = '', patch = '') {
    const key = `${op}:${level}:${file}:${patch ? 'h' : ''}`;
    if (op === 'revert' && confirmKey !== key) { confirmKey = key; setTimeout(() => { if (confirmKey === key) confirmKey = ''; }, 4000); return; }
    confirmKey = '';
    if (busyKey) return;
    busyKey = key;
    try {
      await api.post('/api/claude/review/git', {
        ws, op, level, file, patch,
        // 只有 branch 范围且概览是同范围的才带 baseRef（切范围后 data 可能还是旧范围的，防串）。
        ...(scope === 'branch' && data?.scope === 'branch' && data.baseRef ? { base: data.baseRef } : {}),
      });
      showToast(op === 'revert' ? t('已还原') : t('已执行'));
      await refresh();
    } catch (e) {
      showToast(tr(e?.body?.error) || t('操作失败'), 'err');
    }
    busyKey = '';
  }
  function hunkPatch(parsed, hunk) {
    return [...parsed.header, hunk.header, ...hunk.lines.map((l) => l.text)].join('\n') + '\n';
  }
  // 各范围下哪些操作有意义（提交是历史，只读；分支的还原回到基线）：
  const canStage = $derived(scope === 'unstaged');
  const canUnstage = $derived(scope === 'staged');
  const canRevert = $derived(scope === 'unstaged' || scope === 'staged' || scope === 'branch');
  // 快照访客只读：后端 403，前端直接藏掉 Git 操作按钮（行内评论不算 Git 操作，照常写）。
  const snapReadOnly = $derived(!!view?.readOnly);
  // 提交范围：按钮不藏、改成禁用（让用户看到“这里有操作，但历史 diff 动不了”）。

  // ── 行内评论 ──
  function startComment(file, line) {
    // + 行锚到新文件行号，− 行锚到旧文件行号，上下文行锚到新文件行号。
    const side = line.cls === 'del' ? 'old' : 'new';
    const no = side === 'old' ? line.oldNo : line.newNo;
    if (!no) return;
    commenting = { file, side, no, lineText: line.text };
    commentDraft = '';
  }
  function submitComment() {
    if (!commenting || !commentDraft.trim()) return;
    addReviewComment(ws, { ...commenting, text: commentDraft });
    commenting = null; commentDraft = '';
    showToast(t('评论已记下，随下一条消息发给模型'));
  }
  const commentsFor = (file, side, no) => (reviewComments.byWs[ws] || []).filter((c) => c.file === file && c.side === side && c.no === no);
  // 孤儿评论：锚点的行号在当前 diff 里已不存在（行被删 / diff 已换一批）——
  // 不渲染就永远找不到它、只能「清空」全部删；单独列在文件末尾，带“该行已变化”与单条删除。
  // 判定见 lib/reviewCommentAnchor.js（纯函数，可单测）。

  const stLabel = { A: tc('diff', '新增'), D: tc('diff', '删除'), R: tc('diff', '改名'), U: tc('diff', '未跟踪'), C: tc('diff', '复制') };
  const SCOPE_LABEL = { unstaged: t('未暂存'), staged: t('已暂存'), commit: t('提交'), branch: t('分支'), lastturn: t('上一轮') };
</script>

<div class="rv">
  <div class="rv-scopes">
    {#each ['unstaged', 'staged', 'commit', 'branch', 'lastturn'] as s}
      <button class="rv-scope" class:on={scope === s} onclick={() => setScope(s)}>{SCOPE_LABEL[s]}</button>
    {/each}
  </div>
  {#if scope === 'commit'}
    <div class="rv-pick">
      <select value={sha} onchange={(e) => pickCommit(e.target.value)}>
        <option value="">{t('选择一个提交…')}</option>
        {#each (commits || []) as c}
          <option value={c.sha}>{c.short} {c.subject}</option>
        {/each}
      </select>
    </div>
  {/if}
  {#if scope === 'branch'}
    <div class="rv-pick">
      <select value={baseBranch} onchange={(e) => pickBase(e.target.value)}>
        <option value="">{t('自动基线（main / master）')}</option>
        {#each (branches || []) as b}
          <option value={b.name}>{b.name}{b.current ? t('（当前）') : ''}</option>
        {/each}
      </select>
    </div>
  {/if}
  {#if pendingCount}
    <div class="rv-pending">
      <span>{t('行内评论 {n} 条，将随下一条消息发给模型', { n: pendingCount })}</span>
      <button onclick={() => dropAllReviewComments(ws)}>{t('清空')}</button>
    </div>
  {/if}
  {#if loading}
    <div class="rv-empty"><span class="spin"></span>{t('正在读取变更…')}</div>
  {:else if err}
    <div class="rv-empty">{err}<button class="rv-retry" onclick={refresh}>{t('重试')}</button></div>
  {:else if !view || !view.git}
    <div class="rv-empty">{t('该工作空间不是 git 仓库')}</div>
  {:else}
    <div class="rv-head">
      <span class="rv-branch"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2.6"/><circle cx="6" cy="18" r="2.6"/><circle cx="18" cy="8" r="2.6"/><path d="M6 8.6v6.8M18 10.6c0 4-5 3.4-8 5"/></svg>{view.base}</span>
      {#if scope !== 'lastturn'}
        <span class="rv-arrow">→</span>
        <span class="rv-wt">working tree</span>
      {/if}
      <button class="rv-refresh" aria-label={t('刷新')} onclick={refresh}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v5h-5"/></svg></button>
    </div>
    {#if lastTurnTruncated}
      <div class="rv-warn">{t('本轮 diff 已截断，仅供预览，完整改动请看对应 Git 范围')}</div>
    {/if}
    {#if scope === 'commit' && !sha}
      <div class="rv-empty">{t('请先选择一个提交')}</div>
    {:else if !view.files.length}
      <div class="rv-empty">{scope === 'lastturn' ? t('上一轮没有产生改动') : t('工作树很干净，没有改动')}</div>
    {:else}
      <div class="rv-hint">{t('大文件默认折叠，点击文件展开 diff。共 {n} 个文件', { n: view.files.length })} <em class="add">+{view.total.add}</em> <em class="del">−{view.total.del}</em>{#if view.truncated && scope !== 'lastturn'}{t('（已截断）')}{/if}</div>
      {#if view.files.length}
        <div class="rv-actions">
          {#if !snapReadOnly}
            {#if scope === 'commit'}
              <button class="rv-act" disabled>{t('全部暂存')}</button>
              <button class="rv-act" disabled>{t('全部取消暂存')}</button>
              <button class="rv-act danger" disabled>{t('全部还原')}</button>
            {:else if scope !== 'lastturn'}
              {#if canStage}<button class="rv-act" onclick={() => gitOp('stage', 'all')}>{t('全部暂存')}</button>{/if}
              {#if canUnstage}<button class="rv-act" onclick={() => gitOp('unstage', 'all')}>{t('全部取消暂存')}</button>{/if}
              {#if canRevert}<button class="rv-act danger" onclick={() => gitOp('revert', 'all')}>{confirmKey === 'revert:all::' ? t('确认还原全部（未跟踪文件会被删除）') : t('全部还原')}</button>{/if}
            {/if}
          {/if}
          {#if scope === 'commit'}<span class="rv-ro">{t('提交是只读的')}</span>{/if}
          {#if scope === 'lastturn'}<span class="rv-ro">{t('上一轮 diff 是快照，暂存 / 还原请切到未暂存范围')}</span>{/if}
        </div>
      {/if}
      <div class="rv-list">
        {#each view.files as f (f.path)}
          <div class="rv-file">
            <button class="rv-row" onclick={() => toggle(f)}>
              <svg class="chev" class:open={!!open[f.path]} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
              <span class="rv-name" title={f.from ? `${f.from} → ${f.path}` : f.path}>{f.path}</span>
              {#if f.st && f.st !== 'M'}<span class="rv-st st-{f.st}">{stLabel[f.st] || f.st}</span>{/if}
              {#if f.bin}<span class="rv-bin">{t('二进制')}</span>{:else}<span class="rv-count add">+{f.add}</span><span class="rv-count del">−{f.del}</span>{/if}
            </button>
            {#if open[f.path]}
              <div class="rv-diff">
                {#if open[f.path].loading}
                  <div class="rv-dload"><span class="spin"></span></div>
                {:else if open[f.path].err}
                  <div class="rv-dload">{open[f.path].err}</div>
                {:else if open[f.path].bin}
                  <div class="rv-dload">{t('二进制文件，无法展示 diff')}</div>
                {:else if !open[f.path].text}
                  <div class="rv-dload">{t('（无差异内容）')}</div>
                {:else}
                  {#if !snapReadOnly && (scope === 'commit' || canStage || canUnstage || canRevert)}
                    <div class="rv-facts">
                      {#if scope === 'commit'}
                        <button class="rv-fact" disabled>{t('暂存文件')}</button>
                        <button class="rv-fact" disabled>{t('取消暂存')}</button>
                        <button class="rv-fact danger" disabled>{t('还原文件')}</button>
                      {:else}
                        {#if canStage}<button class="rv-fact" onclick={() => gitOp('stage', 'file', f.path)}>{t('暂存文件')}</button>{/if}
                        {#if canUnstage}<button class="rv-fact" onclick={() => gitOp('unstage', 'file', f.path)}>{t('取消暂存')}</button>{/if}
                        {#if canRevert}<button class="rv-fact danger" onclick={() => gitOp('revert', 'file', f.path)}>{confirmKey === `revert:file:${f.path}:` ? t('确认还原？') : t('还原文件')}</button>{/if}
                      {/if}
                    </div>
                  {/if}
                  <div class="rv-code">
                    {#each open[f.path].parsed.header as hl}
                      <div class="dl meta">{hl || ' '}</div>
                    {/each}
                    {#each open[f.path].parsed.hunks as hunk}
                      <div class="dl hunk">
                        <span>{hunk.header}</span>
                        {#if !snapReadOnly}
                          {#if scope === 'commit'}
                            <button class="rv-hact" disabled>{t('暂存此块')}</button>
                            <button class="rv-hact danger" disabled>{t('还原此块')}</button>
                          {:else if scope === 'unstaged'}
                            <button class="rv-hact" onclick={() => gitOp('stage', 'hunk', f.path, hunkPatch(open[f.path].parsed, hunk))}>{t('暂存此块')}</button>
                            <button class="rv-hact danger" onclick={() => gitOp('revert', 'hunk', f.path, hunkPatch(open[f.path].parsed, hunk))}>{confirmKey === `revert:hunk:${f.path}:h` ? t('确认还原？') : t('还原此块')}</button>
                          {:else if scope === 'staged'}
                            <button class="rv-hact" onclick={() => gitOp('unstage', 'hunk', f.path, hunkPatch(open[f.path].parsed, hunk))}>{t('取消暂存此块')}</button>
                          {/if}
                        {/if}
                      </div>
                      {#each hunk.lines as ln}
                        <div class="dl {ln.cls}">
                          <span class="dl-no">{ln.cls === 'del' ? (ln.oldNo ?? '') : (ln.newNo ?? '')}</span>
                          <span class="dl-txt">{ln.text || ' '}</span>
                          {#if ln.cls !== 'meta'}
                            <button class="dl-plus" title={t('对此行写评论')} onclick={() => startComment(f.path, ln)}>+</button>
                          {/if}
                        </div>
                        {#each commentsFor(f.path, ln.cls === 'del' ? 'old' : 'new', ln.cls === 'del' ? ln.oldNo : ln.newNo) as c}
                          <div class="dl-cmt">
                            {#if isReviewCommentStale(c, ln.text)}<span class="dl-cmt-stale">{t('该行已变化')}</span>{/if}
                            <span class="dl-cmt-t">{c.text}</span>
                            <button class="dl-cmt-x" aria-label={t('删除评论')} onclick={() => dropReviewComment(ws, c.id)}>×</button>
                          </div>
                        {/each}
                        {#if commenting && commenting.file === f.path && commenting.no === (ln.cls === 'del' ? ln.oldNo : ln.newNo) && commenting.side === (ln.cls === 'del' ? 'old' : 'new')}
                          <div class="dl-cmt-ed">
                            <textarea rows="2" bind:value={commentDraft} placeholder={t('写下对这一行的反馈…')}></textarea>
                            <div class="dl-cmt-btns">
                              <button onclick={submitComment}>{t('提交评论')}</button>
                              <button onclick={() => { commenting = null; commentDraft = ''; }}>{t('取消')}</button>
                            </div>
                          </div>
                        {/if}
                      {/each}
                    {/each}
                    {#each orphanReviewComments(reviewComments.byWs[ws] || [], f.path, open[f.path].parsed) as c}
                      <div class="dl-cmt">
                        <span class="dl-cmt-stale">{t('该行已变化')}</span>
                        <span class="dl-cmt-t">{c.text}</span>
                        <button class="dl-cmt-x" aria-label={t('删除评论')} onclick={() => dropReviewComment(ws, c.id)}>×</button>
                      </div>
                    {/each}
                    {#if open[f.path].truncated}<div class="dl meta">{t('…（diff 过长，已截断）')}</div>{/if}
                  </div>
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</div>

<style>
  .rv { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow-y: auto; padding: 4px 10px 16px; }
  .rv::-webkit-scrollbar { width: 6px; }
  .rv::-webkit-scrollbar-track { background: transparent; }
  .rv::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--muted) 38%, transparent); border-radius: 999px; }

  .rv-empty { flex: none; display: flex; align-items: center; justify-content: center; gap: 10px; color: var(--muted); font-size: 14px; padding: 48px 16px; text-align: center; }
  .rv-retry { color: var(--coral); padding: 4px 10px; border-radius: 8px; }
  .rv-retry:active { background: var(--hover); }

  .rv-scopes { display: flex; gap: 4px; padding: 8px 2px 4px; flex-wrap: wrap; }
  .rv-scope { font-size: 12.5px; padding: 4px 10px; border-radius: 8px; opacity: .6; }
  .rv-scope.on { opacity: 1; background: color-mix(in srgb, currentColor 10%, transparent); font-weight: 560; }
  .rv-scope:active { background: var(--hover); }
  .rv-pick { padding: 2px 2px 6px; }
  .rv-pick select { width: 100%; font-size: 13px; padding: 6px 8px; border: 1px solid var(--divider); border-radius: 8px; background: var(--bg); color: var(--text); }
  .rv-pending { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12.5px; color: var(--coral); padding: 4px 6px 8px; }
  .rv-pending button { color: var(--muted); text-decoration: underline; }

  .rv-head { display: flex; align-items: center; gap: 8px; padding: 10px 6px 4px; font-size: 14px; color: var(--text); }
  .rv-branch { display: flex; align-items: center; gap: 6px; font-weight: 560; }
  .rv-branch svg { width: 16px; height: 16px; color: var(--muted); }
  .rv-arrow { color: var(--muted); }
  .rv-wt { color: var(--serif); }
  .rv-refresh { margin-left: auto; width: 30px; height: 30px; border-radius: 8px; display: flex; align-items: center; justify-content: center; color: var(--muted); }
  .rv-refresh svg { width: 16px; height: 16px; }
  .rv-refresh:active { background: var(--hover); }
  @media (hover: hover) { .rv-refresh:hover { background: var(--hover); color: var(--text); } }

  .rv-hint { color: var(--muted); font-size: 12px; padding: 2px 6px 10px; }
  .rv-warn { margin: 2px 6px 8px; padding: 8px 10px; border-radius: 8px; background: color-mix(in srgb, var(--coral) 9%, transparent); color: var(--coral); font-size: 12.5px; }
  .rv-hint .add { color: var(--ok); font-style: normal; }
  .rv-hint .del { color: var(--crit); font-style: normal; }

  .rv-actions { display: flex; gap: 6px; padding: 0 6px 10px; flex-wrap: wrap; }
  .rv-act, .rv-fact { font-size: 12.5px; padding: 5px 10px; border-radius: 8px; background: color-mix(in srgb, currentColor 7%, transparent); }
  .rv-act:active, .rv-fact:active { background: var(--hover); }
  .rv-act.danger, .rv-fact.danger, .rv-hact.danger { color: var(--crit); }
  .rv-ro { font-size: 12px; color: var(--muted); padding: 5px 0; }

  .rv-list { display: flex; flex-direction: column; gap: 2px; }
  .rv-row { width: 100%; display: flex; align-items: center; gap: 7px; padding: 7px 8px; border-radius: 8px; font-size: 13.5px; color: var(--serif); text-align: left; transition: background-color .12s ease; }
  .rv-row:active { background: var(--hover); }
  @media (hover: hover) { .rv-row:hover { background: var(--hover); color: var(--text); } }
  .chev { width: 14px; height: 14px; flex: none; color: var(--muted); transition: transform .16s ease; }
  .chev.open { transform: rotate(90deg); }
  .rv-name { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; direction: rtl; text-align: left; }
  .rv-name::after { content: '\200e'; }
  .rv-st { flex: none; font-size: 11px; padding: 1px 6px; border-radius: 6px; background: var(--hover); color: var(--muted); }
  /* st-* / dl 的分类 class 是模板插值动态拼的，scoped 规则会被编译器当 unused 剪掉——:global 保住 */
  .rv-st:global(.st-A), .rv-st:global(.st-U) { color: var(--ok); }
  .rv-st:global(.st-D) { color: var(--crit); }
  .rv-bin { flex: none; font-size: 12px; color: var(--muted); }
  .rv-count { flex: none; font-size: 12.5px; font-variant-numeric: tabular-nums; }
  .rv-count.add { color: var(--ok); }
  .rv-count.del { color: var(--crit); }

  .rv-diff { margin: 2px 0 8px 20px; border: 1px solid var(--divider); border-radius: 10px; overflow: hidden; }
  .rv-dload { display: flex; align-items: center; justify-content: center; gap: 8px; color: var(--muted); font-size: 13px; padding: 16px; }
  .rv-facts { display: flex; gap: 6px; padding: 8px 10px 2px; flex-wrap: wrap; }
  .rv-code { overflow-x: auto; font-family: Consolas, 'Cascadia Mono', Menlo, monospace; font-size: 12px; line-height: 1.5; padding: 6px 0; }
  .dl { white-space: pre; padding: 0 10px; min-width: max-content; display: flex; align-items: center; gap: 6px; }
  .dl:global(.add) { background: color-mix(in srgb, var(--ok) 12%, transparent); color: var(--text); }
  .dl:global(.del) { background: color-mix(in srgb, var(--crit) 11%, transparent); color: var(--text); }
  .dl:global(.hunk) { color: #7aa2f7; background: color-mix(in srgb, #7aa2f7 7%, transparent); padding-top: 2px; padding-bottom: 2px; justify-content: space-between; }
  .dl:global(.meta) { color: var(--muted); }
  .dl:global(.ctx) { color: var(--serif); }
  .dl-no { flex: none; width: 32px; text-align: right; color: var(--muted); font-size: 11px; user-select: none; }
  .dl-txt { flex: 1; min-width: 0; }
  .dl-plus { flex: none; width: 18px; height: 18px; border-radius: 6px; opacity: 0; color: var(--coral); font-size: 14px; line-height: 1; }
  .dl:hover .dl-plus { opacity: 1; }
  .dl-plus:active { background: var(--hover); }
  .rv-hact { flex: none; font-size: 11.5px; padding: 2px 8px; border-radius: 6px; background: color-mix(in srgb, currentColor 8%, transparent); color: var(--text); }
  .rv-hact:active { background: var(--hover); }
  .dl-cmt { margin: 2px 10px 2px 48px; padding: 6px 10px; border-left: 2px solid var(--coral); background: color-mix(in srgb, var(--coral) 6%, transparent); border-radius: 0 8px 8px 0; display: flex; gap: 8px; align-items: flex-start; font-size: 12.5px; }
  .dl-cmt-t { flex: 1; white-space: pre-wrap; }
  .dl-cmt-stale { flex: none; color: var(--crit); font-size: 11.5px; }
  .dl-cmt-x { flex: none; color: var(--muted); }
  .dl-cmt-ed { margin: 2px 10px 6px 48px; }
  .dl-cmt-ed textarea { width: 100%; font-size: 13px; padding: 8px; border: 1px solid var(--divider); border-radius: 8px; background: var(--bg); color: var(--text); resize: vertical; }
  .dl-cmt-btns { display: flex; gap: 8px; margin-top: 6px; }
  .dl-cmt-btns button { font-size: 12.5px; padding: 4px 12px; border-radius: 8px; background: color-mix(in srgb, currentColor 8%, transparent); }

  .spin { width: 14px; height: 14px; border: 2px solid var(--divider); border-top-color: var(--coral); border-radius: 50%; animation: rvspin .8s linear infinite; flex: none; }
  @keyframes rvspin { to { transform: rotate(360deg); } }
</style>
