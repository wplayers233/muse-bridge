<script>
  // 输入卡右下角的模型胶囊 + 一体浮层（照官方 PC 端 composer：模型名 + ⌄，点开浮层选模型，
  // 换了带思考深度档的模型再进二级视图选档——同一张浮层里翻页，不是两颗下拉框）。
  // 数据直接走 lib/cliChat 的模块级状态（cliModels/modelOf/effortOf/setCliModel），
  // 选完即生效，无需向 CliChat 上抛事件。
  // 清单拿不到（CLI 版本没这条接口 / 没装）时整个组件不渲染：宁可少一颗胶囊，也不摆空的下拉。
  import { cliModels, modelOf, effortOf, setCliModel } from '../../lib/cliChat.svelte.js';
  import { showToast } from '../../lib/toast.svelte.js';
  import { t, tr } from '../../lib/i18n.js';

  let { agent = 'codex', disabled = false } = $props();

  let open = $state(false);
  let view = $state('models');   // 'models' | 'effort'
  let busy = $state(false);
  let dir = $state('up');
  let pillBtn = $state(null);

  const list = $derived(cliModels.list || []);
  const visible = $derived(list.filter((m) => !m.hidden));
  const curModel = $derived(modelOf(agent));
  const curEffort = $derived(effortOf(agent));
  const picked = $derived(visible.find((m) => m.id === curModel) || null);
  // 胶囊上显示当前模型；没挑过（走 CLI 自己的配置）就显示「默认」。
  const pillLabel = $derived(curModel ? (picked?.label || curModel) : t('默认'));
  // 思考深度档以【选中的模型】自己报的为准（各模型能给的档不一样）。
  const efforts = $derived(picked?.efforts || []);

  function toggle() {
    if (disabled) return;
    if (!open && pillBtn) {
      // 开之前测一下上下空间：下方够就朝下弹，不够朝上（照 Claude 页 Composer 的做法）。
      const r = pillBtn.getBoundingClientRect();
      dir = (window.innerHeight - r.bottom) >= r.top ? 'down' : 'up';
    }
    if (open) view = 'models';
    open = !open;
  }
  function close() { open = false; view = 'models'; }

  async function pickModel(id) {
    if (busy) return;
    busy = true;
    try {
      // 换模型时思考深度跟着回落：新模型未必支持旧的那一档，留着会被 CLI 拒。
      await setCliModel(agent, { model: id, effort: '' });
      if (!id) { close(); }
      else if (efforts.length) { view = 'effort'; }
      else { close(); }
    } catch (e) {
      showToast(tr(e?.message) || t('换不了这个模型'), 'err');
    }
    busy = false;
  }
  async function pickEffort(v) {
    if (busy) return;
    busy = true;
    try {
      await setCliModel(agent, { model: curModel, effort: v });
      close();
    } catch (e) {
      showToast(tr(e?.message) || t('换不了这个思考深度'), 'err');
    }
    busy = false;
  }
</script>

<svelte:window onkeydown={(e) => { if (open && e.key === 'Escape') close(); }} />

{#if visible.length}
  <button class="pill" bind:this={pillBtn} onclick={toggle} disabled={disabled}
    class:on={open} aria-label={t('选择模型')} title={t('选择模型')}>
    <span class="plabel">{pillLabel}</span>
    {#if curModel && curEffort !== ''}<span class="peffort">{curEffort}</span>{/if}
    <svg class="chev" class:flip={open} viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m5.5 8 4.5 4.5L14.5 8"/></svg>
  </button>
  {#if open}
    <button class="pk-backdrop" aria-label={t('关闭')} onclick={close}></button>
    <div class="pk" class:down={dir === 'down'} role="menu">
      {#if view === 'models'}
        <button class="row" onclick={() => pickModel('')} disabled={busy}>
          <span class="rname">{t('用 codex 自己的配置')}</span>
          {#if !curModel}<span class="check">✓</span>{/if}
        </button>
        <div class="div"></div>
        {#each visible as m (m.id)}
          <button class="row" onclick={() => pickModel(m.id)} disabled={busy}>
            <span class="rcol">
              <span class="rname">{m.label || m.id}</span>
              {#if m.description}<span class="rdesc">{m.description}</span>{/if}
            </span>
            {#if m.id === curModel}<span class="check accent">✓</span>{/if}
          </button>
        {/each}
      {:else}
        <button class="back" onclick={() => (view = 'models')} disabled={busy}>{t('‹ 返回')}</button>
        <div class="ptitle">{picked?.label || curModel} · {t('思考深度')}</div>
        <button class="row" onclick={() => pickEffort('')} disabled={busy}>
          <span class="rname">{t('默认')}</span>
          {#if curEffort === ''}<span class="check">✓</span>{/if}
        </button>
        {#each efforts as v (v)}
          <button class="row" onclick={() => pickEffort(v)} disabled={busy}>
            <span class="rname">{v}</span>
            {#if curEffort === v}<span class="check accent">✓</span>{/if}
          </button>
        {/each}
      {/if}
    </div>
  {/if}
{/if}

<style>
  /* 胶囊：官方 PC 端 composer 同款（模型名 + ⌄，30px 高、全圆角、弱底色） */
  .pill {
    display: inline-flex; align-items: center; gap: 5px; height: 30px; padding: 0 10px 0 12px;
    border-radius: 999px; border: none; color: inherit; max-width: 180px;
    background: color-mix(in srgb, currentColor 8%, transparent); flex: none;
  }
  .pill:disabled { opacity: .5; }
  .plabel { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .peffort { font-size: 11px; opacity: .6; flex: none; }
  .chev { width: 13px; height: 13px; flex: none; opacity: .65; transition: transform .15s ease; }
  .chev.flip { transform: rotate(180deg); }

  .pk-backdrop { position: fixed; inset: 0; z-index: 60; }
  .pk {
    position: absolute; bottom: calc(100% + 8px); right: 0; z-index: 61;
    min-width: 240px; max-width: min(320px, calc(100vw - 32px)); padding: 4px;
    max-height: 50vh; overflow-y: auto;
    display: flex; flex-direction: column;
    background: var(--q-card, var(--card, #2c2c2a)); border-radius: 14px;
    box-shadow: var(--q-shadow, 0 8px 28px rgba(0,0,0,.35));
  }
  .pk.down { bottom: auto; top: calc(100% + 8px); }
  .row { width: 100%; display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 9px; text-align: left; }
  @media (hover: hover) { .row:hover { background: color-mix(in srgb, currentColor 8%, transparent); } }
  .row:active { background: color-mix(in srgb, currentColor 10%, transparent); }
  .rcol { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
  .rname { font-size: 13px; color: inherit; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .rdesc { font-size: 11px; opacity: .6; line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .check { margin-left: auto; flex: none; font-size: 13px; }
  .check.accent { color: var(--agent-accent, currentColor); }
  .div { height: 1px; background: color-mix(in srgb, currentColor 12%, transparent); margin: 4px 8px; }
  .back { padding: 6px 10px; font-size: 12.5px; color: inherit; opacity: .7; text-align: left; }
  .ptitle { padding: 2px 10px 6px; font-size: 12px; opacity: .65; }
</style>
