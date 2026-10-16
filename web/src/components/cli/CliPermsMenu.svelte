<script>
  // Codex 输入栏的权限档菜单（P4，仅 codex）：四组正交选项，改的是「当轮覆盖」
  // （lib/cliChat.svelte.js 的 permsOverride，只带改过的维度，随下一条消息发；
  // 不改时不发，用线程当前设置）。线程级默认值在「自定义」页「权限」页签改。
  // profile 与 sandbox 互斥：选了 profile 就清 sandbox，反之亦然（后端也有防线）。
  import { onMount } from 'svelte';
  import { t } from '../../lib/i18n.js';
  import { apiUrl } from '../../lib/server.js';
  import { authHeaders } from '../../lib/api.js';
  import { cliChat, setCliPermsOverride } from '../../lib/cliChat.svelte.js';

  let { agent = 'codex', onClose } = $props();
  const close = () => onClose && onClose();

  // 线程级默认值（显示「默认 = 什么」用）与 profile 清单（打开时才拉，不点不花探针进程）。
  let defaults = $state(null);   // null = 还没拉到；拉到后是 { sandbox, approval, reviewer, profile }
  let profiles = $state(null);   // null = 还没拉到 / 探针失败（那时隐藏 profile 组）
  let profilesLoading = $state(false);

  const LABEL = {
    sandbox: { 'read-only': t('只读'), 'workspace-write': t('工作区写入'), 'danger-full-access': t('全部放开') },
    approval: { 'on-request': t('每次询问'), never: t('从不询问'), untrusted: t('仅不受信任时询问') },
    reviewer: { user: t('我来审批'), auto_review: t('自动审阅') },
  };
  const DESC = {
    sandbox: {
      'read-only': t('不写文件、不跑命令'),
      'workspace-write': t('可在工作区内写文件、跑命令'),
      'danger-full-access': t('不拦任何操作，小心用'),
    },
    approval: {
      'on-request': t('写文件、跑命令前先问你'),
      never: t('不问，直接放行或拒绝'),
      untrusted: t('只对不受信任的操作问'),
    },
    reviewer: {
      user: t('审批卡弹回给你点'),
      auto_review: t('子审阅员按风险框架代你批，不弹卡'),
    },
  };
  const GROUPS = [
    { dim: 'sandbox', label: t('沙箱'), options: ['read-only', 'workspace-write', 'danger-full-access'] },
    { dim: 'approval', label: t('审批'), options: ['on-request', 'never', 'untrusted'] },
    { dim: 'reviewer', label: t('审批人'), options: ['user', 'auto_review'] },
  ];

  // 该维度的当前值：覆盖里有就用覆盖的，否则是「默认」（线程当前设置，默认值为 defaults）。
  const current = (dim) => {
    const ov = cliChat[agent]?.permsOverride || {};
    if (ov[dim]) return ov[dim];
    return null; // 默认
  };
  // 「默认」一行显示的默认值（defaults 拉到才有；没拉到只写「默认」）。
  // 括号里的值只对新会话成立（新线程的 thread/start 就是按 defaults 开的）；
  // 续聊线程的当前设置前端并不知道（上一轮的覆盖可能已粘住），那时不写括号，避免误导。
  const isNewSession = () => !cliChat[agent]?.sessionId;
  const defaultLabel = (dim) => {
    const d = defaults?.[dim];
    if (!d || !isNewSession()) return t('默认');
    if (dim === 'profile') return t('默认') + '（' + d + '）';
    return t('默认') + '（' + (LABEL[dim]?.[d] || d) + '）';
  };
  const pick = (dim, value) => setCliPermsOverride(agent, { [dim]: value });
  const resetAll = () => setCliPermsOverride(agent, { sandbox: null, approval: null, reviewer: null, profile: null });

  onMount(async () => {
    try {
      const r = await fetch(apiUrl('/api/codex/perms'), { headers: authHeaders(), credentials: 'same-origin' });
      const j = await r.json().catch(() => null);
      if (r.ok && j?.perms) defaults = j.perms;
    } catch {}
    profilesLoading = true;
    try {
      const r = await fetch(apiUrl('/api/codex/permissions/profiles'), { headers: authHeaders(), credentials: 'same-origin' });
      const j = await r.json().catch(() => null);
      if (r.ok && Array.isArray(j?.profiles)) profiles = j.profiles;
    } catch {}
    profilesLoading = false;
  });
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') close(); }} />

