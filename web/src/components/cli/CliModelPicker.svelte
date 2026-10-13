<script>
  // 输入卡右下角的模型胶囊 + 一体浮层（照官方 PC 端 composer：模型名 + ⌄，点开浮层选模型，
  // 换了带思考深度档的模型再进二级视图选档——同一张浮层里翻页，不是两颗下拉框）。
  // effort 滑条照 components/EffortPanel.svelte（claude.ai/code 官方逆向复刻）整段移植：
  // 拖拽物理 / HSE 吸附缓动 / 档名交换动画 / 顶档 WebGL 能量场（紫→本页 --agent-accent 染色）。
  // 数据源不同：这里走 lib/cliChat 的 cliModels（codex model/list），不是 Claude 的 caps/settings；
  // 改档提交后不关浮层（Claude 官方同款，面板留驻、档名即时更新）。两处各自持有同构实现，互指来源。
  import { cubicOut } from 'svelte/easing';
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

  // —— effort 档位中文名：字面量 switch（i18n-check 要求 t() 的键静态可查）；
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

  // —— 滑条数据（照 EffortPanel 的 efforts 形状 {id, name}）——
  const items = $derived(efforts.map((id) => ({ id, name: effortName(id) })));
  const N = $derived(items.length);
  // 当前生效档的位置：''（默认）时视觉停在模型默认档（没有就第 0 档）。
  const idx = $derived.by(() => {
    if (curEffort !== '') {
      const i = efforts.indexOf(curEffort);
      if (i >= 0) return i;
    }
    const d = efforts.indexOf(picked?.defaultEffort);
    return d >= 0 ? d : 0;
  });
  // 顶档 = accent 档（Claude 只给 Ultracode 上紫；这里顶档一律上各家 accent）
  const accentIdx = $derived(N - 1);
  const accent = $derived(N > 1);

  // 拖动中的高亮档（官方 onValueChange 只改高亮、onValueCommitted 才落值）
  let hlIdx = $state(null);
  const disp = $derived(hlIdx == null ? idx : hlIdx);
  const restPct = $derived(N > 1 ? (disp / (N - 1)) * 100 : 0);
  const topStop = $derived(accent && disp === accentIdx);
  const label = $derived((items[disp] || {}).name || '');

  let dragging = $state(false);
  let control = $state(), trackEl = $state(), fillEl = $state(), thumbEl = $state(), railEl = $state(), inputEl = $state();

  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  // 官方自定义弹性缓动（hse）：400ms linear() 前 48% 完成、尾段驻留
  const HSE = '400ms linear(0, 0.0497, 0.1647, 0.3069, 0.4517, 0.5848, 0.6991, 0.7923, 0.8647, 0.9186, 0.9571, 0.9831, 0.9996, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1)';

  function commit(i) {
    const e = efforts[i];
    // 改档不关浮层（Claude 官方同款）；失败走 pickEffort 里的 toast，档名落回实况。
    if (e != null && e !== curEffort) pickEffort(e);
    hlIdx = null;
  }

  // —— 档名交换动画（官方 framer popLayout 逐行对位：0.2s easeOut、±0.55em、blur 2px）——
  let lbDir = $state(1);
  function setDisp(i) {
    if (i === disp) return;
    lbDir = i > disp ? 1 : -1;
    hlIdx = i;
  }
  const lbIn = (n, { d }) => ({ duration: 200, easing: cubicOut, css: (p, u) => `opacity:${p};filter:blur(${(2 * u).toFixed(2)}px);transform:translateY(${(0.55 * u * d).toFixed(3)}em)` });
  const lbOut = (n, { d }) => ({ duration: 200, easing: cubicOut, css: (p, u) => `position:absolute;left:0;top:0;max-width:100%;opacity:${p};filter:blur(${(2 * u).toFixed(2)}px);transform:translateY(${(-0.55 * u * d).toFixed(3)}em)` });

  // —— 拖拽（官方逐行移植：railRect 定位、thumb 抓取偏移、3px 起判、catchUp 100ms cubic-out、
  //    松手 |raw-target|≥0.5px 才播吸附动画）——
  let st = null;   // { railRect, grabOffsetX, downClientX, lastClientX, rafId, moved, catchUp }
  let endCb = null;
  const frac = () => Math.min(Math.max((st.lastClientX - st.grabOffsetX - st.railRect.left) / (st.railRect.width || 1), 0), 1);
  function setTransitions() {
    if (reduced()) { fillEl.style.transition = ''; thumbEl.style.transition = ''; return; }
    fillEl.style.transition = `width ${HSE}`;
    thumbEl.style.transition = `left ${HSE}, background-color 300ms`;
  }
  function clearEndCb() { if (endCb) { thumbEl.removeEventListener('transitionend', endCb); endCb = null; } }
  function down(e) {
    if (N < 2 || e.button !== 0) return;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
    clearEndCb();
    setTransitions();
    control.style.removeProperty('--slider-drag-pos');
    const trRect = thumbEl.getBoundingClientRect();
    const onThumb = thumbEl.contains(e.target);
    st = { railRect: railEl.getBoundingClientRect(), grabOffsetX: onThumb ? e.clientX - (trRect.left + trRect.width / 2) : 0,
      downClientX: e.clientX, lastClientX: e.clientX, rafId: 0, moved: false, catchUp: null };
    // 点按（未拖）：目标档即刻成为高亮 → rest-pos 变化经 hse 过渡滑过去（官方 base-ui 同构）
    setDisp(Math.round(frac() * (N - 1)));
  }
  function tick() {
    if (!st || !control || !railEl) return;
    st.rafId = 0;
    st.railRect = railEl.getBoundingClientRect();
    const a = frac();
    let r = a;
    if (st.catchUp) {
      const k = Math.min((performance.now() - st.catchUp.startTime) / 100, 1);
      if (k >= 1) st.catchUp = null;
      else { const n = 1 - (1 - k) ** 3; r = st.catchUp.fromFraction + (a - st.catchUp.fromFraction) * n; }
    }
    control.style.setProperty('--slider-drag-pos', (100 * r) + '%');
    setDisp(Math.round(r * (N - 1)));
    if (st.catchUp && st.rafId === 0) st.rafId = requestAnimationFrame(tick);
  }
  function move(e) {
    if (!st) return;
    st.lastClientX = e.clientX;
    if (e.buttons === 0) { up(); return; }
    if (!st.moved) {
      if (Math.abs(e.clientX - st.downClientX) < 3) return;
      st.moved = true; dragging = true;
      const w = control.getBoundingClientRect().width;
      if (w > 0 && !reduced()) {
        const from = Math.min(Math.max(fillEl.getBoundingClientRect().width / w, 0), 1);
        control.style.setProperty('--slider-drag-pos', (100 * from) + '%');
        st.catchUp = { fromFraction: from, startTime: performance.now() };
      }
      fillEl.style.transition = ''; thumbEl.style.transition = '';
    }
    if (st.rafId === 0) st.rafId = requestAnimationFrame(tick);
  }
  function up() {
    const g = st;
    st = null; dragging = false;
    if (!g || !control || !fillEl || !thumbEl) return;
    if (g.rafId !== 0) cancelAnimationFrame(g.rafId);
    const raw = (() => { st = g; const v = frac(); st = null; return v; })();
    if (!g.moved) {
      // 点按：hse 过渡已在滑，落值 + transitionend 清理
      commit(disp);
      const done = (ev) => { if (ev && ev.propertyName !== 'left') return; clearEndCb(); fillEl.style.transition = ''; thumbEl.style.transition = ''; };
      if (thumbEl.getAnimations().length > 0) { endCb = done; thumbEl.addEventListener('transitionend', done); } else done();
      control.style.removeProperty('--slider-drag-pos');
      return;
    }
    const target = Math.round(raw * (N - 1));
    commit(target);
    const d = N > 1 ? target / (N - 1) : 0;
    if (Math.abs(raw - d) * (g.railRect.width || 1) < 0.5 || reduced()) { control.style.removeProperty('--slider-drag-pos'); return; }
    const done = (ev) => {
      if (ev && ev.propertyName !== 'left') return;
      clearEndCb(); fillEl.style.transition = ''; thumbEl.style.transition = ''; control.style.removeProperty('--slider-drag-pos');
    };
    setTransitions();
    control.style.setProperty('--slider-drag-pos', (100 * d) + '%');
    endCb = done;
    thumbEl.addEventListener('transitionend', done);
  }
  function dotTap(e, i) {
    e.stopPropagation();
    clearEndCb(); setTransitions();
    control.style.removeProperty('--slider-drag-pos');
    setDisp(i); commit(i);
    const done = (ev) => { if (ev && ev.propertyName !== 'left') return; clearEndCb(); fillEl.style.transition = ''; thumbEl.style.transition = ''; };
    endCb = done; thumbEl.addEventListener('transitionend', done);
  }
  // 键盘（隐藏 input）：官方即时落值、无动画
  function onInput() { const i = +inputEl.value; setDisp(i); commit(i); }

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
  // 改档不关浮层（Claude 官方同款：滑条留驻，档名即时更新；Esc/点外随时关）。
  async function pickEffort(v) {
    if (busy) return;
    busy = true;
    try {
      await setCliModel(agent, { model: curModel, effort: v });
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
        <!-- effort 二级视图照 Claude EffortPanel 移植：头部（↻ 复位默认 / 档名交换动画 / 模型名返回）
             + Faster/Smarter 两端 + 官方滑条（拖拽吸附）+ 顶档能量场。 -->
        <div class="ehead">
          <button class="preset" onclick={() => pickEffort('')} disabled={busy} aria-label={t('默认')} title={t('默认')}>
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10a6 6 0 1 1 1.8 4.3M4 10V6.5M4 10h3.5"/></svg>
          </button>
          <div class="etitle" role="button" tabindex="0"
            onclick={() => (view = 'models')} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); view = 'models'; } }}>
            <span class="evalwrap">
              {#key disp}<span class="ename" class:accent={topStop} in:lbIn={{ d: lbDir }} out:lbOut={{ d: lbDir }}>{label}</span>{/key}
            </span>
            <span class="emodel">{picked?.label || curModel} ›</span>
          </div>
        </div>
        {#if N >= 2}
          <div class="es-sec">
            <div class="es-ends"><span>Faster</span><span>Smarter</span></div>
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div class="es-slider" class:dragging class:topstop={topStop} bind:this={control}
              style:--slider-rest-pos={restPct + '%'}
              onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={up} onlostpointercapture={up}>
              <div class="es-track" bind:this={trackEl}>
                <span class="es-fill" bind:this={fillEl}></span>
              </div>
              <span class="es-dots" aria-hidden="true">
                {#each items as it, i (it.id)}
                  <!-- svelte-ignore a11y_no_static_element_interactions -->
                  <span class="es-dot" class:last={i === accentIdx} style:--ds={35 * (N - 1 - i) + 'ms'} title={it.name}
                    onpointerdown={(ev) => dotTap(ev, i)}><span class="es-dot-hit"></span></span>
                {/each}
              </span>
              <span class="es-rail" bind:this={railEl}>
                <span class="es-thumb" bind:this={thumbEl} aria-hidden="true"></span>
                <span class="es-thumb es-focusring" aria-hidden="true"></span>
                <input class="es-input" bind:this={inputEl} type="range" min="0" max={N - 1} step="1" value={disp}
                  aria-label={t('思考深度')} aria-valuetext={label} oninput={onInput} />
              </span>
            </div>
          </div>
        {:else if N === 1}
          <button class="row" onclick={() => pickEffort(efforts[0])} disabled={busy}>
            <span class="rname">{items[0].name}</span>
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

  /* —— effort 视图头部：↻ 复位默认 / 档名（交换动画）/ 模型名（点击返回）—— */
  .ehead { position: relative; display: flex; align-items: center; justify-content: center; padding: 10px 12px 4px; min-height: 34px; }
  .preset { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); width: 28px; height: 28px; border-radius: 50%;
    display: inline-flex; align-items: center; justify-content: center; color: inherit; opacity: .55; }
  .preset svg { width: 15px; height: 15px; }
  @media (hover: hover) { .preset:hover { opacity: 1; background: color-mix(in srgb, currentColor 8%, transparent); } }
  .etitle { display: flex; flex-direction: column; align-items: center; gap: 1px; cursor: pointer; border-radius: 8px; padding: 2px 10px; }
  .evalwrap { position: relative; display: flex; min-width: 0; }
  .ename { display: block; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
    font-size: 15px; font-weight: 500; color: inherit; }
  .ename.accent { color: var(--es-accent, var(--agent-accent, currentColor)); }
  .emodel { font-size: 11.5px; opacity: .6; }
  @media (hover: hover) { .etitle:hover .emodel { opacity: 1; text-decoration: underline; text-underline-offset: 2px; } }

  /* ===== effort 滑条（EffortPanel 官方复刻移植，类名 ef- → es-；token 紫改本页 accent）===== */
  .pk {
    --es-accent: var(--agent-accent, currentColor);
    --es-accent-20: color-mix(in srgb, var(--agent-accent, currentColor) 20%, transparent);
    --es-pop-shadow: inset 0 0 0 1px rgba(255, 255, 255, .08), 0 6px 16px rgba(11, 11, 11, .24);
    --es-t5: rgba(255, 255, 255, .25);
    --es-t6: rgba(255, 255, 255, .48);
    --es-t7: rgba(255, 255, 255, .7);
    --es-slider-background: rgb(26, 26, 25);
    --es-track-bg: linear-gradient(90deg, #17181c 0%, #2ea9c9 100%);   /* 深灰黑 → 青蓝 */
    --es-slider-fill: rgba(255, 255, 255, .16);
    --es-slider-handle: rgb(165, 164, 154);
    --es-slider-handle-energized: color-mix(in srgb, var(--agent-accent, currentColor) 25%, #fff);
    --es-thumb-shadow: 0 0 12px rgba(11, 11, 11, .24);
  }
  :global(html[data-theme="light"]) .pk {
    --es-pop-shadow: 0 0 0 1px rgba(11, 11, 11, .06), 0 6px 16px rgba(11, 11, 11, .06);
    --es-t5: rgba(11, 11, 11, .25);
    --es-t6: rgba(11, 11, 11, .5);
    --es-t7: rgba(11, 11, 11, .8);
    --es-slider-background: rgb(237, 236, 232);
    --es-slider-fill: rgba(11, 11, 11, .1);
    --es-slider-handle: #fff;
    --es-slider-handle-energized: #fff;
    --es-thumb-shadow: 0 0 0 1px rgba(11, 11, 11, .04), 0 0 12px rgba(11, 11, 11, .06);
  }

  .es-sec { display: flex; width: 100%; flex-direction: column; gap: 8px; padding: 8px 10px 10px; font-size: 13px; line-height: 18px; user-select: none; }
  .es-ends { display: flex; align-items: center; justify-content: space-between; gap: 4px;
    font-size: 12px; line-height: 15px; color: var(--es-t6); }

  /* control 24 高；track 20 高 r6 上下 margin 2 */
  .es-slider { position: relative; display: flex; height: 24px; width: 100%; align-items: center; touch-action: none; }
  .es-slider.dragging { cursor: ew-resize; }
  .es-track { position: relative; width: 100%; margin: 2px 0; height: calc(100% - 4px); border-radius: 6px;
    overflow: hidden; container-type: inline-size; background: var(--es-track-bg, var(--es-slider-background)); }
  .es-fill { position: absolute; inset: 0 auto 0 0; left: 0; overflow: hidden;
    width: var(--slider-drag-pos, var(--slider-rest-pos)); background: var(--es-slider-fill); }
  /* 能量层：铺满整条轨道框（track 裁圆角）；透明度沿用官方 clamp((pos-25%)*k)，
     --slider-drag-pos 在 .es-slider 上命令式更新、沿自定义属性继承到这层，拖动实时跟手 */

  /* 档位点：3px、px 10 两端、t5（末档 accent）、35ms 步进错峰；顶档非拖动隐去；命中区 19×23 */
  .es-dots { pointer-events: none; position: absolute; inset: 0; display: flex; align-items: center;
    justify-content: space-between; padding: 0 10px; }
  .es-dot { pointer-events: auto; position: relative; display: flex; width: 3px; height: 3px;
    align-items: center; justify-content: center; border-radius: 999px; background: var(--es-t5); }
  .es-dot.last { background: var(--es-accent); }
  .es-dot-hit { position: absolute; inset: -10px -8px; }
  @media (prefers-reduced-motion: no-preference) {
    .es-dot { transition: opacity .3s ease var(--ds, 0ms); }
  }
  .es-slider.dragging .es-dot { pointer-events: none; }
  .es-slider.topstop .es-dot { pointer-events: none; }
  .es-slider.topstop:not(.dragging) .es-dot { opacity: 0; }

  /* 轨内滑轨：两侧内缩半把手（8px）；把手 16×19 r6，背景色 300ms 过渡 */
  .es-rail { pointer-events: none; position: absolute; top: 0; bottom: 0; left: 8px; right: 8px; }
  .es-thumb { pointer-events: auto; position: absolute; width: 16px; height: 19px; border-radius: 6px;
    left: var(--slider-drag-pos, var(--slider-rest-pos)); top: 50%; transform: translate(-50%, -50%);
    background: var(--es-slider-handle); box-shadow: var(--es-thumb-shadow); cursor: ew-resize; }
  @media (prefers-reduced-motion: no-preference) {
    .es-thumb { transition: background-color .3s; }
  }
  .es-slider.topstop .es-thumb { background: var(--es-slider-handle-energized); }
  /* 键盘聚焦环：accent 2px + 环 4px + 20% 辉光（官方 shadow-focus-slider） */
  .es-focusring { pointer-events: none; opacity: 0; background: transparent; cursor: default;
    box-shadow: 0 0 0 2px var(--q-card, #2c2c2a), 0 0 0 4px var(--es-accent), 0 0 14px 4px var(--es-accent-20); }
  .es-slider:focus-within .es-focusring { opacity: 1; }
  /* 真 input：藏在把手位置承载键盘/读屏（官方 clip 内藏 input 同构） */
  .es-input { position: absolute; width: 16px; height: 19px; top: 50%;
    left: var(--slider-drag-pos, var(--slider-rest-pos)); transform: translate(-50%, -50%);
    opacity: 0; pointer-events: none; margin: 0; }
</style>
