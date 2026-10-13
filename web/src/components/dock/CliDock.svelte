<script>
  // Codex / ZCode 分页右侧的工作台：终端 / 审阅 / 文件三张卡。
  //
  // 【为什么是这个薄宿主，而不是直接复用 ClaudeDock】
  // ClaudeDock 绑的是 lib/dock.svelte.js 那份单例状态，而 ClaudePage 常驻挂载、会持续把那份
  // 状态的工作空间写回 Claude 的目录（见 lib/cliDock.svelte.js 开头的说明）。这里只借它那三个
  // 【本来就按 props 参数化】的面板：它们只读 dockState.ws，其余数据自己按 ws 去取。
  //
  // 布局照 Claude 工作台在 medium 档的形态（那一档也是「一根侧列」）：顶上一条工具切换（chip），
  // 下面按开着的卡竖着叠。窄屏没有侧列可用 → 铺满整屏的浮层，chip 仍是那一条。
  //
  // 作用域＝这个 agent 的工作目录（分页里的「工作目录」，见服务端 runtime/cli-cwd.mjs）。
  import ReviewPanel from './ReviewPanel.svelte';
  import TermPanel from './TermPanel.svelte';
  import CliTasksPanel from './CliTasksPanel.svelte';
  import WorkspaceEmbed from './WorkspaceEmbed.svelte';
  import MediaViewer from '../preview/MediaViewer.svelte';
  import { ui } from '../../lib/state.svelte.js';
  import { preview, closePreview } from '../../lib/preview.svelte.js';
  import { cliDock, cliDockCloseView, cliDockOpen, ensureCliDockMeta } from '../../lib/cliDock.svelte.js';
  import { showToast } from '../../lib/toast.svelte.js';
  import { t, tc } from '../../lib/i18n.js';

  let { agent, ws = '', wide = false } = $props();

  const st = $derived(cliDock[agent]);
  // 门禁：终端要身份有 shell（服务端 dock/meta 的 shell 位）；审阅与文件人人可用。
  const shellOk = $derived(!st.meta || st.meta.shell !== false);
  const all = ['review', 'term', 'files', 'tasks'];
  const tools = $derived(all.filter((k) => k !== 'term' || shellOk));
  // 标签走 tc：两家各有自己的说法（codex::文件 / zcode::文件 都是 "Files"，
  // 而「文件」在别处是单数 "File"——见 i18n/en/dock-codex-agy.js）。
  const LABEL = $derived({ review: tc(agent, '审阅'), term: tc(agent, '终端'), files: tc(agent, '文件'), tasks: tc('claude', '任务') });

  // 面板拿的 state：三个面板只读 `ws` 这一个字段（其余自己按 ws 去取）。
  const dockState = $derived({ ws });

  // 展开时取一次元信息（能不能开终端、在不在文件根里、是什么分支）。
  $effect(() => { if (st.open && ws) ensureCliDockMeta(agent, ws); });

  // —— 文件卡：把真·工作空间页挂进来（电脑走 FilesDesktop、手机走 FilesPanel，二选一收在
  //    WorkspaceEmbed 里）。挂载策略与 Claude 工作台同一套：
  //      工作空间在身份文件根之外（admin 常见）→ 以工作空间本身为根挂载（ws 作用域）；
  //      在文件根之内 → 预置 ui.filesPath（相对路径），走 FilesPanel 的一次性初始路径。
  //    ws 变化经 {#key} 整体重挂。
  let filesMount = $state(null);
  const filesShown = $derived(st.views.includes('files'));
  $effect(() => {
    if (!(filesShown && st.meta && ws)) { filesMount = null; return; }
    if (st.meta.rel == null) {
      filesMount = st.meta.shell !== false ? { key: 'wsroot', ws, rel: '' } : null;
      return;
    }
    ui.filesPath = st.meta.rel;
    filesMount = { key: 'ws', ws: '', rel: null };
  });
  const filesRootName = $derived(filesMount?.ws ? (filesMount.ws.split(/[\\/]/).filter(Boolean).pop() || '') : '');
  // 文件卡卸载时若里面正开着预览，一并收掉——否则 preview.host 指着没有实例在渲染的宿主。
  $effect(() => {
    if (!filesMount) return;
    return () => { if (preview.open && preview.host === 'dock') closePreview(); };
  });

  // 开一张卡：没装（或没权限）的工具点了给一句说明，而不是静默什么都不发生。
  function pick(key) {
    if (!tools.includes(key)) { showToast(t('这个分页现在用不了它'), 'err'); return; }
    cliDockOpen(agent, key);
  }
