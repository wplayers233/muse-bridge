// CLI 分页工作台的视图状态机（纯函数，可单测）。
//
// 从 lib/cliDock.svelte.js 里抽出来单独放一份的理由与别的 .js/.svelte.js 分工一致：
// runes（$state）要在 Svelte 编译期才能跑，测不了；而「开一张卡 / 关一张卡 / 关掉最后一张
// = 整个工作台收起」这套转移是这一层唯一容易写错的地方（多卡同开、重复点同一张、
// 关的不是最后一张……），所以把它做成纯函数钉住。
//
// views 是「此刻开着的卡」（按打开先后）。顺序有意义：最后一张 = 最近打开的那张。

/** 开一张卡。已经在开着 → 再点一次就是关掉（chip 的点击语义）。 */
export function openView(views, key) {
  if (views.includes(key)) return closeView(views, key);
  return [...views, key];
}

/** 关一张卡。没开着 → 原样返回（调用方据此判断「什么也没发生」）。 */
export function closeView(views, key) {
  if (!views.includes(key)) return views;
  return views.filter((v) => v !== key);
}
