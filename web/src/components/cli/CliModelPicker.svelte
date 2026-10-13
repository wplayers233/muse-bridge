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

  // —— effort 档位中文名（官方 PC 端滑杆同款）：字面量 switch（i18n-check 要求键可静态查）；
  // 未知档位回退显示原 id。——
  function effortName(v) {
    switch (v) {
      case 'low': return t('低');
      case 'medium': return t('中');
      case 'high': return t('高');
      case 'xhigh': return t('超高');
      case 'max': return t('最大');
      case 'ultra': return t('极致');
      default: return v;
    }
  }
  // 当前生效档位在 efforts 里的位置：''（默认）时视觉停在模型默认档（没有就第 0 档）。
  const restIdx = $derived.by(() => {
    if (curEffort !== '') {
      const i = efforts.indexOf(curEffort);
      if (i >= 0) return i;
    }
    const d = efforts.indexOf(picked?.defaultEffort);
    return d >= 0 ? d : 0;
  });

  // —— 滑杆交互（照官方 PC 端：点轨道/拖动吸附到最近档，松手提交）——
  let dragIdx = $state(-1);      // -1 = 没在拖，视觉用 restIdx
  let trackEl = $state(null);
  const showIdx = $derived(dragIdx >= 0 ? dragIdx : restIdx);
  function idxFromEvent(e) {
    const el = trackEl;
    if (!el || !efforts.length) return 0;
    const r = el.getBoundingClientRect();
    const pct = Math.min(1, Math.max(0, (e.clientX - r.left) / Math.max(1, r.width)));
    return Math.round(pct * (efforts.length - 1));
  }
  function trackDown(e) {
    if (busy || !efforts.length) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragIdx = idxFromEvent(e);
  }
  function trackMove(e) {
    if (dragIdx < 0 || busy) return;
    dragIdx = idxFromEvent(e);
  }
  function trackUp() {
    if (dragIdx < 0) return;
    const v = efforts[dragIdx];
    dragIdx = -1;
    if (v != null && v !== curEffort) pickEffort(v);
  }
  function trackKey(e) {
    if (busy || !efforts.length) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); pickEffort(efforts[Math.max(0, showIdx - 1)]); }
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); pickEffort(efforts[Math.min(efforts.length - 1, showIdx + 1)]); }
  }

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
    {#if curModel && curEffort !== ''}<span class="peffort">{effortName(curEffort)}</span>{/if}
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
        <!-- effort 二级视图照官方 PC 端：大标题=当前档名，副标题=模型名（点击返回），
             右上 ↻ 复位「默认」，下方一条分档滑杆（点轨道/拖动吸附，松手提交）。 -->
        <div class="ehead">
          <button class="preset" onclick={() => pickEffort('')} disabled={busy} aria-label={t('默认')} title={t('默认')}>
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10a6 6 0 1 1 1.8 4.3M4 10V6.5M4 10h3.5"/></svg>
          </button>
          <div class="etitle" class:backable={view === 'effort'} role="button" tabindex="0"
            onclick={() => (view = 'models')} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); view = 'models'; } }}>
            <span class="ename">{curEffort === '' ? t('默认') : effortName(efforts[showIdx] ?? curEffort)}</span>
            <span class="emodel">{picked?.label || curModel} ›</span>
          </div>
        </div>
        {#if efforts.length >= 2}
          <div class="slider" bind:this={trackEl} role="slider" tabindex="0" aria-valuemin="0" aria-valuemax={efforts.length - 1}
            aria-valuenow={showIdx} aria-valuetext={curEffort === '' && dragIdx < 0 ? t('默认') : effortName(efforts[showIdx])}
            onpointerdown={trackDown} onpointermove={trackMove} onpointerup={trackUp} onpointercancel={trackUp}
            onkeydown={trackKey}>
            <div class="strack">
              <div class="sfill" style:width={(efforts.length > 1 ? (showIdx / (efforts.length - 1)) * 100 : 100) + '%'}></div>
              {#each efforts as v, i (v)}
                <span class="sdot" class:on={i <= showIdx} style:left={(efforts.length > 1 ? (i / (efforts.length - 1)) * 100 : 50) + '%'}></span>
              {/each}
              <span class="sthumb" style:left={(efforts.length > 1 ? (showIdx / (efforts.length - 1)) * 100 : 50) + '%'}></span>
            </div>
            <div class="slabels">
              {#each efforts as v (v)}<span class="slabel" class:on={v === (dragIdx >= 0 ? efforts[showIdx] : curEffort)}>{effortName(v)}</span>{/each}
            </div>
          </div>
        {:else if efforts.length === 1}
          <button class="row" onclick={() => pickEffort(efforts[0])} disabled={busy}>
            <span class="rname">{effortName(efforts[0])}</span>
            {#if curEffort === efforts[0]}<span class="check accent">✓</span>{/if}
          </button>
        {/if}
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

  /* —— effort 二级视图（官方 PC 端滑杆同款）—— */
  .ehead { position: relative; display: flex; align-items: center; justify-content: center; padding: 10px 12px 4px; min-height: 34px; }
  .preset { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); width: 28px; height: 28px; border-radius: 50%;
    display: inline-flex; align-items: center; justify-content: center; color: inherit; opacity: .55; }
  .preset svg { width: 15px; height: 15px; }
  @media (hover: hover) { .preset:hover { opacity: 1; background: color-mix(in srgb, currentColor 8%, transparent); } }
  .etitle { display: flex; flex-direction: column; align-items: center; gap: 1px; cursor: default; border-radius: 8px; padding: 2px 10px; }
  .ename { font-size: 15px; font-weight: 600; color: var(--agent-accent, currentColor); }
  .emodel { font-size: 11.5px; opacity: .6; }
  .etitle.backable { cursor: pointer; }
  .etitle.backable:hover .emodel { opacity: 1; text-decoration: underline; text-underline-offset: 2px; }
  .slider { padding: 10px 18px 12px; outline: none; touch-action: none; user-select: none; }
  .slider:focus-visible .sthumb { box-shadow: 0 0 0 3px color-mix(in srgb, var(--agent-accent, currentColor) 35%, transparent); }
  .strack { position: relative; height: 6px; border-radius: 999px;
    background: color-mix(in srgb, currentColor 12%, transparent); }
  .sfill { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 999px;
    background: var(--agent-accent, currentColor); }
  .sdot { position: absolute; top: 50%; width: 6px; height: 6px; border-radius: 50%; transform: translate(-50%, -50%);
    background: color-mix(in srgb, currentColor 45%, transparent); }
  .sdot.on { background: var(--agent-accent, currentColor); }
  .sthumb { position: absolute; top: 50%; width: 18px; height: 18px; border-radius: 50%;
    transform: translate(-50%, -50%); background: var(--agent-accent, currentColor);
    box-shadow: 0 1px 4px rgba(0,0,0,.3); transition: left .12s ease; pointer-events: none; }
  .slabels { display: flex; justify-content: space-between; margin-top: 7px; }
  .slabel { font-size: 10.5px; opacity: .55; }
  .slabel.on { opacity: 1; font-weight: 600; color: var(--agent-accent, currentColor); }
</style>
