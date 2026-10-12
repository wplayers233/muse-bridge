import test from 'node:test';
import assert from 'node:assert/strict';
import { entryName, entryInHtml, currentEntry, checkBuildDrift, watchBuildDrift } from './staleGuard.js';

// 这两条是「换版提醒」的心脏：认错/混比都会变成每次切回前台就弹一次假提示，
// 比不提示更烦人——所以单独盯死。

test('entryName: 认出构建产物的入口脚本名，dev 源码路径一律不认', () => {
  assert.equal(entryName('https://h/app/assets/index-DVD_k6av.js'), 'index-DVD_k6av.js');
  assert.equal(entryName('http://127.0.0.1:8787/app/assets/solo-Bx1y2z.js?v=1'), 'solo-Bx1y2z.js');
  assert.equal(entryName('https://h/app/assets/index-DVD_k6av.js#x'), 'index-DVD_k6av.js');
  assert.equal(entryName('http://127.0.0.1:5173/src/lib/staleGuard.js'), '');   // dev
  assert.equal(entryName('https://h/app/assets/app-main-CxCSbch2.css'), '');    // 不是 js 入口
  assert.equal(entryName(''), '');
});

test('entryInHtml: 从 HTML 里挑出同一族的入口（index 比 index、solo 比 solo）', () => {
  const html = '<script type="module" crossorigin src="/app/assets/index-DVD_k6av.js"></script>'
    + '<link rel="modulepreload" href="/app/assets/solo-Bx1y2z.js">';
  assert.equal(entryInHtml(html, 'index-DVD_k6av.js'), 'index-DVD_k6av.js');   // 同名 → 还是最新
  assert.equal(entryInHtml(html, 'index-OLDHASH1.js'), 'index-DVD_k6av.js');   // 索引入口换了
  assert.equal(entryInHtml(html, 'solo-Bx1y2z.js'), 'solo-Bx1y2z.js');         // solo 页不该被 index 的 hash 带偏
  assert.equal(entryInHtml(html, 'solo-OLDHASH1.js'), 'solo-Bx1y2z.js');
});

test('entryInHtml: 认不出（页面结构变了 / 空 HTML）时返回空，绝不假报换版', () => {
  assert.equal(entryInHtml('<html><body>not found</body></html>', 'index-DVD_k6av.js'), '');
  assert.equal(entryInHtml('', 'index-DVD_k6av.js'), '');
  assert.equal(entryInHtml('<script src="/static/index-A1b2C3.js"></script>', 'index-DVD_k6av.js'), '');
  assert.equal(entryInHtml('<script src="/app/assets/index-A1b2C3.js"></script>', ''), '');
  // 挂在根上（/assets/…）与挂在 /app 下（/app/assets/…）是同一份文件，都认
  assert.equal(entryInHtml('<script src="/assets/index-A1b2C3.js"></script>', 'index-DVD_k6av.js'), 'index-A1b2C3.js');
});

test('currentEntry: 从页面上的入口 <script> 读，而不是从本模块自己的 chunk 名读', () => {
  // 真机上入口 index-*.js 只是几百字节的加载器，staleGuard 被打进的是别的 chunk——
  // 用 import.meta.url 去比会永远对不上（功能静默失效），所以必须读 DOM 里的那个。
  const doc = (src) => ({ querySelector: (sel) => (sel === 'script[type="module"][src]' && src ? { getAttribute: () => src } : null) });
  assert.equal(currentEntry(doc('/app/assets/index-BcKib6NP.js')), 'index-BcKib6NP.js');
  assert.equal(currentEntry(doc('./assets/solo-Xy1.js')), 'solo-Xy1.js');
  assert.equal(currentEntry(doc('/src/main.js')), '');      // dev：没有 hash 名，不查
  assert.equal(currentEntry(doc(null)), '');
  assert.equal(currentEntry(null), '');                      // 没有 DOM（node）也不炸
});

test('checkBuildDrift: 进不去构建产物（dev）就整个不查', async () => {
  assert.equal(await checkBuildDrift(''), '');
  assert.equal(await checkBuildDrift('/src/lib/staleGuard.js'), '');
});

test('checkBuildDrift: 拿得到页面 → fresh / drifted；拿不到 → 静默', async (t) => {
  const cur = 'index-DVD_k6av.js';
  const stub = (impl) => { t.mock.method(globalThis, 'fetch', impl); };
  const html = (name) => '<script type="module" src="/app/assets/' + name + '"></script>';

  stub(async () => ({ ok: true, text: async () => html('index-DVD_k6av.js') }));
  assert.equal(await checkBuildDrift(cur), 'fresh');

  stub(async () => ({ ok: true, text: async () => html('index-NEWHASH.js') }));
  assert.equal(await checkBuildDrift(cur), 'drifted');

  stub(async () => { throw new Error('offline'); });
  assert.equal(await checkBuildDrift(cur), '', '断网时静默，不弹提示');

  stub(async () => ({ ok: false, text: async () => '' }));
  assert.equal(await checkBuildDrift(cur), '');
});

test('watchBuildDrift: 60s 内只问一次（切来切去不刷请求）', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return { ok: true, text: async () => '<script src="/app/assets/index-DVD_k6av.js"></script>' }; });
  await watchBuildDrift(true, 'index-DVD_k6av.js');    // 这一发真的去问
  const first = calls;
  await watchBuildDrift(false, 'index-DVD_k6av.js');   // 紧接着的第二次：被 60s 闸门挡住
  assert.equal(calls, first, '60s 内不该再发请求');
  assert.ok(first > 0);
});
