// 侧栏拖宽的公共工厂 —— Codex/Zcode 页侧栏照 Claude 页对齐时复用（ClaudePage 本体不动）。
//
// 规格照 ClaudePage.svelte（官方 claude.ai/code 同款实测）：宽度 200–420 钳制、拖拽跟手无过渡、
// 键盘可调（Home/End/方向键，键盘处理在页面侧的 sbKey 里，这里只出钳制与持久化）、
// localStorage 持久；默认 290（与 Claude 页一致）。
//
// 用法：
//   const sb = createSidebarWidth('bridge-codex-sbw');
//   sb.sbW      // 当前宽度（$state，模板直接用）
//   sb.sbDrag   // 拖拽中（把手指示条常显）
//   sb.sbDown(e)  // 把手的 onpointerdown
//   sb.SB_MIN / sb.SB_MAX  // aria-valuemin/max 与键盘 Home/End 用
export function createSidebarWidth(lsKey) {
  const SB_MIN = 200, SB_MAX = 420;
  const clamp = (v) => Math.max(SB_MIN, Math.min(SB_MAX, Math.round(v)));
  let sbW = $state((() => {
    try { const v = +(localStorage.getItem(lsKey) || 0); return v ? clamp(v) : 290; } catch { return 290; }
  })());
  let sbDrag = $state(false);
  const save = () => { try { localStorage.setItem(lsKey, String(sbW)); } catch {} };
  // 把手：12px 隐形条骑缝在侧栏右缘（left = 宽-6），拖拽期间禁选字，松手落盘。
  function sbDown(e) {
    e.preventDefault();
    const el = e.currentTarget, sx = e.clientX, sw = sbW;
    sbDrag = true;
    try { el.setPointerCapture(e.pointerId); } catch {}
    document.body.style.userSelect = 'none';
    const mv = (ev) => { sbW = clamp(sw + ev.clientX - sx); };
    const up = () => { sbDrag = false; document.body.style.userSelect = ''; el.removeEventListener('pointermove', mv); save(); };
    el.addEventListener('pointermove', mv);
    el.addEventListener('pointerup', up, { once: true });
    el.addEventListener('pointercancel', up, { once: true });
  }
  // 键盘调宽（role=separator 上的方向键；与 Claude 页同一档步长 16px）。
  function sbKey(e) {
    if (e.key === 'ArrowLeft') sbW = clamp(sbW - 16);
    else if (e.key === 'ArrowRight') sbW = clamp(sbW + 16);
    else if (e.key === 'Home') sbW = SB_MIN;
    else if (e.key === 'End') sbW = SB_MAX;
    else return;
    e.preventDefault(); save();
  }
  return { SB_MIN, SB_MAX, get sbW() { return sbW; }, set sbW(v) { sbW = clamp(v); }, get sbDrag() { return sbDrag; }, sbDown, sbKey };
}
