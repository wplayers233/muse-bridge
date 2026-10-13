<script>
  // Codex 分页。骨架与 ZCode 页同一套（照 Claude 页：窄屏菜单按钮 + 侧拉抽屉 + 大问候空态；
  // 宽屏常驻侧栏），皮照 Codex 官方：近黑底、等宽字体的「盒子」头部，以及官方的圆 + 提示符 mark。
  //
  // 官方 mark 在 public/assets/icons/codex-{dark,light}.svg；这里内联一份给页头与问候处。
  // 命令行走的是服务端 /api/codex/chat（codex exec --json → 归一事件）。
  import { onMount } from 'svelte';
  import CliChat from './cli/CliChat.svelte';
  import CliDock from './dock/CliDock.svelte';
  import CliKeyForm from './cli/CliKeyForm.svelte';
  import AccountCard from './AccountCard.svelte';
  import ProjectPicker from './ProjectPicker.svelte';
  import { cliChat, cliNew, cliPick, cliDrop, cliSessions, cliActiveId, cliStatus, loadCliStatus, statusOf, cwdOf, setCliCwd,
    cliModels, loadCliModels, modelOf, effortOf, setCliModel, syncSessions } from '../lib/cliChat.svelte.js';
  import { cliDock, cliDockOpen, setCliDockWs } from '../lib/cliDock.svelte.js';
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

  let nav = $state(false);
  let wide = $state(false);
  let tab = $state('session');   // 宽屏面板的 tab：'session'（这一轮的实际状态）| 'about'（怎么接上它）
  const sessions = $derived(cliSessions.codex);
  const curId = $derived(cliActiveId('codex'));
  const greet = $derived(me.user ? t('你好，{name}', { name: me.user }) : t('你好'));
  // 这个 agent 自己的工作目录（可换）：状态面的值优先，聊过一轮则退回 meta 带回的。
  const cwd = $derived(cwdOf('codex'));
  let pickOpen = $state(false);

  // —— 模型 / 思考深度（官方桌面应用那颗下拉框的同一条数据）——
  // 清单拿不到（CLI 版本没这条接口 / 没装）就整块不摆：宁可少一个控件，也不摆一个空的下拉框。
  const models = $derived(cliModels.list || []);
  const visibleModels = $derived(models.filter((m) => !m.hidden));
  const curModel = $derived(modelOf('codex'));
  const curEffort = $derived(effortOf('codex'));
  // 思考深度档以【选中的模型】自己报的为准（各模型能给的档不一样）。
  const picked = $derived(visibleModels.find((m) => m.id === curModel) || null);
  const efforts = $derived((picked && picked.efforts.length ? picked.efforts : (visibleModels[0]?.efforts || [])));
  let busyModel = $state(false);

  async function pickModel(id) {
    if (busyModel) return;
    busyModel = true;
    try {
      // 换模型时思考深度跟着回落：新模型未必支持旧的那一档，留着会被 CLI 拒。
      await setCliModel('codex', { model: id, effort: '' });
    } catch (e) {
      showToast(tr(e?.message) || t('换不了这个模型'), 'err');
    }
    busyModel = false;
  }
  async function pickEffort(v) {
    if (busyModel) return;
    busyModel = true;
    try {
      await setCliModel('codex', { model: curModel, effort: v });
    } catch (e) {
      showToast(tr(e?.message) || t('换不了这个思考深度'), 'err');
    }
    busyModel = false;
  }

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
  const dkOpen = $derived(cliDock.codex.open);
  $effect(() => setCliDockWs('codex', cwd));
  onMount(() => {
    loadCliStatus(true);
    // 会话注册表对账：模块加载时跑过一次，这里补一次（换设备/重新登录回到页面要拉最新）。
    syncSessions();
    // 模型清单单独拉（服务端要起一次 app-server 读 model/list，约一秒；那边缓存 10 分钟）。
    loadCliModels();
    const mq = matchMedia('(min-width: 900px)');
    const sync = () => { wide = mq.matches; if (wide) nav = false; };
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  });

  function exit() { if (!single) closePage('codex'); }
  const stateText = $derived(!st || cliStatus.loading ? t('正在读取状态…')
    : st.installed === false ? t('没装命令行工具')
      : st.authed === false ? t('装好了，还没登录')
        : t('已接上'));

  function when(ts) {
    if (!ts) return '';
    const d = new Date(ts); const now = new Date();
    const same = d.toDateString() === now.toDateString();
    const pad = (n) => String(n).padStart(2, '0');
    return same ? pad(d.getHours()) + ':' + pad(d.getMinutes()) : (d.getMonth() + 1) + '/' + d.getDate();
  }
