// 审批决策的白名单：前端传回来的东西在转给 CLI 之前必须过这道闸。
//
// 为什么单测它：这是「浏览器 → 服务端 → CLI」这条路上唯一的输入校验点。上游只认
// CommandExecutionRequestApprovalResponse 里那几个枚举值，但我们的端点是对外暴露的——
// 没有这道闸，任何登录用户都能把任意字符串/对象塞进 CLI 的审批应答里。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.env.BRIDGE_DATA_ROOT) process.env.BRIDGE_DATA_ROOT = mkdtempSync(path.join(os.tmpdir(), 'bridge-apd-'));
const { normApprovalDecision } = await import('./routes/agent-cli.mjs');

test('认这四个枚举值', () => {
  for (const d of ['accept', 'acceptForSession', 'decline', 'cancel']) {
    assert.equal(normApprovalDecision(d), d);
  }
});

test('不认的值一律拒绝（不是「原样放过」）', () => {
  assert.equal(normApprovalDecision('yes'), null);
  assert.equal(normApprovalDecision('accept '), null, '不做 trim：上游枚举是精确匹配');
  assert.equal(normApprovalDecision('ACCEPT'), null);
  assert.equal(normApprovalDecision(''), null);
  assert.equal(normApprovalDecision(null), null);
  assert.equal(normApprovalDecision(undefined), null);
  assert.equal(normApprovalDecision(123), null);
  assert.equal(normApprovalDecision(['accept']), null);
  // 原型链上的东西不能混进来
  assert.equal(normApprovalDecision('constructor'), null);
  assert.equal(normApprovalDecision('toString'), null);
});

test('对象形式只认 acceptWithExecpolicyAmendment 这一个键，且内容是字符串数组', () => {
  const ok = normApprovalDecision({ acceptWithExecpolicyAmendment: { execpolicy_amendment: ['cmd', 'ls'] } });
  assert.deepEqual(ok, { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['cmd', 'ls'] } });
  // 键名对但内容不是数组 → 不认
  assert.equal(normApprovalDecision({ acceptWithExecpolicyAmendment: { execpolicy_amendment: 'x' } }), null);
  assert.equal(normApprovalDecision({ acceptWithExecpolicyAmendment: {} }), null);
  // 别的键一律不认
  assert.equal(normApprovalDecision({ somethingElse: 1 }), null);
  assert.equal(normApprovalDecision({}), null);
  // 数组元素强制成字符串（对象塞进来会变成 "[object Object]"，不再是可执行的形状）
  const coerced = normApprovalDecision({ acceptWithExecpolicyAmendment: { execpolicy_amendment: [{ a: 1 }, 'ls'] } });
  assert.deepEqual(coerced.execpolicyWithExecpolicyAmendment, undefined);
  assert.deepEqual(coerced.acceptWithExecpolicyAmendment.execpolicy_amendment, ['[object Object]', 'ls']);
});
