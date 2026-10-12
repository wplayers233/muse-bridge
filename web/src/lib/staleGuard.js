// 构建漂移自愈：前端重新构建/部署后，旧页面里 vite 懒加载的 chunk（内容 hash 文件名）
// 已被替换，动态 import 报「Failed to fetch dynamically imported module」——预览器/编辑器
// 等一切懒加载功能看起来就是「坏了」。vite 在这类失败时向 window 派发 'vite:preloadError'，
// 收到就整页刷新一次拿新构建。60s 防循环：刚刷过还失败＝不是版本漂移（网络/服务端问题），
// 放行错误交还组件级错误 UI。构建侧同时保留旧资产（vite.config keepOldAssets），双保险。
const KEY = 'bridge-stale-reload';

function recentlyReloaded() {
  try { return Date.now() - (Number(sessionStorage.getItem(KEY)) || 0) < 60_000; } catch { return false; }
}

export function reloadForNewBuild() {
  if (recentlyReloaded()) return false;
  try { sessionStorage.setItem(KEY, String(Date.now())); } catch {}
  location.reload();
  return true;
}

// 组件 catch 块兜底（vite:preloadError 覆盖不到的手写 import() 失败路径）：
// 是 stale-chunk 形状的错误就地刷新自愈，返回 true=已接管（调用方别再画错误态）。
const STALE_RE = /dynamically imported module|Importing a module script failed|error loading dynamically imported/i;
export function recoverStaleChunk(err) {
  if (!STALE_RE.test(String(err?.message || err || ''))) return false;
  return reloadForNewBuild();
}

if (typeof window !== 'undefined') {
  window.addEventListener('vite:preloadError', (event) => {
    if (reloadForNewBuild()) event.preventDefault();   // 吞掉错误：马上刷新，别闪错误态
  });
}

// ── 静默换版提醒 ─────────────────────────────────────────────────────────────
// 上面那套只在「已经撞上 404」时才救场。真机上更常见的是另一种：服务器早就发了新版，
// 但页面一直开着（安卓壳尤其明显——WebView 停在后台，回到前台不会重新加载），用户看到的
// 还是老界面，于是「明明修了怎么还是这样」。这里在页面重新可见/获得焦点时，轻量地问一次
// 服务器「入口脚本还是不是我这个」，变了就提示刷新（不自动刷：正在跑的对话会被打断，
// 该由用户挑时候）。
//
// 入口脚本名带内容 hash（index-DVD_k6av.js），换版必变；index.html 是 no-store，拿得到新的。
// 只比「同一族」的文件（index 比 index、solo 比 solo）——两个入口各有各的 hash，混比必假报。
const DRIFT_KEY = 'bridge-drift-notified';
const DRIFT_EVERY = 60_000;      // 两次检查至少隔 60s（切来切去不刷请求）
let driftAt = 0;

/** 入口脚本名（不含路径）：index-DVD_k6av.js / solo-Bx1y2z.js；不是构建产物（dev）→ ''。 */
export function entryName(url) {
  const m = /\/assets\/([A-Za-z0-9_-]+\.js)(?:[?#]|$)/.exec(String(url || ''));
  return m ? m[1] : '';
}

/** 页面真正加载的那个入口脚本名。
 *  不能用 import.meta.url 代替：本模块会被打进某个 chunk，而 chunk 名与入口名无关
 *  （实测入口 index-*.js 只是个几百字节的加载器，真正代码在别的 chunk 里），
 *  拿它去和 index.html 里的入口名比会永远对不上、功能静默失效。 */
export function currentEntry(doc = typeof document === 'undefined' ? null : document) {
  const tag = doc && doc.querySelector && doc.querySelector('script[type="module"][src]');
  return tag ? entryName(tag.getAttribute('src')) : '';
}

/** 从 index.html / solo.html 里挑出与 cur 同族的入口脚本名；没有 → ''。 */
export function entryInHtml(html, cur) {
  const fam = String(cur || '').replace(/-[A-Za-z0-9_-]+\.js$/, '');
  if (!fam) return '';
  const m = new RegExp(`/assets/(${fam}-[A-Za-z0-9_-]+\\.js)(?:["'?]|$)`).exec(String(html || ''));
  return m ? m[1] : '';
}

/** 问一次服务器：我这份还是最新的吗。返回 'fresh'（还是）/ 'drifted'（换版了）/ ''（问不到，别管）。 */
export async function checkBuildDrift(cur = currentEntry()) {
  if (!cur) return '';                                   // dev / 非构建产物：不查
  const html = cur.startsWith('solo-') ? '../solo.html' : '../index.html';
  try {
    const res = await fetch(new URL(html, import.meta.url), { cache: 'no-store' });
    if (!res.ok) return '';
    const next = entryInHtml(await res.text(), cur);
    if (!next) return '';                                // 认不出（页面结构变了）：别乱提示
    return next === cur ? 'fresh' : 'drifted';
  } catch { return ''; }                                 // 离线/被拦：静默
}

/** 覆盖式检查 + 提示；力竭（还没到点）返回 false。cur 只为测试注入，线上用当前页面的入口。 */
export async function watchBuildDrift(force = false, cur = currentEntry()) {
  const now = Date.now();
  if (!force && now - driftAt < DRIFT_EVERY) return false;
  driftAt = now;
  if (await checkBuildDrift(cur) !== 'drifted') return false;
  try { if (sessionStorage.getItem(DRIFT_KEY)) return false; sessionStorage.setItem(DRIFT_KEY, '1'); } catch {}
  const { showToast } = await import('./toast.svelte.js');
  const { t } = await import('./i18n.js');
  showToast(t('界面有新版本'), 'ok', { label: t('刷新'), fn: () => location.reload() }, 15_000);
  return true;
}

if (typeof window !== 'undefined') {
  const kick = () => { if (!document.hidden) watchBuildDrift().catch(() => {}); };
  window.addEventListener('focus', kick);
  document.addEventListener('visibilitychange', kick);
}
