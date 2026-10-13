<script>
  // CLI 输入卡的加号菜单：照 Claude 页 AddMenu 的壳，精简到两项目（添加图片 / 添加文件）。
  // CLI 附件不走 Claude 的 /api/upload 服务器池，而是内存 dataURL（lib/cliChat 的 images 链路），
  // 所以这里只管「点了哪一项」，附件状态全留在 CliChat——props 只给回调，不收状态。
  // cli 页没有 Claude 页的 --hover token，hover 底用 color-mix(currentColor 8%) 自己调。
  import { t } from '../../lib/i18n.js';
  let { dir = 'up', onPickPhotos, onPickFiles, onClose } = $props();

  const close = () => onClose && onClose();
  function photos() { close(); onPickPhotos && onPickPhotos(); }
  function files() { close(); onPickFiles && onPickFiles(); }
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') close(); }} />

<button class="am-backdrop" aria-label={t('关闭')} onclick={close}></button>
<div class="am" class:down={dir === 'down'} role="menu">
  {#if onPickPhotos}
    <button class="am-row" onclick={photos}>
      <svg class="am-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="15" rx="2.7"/><circle cx="9" cy="9.7" r="1.6"/><path d="m4 17.2 4.6-4.6a1.6 1.6 0 0 1 2.2 0l5.7 5.7"/><path d="m14.3 15.4 1.6-1.6a1.6 1.6 0 0 1 2.2 0l2.4 2.4"/></svg>
      <span class="am-name">{t('添加图片')}</span>
    </button>
  {/if}
  <button class="am-row" onclick={files}>
    <svg class="am-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5 12.6 20a5.2 5.2 0 0 1-7.4-7.4l8.2-8.2a3.5 3.5 0 0 1 5 5l-8.2 8.2a1.8 1.8 0 0 1-2.5-2.5l7.5-7.6"/></svg>
    <span class="am-name">{onPickPhotos ? t('添加文件') : t('添加附件')}</span>
  </button>
</div>

<style>
  .am-backdrop { position: fixed; inset: 0; z-index: 60; }
  .am {
    position: absolute; bottom: calc(100% + 8px); left: 0; z-index: 61;
    min-width: 220px; max-width: min(320px, calc(100vw - 32px)); padding: 6px;
    background: var(--q-card, var(--card, #2c2c2a)); border-radius: 16px; box-shadow: var(--q-shadow, 0 8px 28px rgba(0,0,0,.35));
    max-height: 60vh; overflow-y: auto;
  }
  .am.down { bottom: auto; top: calc(100% + 8px); }
  .am-row { width: 100%; display: flex; align-items: center; gap: 11px; padding: 10px 12px; border-radius: 11px; text-align: left; }
  @media (hover: hover) { .am-row:hover { background: color-mix(in srgb, currentColor 8%, transparent); } }
  .am-row:active { background: color-mix(in srgb, currentColor 10%, transparent); }
  .am-ic { width: 20px; height: 20px; flex: none; opacity: .85; }
  .am-name { font-size: 14px; color: inherit; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
