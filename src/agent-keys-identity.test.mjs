// P3 凭据隔离的存储层单测：key 按 ctx.dataDir 分库、CLI 数据目录只给 user 设。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { homedir } from 'node:os';

const { AGENT_KEYS_DIR, keyDirFor, cliDataEnv, cliSpawnKeyEnv, setAgentKey, savedAgentKey, agentKeyState, cliKeyEnv }
  = await import('./runtime/agent-keys.mjs');

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'agent-keys-iso-'));

// 落盘要过 extension-secrets 的加密（Windows 用 DPAPI，Linux 用 libsecret/文件）。
// 个别环境（如本开发机的沙箱）spawn 不了系统 shell，DPAPI 一律 EBUSY——这类环境跳过
// 「真写盘」的用例（语义与平台无关，服务器 Linux 上照跑）。
const persistProbe = setAgentKey('codex', 'sk-probe-only');
setAgentKey('codex', '');
const CAN_PERSIST = !persistProbe.error;

test('keyDirFor：admin 的 dataDir=ROOT → 全局目录（零迁移）；user 各自 .bridge/agents', () => {
  assert.equal(keyDirFor({ kind: 'admin', dataDir: AGENT_KEYS_DIR.replace(/[\\/]agents$/, '') }), AGENT_KEYS_DIR);
  const u = { kind: 'user', dataDir: tmp() };
  assert.equal(keyDirFor(u), path.join(u.dataDir, 'agents'));
});

test('cliDataEnv：只对 user 设 CODEX_HOME / ZCODE_DATA_BASE_DIR；admin/share 不设（继承宿主）', () => {
  const u = { kind: 'user', dataDir: tmp() };
  const env = cliDataEnv(u);
  assert.equal(env.CODEX_HOME, path.join(u.dataDir, 'cli', 'codex'));
  assert.equal(env.ZCODE_DATA_BASE_DIR, path.join(u.dataDir, 'cli'));
  assert.deepEqual(cliDataEnv({ kind: 'admin', dataDir: tmp() }), {}, 'admin 不设 = 继承宿主（向后兼容关键）');
  assert.deepEqual(cliDataEnv({ kind: 'share', dataDir: tmp() }), {});
  assert.deepEqual(cliDataEnv(null), {});
});

test('key 按身份分库：user A、user B、全局互不可见', { skip: CAN_PERSIST ? false : '本机加密不可用（DPAPI EBUSY）' }, () => {
  const a = { kind: 'user', dataDir: tmp() };
  const b = { kind: 'user', dataDir: tmp() };
  const r1 = setAgentKey('codex', 'sk-aaaa-tail1', keyDirFor(a));
  assert.ok(r1.ok, JSON.stringify(r1));
  const r2 = setAgentKey('codex', 'sk-bbbb-tail2', keyDirFor(b));
  assert.ok(r2.ok);
  assert.equal(savedAgentKey('codex', keyDirFor(a)), 'sk-aaaa-tail1');
  assert.equal(savedAgentKey('codex', keyDirFor(b)), 'sk-bbbb-tail2');
  assert.equal(savedAgentKey('codex'), '', '全局（admin）没存过还是空');
  // 状态视图也按目录走
  assert.equal(agentKeyState('codex', process.env, keyDirFor(a)).tail, 'ail1');
  assert.equal(agentKeyState('codex', process.env, keyDirFor(b)).tail, 'ail2');
  // 清理
  setAgentKey('codex', '', keyDirFor(a));
  setAgentKey('codex', '', keyDirFor(b));
  assert.equal(savedAgentKey('codex', keyDirFor(a)), '');
});

test('cliSpawnKeyEnv：默认不共享 admin 的 key（cliKeyShare 关）；开了才回落', { skip: CAN_PERSIST ? false : '本机加密不可用（DPAPI EBUSY）' }, () => {
  const admin = { kind: 'admin', dataDir: AGENT_KEYS_DIR.replace(/[\\/]agents$/, '') };
  const u = { kind: 'user', dataDir: tmp() };
  try {
    setAgentKey('codex', 'sk-global-admin');
    // 用户没填自己的：cliKeyShare 默认关 → 不注入
    assert.deepEqual(cliSpawnKeyEnv(u, 'codex'), {});
    // admin 自己：全局那把照常注入
    assert.deepEqual(cliSpawnKeyEnv(admin, 'codex'), { OPENAI_API_KEY: 'sk-global-admin' });
  } finally {
    setAgentKey('codex', '');
  }
});

test('cliKeyEnv / setAgentKey 缺省 dir 时行为与从前一致（向后兼容）', { skip: CAN_PERSIST ? false : '本机加密不可用（DPAPI EBUSY）' }, () => {
  try {
    setAgentKey('codex', 'sk-legacy');
    assert.equal(savedAgentKey('codex'), 'sk-legacy');
    assert.deepEqual(cliKeyEnv('codex'), { OPENAI_API_KEY: 'sk-legacy' });
  } finally {
    setAgentKey('codex', '');
  }
  assert.equal(savedAgentKey('codex'), '');
});

test('user 的 CLI 数据目录指向真实存在的独立路径（不与宿主默认目录相撞）', () => {
  const u = { kind: 'user', dataDir: tmp() };
  const env = cliDataEnv(u);
  // Windows 的系统临时目录本身就在用户目录下，不能拿 homedir() 当判据；
  // 要钉住的是「不等于宿主默认值」（~/.codex / ~）。
  assert.notEqual(env.CODEX_HOME, path.join(homedir(), '.codex'));
  assert.notEqual(env.ZCODE_DATA_BASE_DIR, homedir());
  assert.ok(env.ZCODE_DATA_BASE_DIR.startsWith(u.dataDir), '落在该用户自己的数据目录里');
});