</script>

{#if st.open}
  <aside class="cd" class:wide class:narrow={!wide} aria-label={t('工作台')}>
    <div class="cd-top">
      {#each tools as k (k)}
        <button class="cd-chip" class:on={st.views.includes(k)} onclick={() => pick(k)}>{LABEL[k]}</button>
      {/each}
      <span class="cd-spacer"></span>
      <button class="cd-x" aria-label={t('关闭工作台')} onclick={() => cliDockCloseView(agent, st.view)} title={t('关闭工作台')}>
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5.5 5.5l9 9M14.5 5.5l-9 9"/></svg>
      </button>
    </div>
    <div class="cd-cards">
      {#each st.views as view (view)}
        <section class="cd-card">
          <header class="cd-head">
            <span class="cd-title">{LABEL[view]}</span>
            <button class="cd-cbtn" aria-label={t('关闭')} title={t('关闭')} onclick={() => cliDockCloseView(agent, view)}>
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M5.5 5.5l9 9M14.5 5.5l-9 9"/></svg>
            </button>
          </header>
          {#if !ws}
            <div class="cd-wait">{t('工作空间加载中…')}</div>
          {:else}
            {#key ws}
              {#if view === 'review'}
                <ReviewPanel {dockState} />
              {:else if view === 'term'}
                <TermPanel {dockState} />
              {:else if view === 'files'}
                {#if filesMount}
                  {#key filesMount.key}
                    <div class="cd-embed">
                      <WorkspaceEmbed {wide} ws={filesMount.ws} home={ws} rootName={filesRootName} initialPath={filesMount.rel}
                        onExit={() => cliDockCloseView(agent, 'files')} />
                      <MediaViewer host="dock" />
                    </div>
                  {/key}
                {:else if st.meta && st.meta.rel == null}
                  <div class="cd-wait">{t('该工作空间在云端文件区之外，无法在侧栏打开工作空间页')}</div>
                {:else}
                  <div class="cd-wait">{t('工作空间加载中…')}</div>
                {/if}
              {:else if view === 'tasks'}
                <CliTasksPanel {agent} />
              {/if}
            {/key}
          {/if}
        </section>
      {/each}
    </div>
  </aside>
{/if}

<style>
  /* 宽屏：这一格的第二根侧列（.cx-frames 是 flex 行，跟在对话那一栏后面）。
     窄屏：铺满整屏的浮层（手机上侧列摆不下）。 */
  .cd { flex: none; width: clamp(320px, 42%, 620px); min-width: 300px; display: flex; flex-direction: column;
    min-height: 0; overflow: hidden; background: var(--cx-bg, inherit); }
  .cd.wide { border: 1px solid color-mix(in srgb, currentColor 14%, transparent); border-radius: 12px; }
  .cd.narrow { position: fixed; inset: 0; z-index: 45; width: auto; min-width: 0;
    padding: calc(var(--sat, 0px) + 8px) 8px max(8px, var(--sab, 0px)); }
  .cd-top { flex: none; display: flex; align-items: center; gap: 4px; padding: 6px; border-bottom: 1px solid color-mix(in srgb, currentColor 12%, transparent); }
  .cd-chip { font-size: 12.5px; padding: 5px 10px; border-radius: 8px; opacity: .6; color: inherit; }
  .cd-chip.on { opacity: 1; background: color-mix(in srgb, currentColor 8%, transparent); }
  .cd-chip:active { background: color-mix(in srgb, currentColor 12%, transparent); }
  .cd-spacer { flex: 1; }
  .cd-x, .cd-cbtn { width: 28px; height: 28px; border-radius: 7px; display: inline-flex; align-items: center; justify-content: center; color: inherit; opacity: .6; }
  .cd-x svg, .cd-cbtn svg { width: 15px; height: 15px; }
  .cd-x:active, .cd-cbtn:active { opacity: 1; background: color-mix(in srgb, currentColor 10%, transparent); }
  /* 卡片竖着叠：开几张分几份（窄屏一张就是全部）。 */
  .cd-cards { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 8px; padding: 8px; }
  .cd-card { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden;
    border: 1px solid color-mix(in srgb, currentColor 12%, transparent); border-radius: 10px; }
  .cd-head { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 4px 4px 4px 10px; }
  .cd-title { font-size: 12.5px; opacity: .7; }
  .cd-wait { padding: 14px 10px; font-size: 12.5px; opacity: .55; }
  /* 内嵌的工作空间页自带工具栏，撑满这张卡剩下的地方。 */
  .cd-embed { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
</style>