</script>

<div class="cx-shell" style:--cx-bg={bg} style:--agent-accent="#10a37f">
<div class="cx-root">
  <header class="cx-top">
    <div class="cx-left">
      {#if !single}
        <button class="cx-icon" onclick={() => { nav = !nav; }} aria-label={nav ? t('收起侧栏') : t('菜单')} aria-expanded={nav}>
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M3.5 5.5h13M3.5 10h13M3.5 14.5h13"/></svg>
        </button>
      {/if}
      <span class="cx-mark" aria-hidden="true">
        <!-- Codex 官方 mark：圆 + 提示符（与 openai/codex 登录页的 .codex-mark 同几何） -->
        <svg viewBox="0 0 32 32" fill="none"><path d="M22.356 19.797H17.17M9.662 12.29l1.979 3.576a.511.511 0 0 1-.005.504l-1.974 3.409M30.758 16c0 8.15-6.607 14.758-14.758 14.758-8.15 0-14.758-6.607-14.758-14.758C1.242 7.85 7.85 1.242 16 1.242c8.15 0 14.758 6.608 14.758 14.758Z" stroke="currentColor" stroke-linecap="round" stroke-width="2.484"/></svg>
      </span>
      <span class="cx-word">Codex</span>
      {#if wide}<span class="cx-chip" class:ok={!!st && st.installed !== false && st.authed !== false}>{stateText}</span>{/if}
    </div>
    <div class="cx-right">
      {#if wide}
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

  <div class="cx-frames" class:wide>
    <section class="cx-frame conv">
      <CliChat agent="codex"
        placeholder={t('让 Codex 做点什么？')}
        install={st?.install || ''}
        login="codex login"
        docUrl={st?.docs || 'https://github.com/openai/codex'}
        {hero} />
    </section>
    <!-- 工作台：终端 / 审阅 / 文件（作用域＝这个 agent 的工作目录）。宽屏是跟在对话后的
         第二根侧列，窄屏自己铺满整屏（见 CliDock.svelte）。 -->
    <CliDock agent="codex" ws={cwd} {wide} />
    {#if wide}
      <aside class="cx-frame side">
        <div class="cx-tabs" role="tablist">
          <button class="cx-tab" class:on={tab === 'session'} role="tab" aria-selected={tab === 'session'} onclick={() => { tab = 'session'; }}>{t('会话')}</button>
          <button class="cx-tab" class:on={tab === 'about'} role="tab" aria-selected={tab === 'about'} onclick={() => { tab = 'about'; }}>{t('接入')}</button>
        </div>
        <div class="cx-pane">
          {#if tab === 'session'}
            <div class="cx-row"><span class="cx-k">{t('会话')}</span><span class="cx-v mono">{chat.sessionId || t('还没开始')}</span></div>
            <div class="cx-row"><span class="cx-k">{t('目录')}</span><span class="cx-v mono">{cwd || '—'}</span></div>
            {@render modelPicker()}
            <div class="cx-row"><span class="cx-k">{t('状态')}</span><span class="cx-v">{stateText}</span></div>
            {#if st?.note}<div class="cx-note">{tr(st.note)}</div>{/if}
            <div class="cx-actions">
              <button class="cx-btn" onclick={() => { pickOpen = true; }}>{t('更换工作目录')}</button>
              <button class="cx-btn" onclick={() => cliNew('codex')} disabled={chat.busy}>{t('新会话')}</button>
              <button class="cx-btn" onclick={() => loadCliStatus(true)}>{t('重新检测')}</button>
            </div>
            <!-- 我自己的 API key（admin=全局那份；user=自己的，见 /api/cli/agent-key） -->
            <div class="cx-row"><span class="cx-k">{t('凭据')}</span></div>
            <CliKeyForm agent="codex" />
            <!-- 工作台四件套：终端 / 审阅 / 文件 / 任务，都在这个 agent 的工作目录上 -->
            <div class="cx-row"><span class="cx-k">{t('工作台')}</span>
              <span class="cx-v cx-tools">
                <button class="cx-btn" onclick={() => cliDockOpen('codex', 'review')}>{tc('codex', '审阅')}</button>
                <button class="cx-btn" onclick={() => cliDockOpen('codex', 'term')}>{tc('codex', '终端')}</button>
                <button class="cx-btn" onclick={() => cliDockOpen('codex', 'files')}>{tc('codex', '文件')}</button>
                <button class="cx-btn" onclick={() => cliDockOpen('codex', 'tasks')}>{tc('claude', '任务')}</button>
              </span>
            </div>
          {:else}
            <p class="cx-p">{t('这个分页直接跑这台机器上的 codex，用的是它自己的模型配置。')}</p>
            {@render modelPicker()}
            <div class="cx-row"><span class="cx-k">{t('安装')}</span><span class="cx-v mono">{st?.install || '—'}</span></div>
            <div class="cx-row"><span class="cx-k">{t('登录')}</span><span class="cx-v mono">codex login</span></div>
            <a class="cx-btn link" href={st?.docs || 'https://github.com/openai/codex'} target="_blank" rel="noreferrer">{t('官方文档')}</a>
          {/if}
        </div>
      </aside>
    {/if}
  </div>
</div>

<!-- 窄屏抽屉放在 .cx-shell 里：背景 token 挂在 shell 上，抽屉（.cx-root 的兄弟）
     才读得到 --cx-bg——挂在 .cx-root 上时它读不到，背景整条失效成透明。 -->
{#if !wide}
  <button class="cx-scrim" class:on={nav} aria-label={t('关闭侧栏')} onclick={() => { nav = false; }}></button>
  <aside class="cx-drawer {nav ? 'on' : ''}">
    <div class="cx-brand">
      <span class="cx-mark" aria-hidden="true">
        <svg viewBox="0 0 32 32" fill="none"><path d="M22.356 19.797H17.17M9.662 12.29l1.979 3.576a.511.511 0 0 1-.005.504l-1.974 3.409M30.758 16c0 8.15-6.607 14.758-14.758 14.758-8.15 0-14.758-6.607-14.758-14.758C1.242 7.85 7.85 1.242 16 1.242c8.15 0 14.758 6.608 14.758 14.758Z" stroke="currentColor" stroke-linecap="round" stroke-width="2.484"/></svg>
      </span>
      <span class="cx-word">Codex</span>
    </div>

    {#if !single}
      <button class="d-item" onclick={() => { nav = false; exit(); }}>
        <span class="d-lead" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5 10 3.2l6.5 5.3V16a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V8.5Z"/></svg></span>{t('主页')}
      </button>
    {/if}
    <button class="d-item" onclick={() => { cliNew('codex'); nav = false; }}>
      <span class="d-lead" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M10 4.5v11M4.5 10h11"/></svg></span>{t('新会话')}
    </button>
    <button class="d-item" onclick={() => { loadCliStatus(true); }}>
      <span class="d-lead" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 6.5v4M10 13.6h.01"/><circle cx="10" cy="10" r="7"/></svg></span>{t('接入设置')}
    </button>
    <!-- 我自己的 API key（宽屏在右侧「接入」页签里；窄屏在这里） -->
    <div class="d-key"><CliKeyForm agent="codex" /></div>

    <div class="d-sec">{t('会话')}</div>
    <div class="d-list">
      {#each sessions as s (s.id)}
        <div class="d-row" class:cur={s.id === curId}>
          <button class="d-recent" onclick={() => { cliPick('codex', s.id); nav = false; }}>
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

    <div class="d-sec">{t('工作目录')}</div>
    <div class="d-list">
      <div class="d-cwd mono">{cwd || '—'}</div>
      <button class="d-item" onclick={() => { pickOpen = true; nav = false; }}>
        <span class="d-lead" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6.2a1.5 1.5 0 0 1 1.5-1.5h3l1.4 1.7h6.6a1.5 1.5 0 0 1 1.5 1.5v6.4a1.5 1.5 0 0 1-1.5 1.5H4a1.5 1.5 0 0 1-1.5-1.5V6.2Z"/></svg></span>{t('更换工作目录')}
      </button>
    </div>

    {#if visibleModels.length}
      <div class="d-sec">{t('模型')}</div>
      <div class="d-list d-pick">{@render modelPicker()}</div>
    {/if}

    <!-- 窄屏没有侧列：工作台自己铺满整屏（CliDock 的 narrow 形态），入口在这儿。 -->
    <div class="d-sec">{t('工作台')}</div>
    <div class="d-list">
      <button class="d-item" onclick={() => { cliDockOpen('codex', 'review'); nav = false; }}>
        <span class="d-lead" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4.5h12M4 10h12M4 15.5h7"/></svg></span>{t('审阅')}
      </button>
      <button class="d-item" onclick={() => { cliDockOpen('codex', 'term'); nav = false; }}>
        <span class="d-lead" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 6.5l3.5 3.5L5 13.5M11 13.5h4"/></svg></span>{t('终端')}
      </button>
      <button class="d-item" onclick={() => { cliDockOpen('codex', 'files'); nav = false; }}>
        <span class="d-lead" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6.2a1.5 1.5 0 0 1 1.5-1.5h3l1.4 1.7h6.6a1.5 1.5 0 0 1 1.5 1.5v6.4a1.5 1.5 0 0 1-1.5 1.5H4a1.5 1.5 0 0 1-1.5-1.5V6.2Z"/></svg></span>{t('文件')}
      </button>
      <button class="d-item" onclick={() => { cliDockOpen('codex', 'tasks'); nav = false; }}>
        <span class="d-lead" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h12M4 10h12M4 15h8"/><path d="M13.5 13.5l2 2 3-3.5" stroke-width="1.4"/></svg></span>{tc('claude', '任务')}
      </button>
    </div>

    <div class="d-spacer"></div>
    <div class="d-foot"><AccountCard onpick={() => { nav = false; }} onhome={single ? null : () => { nav = false; exit(); }} /></div>
  </aside>
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

{#snippet modelPicker()}
  <!-- 模型 + 思考深度：官方桌面应用那颗下拉框的同一条数据（app-server 的 model/list）。
       清单拿不到就整块不摆——宁可少一个控件，也不摆一个空的下拉框。 -->
  {#if visibleModels.length}
    <div class="cx-row"><span class="cx-k">{t('模型')}</span>
      <span class="cx-v">
        <select class="cx-sel" value={curModel} disabled={busyModel} onchange={(e) => pickModel(e.currentTarget.value)}
          aria-label={t('模型')}>
          <option value="">{t('用 codex 自己的配置')}</option>
          {#each visibleModels as m (m.id)}
            <option value={m.id}>{m.label || m.id}</option>
          {/each}
        </select>
      </span>
    </div>
    {#if curModel && efforts.length}
      <div class="cx-row"><span class="cx-k">{t('思考深度')}</span>
        <span class="cx-v">
          <select class="cx-sel" value={curEffort} disabled={busyModel} onchange={(e) => pickEffort(e.currentTarget.value)}
            aria-label={t('思考深度')}>
            <option value="">{t('默认')}</option>
            {#each efforts as v (v)}
              <option value={v}>{v}</option>
            {/each}
          </select>
        </span>
      </div>
    {/if}
  {/if}
{/snippet}

{#snippet hero()}
  <div class="cx-hello">
    <span class="cx-hello-mark hero-mark" aria-hidden="true">
      <svg viewBox="0 0 32 32" fill="none"><path d="M22.356 19.797H17.17M9.662 12.29l1.979 3.576a.511.511 0 0 1-.005.504l-1.974 3.409M30.758 16c0 8.15-6.607 14.758-14.758 14.758-8.15 0-14.758-6.607-14.758-14.758C1.242 7.85 7.85 1.242 16 1.242c8.15 0 14.758 6.608 14.758 14.758Z" stroke="currentColor" stroke-linecap="round" stroke-width="2.484"/></svg>
    </span>
    <h1>{greet}</h1>
    {#if cwd}<div class="cx-hello-cwd hero-sub">{cwd}</div>{/if}
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
  /* 工作台开着时那颗按钮亮着（与侧栏里的 chip 同一语言） */
  .cx-icon.on { background: color-mix(in srgb, currentColor 10%, transparent); opacity: 1; }

  /* 独立帧的缝 + 圆角描边只在宽屏成立；手机（窄屏）官方形态是单列，铺满整屏、不描边
     （与 Claude 页的手机形态一致，见 ZcodePage.svelte 里同一处的说明）。 */
  .cx-frames { flex: 1; min-height: 0; display: flex; gap: 4px; padding: 0; }
  .cx-frames.wide { padding: 0 12px 4px; max-width: 1180px; width: 100%; margin: 0 auto; }
  .cx-frame { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
  .cx-frames.wide .cx-frame { border: 1px solid color-mix(in srgb, currentColor 14%, transparent); border-radius: 12px; }
  .conv { flex: 1; min-width: 0; padding: 4px 12px 0; }
  .side { width: 264px; flex: none; }
  .cx-tabs { flex: none; display: flex; gap: 2px; padding: 4px; border-bottom: 1px solid color-mix(in srgb, currentColor 12%, transparent); }
  .cx-tab { font-size: 12.5px; padding: 5px 10px; border-radius: 8px; opacity: .6; }
  .cx-tab.on { opacity: 1; background: color-mix(in srgb, currentColor 8%, transparent); }
  .cx-pane { flex: 1; min-height: 0; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
  .cx-row { display: flex; gap: 8px; font-size: 12.5px; line-height: 1.7; font-family: var(--mono, ui-monospace, monospace); }
  .cx-k { width: 46px; flex: none; opacity: .55; }
  .cx-v { min-width: 0; word-break: break-all; }
  .cx-v.mono, .mono { font-family: var(--mono, ui-monospace, monospace); }
  .cx-note { font-size: 12px; opacity: .6; }
  /* 模型 / 思考深度下拉框：跟着侧栏的深色底走（原生 select 在暗色下不自己变），
     所以自己给底色与描边，别让它变成一块白。 */
  .cx-sel { width: 100%; font: inherit; font-size: 12.5px; font-family: var(--mono, ui-monospace, monospace);
    padding: 4px 6px; border-radius: 8px; color: inherit;
    background: color-mix(in srgb, currentColor 8%, transparent);
    border: 1px solid color-mix(in srgb, currentColor 18%, transparent); }
  .cx-sel:disabled { opacity: .5; }
  .cx-sel option { color: #111; background: #fff; }
  .d-pick { padding: 0 10px 2px; }
  .cx-p { font-size: 12.5px; opacity: .6; line-height: 1.65; }
  .cx-actions { display: flex; gap: 8px; margin-top: 2px; }
  .cx-btn { font-size: 12.5px; padding: 6px 12px; border-radius: 10px; border: 1px solid color-mix(in srgb, currentColor 18%, transparent); color: inherit; }
  .cx-btn:disabled { opacity: .45; }
  .cx-btn.link { text-decoration: none; text-align: center; }
  .cx-btn:active { background: color-mix(in srgb, currentColor 10%, transparent); }
  /* 工作台三件套那几个按钮：在「键 值」行里横排，别被 word-break 拆开 */
  .cx-tools { display: flex; gap: 6px; flex-wrap: wrap; }

  .cx-hello { display: flex; flex-direction: column; align-items: center; gap: 14px; }
  .cx-hello-mark { display: inline-flex; }
  .cx-hello-mark svg { width: 64px; height: 64px; }
  /* 问候保留 Codex 的终端等宽基因（官方 TUI 的识别点），字号对齐 dimensio 空态档 */
  .cx-hello h1 { font-family: var(--mono, ui-monospace, monospace); font-weight: 400; font-size: 22px; line-height: 1.2; text-align: center; letter-spacing: .02em; }
  .cx-hello-cwd { font-size: 11.5px; opacity: .55; word-break: break-all; text-align: center; }

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
  .cx-drawer::-webkit-scrollbar { width: 6px; }
  .cx-drawer::-webkit-scrollbar-track { background: transparent; }
  .cx-drawer::-webkit-scrollbar-thumb { background: color-mix(in srgb, currentColor 24%, transparent); border-radius: 999px; }
  .cx-brand { display: flex; align-items: center; gap: 8px; height: 44px; padding: 0 10px 2px; flex: none; }
  .d-item { width: 100%; display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 8px;
    font-size: 14px; color: inherit; text-align: left; transition: background-color .12s ease; }
  .d-item:active { background: color-mix(in srgb, currentColor 10%, transparent); }
  .d-lead { width: 22px; height: 20px; flex: none; display: inline-flex; align-items: center; justify-content: center; }
  .d-lead svg { width: 17px; height: 17px; }
  .d-sec { font-size: 12px; opacity: .55; padding: 14px 4px 4px 10px; }
  .d-key { padding: 10px 10px 4px; border-top: 1px solid color-mix(in srgb, currentColor 12%, transparent); margin-top: 10px; }
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
  .d-cwd { font-size: 11.5px; opacity: .55; padding: 2px 10px 4px; word-break: break-all; }
  .d-spacer { flex: 1; min-height: 12px; }
  .d-foot { flex: none; padding-top: 6px; }
</style>
