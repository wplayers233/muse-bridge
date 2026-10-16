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
  import { codexSkillsVersion } from '../../lib/cliChat.svelte.js';

  let { onClose } = $props();

  const TABS = [
    { key: 'plugin', label: t('插件') },
    { key: 'connector', label: t('连接器') },
    { key: 'skill', label: t('技能') },
    { key: 'perms', label: t('权限') },
  ];
  let tab = $state('plugin');
  let loading = $state(true);
  let err = $state('');
  let catalog = $state([]);        // [{name, marketplace, kinds: ['skill'|'connector']}]
  let installed = $state([]);      // [{id, name, marketplace, enabled}]
  let mcp = $state([]);            // codex mcp list --json 原样
  let busyId = $state('');
  // 技能（skills/list，只读）：切到页签才懒加载，不点不花一次探针进程。
  let skillList = $state(null);    // null = 还没拉过；[] = 拉过、真没技能
  let skillLoading = $state(false);
  let skillErr = $state('');
  // 权限档线程级默认值（P4）：切到页签才拉；每个选项点选即保存（POST /api/codex/perms）。
  // 只对新会话生效——已开的会话走输入栏菜单的当轮覆盖。
  let permsDefaults = $state(null); // null = 还没拉到；拉到后是 { sandbox, approval, reviewer, profile }
  let permsProfiles = $state(null); // null = 还没拉到 / 探针失败（那时隐藏 profile 组）
  let permsLoading = $state(false);
  let permsErr = $state('');
  let permsSaving = $state(false);

  const PERMS_LABEL = {
    sandbox: { 'read-only': t('只读'), 'workspace-write': t('工作区写入'), 'danger-full-access': t('全部放开') },
    approval: { 'on-request': t('每次询问'), never: t('从不询问'), untrusted: t('仅不受信任时询问') },
    reviewer: { user: t('我来审批'), auto_review: t('自动审阅') },
  };
  const PERMS_DESC = {
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
  const PERMS_GROUPS = [
    { dim: 'sandbox', label: t('沙箱'), options: ['read-only', 'workspace-write', 'danger-full-access'] },
    { dim: 'approval', label: t('审批'), options: ['on-request', 'never', 'untrusted'] },
    { dim: 'reviewer', label: t('审批人'), options: ['user', 'auto_review'] },
  ];
  const DEFAULT_PERMS = { sandbox: 'workspace-write', approval: 'on-request', reviewer: 'user', profile: '' };

  async function loadPerms(force = false) {
    if (permsLoading) return;
    permsLoading = true; permsErr = '';
    try {
      const [pr, pf] = await Promise.all([
        fetch(apiUrl('/api/codex/perms'), { headers: authHeaders(), credentials: 'same-origin' }),
        fetch(apiUrl('/api/codex/permissions/profiles' + (force ? '?refresh=1' : '')), { headers: authHeaders(), credentials: 'same-origin' }),
      ]);
      const j = await pr.json().catch(() => null);
      if (!pr.ok || j?.error) throw new Error(j?.error || ('HTTP ' + pr.status));
      permsDefaults = j.perms || { ...DEFAULT_PERMS };
      const jf = await pf.json().catch(() => null);
      if (pf.ok && Array.isArray(jf?.profiles)) permsProfiles = jf.profiles;
    } catch (e) { permsErr = (e && e.message) || String(e); }
    permsLoading = false;
  }
  // 点选即保存：profile 与 sandbox 互斥——选 sandbox 就清 profile；选 profile 时
  // sandbox 存的值保留（清掉 profile 后它就是 fallback），界面上那组显示「不生效」。
  async function savePerms(patch) {
    if (permsSaving || !permsDefaults) return;
    const next = { ...permsDefaults, ...patch };
    if (patch.sandbox) next.profile = '';
    permsSaving = true;
    try {
      const r = await fetch(apiUrl('/api/codex/perms'), {
        method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }),
        credentials: 'same-origin', body: JSON.stringify({ perms: next }),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || j?.error) throw new Error(j?.error || ('HTTP ' + r.status));
      permsDefaults = j.perms || next;
      showToast(t('已保存'));
    } catch (e) { showToast((e && e.message) || String(e)); }
    permsSaving = false;
  }
  const resetPerms = () => savePerms({ ...DEFAULT_PERMS });

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

  // 技能清单：GET /api/codex/skills（服务端调官方 skills/list，只读）。
  // force = 界面「重新扫描」：绕过服务端缓存并让上游重扫磁盘（刚装了技能时用）。
  async function loadSkills(force = false) {
    if (skillLoading) return;
    skillLoading = true; skillErr = '';
    try {
      const r = await fetch(apiUrl('/api/codex/skills' + (force ? '?refresh=1' : '')), { headers: authHeaders(), credentials: 'same-origin' });
      const j = await r.json().catch(() => null);
      if (!r.ok || j?.error) throw new Error(j?.error || ('HTTP ' + r.status));
      skillList = Array.isArray(j?.skills) ? j.skills : [];
    } catch (e) { skillErr = (e && e.message) || String(e); }
    skillLoading = false;
  }
  // 切到技能页签才拉（失败后 skillErr 非空，不重复拉；成功后 skillList 非空，不重复拉）。
  // 技能变了（上游 skills/changed → cliChat 的 codexSkillsVersion +1）：已拉过就重拉。
  let loadedSkillsVersion = $state(0);
  $effect(() => {
    if (tab === 'skill' && skillList === null && !skillErr) loadSkills();
    if (skillList !== null && !skillLoading && codexSkillsVersion.v !== loadedSkillsVersion) {
      loadedSkillsVersion = codexSkillsVersion.v;
      loadSkills();
    }
    // 权限页签同样懒加载（失败后 permsErr 非空，不重复拉）。
    if (tab === 'perms' && permsDefaults === null && !permsErr) loadPerms();
  });

  // 技能来源：system = 内置，user = 用户自己的，project = 当前工作目录的；认不出的原样显示。
  const scopeLabel = (s) => s === 'system' ? t('系统') : s === 'user' ? t('用户') : s === 'project' ? t('项目') : String(s || '');

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

  {#if tab === 'plugin'}
    {#if loading}
      <div class="czp-empty">{t('加载中…')}</div>
    {:else if err}
      <div class="czp-empty err">{tr(err)}</div>
    {:else if !catalog.length}
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
  {:else if tab === 'connector'}
    {#if loading}
      <div class="czp-empty">{t('加载中…')}</div>
    {:else if err}
      <div class="czp-empty err">{tr(err)}</div>
    {:else if !mcp.length}
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
  {:else if tab === 'skill'}
    <!-- 技能（skills/list，只读）：名字 + 来源 + 描述 + SKILL.md 路径；启用/停用只展示，不在这里改。 -->
    {#if skillLoading}
      <div class="czp-empty">{t('加载中…')}</div>
    {:else if skillErr}
      <div class="czp-empty err">{tr(skillErr)}</div>
    {:else if !skillList?.length}
      <div class="czp-empty">{t('暂无技能')}</div>
    {:else}
      <div class="czp-refresh">
        <button onclick={() => loadSkills(true)} disabled={skillLoading}>{t('重新扫描')}</button>
      </div>
      <div class="czp-grid">
        {#each skillList as s (s.path || s.name)}
          <div class="card">
            <div class="card-top">
              <span class="glyph" aria-hidden="true">&#xe0c9;</span>
              <div class="meta">
                <div class="cname">{s.displayName || s.name}</div>
                <div class="kinds">
                  <span class="kind">{scopeLabel(s.scope)}</span>
                  {#if s.name && s.name !== s.displayName}<span class="kind mono">{s.name}</span>{/if}
                </div>
              </div>
              <span class="state" class:on={s.enabled}>{s.enabled ? t('已启用') : t('已停用')}</span>
            </div>
            {#if s.description}<div class="cdesc">{s.description}</div>{/if}
            {#if s.path}<div class="cpath" title={s.path}>{s.path}</div>{/if}
          </div>
        {/each}
      </div>
    {/if}
  {:else if tab === 'perms'}
    <!-- 权限档线程级默认值（P4）：只对新会话生效；已开的会话走输入栏菜单的当轮覆盖。 -->
    {#if permsLoading}
      <div class="czp-empty">{t('加载中…')}</div>
    {:else if permsErr}
      <div class="czp-empty err">{tr(permsErr)}</div>
    {:else if permsDefaults}
      <div class="czp-perms-note">{t('新会话按这里开；已开的会话在输入栏「权限」菜单里改当轮覆盖。')}</div>
      {#each PERMS_GROUPS as g}
        <div class="czp-perms-group">
          <div class="czp-perms-label">{g.label}</div>
          {#if g.dim === 'sandbox' && permsDefaults.profile}
            <div class="czp-perms-muted">{t('已选 profile，沙箱不生效')}</div>
          {/if}
          {#each g.options as opt}
            <button class="czp-perms-row" class:on={permsDefaults[g.dim] === opt}
              disabled={permsSaving || (g.dim === 'sandbox' && !!permsDefaults.profile)}
              onclick={() => savePerms({ [g.dim]: opt })}>
              <span class="czp-perms-check">{permsDefaults[g.dim] === opt ? '✓' : ''}</span>
              <span class="czp-perms-name">{PERMS_LABEL[g.dim][opt]}</span>
              <span class="czp-perms-desc">{PERMS_DESC[g.dim][opt]}</span>
            </button>
          {/each}
        </div>
      {/each}
      {#if permsProfiles !== null}
        <div class="czp-perms-group">
          <div class="czp-perms-label">{t('权限 profile')}</div>
          <div class="czp-perms-note">{t('选了 profile，沙箱就不生效')}</div>
          <button class="czp-perms-row" class:on={!permsDefaults.profile}
            disabled={permsSaving} onclick={() => savePerms({ profile: '' })}>
            <span class="czp-perms-check">{!permsDefaults.profile ? '✓' : ''}</span>
            <span class="czp-perms-name">{t('无 profile（用沙箱）')}</span>
          </button>
          {#each permsProfiles as p}
            <button class="czp-perms-row" class:on={permsDefaults.profile === p.id}
              disabled={permsSaving} onclick={() => savePerms({ profile: p.id })}>
              <span class="czp-perms-check">{permsDefaults.profile === p.id ? '✓' : ''}</span>
              <span class="czp-perms-name">{p.id}</span>
              {#if p.description}<span class="czp-perms-desc">{p.description}</span>{/if}
            </button>
          {/each}
          {#if !permsProfiles.length}<div class="czp-empty">{t('暂无可用 profile')}</div>{/if}
        </div>
      {/if}
      <div class="czp-perms-foot">
        <button class="act" disabled={permsSaving} onclick={resetPerms}>{t('恢复默认')}</button>
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
  /* 技能页签的「重新扫描」：右对齐小按钮（绕过缓存、让上游重扫磁盘）。 */
  .czp-refresh { max-width: 1080px; margin: 0 auto 10px; display: flex; justify-content: flex-end; }
  .czp-refresh button { font-size: 12px; padding: 5px 12px; border-radius: 8px; color: inherit;
    border: 1px solid color-mix(in srgb, currentColor 20%, transparent); }
  .czp-refresh button:disabled { opacity: .45; }
  /* 技能卡的描述与 SKILL.md 路径（路径超长截断，title 悬停看全路径）。 */
  .cdesc { font-size: 12.5px; line-height: 1.6; opacity: .75; }
  .cpath { font-size: 11px; font-family: var(--mono, ui-monospace, monospace); opacity: .5;
    overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  /* 权限页签（P4）：四组单选 + 恢复默认，照菜单的文案（沙箱/审批/审批人/profile）。 */
  .czp-perms-note { max-width: 1080px; margin: 0 auto 14px; font-size: 12.5px; opacity: .6; line-height: 1.5; }
  .czp-perms-group { max-width: 1080px; margin: 0 auto 16px; border-top: 1px solid color-mix(in srgb, currentColor 10%, transparent); padding-top: 10px; }
  .czp-perms-label { font-size: 13px; font-weight: 600; margin-bottom: 6px; }
  .czp-perms-muted { font-size: 12.5px; opacity: .55; margin-bottom: 6px; }
  .czp-perms-row { width: 100%; display: flex; align-items: baseline; gap: 8px; padding: 8px 10px; border-radius: 10px; text-align: left; }
  @media (hover: hover) { .czp-perms-row:hover { background: color-mix(in srgb, currentColor 6%, transparent); } }
  .czp-perms-row:disabled { opacity: .4; }
  .czp-perms-row.on { background: color-mix(in srgb, currentColor 7%, transparent); }
  .czp-perms-check { width: 14px; flex: none; font-size: 12px; }
  .czp-perms-name { font-size: 14px; white-space: nowrap; }
  .czp-perms-desc { font-size: 12px; opacity: .55; margin-left: auto; text-align: right; }
  .czp-perms-foot { max-width: 1080px; margin: 4px auto 0; display: flex; justify-content: flex-end; }
</style>
