<script>
  // Codex「自定义」页 —— 官方 PC 端 `codex plugin` / `codex mcp` 的桥接（对齐 Claude 侧栏 Customize）：
  //   插件页签   = 本地市场目录（curated + bundled）∪ config.toml 安装态；添加/移除走 /api/codex/plugins/*
  //   连接器页签 = `codex mcp list --json` 的透传卡片
  // 全屏占住正文列（Claude 的 CustomizePage 同款开合：侧栏照常在，Esc / × 收）。
  import { onMount } from 'svelte';
  import { apiUrl } from '../../lib/server.js';
  import { authHeaders } from '../../lib/api.js';
  import { showToast } from '../../lib/toast.svelte.js';
  import { t, tr } from '../../lib/i18n.js';

  let { onClose } = $props();

  const TABS = [
    { key: 'plugin', label: t('插件') },
    { key: 'connector', label: t('连接器') },
  ];
  let tab = $state('plugin');
  let loading = $state(true);
  let err = $state('');
  let catalog = $state([]);        // [{name, marketplace, kinds: ['skill'|'connector']}]
  let installed = $state([]);      // [{id, name, marketplace, enabled}]
  let mcp = $state([]);            // codex mcp list --json 原样
  let busyId = $state('');

  const installedMap = $derived(new Map(installed.map((p) => [p.id, p])));
  const stateOf = (name, marketplace) => installedMap.get(`${name}@${marketplace}`);
  const pretty = (s) => String(s || '').split(/[-_]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

  async function load() {
    loading = true; err = '';
    try {
      const r = await fetch(apiUrl('/api/codex/plugins'), { headers: authHeaders(), credentials: 'same-origin' });
      const j = await r.json().catch(() => null);
      if (!r.ok || j?.error) throw new Error(j?.error || ('HTTP ' + r.status));
      catalog = j.catalog || []; installed = j.installed || []; mcp = j.mcp || [];
    } catch (e) { err = (e && e.message) || String(e); }
    loading = false;
  }
  onMount(load);

  async function mutate(kind, name, marketplace) {
    const id = `${name}@${marketplace}`;
    if (busyId) return;
    busyId = id + ':' + kind;
    try {
      const r = await fetch(apiUrl(`/api/codex/plugins/${kind}`), {
        method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }),
        credentials: 'same-origin', body: JSON.stringify({ selector: id }),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || j?.error) throw new Error(j?.error || ('HTTP ' + r.status));
      await load();
    } catch (e) { showToast(tr(e?.message) || t('操作失败'), 'err'); }
    busyId = '';
  }
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') onClose?.(); }} />

