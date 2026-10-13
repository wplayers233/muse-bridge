<script>
  // Codex 分页。侧栏完全照 Claude 页同一套骨架：三档形态（compact 抽屉 / medium 可点常驻 /
  // expanded 恒常驻）、左侧常驻列 200–420 可拖宽、菜单行 + 会话列表 + 底部账户卡；
  // 皮保留 Codex 官方元素：等宽字体的「盒子」头部、官方的圆 + 提示符 mark。
  //
  // 官方 mark 在 public/assets/icons/codex-{dark,light}.svg；这里内联一份给页头与问候处。
  // 命令行走的是服务端 /api/codex/chat（codex exec --json → 归一事件）。
  import { onMount, untrack } from 'svelte';
  import CliChat from './cli/CliChat.svelte';
  import CliDock from './dock/CliDock.svelte';
  import AccountCard from './AccountCard.svelte';
  import { cliChat, cliNew, cliPick, cliDrop, cliSessions, cliActiveId, cliStatus, loadCliStatus, statusOf, cwdOf, setCliCwd,
    loadCliModels, syncSessions } from '../lib/cliChat.svelte.js';
  import { cliDock, cliDockOpen, cliDockClose, setCliDockWs } from '../lib/cliDock.svelte.js';
  import { layout, makeSideYield } from '../lib/layout.svelte.js';
  import { createSidebarWidth } from '../lib/sbWidth.svelte.js';
  import { ui, rootScreen, toggleTheme, me } from '../lib/state.svelte.js';
  import { closePage } from '../lib/pageMorph.js';
  import { showToast } from '../lib/toast.svelte.js';
  import { t, tr, tc } from '../lib/i18n.js';

  const single = $derived(rootScreen() === 'codex');
  const chat = $derived(cliChat.codex);
  const st = $derived(statusOf('codex'));
  const dark = $derived(ui.theme !== 'light');

  // 这一页跟 Claude 页同一套全局配色（app.css 的 --bg token）：不再走 Codex 官方的近黑定制底。
  const bg = $derived(dark ? '#1f1f1e' : '#f8f8f6');

  const sessions = $derived(cliSessions.codex);
  const curId = $derived(cliActiveId('codex'));
  const greet = $derived(me.user ? t('你好，{name}', { name: me.user }) : t('你好'));
  // 这个 agent 自己的工作目录（可换）：状态面的值优先，聊过一轮则退回 meta 带回的。
  // 换目录入口在输入框的工作目录 chip（点击打开选择器）——侧栏保持 Claude 同款极简。
  const cwd = $derived(cwdOf('codex'));
  let pickOpen = $state(false);

  // —— 三档形态（断点单源 lib/layout.svelte.js，与 Claude 页同一套）——
  //   expanded ≥1100：侧栏恒常驻左列
  //   medium 700–1099：侧栏可点汉堡常驻；工作台一开自动让位、关掉回来（makeSideYield）
  //   compact <700：侧栏=抽屉（ui.drawerOpen 全局开关，与 Claude 页同一颗）
  const wide = $derived(layout.expanded);          // 侧栏【恒】常驻
  const sideMode = $derived(layout.side);          // 工作台走侧列（而非底部 sheet）
  const PIN_LS = 'bridge-codex-sidepin';
  let sidePinned = $state((() => { try { return localStorage.getItem(PIN_LS) === '1'; } catch { return false; } })());
  const setPinned = (v) => { sidePinned = v; try { localStorage.setItem(PIN_LS, v ? '1' : '0'); } catch {} };
  const yielder = makeSideYield(() => sidePinned, (v) => { sidePinned = v; });   // 让位不写盘
  const pinned = $derived(layout.expanded || (layout.medium && sidePinned));
  $effect(() => { if (layout.side) ui.drawerOpen = false; });
  // 工作台开合 → medium 档让位/还原（untrack：apply 读写 sidePinned，别让 effect 依赖它）。
  const dkOpen = $derived(cliDock.codex.open);
  $effect(() => { const open = dkOpen; untrack(() => yielder.apply(open)); });
  // 离开本页（keep-alive 换页）把抽屉收掉：ui.drawerOpen 是与 Claude 页共享的全局开关。
  $effect(() => { if (ui.screen !== 'codex') ui.drawerOpen = false; });
  // —— 桌面侧栏拉动（与 Claude 页同规格）：200–420 钳制、拖拽跟手、键盘可调、localStorage 持久。 ——
  const sb = createSidebarWidth('bridge-codex-sbw');
  const SB_MIN = sb.SB_MIN, SB_MAX = sb.SB_MAX;
  const sbW = $derived(sb.sbW);
  const sbDrag = $derived(sb.sbDrag);

  async function pickedDir(dir) {
    pickOpen = false;
    if (!dir) return;
    try {
      const now = await setCliCwd('codex', dir);
      showToast(t('工作目录已换成 {dir}', { dir: now }));
    } catch (e) {
      showToast(tr(e?.body?.error || e?.message) || t('换不了这个目录'), 'err');
    }
  }

  $effect(() => {
    ui.pageChrome = { dark, bg };
    return () => { ui.pageChrome = null; };
  });
  // 工作台（终端/审阅/文件）的作用域＝这个 agent 的工作目录。换目录时 meta 要重取，
  // 文件卡的定位也要清掉（setCliDockWs 内部处理；面板经 {#key ws} 整体重挂）。
  $effect(() => setCliDockWs('codex', cwd));
  onMount(() => {
    loadCliStatus(true);
    // 会话注册表对账：模块加载时跑过一次，这里补一次（换设备/重新登录回到页面要拉最新）。
    syncSessions();
    // 模型清单单独拉（服务端要起一次 app-server 读 model/list，约一秒；那边缓存 10 分钟）。
    loadCliModels();
  });

  function exit() { if (!single) closePage('codex'); }
  const stateText = $derived(!st || cliStatus.loading ? t('正在读取状态…')
    : st.installed === false ? t('没装命令行工具')
      : st.authed === false ? t('装好了，还没登录')
        : t('已接上'));

  // 汉堡键（语义与 Claude 页 onMenuKey 同一档）：compact 拉抽屉；medium 切「侧栏常驻」
  // （工作台开着时手动点＝我就要侧栏，让位记账作废、并把工作台收掉腾地方）。
  function onMenuKey() {
    if (layout.compact) { ui.drawerOpen = true; return; }
    const next = !sidePinned;
    setPinned(next);
    yielder.forget();
    if (next && cliDock.codex.open) cliDockClose('codex');
  }
  const closeDrawer = () => { ui.drawerOpen = false; };

  function when(ts) {
    if (!ts) return '';
    const d = new Date(ts); const now = new Date();
    const same = d.toDateString() === now.toDateString();
    const pad = (n) => String(n).padStart(2, '0');
    return same ? pad(d.getHours()) + ':' + pad(d.getMinutes()) : (d.getMonth() + 1) + '/' + d.getDate();
  }
