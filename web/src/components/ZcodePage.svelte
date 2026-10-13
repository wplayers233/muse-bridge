<script>
  // ZCode 分页。侧栏完全照 Claude 页同一套骨架（与 Codex 页同构）：三档形态
  // （compact 抽屉 / medium 可点常驻 / expanded 恒常驻）、左侧常驻列 200–420 可拖宽、
  // 菜单行 + 会话列表 + 底部账户卡；
  // 皮照 ZCode 官方设计语言（zai-org/ZCode 的 DESIGN.md）：
  //   · 配色用官方品牌 token：深色 Zai Dark #161616 / 浅色 Zai Light #f8f8f8，正文纯白/纯黑；
  //   · 宽屏「独立帧」布局：对话帧 + 工作台侧列，帧之间 4px 缝、圆角；
  //   · 输入壳圆角 2xl、气泡 xl；工具/命令/路径等宽；分层靠背景对比与描边，不靠阴影。
  // 官方 DESIGN.md §563 也写明：窄屏（手机远控）就是**单列 + 抽屉**，所以窄屏这套不是折中，是官方形态。
  //
  // 官方 Z 标（三段的 Z）内联在页头与问候处；图标文件在 public/assets/icons/zcode-{dark,light}.svg。
  // 命令行走 /api/zcode/chat（zcode --output-format stream-json --prompt …）。
  import { onMount, untrack } from 'svelte';
  import CliChat from './cli/CliChat.svelte';
  import CliDock from './dock/CliDock.svelte';
  import AccountCard from './AccountCard.svelte';
  import ProjectPicker from './ProjectPicker.svelte';
  import { cliChat, cliNew, cliPick, cliDrop, cliSessions, cliActiveId, cliStatus, loadCliStatus, statusOf, cwdOf, setCliCwd, syncSessions } from '../lib/cliChat.svelte.js';
  import { cliDock, cliDockOpen, cliDockClose, setCliDockWs } from '../lib/cliDock.svelte.js';
  import { layout, makeSideYield } from '../lib/layout.svelte.js';
  import { createSidebarWidth } from '../lib/sbWidth.svelte.js';
  import { ui, rootScreen, toggleTheme, me } from '../lib/state.svelte.js';
  import { closePage } from '../lib/pageMorph.js';
  import { showToast } from '../lib/toast.svelte.js';
  import { t, tr, tc } from '../lib/i18n.js';

  const single = $derived(rootScreen() === 'zcode');
  const chat = $derived(cliChat.zcode);
  const st = $derived(statusOf('zcode'));
  const dark = $derived(ui.theme !== 'light');
  // 跟 Claude 页同一套全局配色（app.css 的 --bg token）：不再走 Z.ai 的定制底。
  const bg = $derived(dark ? '#1f1f1e' : '#f8f8f6');

  const sessions = $derived(cliSessions.zcode);
  const curId = $derived(cliActiveId('zcode'));
  const greet = $derived(me.user ? t('你好，{name}', { name: me.user }) : t('你好'));
  // 这个 agent 自己的工作目录（可换）：状态面的值优先，聊过一轮则退回 meta 带回的。
  const cwd = $derived(cwdOf('zcode'));
  let pickOpen = $state(false);

  // —— 三档形态（断点单源 lib/layout.svelte.js，与 Claude / Codex 页同一套）——
  //   expanded ≥1100：侧栏恒常驻左列
  //   medium 700–1099：侧栏可点汉堡常驻；工作台一开自动让位、关掉回来（makeSideYield）
  //   compact <700：侧栏=抽屉（ui.drawerOpen 全局开关，与 Claude / Codex 页同一颗）
  const wide = $derived(layout.expanded);          // 侧栏【恒】常驻
  const sideMode = $derived(layout.side);          // 工作台走侧列（而非底部 sheet）
  const PIN_LS = 'bridge-zcode-sidepin';
  let sidePinned = $state((() => { try { return localStorage.getItem(PIN_LS) === '1'; } catch { return false; } })());
  const setPinned = (v) => { sidePinned = v; try { localStorage.setItem(PIN_LS, v ? '1' : '0'); } catch {} };
  const yielder = makeSideYield(() => sidePinned, (v) => { sidePinned = v; });   // 让位不写盘
  const pinned = $derived(layout.expanded || (layout.medium && sidePinned));
  $effect(() => { if (layout.side) ui.drawerOpen = false; });
  // 工作台开合 → medium 档让位/还原（untrack：apply 读写 sidePinned，别让 effect 依赖它）。
  const dkOpen = $derived(cliDock.zcode.open);
  $effect(() => { const open = dkOpen; untrack(() => yielder.apply(open)); });
  // 离开本页（keep-alive 换页）把抽屉收掉：ui.drawerOpen 是与 Claude / Codex 页共享的全局开关。
  $effect(() => { if (ui.screen !== 'zcode') ui.drawerOpen = false; });
  // —— 桌面侧栏拉动（与 Claude 页同规格）：200–420 钳制、拖拽跟手、键盘可调、localStorage 持久。 ——
  const sb = createSidebarWidth('bridge-zcode-sbw');
  const SB_MIN = sb.SB_MIN, SB_MAX = sb.SB_MAX;
  const sbW = $derived(sb.sbW);
  const sbDrag = $derived(sb.sbDrag);

  // 换工作目录入口在侧栏「项目」行——接入设置折叠组已从侧栏移除（极简化）。

  // 工作台（终端/审阅/文件）的作用域＝这个 agent 的工作目录。换目录时 meta 要重取、
  // 文件卡的定位要清掉（setCliDockWs 内部处理；面板经 {#key ws} 整体重挂）。
  $effect(() => setCliDockWs('zcode', cwd));

  // 选完目录（或取消）：ProjectPicker 给的绝对路径交给服务端存，成功就地更新显示。
  async function pickedDir(dir) {
    pickOpen = false;
    if (!dir) return;
    try {
      const now = await setCliCwd('zcode', dir);
      showToast(t('工作目录已换成 {dir}', { dir: now }));
    } catch (e) {
      showToast(tr(e?.body?.error || e?.message) || t('换不了这个目录'), 'err');
    }
  }

  $effect(() => {
    ui.pageChrome = { dark, bg };
    return () => { ui.pageChrome = null; };
  });
  onMount(() => {
    loadCliStatus(true);
    syncSessions();   // 会话注册表对账（模块加载时跑过一次，回页面补一次）
  });

  function exit() { if (!single) closePage('zcode'); }
  const stateText = $derived(!st || cliStatus.loading ? t('正在读取状态…')
    : st.installed === false ? t('没装命令行工具')
      : st.authed === false ? t('装好了，还没登录')
        : t('已接上'));

  // 汉堡键（语义与 Claude / Codex 页 onMenuKey 同一档）：compact 拉抽屉；medium 切「侧栏常驻」
  // （工作台开着时手动点＝我就要侧栏，让位记账作废、并把工作台收掉腾地方）。
  function onMenuKey() {
    if (layout.compact) { ui.drawerOpen = true; return; }
    const next = !sidePinned;
    setPinned(next);
    yielder.forget();
    if (next && cliDock.zcode.open) cliDockClose('zcode');
  }
  const closeDrawer = () => { ui.drawerOpen = false; };

  // 会话列表的时间戳：今天只给时分，更早给月日。
  function when(ts) {
    if (!ts) return '';
    const d = new Date(ts); const now = new Date();
    const same = d.toDateString() === now.toDateString();
    const pad = (n) => String(n).padStart(2, '0');
    return same ? pad(d.getHours()) + ':' + pad(d.getMinutes()) : (d.getMonth() + 1) + '/' + d.getDate();
  }
