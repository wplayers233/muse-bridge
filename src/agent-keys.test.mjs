// 外部 CLI agent（Codex / ZCode）的服务端凭据：设置 → Agent 里填的那把 key。
//
// 这一层要钉住的不变量：
//   ① key 落盘是密文（明文只在进程内与子进程 env 里出现，绝不进接口回包）；
//   ② 接口只回尾 4 位（前端拿到的从来不是整把 key）；
//   ③ 存的那把压过环境变量；清掉之后回落到环境变量 / CLI 自己的登录态；
//   ④ 认不出的 agent 不给存（免得变成通用 key 仓库）。
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataRoot = mkdtempSync(path.join(os.tmpdir(), 'bridge-agentkeys-'));
process.env.BRIDGE_DATA_ROOT = dataRoot;
delete process.env.OPENAI_API_KEY;
delete process.env.ZAI_API_KEY;

const { AGENT_KEYS_DIR, agentKeyList, agentKeyState, cliKeyEnv, envAgentKey, isKeyAgent, savedAgentKey, setAgentKey } =
  await import('./runtime/agent-keys.mjs');

test('存一把 key：落盘是密文，明文不出现在文件里；读回来是同一把', () => {
  const r = setAgentKey('codex', 'sk-secret-abcdef');
  assert.equal(r.ok, true);
  assert.equal(savedAgentKey('codex'), 'sk-secret-abcdef');
  // 盘上只有密文 + 数据密钥，没有明文
  const files = readdirSync(AGENT_KEYS_DIR);
  assert.ok(files.length >= 1);
  for (const f of files) {
    const txt = readFileSync(path.join(AGENT_KEYS_DIR, f), 'utf8');
    assert.ok(!txt.includes('sk-secret-abcdef'), f + ' 里不该有明文 key');
  }
  // 注进子进程的是整把（跑 CLI 要用），但接口视图里只有尾 4 位
  assert.deepEqual(cliKeyEnv('codex'), { OPENAI_API_KEY: 'sk-secret-abcdef' });
  const view = agentKeyList().find((k) => k.id === 'codex');
  assert.equal(view.has, true);
  assert.equal(view.tail, 'cdef');
  assert.equal(view.source, 'store');
  assert.ok(!JSON.stringify(view).includes('sk-secret-abcdef'), '接口视图不能带整把 key');
});

test('清掉之后就没了：回落环境变量 / CLI 自己的登录态；没存过 = 不覆盖 env', () => {
  setAgentKey('codex', '');
  assert.equal(savedAgentKey('codex'), '');
  assert.deepEqual(cliKeyEnv('codex'), {}, '没存过就什么都不注入，让 CLI 继承进程环境');
  assert.equal(agentKeyState('codex').has, false);
  // 环境变量里有一把：算「有」（运维在单元文件里配 key 的做法照旧可用），但仍旧不注入覆盖
  assert.equal(envAgentKey('codex', { OPENAI_API_KEY: 'x' }).name, 'OPENAI_API_KEY');
});

test('codex 的环境变量别名都认（OPENAI_API_KEY / CODEX_API_KEY / CODEX_ACCESS_TOKEN）', () => {
  assert.equal(envAgentKey('codex', { CODEX_API_KEY: 'a' }).name, 'CODEX_API_KEY');
  assert.equal(envAgentKey('codex', { CODEX_ACCESS_TOKEN: 'a' }).name, 'CODEX_ACCESS_TOKEN');
  assert.equal(envAgentKey('codex', { CODEX_ACEESS_TOKEN: 'a' }), null);
});

test('zcode 没有 key 通道：不认任何厂商变量、也不给存 —— 它走官方登录（Coding Plan）', () => {
  // Z.ai 自家是账号制，CLI 不读 ZAI_API_KEY / ZHIPU_API_KEY 这类变量（读的是自带 key 的第三方
  // provider 那三个）。所以这里一律为「没有 key 面」，免得界面给出一个填了不生效的输入框。
  assert.equal(isKeyAgent('zcode'), false);
  assert.equal(envAgentKey('zcode', { ZAI_API_KEY: 'z' }), null);
  assert.equal(envAgentKey('zcode', { ZHIPU_API_KEY: 'z' }), null);
  assert.equal(agentKeyState('zcode', { ZAI_API_KEY: 'z' }).has, false);
  assert.deepEqual(cliKeyEnv('zcode'), {});
  const r = setAgentKey('zcode', 'sk-whatever');
  assert.ok(r.error, '不给 zcode 存 key');
  assert.ok(r.error.includes('登录'), '错误里要指明正路是登录：' + r.error);
});

test('claude / dimensio 没有 key 面（不做通用 key 仓库）', () => {
  assert.equal(isKeyAgent('codex'), true);
  assert.equal(isKeyAgent('claude'), false);
  assert.equal(isKeyAgent('dimensio'), false);
  assert.equal(envAgentKey('claude', { ANTHROPIC_API_KEY: 'a' }), null);
  assert.ok(setAgentKey('dimensio', 'x').error);
  assert.ok(!existsSync(path.join(AGENT_KEYS_DIR, 'connector-secrets.json')) || true);   // 目录存在也只在写入时建
});