<div class="czp">
  <div class="czp-head">
    <h1>{t('自定义')}</h1>
    <button class="czp-x" onclick={() => onClose?.()} aria-label={t('关闭')}>
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M5.5 5.5l9 9M14.5 5.5l-9 9"/></svg>
    </button>
  </div>
  <div class="czp-tabs">
    {#each TABS as tb (tb.key)}
      <button class="czp-tab" class:on={tab === tb.key} onclick={() => (tab = tb.key)}>{tb.label}</button>
    {/each}
  </div>

  {#if loading}
    <div class="czp-empty">{t('加载中…')}</div>
  {:else if err}
    <div class="czp-empty err">{tr(err)}</div>
  {:else if tab === 'plugin'}
    {#if !catalog.length}
      <div class="czp-empty">{t('插件目录是空的')}</div>
    {:else}
      <div class="czp-grid">
        {#each catalog as p (p.marketplace + '/' + p.name)}
          {@const inst = stateOf(p.name, p.marketplace)}
          <div class="card">
            <div class="card-top">
              <span class="glyph" aria-hidden="true">&#xe0c9;</span>
              <div class="meta">
                <div class="cname">{pretty(p.name)}<span class="mp">{p.marketplace}</span></div>
                <div class="kinds">
                  {#if p.kinds.includes('skill')}<span class="kind">{t('技能')}</span>{/if}
                  {#if p.kinds.includes('connector')}<span class="kind">{t('连接器')}</span>{/if}
                </div>
              </div>
              {#if inst}<span class="state on">{inst.enabled ? t('已启用') : t('未安装')}</span>{:else}<span class="state">{t('未安装')}</span>{/if}
            </div>
            {#if busyId === p.marketplace + '/' + p.name + ':add' || busyId === p.marketplace + '/' + p.name + ':remove'}
              <div class="czp-empty">{busyId.endsWith(':add') ? t('安装中…') : t('移除中…')}</div>
            {:else if inst}
              <button class="act" disabled={!!busyId} onclick={() => mutate('remove', p.name, p.marketplace)}>{t('移除')}</button>
            {:else}
              <button class="act primary" disabled={!!busyId} onclick={() => mutate('add', p.name, p.marketplace)}>{t('添加')}</button>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  {:else}
    {#if !mcp.length}
      <div class="czp-empty">{t('还没有连接器')}</div>
    {:else}
      <div class="czp-grid">
        {#each mcp as s (s.name)}
          <div class="card">
            <div class="card-top">
              <span class="glyph" aria-hidden="true">&#xe0c9;</span>
              <div class="meta">
                <div class="cname">{s.name}</div>
                <div class="kinds mono">{s.transport?.command || ''} {(s.transport?.args || []).join(' ')}</div>
              </div>
              <span class="state" class:on={s.enabled}>{s.enabled ? t('已启用') : t('未安装')}</span>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</div>

<style>
  .czp { position: fixed; inset: 0; z-index: 70; overflow-y: auto; padding: 26px clamp(16px, 6vw, 64px) 40px;
    background: var(--bg, #1f1f1e); color: var(--text, #eee); }
  .czp-head { display: flex; align-items: center; justify-content: space-between; max-width: 1080px; margin: 0 auto 6px; }
  .czp-head h1 { font-family: var(--serif-stack, Georgia, serif); font-size: 30px; font-weight: 500; }
  .czp-x { width: 32px; height: 32px; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; color: inherit; opacity: .7; }
  .czp-x:hover { opacity: 1; background: color-mix(in srgb, currentColor 8%, transparent); }
  .czp-x svg { width: 16px; height: 16px; }
  .czp-tabs { display: flex; gap: 4px; max-width: 1080px; margin: 0 auto 18px; }
  .czp-tab { font-size: 13px; padding: 6px 14px; border-radius: 999px; color: inherit; opacity: .65; }
  .czp-tab.on { opacity: 1; background: color-mix(in srgb, currentColor 10%, transparent); }
  .czp-grid { max-width: 1080px; margin: 0 auto; display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }
  .card { display: flex; flex-direction: column; gap: 10px; padding: 14px; border-radius: 12px;
    border: 1px solid color-mix(in srgb, currentColor 12%, transparent);
    background: color-mix(in srgb, currentColor 4%, transparent); }
  .card-top { display: flex; gap: 10px; align-items: flex-start; }
  .glyph { width: 34px; height: 34px; flex: none; border-radius: 9px; display: inline-flex; align-items: center; justify-content: center;
    font-family: var(--icons, inherit); font-size: 19px; color: var(--serif, currentColor);
    background: color-mix(in srgb, currentColor 7%, transparent); }
  .meta { flex: 1; min-width: 0; }
  .cname { font-size: 14px; font-weight: 600; display: flex; align-items: baseline; gap: 8px; min-width: 0; }
  .mp { font-size: 10.5px; font-weight: 400; opacity: .5; }
  .kinds { display: flex; gap: 6px; margin-top: 3px; flex-wrap: wrap; font-size: 11px; opacity: .6; }
  .kind { padding: 1px 7px; border-radius: 999px; border: 1px solid color-mix(in srgb, currentColor 16%, transparent); }
  .kinds.mono { font-family: var(--mono, ui-monospace, monospace); font-size: 10.5px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; display: block; }
  .state { flex: none; font-size: 11px; padding: 2px 8px; border-radius: 999px; opacity: .6;
    border: 1px solid color-mix(in srgb, currentColor 16%, transparent); }
  .state.on { opacity: 1; color: var(--agent-accent, currentColor); border-color: color-mix(in srgb, var(--agent-accent, currentColor) 40%, transparent); }
  .act { align-self: flex-start; font-size: 12.5px; padding: 6px 14px; border-radius: 9px; color: inherit;
    border: 1px solid color-mix(in srgb, currentColor 20%, transparent); }
  .act.primary { background: var(--agent-accent, currentColor); border-color: transparent; color: #fff; font-weight: 600; }
  .act:disabled { opacity: .45; }
  .czp-empty { max-width: 1080px; margin: 24px auto; text-align: center; font-size: 13px; opacity: .55; }
  .czp-empty.err { color: var(--danger, #c0392b); opacity: 1; }
</style>
