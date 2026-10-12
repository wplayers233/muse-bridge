<script>
  // 外部 CLI agent（Codex / ZCode）的「去配置」面板。
  //
  // 两家认证方式不同，面板按 status 里有什么字段决定画什么：
  //   Codex  —— 有 keyEnv：填一把 OpenAI API key（服务器上加密落盘，跑 CLI 时注进子进程 env）。
  //   ZCode  —— 只有 login：它不认厂商 key 环境变量（Z.ai 是 Coding Plan 账号制），凭据由官方
  //             `zcode login` 的浏览器授权写进加密的 ~/.zcode/v2/，所以这里只给那条命令。
  // 两家共用的还有「工具没装时在这台机器上装」。
  //
  // 与 Claude 那一行的分别：Claude 的 token 在控制台「Claude 账号」页里管（多账号、可切换）；
  // 这两家就地展开最省事，所以做成设置页里就地展开的面板（见 SecAgents 的「去配置」）。
  import { t } from '../../lib/i18n.js';

  let { agent, status = null, onSaved = () => {} } = $props();

  // 厂商口吻按各家官方叫法（见 GLOSSARY.md §3）：交付给用户的那把 key 的名字。
  const KEY_LABEL = { codex: t('OpenAI API key') };

  let key = $state('');
  let busy = $state('');
  let msg = $state('');
  let err = $state('');
  let copied = $state('');

  const keyEnv = $derived(status?.keyEnv || '');
  const hasKeyBox = $derived(!!keyEnv);
  const login = $derived(status?.login || '');
  const hasKey = $derived(!!status?.hasKey);
  const tail = $derived(status?.keyTail || '');
  const fromEnv = $derived(status?.keySource === 'env');
  const installed = $derived(status ? status.installed !== false : true);
  const authed = $derived(status ? status.authed !== false : false);

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); copied = text; setTimeout(() => { copied = ''; }, 1500); } catch {}
  }

  async function save(clear = false) {
    if (busy) return;
    busy = clear ? 'clear' : 'save';
    msg = ''; err = '';
    try {
      const r = await fetch('/api/admin/agent-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ id: agent, key: clear ? '' : key.trim() }),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || j?.error) throw new Error(j?.error || ('HTTP ' + r.status));
      key = '';
      onSaved((j.keys || []).find((k) => k.id === agent) || null);
      msg = clear ? t('已清除') : t('已保存');
    } catch (e) { err = (e && e.message) || String(e); }
    busy = '';
  }

  async function install() {
    if (busy) return;
    busy = 'install';
    msg = ''; err = '';
    try {
      const r = await fetch('/api/admin/agent-install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ id: agent }),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || j?.error) throw new Error(j?.error || ('HTTP ' + r.status));
      msg = j.installed ? t('装好了') : t('脚本跑完了，但还是没找到命令');
    } catch (e) { err = (e && e.message) || String(e); }
    busy = '';
  }
</script>

<div class="kp">
  {#if hasKeyBox}
    <div class="kp-row">
      <span class="kp-k">{KEY_LABEL[agent] || t('API key')}</span>
      {#if hasKey}
        <code class="kp-v">••••{tail}{fromEnv ? t('（环境变量）') : ''}</code>
      {:else}
        <span class="kp-v kp-muted">{t('还没配')}</span>
      {/if}
    </div>
    <div class="kp-form">
      <input class="kp-in" type="password" bind:value={key}
        placeholder={keyEnv ? t('粘贴 {env}', { env: keyEnv }) : t('粘贴 API key')}
        autocomplete="off" autocapitalize="off" spellcheck="false"
        onkeydown={(e) => { if (e.key === 'Enter') save(false); }} />
      <button class="kp-btn pri" disabled={!!busy || !key.trim()} onclick={() => save(false)}>
        {busy === 'save' ? t('保存中…') : t('保存')}
      </button>
      {#if hasKey}
        <button class="kp-btn" disabled={!!busy} onclick={() => save(true)}>{busy === 'clear' ? t('清除中…') : t('清除')}</button>
      {/if}
    </div>
    <div class="kp-hint">
      {t('存在服务器的加密凭据里（只回显尾 4 位），跑 CLI 时注进 {env}；环境变量里已有的那把不用填。', { env: keyEnv || 'API_KEY' })}
    </div>
  {/if}

  {#if login}
    <div class="kp-row">
      <span class="kp-k">{t('登录')}</span>
      {#if authed}
        <span class="kp-v kp-muted">{t('已登录')}</span>
      {:else}
        <span class="kp-v kp-muted">{t('还没登录')}</span>
      {/if}
    </div>
    <div class="kp-form">
      <code class="kp-cmd">{login}</code>
      <button class="kp-btn" disabled={!!busy} onclick={() => copy(login)}>
        {copied === login ? t('已复制') : t('复制')}
      </button>
    </div>
    <div class="kp-hint">
      {#if agent === 'zcode'}
        {t('在服务器上跑一次这条命令完成授权（浏览器打开它给的链接，登录你的智谱 / Z.ai 账号）。登录态存在服务器上。')}
        <br>
        {t('两个版本各一条：智谱国内版 zcode login bigmodel，Z.ai 国际版 zcode login zai；不认 API key。')}
      {:else}
        {t('在服务器上跑一次这条命令完成登录（浏览器里点一下）。')}
      {/if}
    </div>
  {/if}

  {#if !installed}
    <div class="kp-hint">
      {t('这台机器上还没装它：分页里的「接入」卡有安装命令；装好点一次「重新检测」。')}
      <button class="kp-btn" disabled={!!busy} onclick={install}>{busy === 'install' ? t('安装中…') : t('在这台机器上装')}</button>
    </div>
  {/if}

  {#if msg}<div class="kp-ok">{msg}</div>{/if}
  {#if err}<div class="kp-err">{err}</div>{/if}
</div>

<style>
  .kp { display: flex; flex-direction: column; gap: 8px; padding: 10px 0 12px; }
  .kp-row { display: flex; align-items: center; gap: 10px; font-size: 13.5px; }
  .kp-k { color: var(--st-muted); }
  .kp-v { font-family: var(--mono, ui-monospace, monospace); font-size: 12.5px; }
  .kp-muted { color: var(--st-muted); font-family: inherit; }
  .kp-form { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .kp-in {
    flex: 1; min-width: 180px; height: 32px; padding: 0 12px; border: 0; border-radius: 8px; outline: none;
    background: var(--st-field); box-shadow: inset 0 0 0 1px var(--st-line); color: var(--text); font: inherit; font-size: 14px;
  }
  .kp-in:focus { box-shadow: inset 0 0 0 1px var(--st-accent), 0 0 0 3px color-mix(in srgb, var(--st-accent) 22%, transparent); }
  .kp-cmd { flex: 1; min-width: 180px; padding: 7px 12px; border-radius: 8px; font-family: var(--mono, ui-monospace, monospace);
    font-size: 12.5px; background: var(--st-field); box-shadow: inset 0 0 0 1px var(--st-line); overflow-x: auto; white-space: nowrap; }
  .kp-btn { height: 28px; padding: 0 10px; border: 0; border-radius: 7px; cursor: pointer; font: inherit; font-size: 14px;
    background: transparent; color: var(--text); box-shadow: inset 0 0 0 1px var(--st-line); }
  .kp-btn.pri { background: var(--st-primary); color: var(--st-primary-ink); font-weight: 500; box-shadow: none; }
  .kp-btn:disabled { opacity: .45; cursor: default; }
  .kp-hint { font-size: 12.5px; line-height: 1.6; color: var(--st-muted); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .kp-hint code { font-size: 12px; }
  .kp-ok { font-size: 12.5px; color: var(--st-accent); }
  .kp-err { font-size: 12.5px; color: var(--crit); word-break: break-word; }
</style>
