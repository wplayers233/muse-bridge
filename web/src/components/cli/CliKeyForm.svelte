<script>
  // CLI 的「我自己的 API key」表单（P3 凭据隔离的 UI 面）。
  // 走 /api/cli/agent-key：admin 存的就是全局那把（dataDir=ROOT，与设置 → Agent 同一处）；
  // user 存的是自己的（<dataDir>/agents/），互不可见。接口只回尾 4 位。
  // 只有 codex 有 key 口子（zcode 只认官方登录，见 runtime/agent-keys.mjs）。
  import { t } from '../../lib/i18n.js';
  import { showToast } from '../../lib/toast.svelte.js';
  import { apiUrl } from '../../lib/server.js';
  import { authHeaders } from '../../lib/api.js';

  let { agent = 'codex', note = '' } = $props();

  let st = $state({ has: false, keyTail: '' });
  let val = $state('');
  let busy = $state(false);
  let loaded = $state(false);

  async function load() {
    try {
      const r = await fetch(apiUrl(`/api/cli/agent-key?agent=${agent}`), { headers: authHeaders(), credentials: 'same-origin' });
      const j = await r.json().catch(() => null);
      if (r.ok && j) { st = { has: !!j.has, keyTail: j.keyTail || '', note: j.note || '' }; loaded = true; }
    } catch {}
  }

  async function save(clear = false) {
    if (busy) return;
    const key = clear ? '' : String(val || '').trim();
    if (!clear && !key) return;
    busy = true;
    try {
      const r = await fetch(apiUrl('/api/cli/agent-key'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        credentials: 'same-origin',
        body: JSON.stringify({ agent, key }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || ('HTTP ' + r.status));
      st = { has: !!j.has, keyTail: j.keyTail || '' };
      val = '';
      showToast(clear ? t('已清除，回落到环境变量或 CLI 登录态') : t('已保存（只显示尾 4 位）'));
    } catch (e) {
      showToast((e && e.message) || t('没存上'), 'err');
    } finally {
      busy = false;
    }
  }

  load();
</script>

<div class="ckf">
  <div class="ckf-row">
    <span class="ckf-k">{t('API Key')}</span>
    <span class="ckf-v mono">
      {#if st.has}{t('已存 · 尾 {tail}', { tail: st.keyTail })}{:else}{t('没存')}{/if}
    </span>
  </div>
  {#if note || st.note}
    <div class="ckf-note">{note || st.note}</div>
  {/if}
  <div class="ckf-row">
    <input class="ckf-in" type="password" placeholder={st.has ? t('换一把（留空不动）') : t('粘贴你的 API Key')}
      bind:value={val} disabled={busy} autocomplete="off" spellcheck="false" />
    <button class="ckf-btn" onclick={() => save(false)} disabled={busy || !val.trim()}>{t('保存')}</button>
    {#if st.has}
      <button class="ckf-btn ghost" onclick={() => save(true)} disabled={busy}>{t('清除')}</button>
    {/if}
  </div>
</div>

<style>
  .ckf { display: flex; flex-direction: column; gap: 8px; }
  .ckf-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .ckf-k { font-size: 13px; color: color-mix(in srgb, var(--text) 60%, transparent); flex: none; }
  .ckf-v { font-size: 13px; word-break: break-all; }
  .mono { font-family: var(--mono, ui-monospace, monospace); }
  .ckf-note { font-size: 12px; color: color-mix(in srgb, var(--text) 55%, transparent); }
  .ckf-in { flex: 1; min-width: 140px; height: 32px; padding: 0 10px; border: 1px solid color-mix(in srgb, var(--text) 18%, transparent);
    border-radius: 8px; background: color-mix(in srgb, var(--text) 5%, transparent); color: var(--text); font: inherit; font-size: 13px; }
  .ckf-in:focus { outline: none; border-color: color-mix(in srgb, var(--accent, var(--text)) 55%, transparent); }
  .ckf-btn { height: 32px; padding: 0 12px; border: 0; border-radius: 8px; background: var(--accent, var(--text));
    color: var(--bg, #fff); font: inherit; font-size: 13px; cursor: pointer; }
  .ckf-btn:disabled { opacity: .45; cursor: default; }
  .ckf-btn.ghost { background: color-mix(in srgb, var(--text) 10%, transparent); color: var(--text); }
</style>
