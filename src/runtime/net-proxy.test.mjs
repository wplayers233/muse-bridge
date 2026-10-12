import test from 'node:test';
import assert from 'node:assert/strict';
import { decideOutbound } from './net-proxy.mjs';

// 出口状态机。与 harness/server/net-proxy.test.ts 同源——两边判据必须一致，否则
// bridge 和 harness 会对同一网络给出不同结论（子进程还继承 bridge 的 env）。
// 测的是最难手工复现的两条：迟滞（单次抖动不许切走出口）与粘滞（两条路都验不通时
// 绝不主动切进「完全不能出海」的直连）。DIRECT_HYSTERESIS 当前为 2。

const P = 'http://127.0.0.1:7897';
const proxyD = { kind: 'proxy', proxy: P, reason: '探测到可用本地代理' };
const directD = { kind: 'direct', proxy: '', reason: '直连已验证可出海' };
const unknownD = { kind: 'unknown', proxy: '', reason: '代理与直连均未验证通过' };

test('探到可用代理：立即采用并记为 lastGood', () => {
  const r = decideOutbound({ proxy: '', mode: 'auto' }, proxyD, { lastGood: '', directStreak: 0 });
  assert.equal(r.proxy, P);
  assert.equal(r.verified, true);
  assert.equal(r.lastGood, P);
  assert.equal(r.directStreak, 0);
});

test('迟滞：用着代理时第一次判定为直连不切走，第二次才切', () => {
  const first = decideOutbound({ proxy: P, mode: 'auto' }, directD, { lastGood: P, directStreak: 0 });
  assert.equal(first.proxy, P, '第一次不该切');
  assert.match(first.reason, /迟滞观察/);
  const second = decideOutbound({ proxy: first.proxy, mode: 'auto' }, directD, {
    lastGood: first.lastGood, directStreak: first.directStreak,
  });
  assert.equal(second.proxy, '');
  assert.equal(second.verified, true);
});

test('本来就是直连时，直连结论不受迟滞拖延', () => {
  const r = decideOutbound({ proxy: '', mode: 'auto' }, directD, { lastGood: '', directStreak: 0 });
  assert.equal(r.proxy, '');
  assert.doesNotMatch(r.reason, /迟滞/);
});

test('粘滞：两条路都没验证通过时粘住当前代理', () => {
  const r = decideOutbound({ proxy: P, mode: 'auto' }, unknownD, { lastGood: P, directStreak: 0 });
  assert.equal(r.proxy, P, '绝不能因为探不通就切进直连');
  assert.equal(r.verified, false);
  assert.match(r.reason, /保持上次可用配置/);
});

test('粘滞：当前是直连但历史上有可用代理时回退到它', () => {
  const r = decideOutbound({ proxy: '', mode: 'auto' }, unknownD, { lastGood: P, directStreak: 0 });
  assert.equal(r.proxy, P);
  assert.equal(r.verified, false);
});

test('从没探到过代理、直连也验不通：如实说没有已验证出口', () => {
  const r = decideOutbound({ proxy: '', mode: 'auto' }, unknownD, { lastGood: '', directStreak: 0 });
  assert.equal(r.proxy, '');
  assert.equal(r.verified, false);
  assert.match(r.reason, /无已验证出口/);
});

// 实锤过的坑：Node 的内置 fetch 不认 HTTP_PROXY/HTTPS_PROXY，要 NODE_USE_ENV_PROXY=1 才走代理。
// 外部 CLI（zcode）自己就是用内置 fetch 的，漏了它登录与每一轮都报 "fetch failed"。
test('配了代理就顺手设上 NODE_USE_ENV_PROXY=1（Node 内置 fetch 只认它）', async () => {
  const { initOutboundProxy } = await import('./net-proxy.mjs');
  const saved = { HTTPS_PROXY: process.env.HTTPS_PROXY, NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY };
  try {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7897';
    delete process.env.NODE_USE_ENV_PROXY;
    const st = await initOutboundProxy();     // 环境里已有代理 → 走「沿用」分支，不出网
    assert.equal(st.proxy, 'http://127.0.0.1:7897');
    assert.equal(process.env.NODE_USE_ENV_PROXY, '1', '不设这一句，子进程里的 fetch 会裸直连');
  } finally {
    if (saved.HTTPS_PROXY === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = saved.HTTPS_PROXY;
    if (saved.NODE_USE_ENV_PROXY === undefined) delete process.env.NODE_USE_ENV_PROXY; else process.env.NODE_USE_ENV_PROXY = saved.NODE_USE_ENV_PROXY;
  }
});
