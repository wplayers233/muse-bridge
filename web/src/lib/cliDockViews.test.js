// CLI 分页工作台的视图状态机（开一张卡 / 关一张卡 / 关掉最后一张 = 整个工作台收起）。
//
// 这一层是 CliDock 唯一容易写错的地方，而它跑在浏览器里（这台机器没有浏览器可验），
// 所以把转移抽成纯函数钉住：
//   · 点已经开着的那张 = 关掉它（chip 的点击语义，不是「再加一遍」）；
//   · 关不是最后一张时，剩下的顺序不乱、view（聚焦的那张）落到次新的一张；
//   · 关掉最后一张 → 空数组，调用方据此把整个工作台收起。
import test from 'node:test';
import assert from 'node:assert/strict';
import { closeView, openView } from './cliDockViews.js';

test('openView：依次开三张，顺序 = 打开先后（最后一张是最近打开的）', () => {
  let v = [];
  v = openView(v, 'review');
  assert.deepEqual(v, ['review']);
  v = openView(v, 'term');
  assert.deepEqual(v, ['review', 'term']);
  v = openView(v, 'files');
  assert.deepEqual(v, ['review', 'term', 'files'], '顺序不能乱：view（聚焦）取的是最后一张');
});

test('openView：点已经开着的那张 = 关掉它（不是再压一遍）', () => {
  assert.deepEqual(openView(['review', 'term'], 'review'), ['term']);
  assert.deepEqual(openView(['term'], 'term'), [], '关掉最后一张 = 空 = 整个工作台收起');
  // 关中间那张时两边的顺序都要留住
  assert.deepEqual(openView(['review', 'term', 'files'], 'term'), ['review', 'files']);
});

test('closeView：没开着的那张 → 原样返回（调用方据此判断「什么也没发生」）', () => {
  const v = ['review', 'files'];
  assert.equal(closeView(v, 'term'), v, '要返回同一个引用：调用方用 === 判「没变化」');
  assert.equal(closeView(v, 'review').length, 1);
});

test('关掉最后一张 → 空数组（调用方据此把整个工作台收起）', () => {
  assert.deepEqual(closeView(['review'], 'review'), []);
  assert.equal(closeView(['review', 'term'], 'review').length, 1);
  assert.equal(closeView(['review'], 'term').length, 1, '关没开着的那张，张数不变');
});

test('开开关关之后仍能回到空（不会把已关的卡留在列表里）', () => {
  let v = [];
  for (const k of ['review', 'term', 'files', 'review', 'files', 'term']) v = openView(v, k);
  assert.deepEqual(v, [], '每一张都被点了偶数次 → 全关');
  // 交错：开两张、关一张、再开回来
  v = openView(openView(openView([], 'review'), 'term'), 'files');
  assert.deepEqual(v, ['review', 'term', 'files']);
  v = closeView(v, 'files');
  assert.deepEqual(v, ['review', 'term']);
  v = openView(v, 'files');
  assert.deepEqual(v, ['review', 'term', 'files'], '重新打开的排在末尾（最近打开）');
});
