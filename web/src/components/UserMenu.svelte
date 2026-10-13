<script>
  // 侧栏底部账户卡的弹出菜单（claude.ai 左下角用户菜单同款：顶部一行身份，下面「设置 / 账户…退出」；
  // 272px 宽、圆角 12、内边距 4、行高 32 / 圆角 8 / 图标 20px、1px 描边 + 双层投影）。
  // 条目：（主页）、设置、账户、关于、工作空间、扫一扫（触屏）、退出 / 登录。
  // 常规模式（传了 onhome）多一项「主页」，退出后回主页（常规模式的登录卡在主页右上）。
  // 由 AccountCard 挂出（portal 到 <body>）。
  import { onMount } from 'svelte';
  import { ui, me, applyMe, status } from '../lib/state.svelte.js';
  import { api, setToken } from '../lib/api.js';
  import { openSettings } from '../lib/settingsNav.svelte.js';
  import { pushBackLayer } from '../lib/nav.js';
  import { agentPlan, loadAgentPlan } from '../lib/cliPlan.svelte.js';
  import { ctxLevel, fmtResetAt } from '../lib/ctxUsage.js';
  import { t } from '../lib/i18n.js';

  // anchor：账户卡按钮的 DOMRect；onclose：点空白 / Esc / 返回键；onpick：选了某一项（侧栏抽屉跟着收起）；
  // onhome：常规模式回主页（单 agent 模式不传——没有主页）；
  // agent：所在页的 agent（claude/codex/zcode）——「用哪个软件的就显示哪家的」coding plan 余额行；
  // 缺省 = 老调用方（dimensio 侧栏），不带余额行。
  let { anchor, onclose, onpick, onhome = null, agent = '' } = $props();

  // 余额行数据（打开菜单这一刻取一次；codex/zcode 走 /api/agent/plan 懒加载，claude 直接读
  // QuotaRing 已在维护的 status.limits，不发新请求）。null = 不显示（未登录 / API-key / 上游不合）。
  $effect(() => { if (agent === 'codex' || agent === 'zcode') loadAgentPlan(agent); });
  const planRow = $derived.by(() => {
    if (agent === 'codex' || agent === 'zcode') {
      const p = agentPlan[agent];
      if (!p) return null;
      const w = p.primary;
      // codex 的 resetsAt 是秒级 epoch（schema int64），fmtResetAt 吃毫秒——兼容两种量级。
      const rs = w && w.resetsAt ? (w.resetsAt > 1e12 ? w.resetsAt : w.resetsAt * 1000) : 0;
      const sub = (rs ? fmtResetAt(rs) : '')
        + (p.credits && p.credits.balance ? (rs ? ' · ' : '') + t('余额 {b}', { b: p.credits.balance }) : '');
      return { label: p.planType || t('Coding Plan'), pct: w ? w.usedPercent : null, sub };
    }
    if (agent === 'claude') {
      const rows = Object.entries(status.limits || {}).map(([key, v]) => ({ key, ...v })).filter((r) => r.pct != null);
      const tightest = rows.sort((a, b) => b.pct - a.pct)[0];
      if (!tightest) return null;
      return { label: 'Claude' + (status.plan ? ' · ' + status.plan : ''), pct: tightest.pct, sub: tightest.resetsAt ? fmtResetAt(tightest.resetsAt) : '' };
    }
    return null;
  });

  const canScan = (() => { try { return matchMedia('(pointer: coarse)').matches; } catch { return false; } })();
  const roleLabel = $derived(me.kind === 'admin' ? t('管理员') : me.kind === 'user' ? (me.tier === 'pro' ? t('Pro 用户') : t('普通用户')) : t('未登录'));
  const shownName = $derived(me.user || (me.kind === 'admin' ? 'admin' : ''));

  const W = Math.min(272, window.innerWidth - 16);
  const left = $derived(Math.max(8, Math.min(anchor.left, window.innerWidth - W - 8)));
  const bottom = $derived(Math.max(8, window.innerHeight - anchor.top + 6));

  let el = $state();
  $effect(() => pushBackLayer(onclose));   // 系统返回 / 浏览器后退先关菜单
  onMount(() => { el?.querySelector('.um-i')?.focus({ preventScroll: true }); });

  function pick(fn) { (onpick || onclose)?.(); fn(); }
  async function logout() {
    try { await api.logout(); } catch {}
    setToken(null);
    applyMe(null);
    ui.loginOpen = true;
    onhome?.();
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onclose?.(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const items = [...el.querySelectorAll('.um-i')];
    const i = items.indexOf(document.activeElement);
    const n = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1
      : (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[n]?.focus();
  }
  const SCAN = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M3 7V5.2A2.2 2.2 0 0 1 5.2 3H7M13 3h1.8A2.2 2.2 0 0 1 17 5.2V7M17 13v1.8a2.2 2.2 0 0 1-2.2 2.2H13M7 17H5.2A2.2 2.2 0 0 1 3 14.8V13M4 10h12"/></svg>';
</script>

<button class="um-bd" aria-label={t('关闭菜单')} tabindex="-1" onclick={onclose}></button>
<div class="um" role="menu" tabindex="-1" aria-label={t('账户菜单')} bind:this={el} onkeydown={onKey}
  style:left="{left}px" style:bottom="{bottom}px" style:width="{W}px">
  <div class="um-h">{me.kind === 'none' ? t('未登录') : `${shownName} · ${roleLabel}`}</div>
  {#if planRow}
    <div class="um-plan">
      <div class="um-plan-t">
        <span class="um-plan-k">{planRow.label}</span>
        <span class="um-plan-v">{planRow.pct != null ? Math.round(planRow.pct) + '%' : ''}</span>
      </div>
      {#if planRow.pct != null}
        <div class="um-plan-bar"><span class="um-plan-fill {ctxLevel(planRow.pct)}" style="width:{Math.min(100, planRow.pct)}%"></span></div>
      {/if}
      {#if planRow.sub}<div class="um-plan-s">{planRow.sub}</div>{/if}
    </div>
  {/if}
  {#if onhome}
    <button class="um-i" role="menuitem" onclick={() => pick(onhome)}><span class="ic" aria-hidden="true">&#xe08a;</span><span class="um-l">{t('主页')}</span></button>
  {/if}
  <!-- 不指定分区：宽屏落在「通用」，手机落在设置首页的列表 -->
  <button class="um-i" role="menuitem" onclick={() => pick(() => openSettings())}><span class="ic" aria-hidden="true">&#xe0d6;</span><span class="um-l">{t('设置')}</span></button>
  <button class="um-i" role="menuitem" onclick={() => pick(() => openSettings('account'))}><span class="ic" aria-hidden="true">&#xe105;</span><span class="um-l">{t('账户')}</span></button>
  <button class="um-i" role="menuitem" onclick={() => pick(() => openSettings('about'))}><span class="ic" aria-hidden="true">&#xe08f;</span><span class="um-l">{t('关于')}</span></button>
  <div class="um-sep" role="separator"></div>
  <button class="um-i" role="menuitem" onclick={() => pick(() => { ui.screen = 'files'; })}><span class="ic" aria-hidden="true">&#xe072;</span><span class="um-l">{t('工作空间')}</span></button>
  {#if canScan && me.kind !== 'none'}
    <button class="um-i" role="menuitem" onclick={() => pick(() => { ui.pairScan = { mode: 'scan' }; })}><span class="ic svg" aria-hidden="true">{@html SCAN}</span><span class="um-l">{t('扫一扫登录网页版')}</span></button>
  {/if}
  <div class="um-sep" role="separator"></div>
  {#if me.kind === 'none'}
    <button class="um-i" role="menuitem" onclick={() => pick(() => { ui.loginOpen = true; onhome?.(); })}><span class="ic" aria-hidden="true">&#xe105;</span><span class="um-l">{t('登录')}</span></button>
  {:else}
    <button class="um-i" role="menuitem" onclick={() => pick(logout)}><span class="ic" aria-hidden="true">&#xe0a4;</span><span class="um-l">{t('退出登录')}</span></button>
  {/if}
</div>

<style>
  .um-bd { position: fixed; inset: 0; z-index: 57; border: 0; background: transparent; cursor: default; }
  .um { position: fixed; z-index: 58; padding: 4px; border-radius: 12px; background: var(--st-menu); box-shadow: var(--st-menu-shadow);
    font-family: var(--sans); transform-origin: bottom left; animation: um-in .14s var(--ea-decel); outline: none; }
  @keyframes um-in { from { opacity: 0; transform: translateY(4px) scale(.98); } }
  .um-h { padding: 6px 10px 6px; font-size: 13px; line-height: 16px; color: var(--st-muted); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  /* coding plan 余额行（官方 claude.ai 账户菜单里那行额度摘要同款）：名字 + 用量% + 4px 条 + 重置时刻。
     QuotaRing 的环/条同一套阈值色（≥90 critical / ≥75 warning）。数据拿不到时整块不渲染。 */
  .um-plan { padding: 2px 10px 8px; }
  .um-plan-t { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  .um-plan-k { font-size: 12px; line-height: 16px; color: var(--st-muted); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .um-plan-v { flex: none; font-size: 12px; line-height: 16px; color: var(--text); font-variant-numeric: tabular-nums; }
  .um-plan-bar { margin-top: 4px; height: 4px; border-radius: 999px; background: color-mix(in srgb, var(--st-muted) 25%, transparent); overflow: hidden; }
  .um-plan-fill { display: block; height: 100%; border-radius: 999px; background: var(--text); transition: width .2s ease; }
  .um-plan-fill.warning { background: #d97706; }
  .um-plan-fill.critical { background: #dc2626; }
  .um-plan-s { margin-top: 4px; font-size: 11px; line-height: 14px; color: var(--st-muted); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .um-i { width: 100%; height: 32px; display: flex; align-items: center; gap: 8px; padding: 6px 10px; border: 0; border-radius: 8px;
    background: none; color: var(--text); font: inherit; font-size: 14px; text-align: left; cursor: pointer; outline: none; }
  .um-i:focus-visible, .um-i:active { background: var(--st-hover); }
  @media (hover: hover) { .um-i:hover { background: var(--st-hover); } }
  .ic { width: 20px; flex: none; font-family: var(--icons); font-size: 20px; font-weight: 433; line-height: 1; color: var(--text);
    display: inline-flex; align-items: center; justify-content: center; }
  .ic.svg :global(svg) { width: 18px; height: 18px; }
  .um-l { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .um-sep { height: 1px; margin: 4px 6px; background: var(--st-hair); }
  @media (pointer: coarse) {
    .um-i { height: 42px; font-size: 15px; }
  }
</style>