<button class="pm-backdrop" aria-label={t('关闭')} onclick={close}></button>
<div class="pm" role="menu">
  <div class="pm-head">{t('权限')}</div>
  <div class="pm-note">{t('本轮覆盖：只对下一条消息生效，改完的设置会留在会话里')}</div>

  {#each GROUPS as g}
    <div class="pm-group">
      <div class="pm-group-label">{g.label}</div>
      <button class="pm-row" class:on={current(g.dim) === null} onclick={() => pick(g.dim, null)}>
        <span class="pm-check">{current(g.dim) === null ? '✓' : ''}</span>
        <span class="pm-name">{defaultLabel(g.dim)}</span>
      </button>
      {#each g.options as opt}
        <button class="pm-row" class:on={current(g.dim) === opt} onclick={() => pick(g.dim, opt)}>
          <span class="pm-check">{current(g.dim) === opt ? '✓' : ''}</span>
          <span class="pm-name">{LABEL[g.dim][opt]}</span>
          <span class="pm-desc">{DESC[g.dim][opt]}</span>
        </button>
      {/each}
    </div>
  {/each}

  {#if profiles !== null}
    <div class="pm-group">
      <div class="pm-group-label">{t('权限 profile')}</div>
      <div class="pm-note">{t('选了 profile，沙箱就不生效')}</div>
      <button class="pm-row" class:on={current('profile') === null} onclick={() => pick('profile', null)}>
        <span class="pm-check">{current('profile') === null ? '✓' : ''}</span>
        <span class="pm-name">{defaults?.profile && isNewSession() ? t('默认') + '（' + defaults.profile + '）' : t('默认')}</span>
      </button>
      {#each profiles as p}
        <button class="pm-row" class:on={current('profile') === p.id} onclick={() => pick('profile', p.id)}>
          <span class="pm-check">{current('profile') === p.id ? '✓' : ''}</span>
          <span class="pm-name">{p.id}</span>
          {#if p.description}<span class="pm-desc">{p.description}</span>{/if}
        </button>
      {/each}
      {#if !profiles.length}<div class="pm-empty">{t('暂无可用 profile')}</div>{/if}
    </div>
  {:else if profilesLoading}
    <div class="pm-group"><div class="pm-note">{t('正在拉 profile 清单…')}</div></div>
  {/if}

  <div class="pm-foot">
    <button class="pm-foot-btn" onclick={() => { resetAll(); }}>{t('恢复默认')}</button>
    <button class="pm-foot-btn primary" onclick={close}>{t('完成')}</button>
  </div>
</div>

<style>
  .pm-backdrop { position: fixed; inset: 0; z-index: 60; }
  .pm {
    position: absolute; bottom: calc(100% + 8px); left: 0; z-index: 61;
    min-width: 300px; max-width: min(380px, calc(100vw - 32px)); padding: 10px 12px 8px;
    background: var(--q-card, var(--card, #2c2c2a)); border-radius: 16px; box-shadow: var(--q-shadow, 0 8px 28px rgba(0,0,0,.35));
    max-height: 70vh; overflow-y: auto;
  }
  .pm-head { font-size: 14px; font-weight: 600; padding: 2px 4px 4px; }
  .pm-note { font-size: 12px; opacity: .6; padding: 0 4px 8px; line-height: 1.4; }
  .pm-group { border-top: 1px solid color-mix(in srgb, currentColor 10%, transparent); padding: 8px 0 4px; }
  .pm-group-label { font-size: 12px; opacity: .6; padding: 0 4px 4px; }
  .pm-row { width: 100%; display: flex; align-items: baseline; gap: 8px; padding: 7px 8px; border-radius: 10px; text-align: left; }
  @media (hover: hover) { .pm-row:hover { background: color-mix(in srgb, currentColor 8%, transparent); } }
  .pm-row:active { background: color-mix(in srgb, currentColor 10%, transparent); }
  .pm-check { width: 14px; flex: none; font-size: 12px; }
  .pm-name { font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pm-desc { font-size: 12px; opacity: .55; margin-left: auto; text-align: right; }
  .pm-empty { font-size: 13px; opacity: .6; padding: 4px 8px; }
  .pm-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 8px 4px 2px; border-top: 1px solid color-mix(in srgb, currentColor 10%, transparent); }
  .pm-foot-btn { font-size: 13px; padding: 6px 14px; border-radius: 999px; }
  .pm-foot-btn.primary { background: color-mix(in srgb, currentColor 12%, transparent); }
</style>