</script>

<div class="zc-shell" style:--zc-bg={bg} style:--agent-accent="#5B6CFF">
  <div class="zc-root" class:wide={pinned || sideMode}>

{#if pinned}
  <aside class="zc-drawer pinned" style:width={sbW + 'px'}>{@render drawerBody()}</aside>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex a11y_no_noninteractive_element_interactions -->
  <div class="sb-handle" class:drag={sbDrag} style:left={(sbW - 6) + 'px'} role="separator"
    aria-orientation="vertical" aria-label={t('调整侧栏宽度')} aria-valuenow={sbW} aria-valuemin={SB_MIN} aria-valuemax={SB_MAX}
    tabindex="0" onpointerdown={sb.sbDown} onkeydown={sb.sbKey}><span class="sb-pill"></span></div>
{/if}

<div class="zc-body">
  <header class="zc-top">
    <div class="zc-left">
      {#if !single}
        <button class="zc-ic" class:on={pinned && !wide} onclick={onMenuKey} aria-label={t('菜单')}
          aria-expanded={layout.compact ? ui.drawerOpen : pinned}>
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M3.5 5.5h13M3.5 10h13M3.5 14.5h13"/></svg>
        </button>
      {/if}
      <span class="zc-word">ZCode</span>
      {#if sideMode}<span class="zc-chip" class:ok={!!st && st.installed !== false && st.authed !== false}>{stateText}</span>{/if}
    </div>
    <div class="zc-right">
      {#if sideMode}
        <button class="zc-ic" class:on={dkOpen} onclick={() => cliDockOpen('zcode', 'review')}
          aria-label={t('工作台')} aria-pressed={dkOpen} title={t('审阅 / 终端 / 文件')}>
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="3.5" width="15" height="13" rx="2"/><path d="M12.5 3.5v13"/></svg>
        </button>
      {/if}
      <button class="zc-ic" onclick={toggleTheme} aria-label={t('切换明暗主题')}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
      </button>
      {#if !single}<button class="zc-ic" onclick={exit} aria-label={t('关闭')}><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 5l10 10M15 5L5 15"/></svg></button>{/if}
    </div>
  </header>

  <!-- 侧列档：独立帧（对话帧 + 工作台侧列，4px 缝）；窄屏只留对话帧 -->
  <div class="zc-frames" class:wide={sideMode}>
    <section class="zc-frame conv">
      <CliChat agent="zcode"
        placeholder={t('问 ZCode 做点什么？')}
        install={st?.install || ''}
        login="zcode login"
        docUrl={st?.docs || 'https://github.com/zai-org/ZCode'}
        {hero} />
    </section>
    <!-- 工作台：终端 / 审阅 / 文件（作用域＝这个 agent 的工作目录）。 -->
    <CliDock agent="zcode" ws={cwd} wide={sideMode} />
  </div>
</div>
  </div>

<!-- 窄屏：侧拉抽屉。
     放在 .zc-shell 里：背景 token（--zc-bg / --zc-fg）挂在 shell 上，
     抽屉作为 .zc-root 的兄弟才拿得到——挂在 .zc-root 上时抽屉这一层读不到，
     color-mix 整条失效，背景回落成透明（截图里能直接看穿到后面的对话）。 -->
{#if !wide}
  <button class="zc-scrim" class:on={ui.drawerOpen} aria-label={t('关闭侧栏')} onclick={closeDrawer}></button>
  <aside class="zc-drawer {ui.drawerOpen ? 'on' : ''}">{@render drawerBody()}</aside>
{/if}
</div>

<!-- 换工作目录：与 Claude「新建项目」、dimensio「默认工作空间」同一个选择器
     （工作空间文件管理器本体，长按文件夹拖进底栏＝选它）。授权尺在服务端。 -->
{#if pickOpen}
  <ProjectPicker
    title={t('选择工作目录')}
    hint={t('把文件夹拖进底栏，它就是 ZCode 的工作目录')}
    preferPath={cwd}
    onPick={pickedDir}
    onClose={() => (pickOpen = false)} />
{/if}

{#snippet drawerBody()}
  <!-- 品牌行：不用 Z 标，「ZCode」用 Claude 字标的衬线字体（Anthropic Serif 栈） -->
  <div class="zc-brand"><span class="zc-word">ZCode</span></div>

  {#if !single}
    <button class="d-item" onclick={() => { closeDrawer(); exit(); }}>
      <span class="d-lead" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5 10 3.2l6.5 5.3V16a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V8.5Z"/></svg></span>{t('主页')}
    </button>
  {/if}
  <button class="d-item" onclick={() => { cliNew('zcode'); closeDrawer(); }}>
    <span class="d-lead" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M10 4.5v11M4.5 10h11"/></svg></span>{t('新会话')}
  </button>
  <!-- 接入设置 / 工作台两组已从侧栏移除（对齐 Claude 的极简结构）：
       状态看页头 chip 与空态引导，工作台入口在页头的工作台按钮，换工作目录在下方「项目」行。 -->

  <div class="d-sec">{t('会话')}</div>
  <div class="d-list">
    {#each sessions as s (s.id)}
      <div class="d-row" class:cur={s.id === curId}>
        <button class="d-recent" onclick={() => { cliPick('zcode', s.id); closeDrawer(); }}>
          <span class="d-title">{s.title || t('新会话')}</span>
          <span class="d-at">{when(s.at)}</span>
        </button>
        <button class="d-more" aria-label={t('删除')} onclick={() => cliDrop('zcode', s.id)}>
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M5.5 5.5l9 9M14.5 5.5l-9 9"/></svg>
        </button>
      </div>
    {/each}
    {#if !sessions.length}<div class="d-empty">{t('还没有会话')}</div>{/if}
  </div>

  <!-- 项目：Claude 侧栏同款（一行 = 当前工作目录，点击换目录） -->
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
  <div class="d-foot"><AccountCard agent="zcode" onpick={closeDrawer} onhome={single ? null : () => { closeDrawer(); exit(); }} /></div>
{/snippet}

{#snippet hero()}
  <div class="zc-hello">
    <span class="zc-hello-mark hero-mark" aria-hidden="true">
      <svg viewBox="0 0 256 218" fill="currentColor"><path d="M249.6 0.13L116.48 25.6022C113.665 29.5699 109.054 32.0019 104.064 32.0019H6.3999V0H249.6Z"/><path d="M249.6 0.13L102.401 217.732H0L153.599 0.13H249.6Z"/><path d="M121.601 217.732L139.65 192.134C142.465 188.166 147.076 185.734 152.067 185.734H249.604V217.736H121.601V217.732Z"/></svg>
    </span>
    <h1>{greet}</h1>
  </div>
{/snippet}

<style>
  /* 官方品牌 token：Zai Dark #161616 / Zai Light #f8f8f8，正文纯白 / 纯黑。
     这一页的字色/描边/浅底都从 --zc-fg 派生，明暗切换只翻这一个值。
     token 挂在 .zc-shell（而不是 .zc-root）上：抽屉与遮罩是 .zc-root 的兄弟节点，
     挂在里面它们读不到，抽屉背景会整条失效成透明。shell 用 display:contents 只是
     提供作用域（不生成盒子，position:fixed 的 root 与抽屉照旧相对视口定位）。 */
  .zc-shell { display: contents; --zc-fg: #FFFFFF;
    --text: var(--zc-fg);
    --line: color-mix(in srgb, var(--zc-fg) 14%, transparent);
    --card: color-mix(in srgb, var(--zc-fg) 6%, transparent);
    --faint: color-mix(in srgb, var(--zc-fg) 55%, transparent);
  }
  .zc-root { position: fixed; inset: 0; display: flex; flex-direction: column; overflow: hidden;
    background: var(--zc-bg); color: var(--zc-fg);
  }
  /* 侧栏常驻/侧列档：整页变 row（侧栏左列 + 右侧主体），与 Claude 页 .claude-root.wide 同构。
     medium 档侧栏让位给工作台时 pinned=false，但仍必须保持 row，否则工作台会掉到正文下面。 */
  .zc-root.wide { flex-direction: row; }
  .zc-body { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
  :global(html[data-theme="light"]) .zc-shell { --zc-fg: #000000; }
  .zc-top { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 8px;
    /* 顶部安全区：手机上这块正落在状态栏 / 刘海底下（viewport-fit=cover，页面铺到屏幕边沿）。
       原来没吃安全区，菜单 / 主题 / 关闭三个按钮被状态栏压住、点不到；App 里其它页都把安全区算进
       顶部内边距（TopBar 的 calc(var(--sat) + 10px)、抽屉的 max(10px, var(--sat))），这里照同一套。 */
    padding: calc(var(--sat, 0px) + 8px) 10px 8px; }
  .zc-left, .zc-right { display: flex; align-items: center; gap: 8px; min-width: 0; }
  /* 品牌字用 Claude 字标同款衬线字体栈（Anthropic Serif），不带 Z 标 */
  .zc-word { font-family: var(--serif-stack, Georgia, serif); font-size: 16px; font-weight: 500; letter-spacing: .01em; }
  .zc-chip { font-size: 11px; padding: 3px 8px; border-radius: 999px; border: 1px solid var(--line); color: var(--faint); white-space: nowrap; }
  .zc-chip.ok { color: inherit; border-color: color-mix(in srgb, currentColor 30%, transparent); }
  .zc-ic { width: 32px; height: 32px; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; color: inherit; }
  .zc-ic svg { width: 18px; height: 18px; }
  .zc-ic:active { background: var(--card); }
  /* medium 档汉堡亮着＝侧栏已常驻；工作台开着时顶上那颗按钮亮着 */
  .zc-ic.on { background: color-mix(in srgb, currentColor 10%, transparent); opacity: 1; }

  /* 独立帧的 4px 缝 + 圆角描边（DESIGN.md 的 resizable gaps）——只在侧列档成立。
     手机（窄屏）这一档官方形态本来就是单列：四周不留缝、不描边，对话铺满整屏，
     与 Claude 页的手机形态一致。窄屏留着这道描边时，底下那圈框线正好顶在输入框与屏幕边之间，
     看起来就是一条悬空的线（输入框上方 12px + 安全区、下方 4px 框线 + 4px 边距，两层留白不齐）。 */
  .zc-frames { flex: 1; min-height: 0; display: flex; gap: 4px; padding: 0; }
  .zc-frames.wide { padding: 0 4px 4px; }
  .zc-frame { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
  .zc-frames.wide .zc-frame { border: 1px solid var(--line); border-radius: 12px; }
  .conv { flex: 1; min-width: 0; padding: 4px 12px 0; }

  /* —— 空态问候（照 Claude 页的 .greeting：图标 + 一行大字）—— */
  .zc-hello { display: flex; flex-direction: column; align-items: center; gap: 14px; }
  .zc-hello-mark { display: inline-flex; }
  .zc-hello-mark svg { width: 64px; height: 64px; }
  /* 问候照 dimensio 用展示衬线 */
  .zc-hello h1 { font-family: var(--serif-stack, Georgia, serif); font-size: 24px; font-weight: 400; letter-spacing: .01em; line-height: 1.2; text-align: center; }

  /* —— 抽屉（骨架照 Claude 页；配色走 ZCode 自己的 token）—— */
  .zc-scrim { position: fixed; inset: 0; background: rgba(0,0,0,.45); opacity: 0; visibility: hidden;
    transition: opacity .25s ease, visibility .25s; z-index: 40; }
  .zc-scrim.on { opacity: 1; visibility: visible; }
  .zc-drawer { position: fixed; top: 0; left: 0; bottom: 0; width: 80vw; max-width: 320px; z-index: 50;
    display: flex; flex-direction: column; padding: 10px 8px max(10px, var(--sab, 0px));
    padding-top: max(10px, var(--sat, 0px));
    overflow-y: auto; background: color-mix(in srgb, var(--zc-fg) 4%, var(--zc-bg));
    border-right: 1px solid color-mix(in srgb, var(--zc-fg) 12%, transparent);
    transform: translateX(-100%); visibility: hidden;
    transition: transform .26s cubic-bezier(.22,1,.36,1), visibility 0s linear .26s; }
  .zc-drawer.on { transform: none; visibility: visible; box-shadow: 0 0 40px rgba(0,0,0,.35); transition: transform .26s cubic-bezier(.22,1,.36,1), visibility 0s linear 0s; }
  /* 常驻列（照 Claude 页 .drawer.pinned）：钉在 flex row 里当左列，宽度由 style:width 下发 */
  .zc-drawer.pinned {
    position: static; transform: none; visibility: visible; transition: none;
    max-width: none; flex: none; height: auto; box-shadow: none; width: auto;
  }
  /* 细滚条（同 Claude 页：只用 webkit 私有伪元素，别设标准属性） */
  .zc-drawer::-webkit-scrollbar { width: 6px; }
  .zc-drawer::-webkit-scrollbar-track { background: transparent; }
  .zc-drawer::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--zc-fg) 24%, transparent); border-radius: 999px; }
  /* 侧栏拉动把手（与 Claude 页同款）：12px 隐形条骑缝右缘，3×48 指示条悬停 200ms 延迟浮现 */
  .sb-handle { position: absolute; top: 0; bottom: 0; width: 12px; z-index: 45; cursor: col-resize; outline: none; }
  .sb-pill { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 3px; height: 48px;
    border-radius: 999px; background: var(--zc-fg); opacity: 0;
    transition: opacity .2s ease .2s, background-color .2s ease; }
  .sb-handle:hover .sb-pill, .sb-handle.drag .sb-pill { opacity: .5; }
  .sb-handle:focus-visible .sb-pill { opacity: 1; transition-delay: 0s; }
  .zc-brand { display: flex; align-items: center; gap: 8px; height: 44px; padding: 0 10px 2px; flex: none; }
  .d-item { width: 100%; display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 8px; font-size: 14px; color: inherit; text-align: left; transition: background-color .12s ease; }
  .d-item:active { background: var(--card); }
  .d-lead { width: 22px; height: 20px; flex: none; display: inline-flex; align-items: center; justify-content: center; }
  .d-lead svg { width: 17px; height: 17px; }
  .d-bub { position: relative; width: 20px; height: 20px; flex: none; display: flex; align-items: center; justify-content: center; }
  .d-bub .pj { font-size: 18px; color: var(--serif, currentColor); font-family: var(--icons, inherit); line-height: 1; }
  .d-sec { color: var(--faint); font-size: 12px; padding: 14px 4px 4px 10px; }
  .d-list { display: flex; flex-direction: column; }
  .d-row { position: relative; display: flex; align-items: center; border-radius: 8px; margin-bottom: .5px; }
  .d-row.cur { background: color-mix(in srgb, var(--zc-fg) 8%, transparent); }
  .d-row.cur .d-title { font-weight: 500; }
  .d-recent { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 8px; padding: 8px 2px 8px 10px; border-radius: 8px; text-align: left; font-size: 14px; }
  .d-recent:active { background: var(--card); }
  .d-title { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .d-at { flex: none; font-size: 11px; color: var(--faint); }
  .d-more { width: 28px; height: 28px; margin-right: 2px; border-radius: 6px; flex: none; display: flex; align-items: center; justify-content: center; color: var(--faint); }
  .d-more svg { width: 14px; height: 14px; }
  .d-more:active { color: inherit; background: var(--card); }
  .d-empty { font-size: 12.5px; color: var(--faint); padding: 2px 10px 6px; }
  .d-spacer { flex: 1; min-height: 12px; }
  .d-foot { flex: none; padding-top: 6px; }
</style>
