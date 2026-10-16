<script>
  // 外部 CLI agent（Codex / ZCode）分页共用的对话内核：消息流 + 输入栏 + 「接入」卡。
  //
  // 两家的 CLI 事件已经被服务端归一成同一套（见 src/runtime/agent-cli.mjs），所以渲染只写一份；
  // 各自的「官方排版语言」（页头、侧栏、配色）由外层分页提供，空态则由外层用 hero 片段传进来
  // （照 Claude 页：大问候 + 居中输入栏）。
  //
  // 排版照官方 ZCode DESIGN.md §530 Chat/Tooling：
  //   · 聊天气泡 rounded-xl，主输入壳 rounded-2xl（官方点名的例外）；
  //   · 工具输出 / 命令 / 路径一律等宽；
  //   · 深度靠背景对比与描边，不靠大阴影（§537 Elevation）。
  //
  // 状态在 lib/cliChat.svelte.js（模块级，退回主页再进来不丢；会话列表也在那儿）。
  import { cliChat, cliSend, cliStop, cliNew, cliStatus, loadCliStatus, statusOf, answerApproval, cwdOf } from '../../lib/cliChat.svelte.js';
  import { cliDock, ensureCliDockMeta } from '../../lib/cliDock.svelte.js';
  import { reviewComments, dropAllReviewComments } from '../../lib/reviewComments.svelte.js';
  import { apiUrl } from '../../lib/server.js';
  import { authHeaders } from '../../lib/api.js';
  import { renderMarkdown } from '../../lib/md.js';
  import { showToast } from '../../lib/toast.svelte.js';
  import { t, tr } from '../../lib/i18n.js';
  import CliAddMenu from './CliAddMenu.svelte';
  import CliModelPicker from './CliModelPicker.svelte';

  // agent: 'codex' | 'zcode'；placeholder：输入栏提示语（各家官方口吻，外层给）；
  // install/login/docUrl：接入卡上的命令与文档；hero：空态（外层给，含大问候）。
  let { agent, placeholder = '', install = '', login = '', docUrl = '', hero = null } = $props();

  const chat = $derived(cliChat[agent]);
  const st = $derived(statusOf(agent));
  // 能用（装了 + 认证了）才显示输入栏；没就绪就把「接入」卡摆出来，讲清缺什么、怎么补。
  const ready = $derived(!!st && st.installed !== false && st.authed !== false);
  // 「装了没」是第一条：没装时先讲装，装好了没登录才是下一步（ZCode 的登录是浏览器 OAuth，
  // 命令得在服务器上跑；Codex 还能在 设置 → Agent 里填一把 key）。
  const notInstalled = $derived(!!st && st.installed === false);
  const needAuth = $derived(!!st && st.installed !== false && st.authed === false);
  const empty = $derived(!chat.items.length);
  let installing = $state(false);
  let installMsg = $state('');
  async function installNow() {
    if (installing) return;
    installing = true; installMsg = '';
    try {
      const r = await fetch(apiUrl('/api/admin/agent-install'), {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        credentials: 'same-origin',
        body: JSON.stringify({ id: agent }),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || j?.error) throw new Error(j?.error || ('HTTP ' + r.status));
      await loadCliStatus(true);
      installMsg = j.installed ? t('装好了') : t('脚本跑完了，但还是没找到命令');
    } catch (e) { installMsg = (e && e.message) || String(e); }
    installing = false;
  }

  let draft = $state('');
  // worktree 勾选框（P3，照 Claude 侧 WorkspaceChips 的两态）：
  //   新对话 + 服务端说这里能开 worktree 会话（dock meta 的 wtNew：git 主检出、非快照）→ 开关，可点；
  //   会话已开 → 只读指示：勾着 = 这条会话跑在 worktree 里（worktree 事件带回）。
  // 勾选状态记在 localStorage（按 agent 分开），下次新对话还是勾着（同 Claude 侧 prefs.worktree）。
  const wtKey = 'bridge-cli-worktree-' + agent;
  function loadWtPref() { try { return localStorage.getItem(wtKey) === '1'; } catch { return false; } }
  let worktreeOn = $state(loadWtPref());
  function toggleWorktree() {
    worktreeOn = !worktreeOn;
    try { localStorage.setItem(wtKey, worktreeOn ? '1' : '0'); } catch {}
  }
  const wtMeta = $derived(cliDock[agent]?.meta);
  const wtArmable = $derived(!chat.sessionId && !!wtMeta?.wtNew);
  const wtInSession = $derived(!!chat.sessionId && !!chat.worktree);
  // dock meta 只在工作台展开时才拉；输入栏的勾选框也要它（wtNew），这里顺手拉一次（同缓存，不多打一遍）。
  $effect(() => { const w = cwdOf(agent); if (w) ensureCliDockMeta(agent, w); });
  // 有待发送的行内评论时，正文为空也能发（发送按钮与 send() 的门禁共用这一个）。
  const hasPendingComments = $derived((reviewComments.byWs[cwdOf(agent)] || []).length > 0);
  let feedEl = $state(null);
  let showReasoning = $state(false);
  // 计划模式开关（仅 Codex）：打开后这一条只出计划、不改文件；开关本身不随消息走，
  // 一直开着就是一直计划——关掉才回普通模式（单条生效是在服务端那层，见路由注释）。
  let planMode = $state(false);
  let copied = $state('');

  loadCliStatus();

  // 新内容到达就贴底（用户往上翻过就先不打扰——离底 80px 内才自动跟）
  $effect(() => {
    chat.items.length; chat.items[chat.items.length - 1]?.text;
    const el = feedEl;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 80 || chat.busy) el.scrollTop = el.scrollHeight;
  });

  function send() {
    const text = draft.trim();
    // 正文为空、只有行内评论时也能发（消息就是评论指令块，见 cliSend）。
    if ((!text && !hasPendingComments) || chat.busy || !ready) return;
    const imgs = agent === 'codex' ? atts : [];
    draft = ''; atts = []; mOpen = false; mItems = [];
    cliSend(agent, text, imgs, { plan: agent === 'codex' && planMode, worktree: worktreeOn });
  }
  function onKey(e) {
    // @ 提及菜单优先（开着时方向键/回车都在菜单里），其次 / 命令菜单
    if (mOpen && mItems.length && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) {
      e.preventDefault();
      if (e.key === 'Escape') { mOpen = false; mItems = []; return; }
      if (e.key === 'ArrowDown') { mIdx = (mIdx + 1) % mItems.length; return; }
      if (e.key === 'ArrowUp') { mIdx = (mIdx - 1 + mItems.length) % mItems.length; return; }
      pickMention(mItems[mIdx]); return;
    }
    if (slashOpen && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) {
      e.preventDefault();
      if (e.key === 'Escape') { draft = ''; return; }
      if (e.key === 'ArrowDown') { slashIdx = (slashIdx + 1) % slashList.length; return; }
      if (e.key === 'ArrowUp') { slashIdx = (slashIdx - 1 + slashList.length) % slashList.length; return; }
      runSlash(slashList[slashIdx]); return;
    }
    // 触屏设备回车当换行（手机上没有 Shift 组合键，回车发送会误触）；桌面回车发送。
    const touch = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
    if (e.key === 'Enter' && !e.shiftKey && !touch) { e.preventDefault(); send(); }
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
  }
  async function copy(text, tag) {
    try { await navigator.clipboard.writeText(text); copied = tag; setTimeout(() => { if (copied === tag) copied = ''; }, 1600); } catch {}
  }
  function autoGrow(node) {
    const fit = () => { node.style.height = 'auto'; node.style.height = Math.min(200, node.scrollHeight) + 'px'; };
    fit();
    return { update: fit };
  }
  const toolLabel = (s) => (s === 'completed' ? '✓' : s === 'failed' ? '✕' : '•');

  // ── 输入框的 PC 端功能：+ 附件菜单、/ 命令、@ 文件提及、图片附件（codex 走官方 exec -i）──
  let atts = $state([]);            // 待发的附件 [{name, dataUrl, isImg}]
  let photoEl = $state(null);       // 图片专用 input（只列 image/*）
  let fileEl = $state(null);        // 文件 input（不过滤类型）
  let taEl = $state(null);
  const MAX_IMGS = 6, MAX_IMG_MB = 10;
  function addFiles(files) {
    for (const f of files) {
      if (!f) continue;
      if (atts.length >= MAX_IMGS) { showToast(t('最多附 {n} 张图片', { n: MAX_IMGS }), 'err'); break; }
      if (f.size > MAX_IMG_MB * 1024 * 1024) { showToast(t('图片太大（单张限 {n}MB）', { n: MAX_IMG_MB }), 'err'); continue; }
      const r = new FileReader();
      r.onload = () => {
        const dataUrl = String(r.result);
        atts = [...atts, { name: f.name || 'image.png', dataUrl, isImg: /^data:image\//.test(dataUrl) }];
      };
      r.readAsDataURL(f);
    }
  }
  function onPaste(e) {
    const imgs = [...(e.clipboardData?.items || [])].filter((i) => i.type.startsWith('image/'));
    if (imgs.length && agent === 'codex') { e.preventDefault(); addFiles(imgs.map((i) => i.getAsFile()).filter(Boolean)); }
  }

  // 加号菜单（照 Claude 页 Composer 的加号弹层，精简两项目）：开之前测上下空间定弹向。
  let addOpen = $state(false);
  let plusBtn = $state(null);
  let addDir = $state('up');
  function toggleAdd() {
    if (!addOpen && plusBtn) {
      const r = plusBtn.getBoundingClientRect();
      addDir = (window.innerHeight - r.bottom) >= r.top ? 'down' : 'up';
    }
    addOpen = !addOpen;
  }
  // 菜单项只负责点开对应的文件对话框（附件状态全在本组件，不进菜单组件）。
  const pickPhotos = () => photoEl?.click();
  const pickFiles = () => fileEl?.click();
  function onPick(e) { addFiles([...e.currentTarget.files]); e.currentTarget.value = ''; }

  // / 命令菜单（客户端本地命令，与 PC 端 TUI 的斜杠习惯一致）
  const SLASH = [
    { cmd: '/new',  desc: () => t('开一段新会话'), run: () => cliNew(agent) },
    { cmd: '/stop', desc: () => t('停止这一轮'),   run: () => cliStop(agent) },
    { cmd: '/help', desc: () => t('显示这些命令'), run: () => showToast(t('命令：/new 新会话 · /stop 停止 · @ 引用文件'), 'ok') },
  ];
  let slashIdx = $state(0);
  const slashQuery = $derived(/^\/(\S*)$/.test(draft.trim()) ? draft.trim().slice(1).toLowerCase() : null);
  const slashList = $derived(slashQuery == null ? [] : SLASH.filter((c) => c.cmd.slice(1).startsWith(slashQuery)));
  const slashOpen = $derived(slashList.length > 0 && !chat.busy);
  $effect(() => { void slashQuery; slashIdx = 0; });
  function runSlash(c) { c.run(); draft = ''; }

  // @ 文件提及：从服务端列工作目录（/api/files 支持 path + 按名筛选），选中插入 @相对路径
  let mItems = $state([]); let mOpen = $state(false); let mToken = $state(''); let mIdx = $state(0); let mTimer = 0;
  $effect(() => { void mToken; mIdx = 0; });
  function caretToken(el) {
    const pos = el.selectionStart ?? el.value.length;
    const m = /@([\w./\\-]*)$/.exec(el.value.slice(0, pos));
    return m ? m[1] : null;
  }
  function onInput() {
    const el = taEl; if (!el) return;
    const tok = caretToken(el);
    mToken = tok ?? '';
    mOpen = tok != null;
    clearTimeout(mTimer);
    if (tok != null) mTimer = setTimeout(loadFiles, 160);
    else mItems = [];
  }
  async function loadFiles() {
    const ws = cwdOf(agent);
    if (!ws) { mItems = []; return; }
    const q = mToken || '';
    const slash = q.lastIndexOf('/');
    const dirPart = slash >= 0 ? q.slice(0, slash) : '';
    const namePart = slash >= 0 ? q.slice(slash + 1) : q;
    try {
      const u = apiUrl(`/api/files?ws=${encodeURIComponent(ws)}&path=${encodeURIComponent(dirPart)}&q=${encodeURIComponent(namePart)}`);
      const r = await fetch(u, { headers: authHeaders(), credentials: 'same-origin' });
      if (!r.ok) { mItems = []; return; }
      const j = await r.json();
      mItems = (j.items || []).slice(0, 8).map((x) => ({ rel: (dirPart ? dirPart + '/' : '') + x.name, dir: !!(x.dir || x.type === 'dir' || x.isDirectory) }));
    } catch { mItems = []; }
  }
  function pickMention(it) {
    const el = taEl; if (!el) return;
    const pos = el.selectionStart ?? el.value.length;
    const before = el.value.slice(0, pos).replace(/@[\w./\\-]*$/, '@' + it.rel + ' ');
    draft = before + el.value.slice(pos);
    mOpen = false; mItems = [];
    queueMicrotask(() => { el.focus(); el.setSelectionRange(before.length, before.length); });
  }

  // 审批按钮的文案。上游给的是一串英文枚举（accept / acceptForSession / decline / cancel），
  // 认不出的原样显示（上游哪天加新决策也不会变成一个空按钮）。
  function decisionLabel(d) {
    switch (d) {
      case 'accept': return t('允许');
      case 'acceptForSession': return t('本会话都允许');
      case 'acceptWithExecpolicyAmendment': return t('总是允许这类命令');
      case 'decline': return t('拒绝');
      case 'cancel': return t('拒绝并停下');
      default: return String(d);
    }
  }

  // —— 工具行的细节：命令输出 / 入参 / 改动文件 / 搜索词 ——
  // 有东西可看才做成可展开的（纯名字的一行保持原样，不占高度）。
  const hasDetail = (tl) => !!(tl.output || tl.input || (Array.isArray(tl.changes) && tl.changes.length) || tl.query);
  // 展开状态挂在工具行对象上（它随消息走、由 cliChat 持久化），来回切页不丢。
  function toggleTool(tl) { tl.open = !tl.open; }

  // 待办清单的条目标记（codex 用 pending / in_progress / completed）
  const todoMark = (s) => (s === 'completed' || s === 'done' ? '✓' : s === 'in_progress' || s === 'running' ? '▸' : '○');
  const todoDone = (s) => s === 'completed' || s === 'done';

  // 用量：两家的字段名不一样（codex: input_tokens/output_tokens；zcode: total/…），
  // 认得的就报，认不出就不显示——宁可少一行，也别摆一串 undefined。
  const fmtNum = (n) => (n >= 10000 ? Math.round(n / 1000) + 'k' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));
  function usageText(u) {
    if (!u || typeof u !== 'object') return '';
    const pick = (...keys) => {
      for (const k of keys) { const v = u[k]; if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v; }
      return null;
    };
    const inTok = pick('input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens');
    const outTok = pick('output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens');
    const total = pick('total', 'total_tokens', 'totalTokens');
    const parts = [];
    if (inTok != null) parts.push(t('输入 {n}', { n: fmtNum(inTok) }));
    if (outTok != null) parts.push(t('输出 {n}', { n: fmtNum(outTok) }));
    if (!parts.length && total != null) parts.push(t('共 {n}', { n: fmtNum(total) }));
    return parts.join(' · ');
  }
</script>

<div class="cli-chat">
  <div class="stage" class:feedmode={!empty}>
    {#if empty}
      {#if hero}{@render hero()}{/if}
      {#if !ready}
        <!-- 接入提示照 dimensio 空态：弱化的 chip（细节在侧栏「接入」里），不再是整张卡 -->
        <div class="notes">
          {#if notInstalled}
            <button class="chip click" disabled={installing} onclick={installNow}>
              <span>{installing ? t('安装中…') : t('还没装命令行工具 · 点这里安装')}</span>
            </button>
            {#if install}<code class="chip-cmd">{install}</code>{/if}
            {#if installMsg}<div class="chip-msg">{tr(installMsg)}</div>{/if}
          {:else if needAuth}
            <div class="chip">{t('装好了，还没登录')}</div>
            {#if login}
              <button class="chip click" onclick={() => copy(login, 'login')}>
                <code>{login}</code>
                <span>{copied === 'login' ? t('已复制') : t('复制')}</span>
              </button>
            {/if}
            {#if st?.keyEnv}
              <div class="chip-msg">{t('也可以在「设置 → Agent」里给它填一把 API key（服务器上加密保存，只回显尾 4 位），不用上机登录。')}</div>
            {:else if login}
              <div class="chip-msg">{t('登录会在服务器上留下凭据，之后这个分页就一直能用；不想上机的话，去「设置 → Agent → 去配置」也能看到这条命令。')}</div>
            {/if}
          {:else if !st || cliStatus.loading}
            <div class="chip">{t('正在读取状态…')}</div>
          {/if}
          {#if st?.note}<div class="chip-msg">{tr(st.note)}</div>{/if}
          {#if cliStatus.err}<div class="chip-msg err">{tr(cliStatus.err)}</div>{/if}
          <div class="chip-foot">
            <button class="mini" onclick={() => loadCliStatus(true)}>{t('重新检测')}</button>
            {#if docUrl}<a class="mini link" href={docUrl} target="_blank" rel="noreferrer">{t('官方文档')}</a>{/if}
          </div>
        </div>
      {/if}
    {:else}
    <div class="feed" bind:this={feedEl}>
      {#each chat.items as m (m.id)}
        {#if m.role === 'user'}
          <div class="row user">
            {#if m.imgs}<div class="uimgs">📎 {m.imgs}</div>{/if}
            <div class="bubble user">{m.text}</div>
          </div>
        {:else}
          <div class="row agent">
            {#if m.reasoning}
              <div class="reason">
                <button class="reason-t" onclick={() => { showReasoning = !showReasoning; }} aria-expanded={showReasoning}>
                  <span class="dot"></span>{t('思考')}<span class="caret-d">{showReasoning ? '▾' : '▸'}</span>
                </button>
                {#if showReasoning}<div class="reason-body">{m.reasoning}</div>{/if}
              </div>
            {/if}
            {#if m.plan}
              <!-- 计划块：计划模式下计划内容走 item/plan/delta 流式来（见 lib/cliChat 的 plan 归约），
                   与正文分开画，用户一眼能看出「这是计划、还没执行」。 -->
              <div class="plan">
                <div class="plan-t">{t('计划')}</div>
                <div class="plan-body">{@html renderMarkdown(m.plan)}</div>
              </div>
            {/if}
            {#if Array.isArray(m.todos) && m.todos.length}
              <!-- 待办清单：逐条画（codex 的 todo_list 以前只压成一行「待办清单」，条目全丢） -->
              <div class="todos">
                {#each m.todos as td}
                  <div class="todo" class:done={todoDone(td.status)}><span class="tmark">{todoMark(td.status)}</span><span class="ttext">{td.text}</span></div>
                {/each}
              </div>
            {/if}
            {#each m.tools as tl}
              <div class="toolrow">
                <button class="tool" class:dim={tl.status === 'completed'} class:clickable={hasDetail(tl)}
                  onclick={() => hasDetail(tl) && toggleTool(tl)} disabled={!hasDetail(tl)} aria-expanded={hasDetail(tl) ? !!tl.open : undefined}>
                  <span class="tstate">{toolLabel(tl.status)}</span><span class="tname">{tl.name}</span>
                  {#if tl.exitCode != null && tl.exitCode !== 0}<span class="tcode">{t('退出码 {n}', { n: tl.exitCode })}</span>{/if}
                  {#if hasDetail(tl)}<span class="tcaret">{tl.open ? '▾' : '▸'}</span>{/if}
                </button>
                {#if tl.progress}
                  <!-- 长 MCP 调用的实时进度（item/mcpToolCall/progress，P4）：工具行下方弱字一行。 -->
                  <div class="tprogress">{tl.progress}</div>
                {/if}
                {#if tl.open}
                  <div class="tdetail">
                    {#if tl.query}<div class="dlabel">{t('搜索')}</div><div class="dtext">{tl.query}</div>{/if}
                    {#if Array.isArray(tl.changes) && tl.changes.length}
                      <div class="dlabel">{t('改动')}</div>
                      {#each tl.changes as ch}<div class="dchange"><span class="dkind">{ch.kind || t('改')}</span><span class="dtext mono">{ch.path}</span></div>{/each}
                    {/if}
                    {#if tl.output}<div class="dlabel">{t('输出')}</div><pre class="dpre">{tl.output}</pre>{/if}
                    {#if tl.input && !tl.output}<div class="dlabel">{t('入参')}</div><pre class="dpre">{tl.input}</pre>{/if}
                  </div>
                {/if}
              </div>
            {/each}
            {#each (m.approvals || []) as ap (ap.id)}
              <!-- 审批卡：上游在问「这条命令能不能跑」。按钮按上游给的 decisions 摆，
                   用户点了走 lib/cliChat 的 answerApproval（POST /api/codex/approval）。 -->
              <div class="apcard" class:done={!!ap.answer}>
                <div class="aphead">
                  <span class="apico" aria-hidden="true">!</span>
                  <span class="aptitle">{t('需要你授权')}</span>
                  {#if ap.answer}<span class="apdone">{t('已处理')}</span>{/if}
                </div>
                {#if ap.reason}<div class="apreason">{ap.reason}</div>{/if}
                {#if ap.command}<pre class="apcmd">{ap.command}</pre>{/if}
                {#if ap.changes.length}
                  <div class="apchanges">
                    {#each ap.changes as ch}<div class="apch"><span class="apkind">{ch.kind || t('改')}</span><span class="appath mono">{ch.path}</span></div>{/each}
                  </div>
                {/if}
                {#if ap.err}<div class="aperr">{ap.err}</div>{/if}
                {#if !ap.answer && !ap.expired}
                  <div class="apbtns">
                    {#each ap.decisions as d (d)}
                      <button class="apbtn" class:primary={d === 'accept' || d === 'acceptForSession'}
                        class:danger={d === 'cancel'} disabled={ap.sending}
                        onclick={() => answerApproval(agent, m.id, ap.id, d)}>
                        {decisionLabel(d)}
                      </button>
                    {/each}
                  </div>
                {:else if ap.expired && !ap.answer}
                  <div class="apexpired">{t('这一轮已经结束了，这张卡作废')}</div>
                {/if}
              </div>
            {/each}
            {#if m.text.trim()}
              <div class="bubble agent">{@html renderMarkdown(m.text)}</div>
            {:else if m.status === 'running'}
              <div class="thinking"><span class="pulse"></span>{t('正在工作…')}</div>
            {/if}
            {#if m.usage && usageText(m.usage)}
              <div class="usage">{usageText(m.usage)}</div>
            {/if}
            {#each m.notes as n}<div class="note">{n}</div>{/each}
            {#if m.error}<div class="err">{tr(m.error)}</div>{/if}
            {#if m.error && m.auth && login}
              <!-- 认证类失败：CLI 那句「Provider authentication failed.」到此为止，
                   用户需要知道下一步做什么（重新登录哪条命令） -->
              <div class="err-hint">{t('登录失效或套餐没生效：在服务器上重新跑一次 {cmd}，再回这里点「重新检测」', { cmd: login })}</div>
            {/if}
          </div>
        {/if}
      {/each}
    </div>
    {/if}
  </div>
  {@render composer(!empty)}
</div>

{#snippet composer(bottom)}
  <div class="composer" class:bottom>
    <!-- 输入卡照 dimensio：上层纯输入，下层控制条（左：+附件 / 工作目录；右：模型胶囊 + 圆形发送钮） -->
    <div class="boxwrap">
      {#if slashOpen}
        <div class="menu">
          {#each slashList as c, i (c.cmd)}
            <button class="mi" class:on={i === slashIdx} onclick={() => runSlash(c)}>
              <code>{c.cmd}</code><span>{c.desc()}</span>
            </button>
          {/each}
        </div>
      {:else if mOpen && mItems.length}
        <div class="menu">
          {#each mItems as it, i (it.rel)}
            <button class="mi" class:on={i === mIdx} onclick={() => pickMention(it)}>
              <span class="mico">{it.dir ? '▸' : '·'}</span><span class="mpath">{it.rel}</span>
            </button>
          {/each}
        </div>
      {/if}
      {#if atts.length}
        <div class="atts">
          {#each atts as a, i (i + a.name)}
            {#if a.isImg}
              <span class="att">
                <img src={a.dataUrl} alt={a.name} />
                <button class="att-x" onclick={() => atts = atts.filter((_, j) => j !== i)} aria-label={t('移除')}>×</button>
              </span>
            {:else}
              <span class="att file">
                <span class="att-fname">📄 {a.name}</span>
                <button class="att-x" onclick={() => atts = atts.filter((_, j) => j !== i)} aria-label={t('移除')}>×</button>
              </span>
            {/if}
          {/each}
        </div>
      {/if}
      <div class="box">
        {#if (reviewComments.byWs[cwdOf(agent)] || []).length}
          <div class="rv-pending">
            <span>{t('审阅面板行内评论 {n} 条，将随下一条消息发给模型', { n: (reviewComments.byWs[cwdOf(agent)] || []).length })}</span>
            <button onclick={() => dropAllReviewComments(cwdOf(agent))}>{t('不带了')}</button>
          </div>
        {/if}
        <textarea class="ta" bind:this={taEl} bind:value={draft} {placeholder} rows="1" use:autoGrow
          oninput={onInput} onpaste={onPaste} onkeydown={onKey} disabled={!ready}></textarea>
        <div class="bar">
          {#if agent === 'codex'}
            <button class="plus" bind:this={plusBtn} onclick={toggleAdd} disabled={!ready} aria-label={t('添加附件')} title={t('添加附件')}>
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M10 4.5v11M4.5 10h11"/></svg>
            </button>
            {#if addOpen}
              <CliAddMenu dir={addDir} onPickPhotos={pickPhotos} onPickFiles={pickFiles} onClose={() => (addOpen = false)} />
            {/if}
            <input type="file" bind:this={photoEl} accept="image/*" multiple hidden onchange={onPick} />
            <input type="file" bind:this={fileEl} multiple hidden onchange={onPick} />
          {/if}
          <span class="bspacer"></span>
          {#if wtArmable}
            <button class="wt-toggle" role="checkbox" aria-checked={worktreeOn}
              title={t('在仓库的隔离副本里工作')} onclick={toggleWorktree} disabled={!ready}>
              <span class="wt-box" class:off={!worktreeOn}>{#if worktreeOn}✓{/if}</span>
              <span>worktree</span>
            </button>
          {:else if wtInSession}
            <span class="wt-toggle ro" title={t('此工作空间是 git worktree，不是主检出')}>
              <span class="wt-box">✓</span>
              <span>worktree</span>
            </span>
          {/if}
          {#if agent === 'codex'}
            <!-- 计划模式开关（仅 Codex）：打开后这一条只出计划、不改文件。
                 关掉再发就是普通模式（按计划执行时关掉它就行）。 -->
            <button class="plan-toggle" class:on={planMode} onclick={() => (planMode = !planMode)}
              disabled={!ready} aria-pressed={planMode} aria-label={t('计划模式')}
              title={t('计划模式：只出计划，不改文件')}>
              {t('计划模式')}
            </button>
            <CliModelPicker agent="codex" disabled={chat.busy || !ready} />
          {/if}
          {#if chat.busy}
            <button class="send stop" onclick={() => cliStop(agent)} aria-label={t('停止')}>
              <svg viewBox="0 0 20 20" fill="currentColor"><rect x="6" y="6" width="8" height="8" rx="1.5"/></svg>
            </button>
          {:else}
            <button class="send" onclick={send} disabled={!ready || (!draft.trim() && !hasPendingComments)} aria-label={t('发送')}>
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M10 15.5V5M10 5l-4 4M10 5l4 4"/></svg>
            </button>
          {/if}
        </div>
      </div>
    </div>
  </div>
{/snippet}

<style>
  .cli-chat { display: flex; flex-direction: column; min-height: 0; height: 100%; }
  /* 空态照 dimensio：标志 + 问候坐在视觉中心略上（底部留 7vh），接入提示弱化成 chip；
     输入栏恒在底栏（对话态同一根 stage，内容换成消息流）。 */
  .stage { flex: 1; min-height: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 0 12px 7vh; overflow-y: auto; }
  .stage.feedmode { justify-content: flex-start; padding: 0; overflow: hidden; }

  /* 入场动画（时长/节奏对齐 dimensio 标志 intro：INTRO_MS=1850，弹簧过冲回正）：
     标志旋入摆正，问候与提示随后上浮（dimensio h1 delay=120ms）；减弱动效只留淡入 */
  .stage :global(.hero-mark svg) { animation: cliMarkIn 1850ms cubic-bezier(.22, 1, .36, 1) both; transform-origin: 50% 50%; }
  .stage :global(.hero h1) { animation: cliRiseIn .42s .12s cubic-bezier(.22, 1, .36, 1) both; }
  .stage :global(.hero .hero-sub) { animation: cliRiseIn .42s .2s cubic-bezier(.22, 1, .36, 1) both; }
  @keyframes cliMarkIn {
    0% { opacity: 0; transform: rotate(-120deg) scale(.5); }
    55% { opacity: 1; }
    70% { transform: rotate(8deg) scale(1.06); }
    85% { transform: rotate(-3deg) scale(.99); }
    100% { opacity: 1; transform: rotate(0deg) scale(1); }
  }
  @keyframes cliRiseIn { from { opacity: 0; transform: translateY(10px); } }
  @media (prefers-reduced-motion: reduce) {
    .stage :global(.hero-mark svg), .stage :global(.hero h1), .stage :global(.hero .hero-sub) { animation-duration: .01s; animation-delay: 0s; }
  }

  /* 接入提示 chip（dimensio 式弱化，细节在侧栏「接入」） */
  .notes { display: flex; flex-direction: column; align-items: center; gap: 10px; margin-top: 26px; max-width: 520px; }
  .chip { display: inline-flex; align-items: center; gap: 8px; padding: 9px 14px; border-radius: 12px; font-size: 13px;
    line-height: 1.5; color: var(--faint, #8a8a86); background: color-mix(in srgb, currentColor 7%, transparent); text-align: left; }
  .chip.click { color: inherit; }
  .chip.click:active { background: color-mix(in srgb, var(--agent-accent, currentColor) 16%, transparent); }
  @media (hover: hover) { .chip.click:hover { background: color-mix(in srgb, var(--agent-accent, currentColor) 14%, transparent); } }
  .chip code { font-family: var(--mono, monospace); font-size: 12px; }
  .chip-cmd { max-width: 100%; overflow-x: auto; white-space: nowrap; font-family: var(--mono, monospace); font-size: 12px;
    opacity: .7; padding: 6px 10px; border-radius: 8px; background: color-mix(in srgb, currentColor 6%, transparent); }
  .chip-msg { font-size: 12px; color: var(--faint, #8a8a86); line-height: 1.6; text-align: center; }
  .chip-msg.err { color: var(--danger, #c0392b); }
  .chip-foot { display: flex; gap: 8px; margin-top: 2px; }

  /* 消息列：与 Claude 页 Thread 完全同一套列规则（760px 居中、16px 侧边距）。
     之前 .feed 没写 width/max-width，而父级 .stage 带 align-items: center、
     .stage.feedmode 又没重置它——消息短时 .feed 会被挤成内容宽度居中，
     看起来就是一根窄列；width:100% 把它钉满，顺带修了这个挤压。 */
  .feed { flex: 1; min-height: 0; overflow-y: auto; padding: 8px 16px 16px; overscroll-behavior: contain;
    width: 100%; max-width: 760px; margin: 0 auto; }
  .row { padding: 6px 0; display: flex; flex-direction: column; gap: 6px; }
  .row.user { align-items: flex-end; }

  /* 官方容器层级：气泡从 rounded-xl 起（DESIGN.md §532）。
     用户气泡用「比背景亮一档」的底（官方靠背景对比分层，不靠阴影）；回答不打气泡，直接读。 */
  .bubble.user { max-width: 86%; border-radius: 14px; padding: 9px 13px; font-size: 15px; line-height: 1.6;
    white-space: pre-wrap; word-break: break-word; background: color-mix(in srgb, currentColor 9%, transparent); }
  .bubble.agent { font-size: 15px; line-height: 1.68; }
  .bubble.agent :global(p) { margin: 0 0 10px; }
  .bubble.agent :global(p:last-child) { margin-bottom: 0; }
  .bubble.agent :global(pre) { overflow-x: auto; border-radius: 10px; }
  /* 工具 / 命令 / 路径 = 等宽（官方 §533） */
  .toolrow { display: flex; flex-direction: column; gap: 4px; }
  .tool { display: flex; gap: 8px; align-items: baseline; font-size: 12.5px; line-height: 1.6; color: var(--faint, #8a8a86);
    font-family: var(--mono, ui-monospace, monospace); text-align: left; }
  .tool.dim { opacity: .72; }
  /* 有细节可看的行做成可点的（展开输出）；纯名字的行不可点，鼠标也不变手型。 */
  .tool.clickable { cursor: pointer; }
  .tool.clickable:hover { opacity: 1; }
  .tool:disabled { opacity: .72; }
  .tstate { width: 10px; flex: none; }
  .tname { min-width: 0; word-break: break-word; }
  .tcode { flex: none; color: var(--danger, #c0392b); opacity: .9; }
  .tcaret { flex: none; font-size: 10px; opacity: .7; }
  /* MCP 工具的实时进度（P4）：弱字一行，与工具行细节同缩进。 */
  .tprogress { font-size: 12px; color: var(--faint, #8a8a86); margin: -2px 0 2px 18px; }

  /* 工具行的细节块：输出 / 入参 / 改动文件（深一层底，不靠阴影——官方 §537） */
  .tdetail { display: flex; flex-direction: column; gap: 4px; margin: 0 0 4px 18px; }
  .dlabel { font-size: 11px; color: var(--faint, #8a8a86); opacity: .75; letter-spacing: .02em; }
  .dtext { font-size: 12.5px; line-height: 1.6; word-break: break-word; }
  .dchange { display: flex; gap: 8px; align-items: baseline; font-size: 12.5px; }
  .dkind { flex: none; font-size: 11px; color: var(--faint, #8a8a86); opacity: .8; }
  .dpre { margin: 0; max-height: 320px; overflow: auto; border-radius: 10px; padding: 8px 10px; font-size: 12px; line-height: 1.6;
    font-family: var(--mono, ui-monospace, monospace); white-space: pre-wrap; word-break: break-word;
    background: color-mix(in srgb, currentColor 6%, transparent); }
  .mono { font-family: var(--mono, ui-monospace, monospace); }

  /* 待办清单（codex 的 todo_list）：条目逐条列，做完的打勾压暗 */
  .todos { display: flex; flex-direction: column; gap: 3px; padding: 2px 0 2px 2px; }
  .todo { display: flex; gap: 8px; align-items: baseline; font-size: 13px; line-height: 1.55; }
  .todo.done { opacity: .55; }
  .tmark { width: 12px; flex: none; color: var(--faint, #8a8a86); }
  .ttext { min-width: 0; word-break: break-word; }

  /* 用量（token 计数）：最弱的一行，收在回答末尾 */
  .usage { font-size: 11px; color: var(--faint, #8a8a86); opacity: .7; font-family: var(--mono, ui-monospace, monospace); }

  /* 审批卡：上游在问授权。视觉上要压过普通工具行——它是「卡住了，等你点」。 */
  .apcard { display: flex; flex-direction: column; gap: 8px; margin: 6px 0; padding: 12px; border-radius: 12px;
    border: 1px solid color-mix(in srgb, currentColor 24%, transparent);
    background: color-mix(in srgb, currentColor 6%, transparent); }
  .apcard.done { opacity: .68; }
  .aphead { display: flex; align-items: center; gap: 8px; }
  .apico { width: 16px; height: 16px; flex: none; border-radius: 50%; font-size: 11px; font-weight: 700; line-height: 16px;
    text-align: center; color: #fff; background: var(--warn, #b7791f); }
  .aptitle { font-size: 13px; font-weight: 600; }
  .apdone { font-size: 11px; opacity: .65; margin-left: auto; }
  .apreason { font-size: 13px; line-height: 1.6; }
  .apcmd { margin: 0; padding: 8px 10px; border-radius: 8px; font-size: 12px; line-height: 1.6; overflow-x: auto;
    font-family: var(--mono, ui-monospace, monospace); white-space: pre-wrap; word-break: break-word;
    background: color-mix(in srgb, currentColor 8%, transparent); }
  .apchanges { display: flex; flex-direction: column; gap: 3px; }
  .apch { display: flex; gap: 8px; align-items: baseline; font-size: 12.5px; }
  .apkind { flex: none; font-size: 11px; opacity: .7; }
  .appath { min-width: 0; word-break: break-all; }
  .aperr { font-size: 12px; color: var(--danger, #c0392b); }
  .apexpired { font-size: 12px; opacity: .6; }
  .apbtns { display: flex; gap: 8px; flex-wrap: wrap; }
  .apbtn { font-size: 12.5px; padding: 6px 12px; border-radius: 8px; color: inherit;
    border: 1px solid color-mix(in srgb, currentColor 22%, transparent); }
  .apbtn.primary { background: color-mix(in srgb, var(--agent-accent, currentColor) 18%, transparent); font-weight: 600; }
  .apbtn.danger { color: var(--danger, #c0392b); border-color: color-mix(in srgb, var(--danger, #c0392b) 40%, transparent); }
  .apbtn:disabled { opacity: .5; }

  .reason-t { display: inline-flex; gap: 6px; align-items: center; font-size: 12.5px; color: var(--faint, #8a8a86); padding: 2px 0; }
  .reason-body { font-size: 13px; color: var(--faint, #8a8a86); white-space: pre-wrap; border-left: 2px solid currentColor; padding-left: 10px; margin: 4px 0 8px; opacity: .85; }

  /* 计划块（Codex 计划模式）：与正文分开画，带描边 + 弱底，一眼看出「这是计划、还没执行」。 */
  .plan { margin: 2px 0 4px; padding: 10px 12px; border-radius: 12px;
    border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
    background: color-mix(in srgb, currentColor 4%, transparent); }
  .plan-t { font-size: 12px; font-weight: 600; opacity: .8; margin-bottom: 6px; }
  .plan-body { font-size: 14px; line-height: 1.65; }
  .plan-body :global(p) { margin: 0 0 8px; }
  .plan-body :global(p:last-child) { margin-bottom: 0; }
  .plan-body :global(pre) { overflow-x: auto; border-radius: 10px; }

  /* 计划模式开关胶囊（仅 Codex，模型胶囊左边）：开着时 accent 底 + 加粗，关着是弱描边。 */
  .plan-toggle { flex: none; font-size: 12px; padding: 5px 11px; border-radius: 999px; white-space: nowrap;
    border: 1px solid color-mix(in srgb, currentColor 20%, transparent); color: inherit; }
  .plan-toggle.on { background: color-mix(in srgb, var(--agent-accent, currentColor) 18%, transparent);
    border-color: color-mix(in srgb, var(--agent-accent, currentColor) 45%, transparent); font-weight: 600; }
  .plan-toggle:disabled { opacity: .35; }
  /* worktree 勾选框（P3，照 WorkspaceChips：小方框 + worktree 字样；会话中是只读指示）。 */
  .wt-toggle { flex: none; display: inline-flex; align-items: center; gap: 5px; font-size: 12px; padding: 5px 9px; border-radius: 999px; white-space: nowrap; color: inherit; }
  .wt-toggle:active { background: var(--hover); }
  .wt-toggle:disabled { opacity: .35; }
  .wt-toggle.ro { cursor: default; }
  .wt-box { width: 14px; height: 14px; border-radius: 4px; border: 1.5px solid currentColor; display: inline-flex; align-items: center; justify-content: center; font-size: 10px; line-height: 1; }
  .wt-box.off { opacity: .45; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; opacity: .5; }
  .caret-d { font-size: 10px; }
  .thinking { display: flex; gap: 8px; align-items: center; font-size: 14px; color: var(--faint, #8a8a86); }
  .pulse { width: 8px; height: 8px; border-radius: 50%; background: currentColor; animation: cliPulse 1.1s ease-in-out infinite; }
  @keyframes cliPulse { 50% { opacity: .25; } }
  .note { font-size: 12.5px; color: var(--faint, #8a8a86); }
  .err { font-size: 14px; color: var(--danger, #c0392b); white-space: pre-wrap; }
  /* 「怎么办」那句：比错误本身弱一档，但仍在同一处，用户不用去找 */
  .err-hint { font-size: 12.5px; color: var(--faint, #8a8a86); line-height: 1.6; }
  .err-hint::before { content: '→ '; opacity: .7; }

  .composer { flex: none; width: 100%; max-width: 760px; margin: 0 auto; padding: 8px 2px 12px; display: flex; flex-direction: column; gap: 6px; }
  .composer.bottom { padding-bottom: calc(12px + var(--sab, 0px)); }
  /* 输入卡照官方 PC 端 composer：圆角 ~22 的一层壳包住「纯输入区 + 44px 控制条」，壳内不再有第二道边框 */
  .box { display: flex; flex-direction: column; border: 1px solid var(--line, #3a3a38); border-radius: 22px;
    background: color-mix(in srgb, currentColor 5%, transparent); padding: 4px 8px 8px; }
  .ta { width: 100%; resize: none; font: inherit; font-size: 15px; line-height: 1.5;
    padding: 10px 8px 4px; border: none; background: transparent; color: var(--text, #eee); outline: none; }
  .ta::placeholder { color: var(--faint, #8a8a86); }
  .box:focus-within { border-color: color-mix(in srgb, var(--agent-accent, currentColor) 45%, transparent); }
  .box:has(.ta:disabled) { opacity: .5; }
  /* 审阅行内评论待发送提示（审阅面板写了评论，下一条消息会带上；点「不带了」丢掉） */
  .rv-pending { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12.5px; color: var(--coral); padding: 8px 8px 2px; }
  .rv-pending button { color: var(--muted); text-decoration: underline; }
  /* 控制条：左 +/工作目录、右模型胶囊 + 圆形发送钮（官方 PC 端同构，条高 44px） */
  .bar { display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 2px 6px 2px 6px; }
  .bspacer { flex: 1; }
  /* 圆形发送钮（官方 PC 端同款，accent 随各家：Codex 绿 / ZCode 蓝） */
  .send { flex: none; width: 34px; height: 34px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center;
    background: var(--agent-accent, var(--text, #eee)); color: #fff; }
  .send svg { width: 17px; height: 17px; }
  .send:disabled { opacity: .35; }
  .send.stop { background: var(--danger, #c0392b); color: #fff; }

  .mini { font-size: 12px; padding: 3px 8px; border-radius: 8px; border: 1px solid var(--line, #3a3a38); color: inherit; }
  .mini.link { text-decoration: none; }
  .mini:active { opacity: .6; }

  /* 控制条左端的 ＋（codex 附件菜单入口，官方 PC 端同款 30px 弱按钮） */
  .plus { flex: none; width: 30px; height: 30px; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; color: inherit; }
  .plus svg { width: 17px; height: 17px; }
  @media (hover: hover) { .plus:hover { background: color-mix(in srgb, currentColor 8%, transparent); } }
  .plus:active { background: color-mix(in srgb, currentColor 10%, transparent); }
  .plus:disabled { opacity: .3; }
  /* 待发附件缩略条 + 弹出菜单（/ 命令 与 @ 提及共用一层）：图片走缩略图，其余文件是「📄+文件名」chip */
  .atts { display: flex; gap: 8px; flex-wrap: wrap; padding: 0 2px 8px; }
  .att { position: relative; display: inline-flex; }
  .att.file { align-items: center; max-width: 100%; padding: 6px 10px; border-radius: 10px; font-size: 12.5px;
    border: 1px solid color-mix(in srgb, currentColor 16%, transparent);
    background: color-mix(in srgb, currentColor 6%, transparent); }
  .att-fname { min-width: 0; max-width: 220px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .att img { width: 46px; height: 46px; object-fit: cover; border-radius: 8px; border: 1px solid color-mix(in srgb, currentColor 16%, transparent); }
  .att-x { position: absolute; top: -6px; right: -6px; width: 18px; height: 18px; border-radius: 50%; font-size: 12px; line-height: 1;
    display: inline-flex; align-items: center; justify-content: center; background: var(--text, #eee); color: var(--bg, #1b1b19); }
  .uimgs { font-size: 11.5px; opacity: .6; }
  .menu { position: absolute; bottom: calc(100% + 8px); left: 0; min-width: 260px; max-width: 100%; z-index: 20;
    display: flex; flex-direction: column; padding: 4px; border-radius: 12px; overflow: hidden;
    border: 1px solid color-mix(in srgb, currentColor 16%, transparent);
    background: var(--card, #2c2c2a); box-shadow: 0 8px 28px rgba(0,0,0,.35); }
  .mi { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-radius: 8px; font-size: 13px; color: inherit; text-align: left; }
  .mi.on, .mi:active { background: color-mix(in srgb, var(--agent-accent, currentColor) 14%, transparent); }
  .mi code { font-family: var(--mono, monospace); font-size: 12.5px; font-weight: 600; }
  .mi span { opacity: .6; font-size: 12px; }
  .mico { width: 14px; flex: none; opacity: .5; }
  .mpath { font-family: var(--mono, monospace); font-size: 12.5px; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .boxwrap { position: relative; }
</style>