</script>

<div class="cx-shell" style:--cx-bg={bg} style:--agent-accent="#10a37f">
<div class="cx-root" class:wide={pinned || sideMode}>

{#if pinned}
  <aside class="cx-drawer pinned" style:width={sbW + 'px'}>{@render drawerBody()}</aside>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex a11y_no_noninteractive_element_interactions -->
  <div class="sb-handle" class:drag={sbDrag} style:left={(sbW - 6) + 'px'} role="separator"
    aria-orientation="vertical" aria-label={t('调整侧栏宽度')} aria-valuenow={sbW} aria-valuemin={SB_MIN} aria-valuemax={SB_MAX}
    tabindex="0" onpointerdown={sb.sbDown} onkeydown={sb.sbKey}><span class="sb-pill"></span></div>
{/if}

<div class="cx-body">
  <header class="cx-top">
    <div class="cx-left">
      {#if !single}
        <button class="cx-icon" class:on={pinned && !wide} onclick={onMenuKey} aria-label={t('菜单')}
          aria-expanded={layout.compact ? ui.drawerOpen : pinned}>
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M3.5 5.5h13M3.5 10h13M3.5 14.5h13"/></svg>
        </button>
      {/if}
      <span class="cx-mark" aria-hidden="true">
        <!-- Codex 官方 mark：圆 + 提示符（与 openai/codex 登录页的 .codex-mark 同几何） -->
        <svg viewBox="0 0 32 32" fill="none"><path d="M22.356 19.797H17.17M9.662 12.29l1.979 3.576a.511.511 0 0 1-.005.504l-1.974 3.409M30.758 16c0 8.15-6.607 14.758-14.758 14.758-8.15 0-14.758-6.607-14.758-14.758C1.242 7.85 7.85 1.242 16 1.242c8.15 0 14.758 6.608 14.758 14.758Z" stroke="currentColor" stroke-linecap="round" stroke-width="2.484"/></svg>
      </span>
      <span class="cx-word">Codex</span>
      {#if sideMode}<span class="cx-chip" class:ok={!!st && st.installed !== false && st.authed !== false}>{stateText}</span>{/if}
    </div>
    <div class="cx-right">
      {#if sideMode}
        <button class="cx-icon" class:on={dkOpen} onclick={() => cliDockOpen('codex', 'review')}
          aria-label={t('工作台')} aria-pressed={dkOpen} title={t('审阅 / 终端 / 文件')}>
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="3.5" width="15" height="13" rx="2"/><path d="M12.5 3.5v13"/></svg>
        </button>
      {/if}
      <button class="cx-icon" onclick={toggleTheme} aria-label={t('切换明暗主题')}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
      </button>
      {#if !single}<button class="cx-icon" onclick={exit} aria-label={t('关闭')}><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 5l10 10M15 5L5 15"/></svg></button>{/if}
    </div>
  </header>

  <div class="cx-frames" class:wide={sideMode}>
    <section class="cx-frame conv">
      <CliChat agent="codex"
        placeholder={t('让 Codex 做点什么？')}
        install={st?.install || ''}
        login="codex login"
        docUrl={st?.docs || 'https://github.com/openai/codex'}
        onCwdClick={() => { pickOpen = true; }}
        {hero} />
    </section>
    <!-- 工作台：终端 / 审阅 / 文件（作用域＝这个 agent 的工作目录）。侧列档是跟在对话后的
         第二根侧列，窄屏自己铺满整屏（见 CliDock.svelte）。 -->
    <CliDock agent="codex" ws={cwd} wide={sideMode} />
  </div>
</div>
</div>

<!-- 窄屏抽屉放在 .cx-shell 里：背景 token 挂在 shell 上，抽屉（.cx-root 的兄弟）
     才读得到 --cx-bg——挂在 .cx-root 上时它读不到，背景整条失效成透明。 -->
{#if !wide}
  <button class="cx-scrim" class:on={ui.drawerOpen} aria-label={t('关闭侧栏')} onclick={closeDrawer}></button>
  <aside class="cx-drawer {ui.drawerOpen ? 'on' : ''}">{@render drawerBody()}</aside>
{/if}
</div>

<!-- 换工作目录：与 Claude「新建项目」、dimensio「默认工作空间」同一个选择器。 -->
{#if pickOpen}
  <ProjectPicker
    title={t('选择工作目录')}
    hint={t('把文件夹拖进底栏，它就是 Codex 的工作目录')}
    preferPath={cwd}
    onPick={pickedDir}
    onClose={() => (pickOpen = false)} />
{/if}

{#snippet drawerBody()}
  <div class="cx-brand">
    <span class="cx-mark" aria-hidden="true">
      <svg viewBox="0 0 32 32" fill="none"><path d="M22.356 19.797H17.17M9.662 12.29l1.979 3.576a.511.511 0 0 1-.005.504l-1.974 3.409M30.758 16c0 8.15-6.607 14.758-14.758 14.758-8.15 0-14.758-6.607-14.758-14.758C1.242 7.85 7.85 1.242 16 1.242c8.15 0 14.758 6.608 14.758 14.758Z" stroke="currentColor" stroke-linecap="round" stroke-width="2.484"/></svg>
    </span>
    <span class="cx-word">Codex</span>
  </div>

  {#if !single}
    <button class="d-item" onclick={() => { closeDrawer(); exit(); }}>
      <span class="d-lead" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5 10 3.2l6.5 5.3V16a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V8.5Z"/></svg></span>{t('主页')}
    </button>
  {/if}
  <button class="d-item" onclick={() => { cliNew('codex'); closeDrawer(); }}>
    <span class="d-lead" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M10 4.5v11M4.5 10h11"/></svg></span>{t('新会话')}
  </button>
  <!-- 接入设置 / 凭据 / 工作台三组已从侧栏移除（对齐 Claude 的极简结构）：
       状态看页头 chip 与空态引导，模型/思考深度在输入框胶囊里选，凭据走「设置 → Agent」，
       工作台入口在页头的工作台按钮，换工作目录在下方「项目」行 / 输入框 cwd chip。 -->
  <div class="d-sec">{t('会话')}</div>
  <div class="d-list">
    {#each sessions as s (s.id)}
      <div class="d-row" class:cur={s.id === curId}>
        <button class="d-recent" onclick={() => { cliPick('codex', s.id); closeDrawer(); }}>
          <span class="d-title">{s.title || t('新会话')}</span>
          <span class="d-at">{when(s.at)}</span>
        </button>
        <button class="d-more" aria-label={t('删除')} onclick={() => cliDrop('codex', s.id)}>
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M5.5 5.5l9 9M14.5 5.5l-9 9"/></svg>
        </button>
      </div>
    {/each}
    {#if !sessions.length}<div class="d-empty">{t('还没有会话')}</div>{/if}
  </div>

  <!-- 项目：Claude 侧栏同款（一行 = 当前工作目录，点击换目录——侧栏极简化后目录入口也在这儿） -->
  <div class="d-sec">{tc('claude', '项目')}</div>
  <div class="d-list">
    <div class="d-row proj" title={cwd || ''}>
      <button class="d-recent" onclick={() => { pickOpen = true; closeDrawer(); }}>
        <span class="d-bub"><span class="ic pj" aria-hidden="true">&#xe0c9;</span></span>
        <span class="d-title">{cwd ? (cwd.split(/[\\/]/).filter(Boolean).pop() || cwd) : '—'}</span>
      </button>
    </div>
  </div>

  <div class="d-spacer"></div>
  <div class="d-foot"><AccountCard agent="codex" onpick={closeDrawer} onhome={single ? null : () => { closeDrawer(); exit(); }} /></div>
{/snippet}

{#snippet hero()}
  <div class="cx-hello">
    <span class="cx-hello-mark hero-mark" aria-hidden="true">
      <svg viewBox="0 0 32 32" fill="none"><path d="M22.356 19.797H17.17M9.662 12.29l1.979 3.576a.511.511 0 0 1-.005.504l-1.974 3.409M30.758 16c0 8.15-6.607 14.758-14.758 14.758-8.15 0-14.758-6.607-14.758-14.758C1.242 7.85 7.85 1.242 16 1.242c8.15 0 14.758 6.608 14.758 14.758Z" stroke="currentColor" stroke-linecap="round" stroke-width="2.484"/></svg>
    </span>
    <h1>{greet}</h1>
  </div>
{/snippet}

<style>
  /* 背景/前景 token 挂 .cx-shell：抽屉与遮罩是 .cx-root 的兄弟节点，
     挂在 .cx-root 上它们读不到（背景会整条失效成透明）。display:contents 只提供作用域。 */
  .cx-shell { display: contents; }
  .cx-root {
    position: fixed; inset: 0; display: flex; flex-direction: column; overflow: hidden;
    background: var(--cx-bg); color: var(--text);
  }
  /* 侧栏常驻/侧列档：整页变 row（侧栏左列 + 右侧主体），与 Claude 页 .claude-root.wide 同构。
     medium 档侧栏让位给工作台时 pinned=false，但仍必须保持 row，否则工作台会掉到正文下面。 */
  .cx-root.wide { flex-direction: row; }
  .cx-body { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
  .cx-top { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 8px;
    /* 顶部安全区：手机上这块正落在状态栏 / 刘海底下（viewport-fit=cover，页面铺到屏幕边沿），
       不吃安全区时菜单 / 主题 / 关闭三个按钮被状态栏压住、点不到（ZCode 页同一处同样改）。 */
    padding: calc(var(--sat, 0px) + 8px) 10px 8px; }
  .cx-left, .cx-right { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .cx-mark { display: inline-flex; width: 22px; height: 22px; }
  .cx-mark svg { width: 22px; height: 22px; }
  .cx-word { font-size: 15px; letter-spacing: .02em; font-weight: 500; }
  .cx-chip { font-size: 11px; padding: 3px 8px; border-radius: 999px; white-space: nowrap;
    border: 1px solid color-mix(in srgb, currentColor 18%, transparent); opacity: .7; }
  .cx-chip.ok { opacity: 1; }
  .cx-icon { width: 32px; height: 32px; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; color: inherit; }
  .cx-icon svg { width: 18px; height: 18px; }
  .cx-icon:active { background: color-mix(in srgb, currentColor 12%, transparent); }
  /* 工作台开着时那颗按钮亮着（与侧栏里的 chip 同一语言）；medium 档汉堡亮着＝侧栏已常驻 */
  .cx-icon.on { background: color-mix(in srgb, currentColor 10%, transparent); opacity: 1; }

  /* 独立帧的缝 + 圆角描边只在侧列档成立；手机（窄屏）官方形态是单列，铺满整屏、不描边
     （与 Claude 页的手机形态一致，见 ZcodePage.svelte 里同一处的说明）。 */
  .cx-frames { flex: 1; min-height: 0; display: flex; gap: 4px; padding: 0; }
  .cx-frames.wide { padding: 0 12px 4px; max-width: 1180px; width: 100%; margin: 0 auto; }
  .cx-frame { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
  .cx-frames.wide .cx-frame { border: 1px solid color-mix(in srgb, currentColor 14%, transparent); border-radius: 12px; }
  .conv { flex: 1; min-width: 0; padding: 4px 12px 0; }

  .cx-hello { display: flex; flex-direction: column; align-items: center; gap: 14px; }
  .cx-hello-mark { display: inline-flex; }
  .cx-hello-mark svg { width: 64px; height: 64px; }
  /* 问候保留 Codex 的终端等宽基因（官方 TUI 的识别点），字号对齐 dimensio 空态档 */
  .cx-hello h1 { font-family: var(--mono, ui-monospace, monospace); font-weight: 400; font-size: 22px; line-height: 1.2; text-align: center; letter-spacing: .02em; }

  .cx-scrim { position: fixed; inset: 0; background: rgba(0,0,0,.45); opacity: 0; visibility: hidden;
    transition: opacity .25s ease, visibility .25s; z-index: 40; }
  .cx-scrim.on { opacity: 1; visibility: visible; }
  .cx-drawer { position: fixed; top: 0; left: 0; bottom: 0; width: 80vw; max-width: 320px; z-index: 50;
    display: flex; flex-direction: column; padding: 10px 8px max(10px, var(--sab, 0px));
    padding-top: max(10px, var(--sat, 0px));
    overflow-y: auto; background: var(--cx-bg); border-right: 1px solid color-mix(in srgb, currentColor 14%, transparent);
    transform: translateX(-100%); visibility: hidden;
    transition: transform .26s cubic-bezier(.22,1,.36,1), visibility 0s linear .26s; }
  .cx-drawer.on { transform: none; visibility: visible; box-shadow: 0 0 40px rgba(0,0,0,.35); transition: transform .26s cubic-bezier(.22,1,.36,1), visibility 0s linear 0s; }
  /* 常驻列（照 Claude 页 .drawer.pinned）：钉在 flex row 里当左列，宽度由 style:width 下发 */
  .cx-drawer.pinned {
    position: static; transform: none; visibility: visible; transition: none;
    max-width: none; flex: none; height: auto; box-shadow: none; width: auto;
  }
  .cx-drawer::-webkit-scrollbar { width: 6px; }
  .cx-drawer::-webkit-scrollbar-track { background: transparent; }
  .cx-drawer::-webkit-scrollbar-thumb { background: color-mix(in srgb, currentColor 24%, transparent); border-radius: 999px; }
  /* 侧栏拉动把手（与 Claude 页同款）：12px 隐形条骑缝右缘，3×48 指示条悬停 200ms 延迟浮现 */
  .sb-handle { position: absolute; top: 0; bottom: 0; width: 12px; z-index: 45; cursor: col-resize; outline: none; }
  .sb-pill { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 3px; height: 48px;
    border-radius: 999px; background: currentColor; opacity: 0;
    transition: opacity .2s ease .2s, background-color .2s ease; }
  .sb-handle:hover .sb-pill, .sb-handle.drag .sb-pill { opacity: .5; }
  .sb-handle:focus-visible .sb-pill { opacity: 1; transition-delay: 0s; }
  .cx-brand { display: flex; align-items: center; gap: 8px; height: 44px; padding: 0 10px 2px; flex: none; }
  .d-item { width: 100%; display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 8px;
    font-size: 14px; color: inherit; text-align: left; transition: background-color .12s ease; }
  .d-item:active { background: color-mix(in srgb, currentColor 10%, transparent); }
  .d-lead { width: 22px; height: 20px; flex: none; display: inline-flex; align-items: center; justify-content: center; }
  .d-lead svg { width: 17px; height: 17px; }
  /* 折叠组的 chevron：贴行尾，展开时转 180° */
  .d-sec { font-size: 12px; opacity: .55; padding: 14px 4px 4px 10px; }
  .d-list { display: flex; flex-direction: column; }
  .d-row { position: relative; display: flex; align-items: center; border-radius: 8px; margin-bottom: .5px; }
  .d-row.cur { background: color-mix(in srgb, currentColor 10%, transparent); }
  .d-row.cur .d-title { font-weight: 500; }
  .d-recent { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 8px; padding: 8px 2px 8px 10px;
    border-radius: 8px; text-align: left; font-size: 14px; }
  .d-recent:active { background: color-mix(in srgb, currentColor 8%, transparent); }
  .d-title { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .d-at { flex: none; font-size: 11px; opacity: .55; }
  .d-more { width: 28px; height: 28px; margin-right: 2px; border-radius: 6px; flex: none; display: flex;
    align-items: center; justify-content: center; opacity: .55; }
  .d-more svg { width: 14px; height: 14px; }
  .d-more:active { opacity: 1; background: color-mix(in srgb, currentColor 10%, transparent); }
  .d-empty { font-size: 12.5px; opacity: .55; padding: 2px 10px 6px; }
  /* 项目行（Claude 侧栏同款）：图标用同一份图标字形的盒盖字形 */
  .d-bub { position: relative; width: 20px; height: 20px; flex: none; display: flex; align-items: center; justify-content: center; }
  .d-bub .pj { font-size: 18px; color: var(--serif, currentColor); font-family: var(--icons, inherit); line-height: 1; }
  .d-spacer { flex: 1; min-height: 12px; }
  .d-foot { flex: none; padding-top: 6px; }
</style>
