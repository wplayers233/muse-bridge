// 「可选 agent」这条链的契约：统一 id（config/agents.mjs）→ 全局开关 + 装没装/认证探测
// （runtime/agent-status.mjs）→ 每个身份能用哪些（runtime/identity.mjs）。
//
// Codex 与 ZCode 是【外部 CLI】agent：分页与对话接口都随 bridge 自带，命令行工具要在这台机器上另装。
// 两个不变量最要紧：
//   ① 它们不默认开给注册用户（USER_DEFAULT_AGENTS 仍只有 Claude，且 multiUser:false）；
//   ② 装没装只看这台机器（PATH / 用户安装目录），没装只算提示、不把分页整个抹掉。
import { test } from 'node:test';
import assert from 'node:assert';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 数据根与「装了哪些 CLI」都在这里定死：PATH 上摆桩 codex/zcode，HOME 指向临时目录（别看见真机的 ~/.codex）。
// BRIDGE_AGENT_BIN_DIR 显式置空 = 不用「随程序自带的那一份」（release 的 node_modules/.bin 里装了
// 真的 @openai/codex）——否则这些断言会跟着开发机上装了什么变。
if (!process.env.BRIDGE_DATA_ROOT) process.env.BRIDGE_DATA_ROOT = mkdtempSync(path.join(os.tmpdir(), 'bridge-agents-'));
const stubDir = mkdtempSync(path.join(os.tmpdir(), 'bridge-agentbins-'));
const fakeHome = mkdtempSync(path.join(os.tmpdir(), 'bridge-agenthome-'));
for (const n of ['codex', 'zcode']) {
  const p = path.join(stubDir, n);
  writeFileSync(p, '#!/bin/sh\nexit 0\n');
  chmodSync(p, 0o755);
}
process.env.PATH = stubDir;
process.env.HOME = fakeHome;
process.env.BRIDGE_AGENT_BIN_DIR = '';
delete process.env.CODEX_HOME;
delete process.env.OPENAI_API_KEY;
delete process.env.ZAI_API_KEY;

const { AGENTS, AGENT_IDS, AGENT_BY_ID, USER_DEFAULT_AGENTS, normAgentList, screenAgents } = await import('./config/agents.mjs');
const { findCliBin, agentInstalled, agentAuthed, agentEnabled, enabledAgents, agentStatusList, agentInstallNote, setAgentSwitch, refreshAgentProbes } =
  await import('./runtime/agent-status.mjs');
const { contextFor, agentsFor } = await import('./runtime/identity.mjs');

// —— ① 表 ——
test('四个 agent 一张表：codex / zcode 挂在各自的 screen 上，且不默认传给注册用户', () => {
  assert.deepEqual([...AGENT_IDS], ['claude', 'dimensio', 'codex', 'zcode']);
  assert.deepEqual(AGENTS.map((a) => a.screen), ['claude', 'harness', 'codex', 'zcode']);
  assert.deepEqual(AGENTS.filter((a) => a.multiUser).map((a) => a.id), ['claude', 'dimensio'], '只有 claude / dimensio 支持多人');
  assert.deepEqual([...USER_DEFAULT_AGENTS], ['claude'], '新账号默认名单里没有 codex / zcode');
  assert.deepEqual(screenAgents('codex'), ['codex']);
  assert.deepEqual(screenAgents('zcode'), ['zcode']);
});

test('名单归一：认识的留下、按表内顺序、去重、大小写不敏感', () => {
  assert.deepEqual(normAgentList(['zcode', 'CODE', 'codex', 'claude', 'zcode']), ['claude', 'codex', 'zcode']);
  assert.deepEqual(normAgentList(['nope', '', null]), []);
});

// —— ② 探测 ——
test('装没装：PATH 上找得到就算装了，找不到就是没装（外部 CLI 的兜底目录也试）', () => {
  assert.equal(findCliBin('codex'), path.join(stubDir, 'codex'));
  assert.equal(findCliBin('zcode'), path.join(stubDir, 'zcode'));
  assert.equal(findCliBin('codex', { PATH: '/nonexistent-xyz', HOME: fakeHome, BRIDGE_AGENT_BIN_DIR: '' }), '');
  // 兜底：~/.local/bin 与 zcode 官方安装落点
  const home2 = mkdtempSync(path.join(os.tmpdir(), 'bridge-home2-'));
  mkdirSync(path.join(home2, '.local', 'bin'), { recursive: true });
  writeFileSync(path.join(home2, '.local', 'bin', 'zcode'), 'x');
  assert.equal(findCliBin('zcode', { PATH: '/nonexistent-xyz', HOME: home2, BRIDGE_AGENT_BIN_DIR: '' }), path.join(home2, '.local', 'bin', 'zcode'));
  assert.equal(agentInstalled('codex'), true);
});

test('自带的那一份：程序 node_modules/.bin 里有 codex，PATH 上什么都没有也算装了', () => {
  const bundled = mkdtempSync(path.join(os.tmpdir(), 'bridge-bundled-'));
  writeFileSync(path.join(bundled, 'codex'), '#!/bin/sh\nexit 0\n');
  chmodSync(path.join(bundled, 'codex'), 0o755);
  const env = { PATH: '/nonexistent-xyz', HOME: fakeHome, BRIDGE_AGENT_BIN_DIR: bundled };
  assert.equal(findCliBin('codex', env), path.join(bundled, 'codex'));
  // 显式置空 = 不用自带的那份，回落到 PATH / 用户目录
  assert.equal(findCliBin('codex', { ...env, BRIDGE_AGENT_BIN_DIR: '' }), '');
  assert.equal(findCliBin('codex', { PATH: stubDir, HOME: fakeHome, BRIDGE_AGENT_BIN_DIR: '' }), path.join(stubDir, 'codex'));
});

test('认证探测：codex 认 auth.json / 环境变量，zcode 认官方登录写的 credentials.json；都没有就是没登录', () => {
  assert.equal(agentAuthed('codex'), false, '临时 HOME 下没有 auth.json，也没配 OPENAI_API_KEY');
  assert.equal(agentAuthed('zcode'), false);
  const home = fakeHome;
  mkdirSync(path.join(home, '.codex'), { recursive: true });
  writeFileSync(path.join(home, '.codex', 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access: 'x' } }));
  // zcode 的登录态：官方 `zcode login` 写在 {data}/.zcode/v2/credentials.json，值是加密串。
  // 键名随 provider / 账号类型变，所以只认「有没有一条非空凭据」。
  mkdirSync(path.join(home, '.zcode', 'v2'), { recursive: true });
  writeFileSync(path.join(home, '.zcode', 'v2', 'credentials.json'), JSON.stringify({ 'zai-coding-plan': 'enc:v1:abc.def.ghi' }));
  // 探测结果缓存 20 秒：刚登录完要点分页里的「重新检测」（= refresh，现探一次）才立刻可见
  refreshAgentProbes();
  assert.equal(agentAuthed('codex'), true, 'auth.json 在 → 视为已登录');
  assert.equal(agentAuthed('zcode'), true, 'credentials.json 里有凭据 → 视为已登录');
  // 空凭据不算登录（别把「跑过一次但没授权」当成已登录）
  writeFileSync(path.join(home, '.zcode', 'v2', 'credentials.json'), JSON.stringify({ 'zai-coding-plan': '' }));
  refreshAgentProbes();
  assert.equal(agentAuthed('zcode'), false, '空凭据不算登录');
});

test('开关默认开（这就是「可选」：一键关掉即从所有客户端消失），装上就能跑', () => {
  assert.equal(agentEnabled('codex'), true);
  assert.equal(agentEnabled('zcode'), true);
  assert.ok(enabledAgents().includes('codex'));
  const off = setAgentSwitch('codex', false);
  assert.equal(off.ok, true);
  assert.equal(agentEnabled('codex'), false);
  assert.ok(!enabledAgents().includes('codex'), '关掉后就不在启用名单里');
  assert.equal(agentEnabled('zcode'), true, '关一个不影响另一个');
  assert.equal(setAgentSwitch('nope', true).error, '未知 agent：nope');
  setAgentSwitch('codex', true);   // 收回默认态，后面的身份断言按四个都在算
});

test('设置页的视图：这两家都带上 installed，缺 CLI 时 note 讲的是怎么装', () => {
  const list = agentStatusList();
  assert.deepEqual(list.map((a) => a.id), ['claude', 'dimensio', 'codex', 'zcode']);
  for (const id of ['codex', 'zcode']) {
    const a = list.find((x) => x.id === id);
    assert.equal(typeof a.installed, 'boolean', id + ' 要有 installed');
    assert.equal(a.runnable, true, '分页自带，永远算「能开」');
    assert.equal(a.multiUser, false);
  }
  assert.ok(agentInstallNote('codex').includes('chatgpt.com/codex/install.sh'));
  assert.ok(agentInstallNote('zcode').includes('install-zcode.sh'), 'zcode 的说明指向自带脚本：' + agentInstallNote('zcode'));
  // 视图里要带上「怎么认证」：codex 有 keyEnv，zcode 只有 login（它走官方登录）
  const cx = list.find((x) => x.id === 'codex');
  const zc = list.find((x) => x.id === 'zcode');
  assert.equal(cx.keyEnv, 'OPENAI_API_KEY');
  assert.equal(cx.login, 'codex login');
  assert.equal(zc.keyEnv, undefined);
  assert.equal(zc.login, 'zcode login');
});

// —— ③ 身份 ——
test('admin 拿到全部启用的 agent（codex / zcode 也在）', () => {
  const admin = contextFor({ kind: 'admin', user: null });
  assert.deepEqual(admin.agents, enabledAgents());
  assert.equal(admin.allowCodex, true);
  assert.equal(admin.allowZcode, true);
});

test('注册用户即使被勾了 codex / zcode 也拿不到（还没做每人隔离）', () => {
  const u = { kind: 'user', user: 'someone', tier: 'pro', agents: ['claude', 'codex', 'zcode'] };
  const ctx = contextFor(u);
  assert.deepEqual(agentsFor(u).filter((id) => id === 'codex' || id === 'zcode'), []);
  assert.equal(ctx.allowCodex, false);
  assert.equal(ctx.allowZcode, false);
  // 管理员把这两家塞进某人的名单也没用：multiUser 挡着
  assert.deepEqual(agentsFor({ kind: 'user', user: 'x', tier: 'pro', agents: ['codex'] }), []);
});

test('公开身份：share 一个都没有；快照只有 Claude', () => {
  const share = contextFor({ kind: 'share', token: 't', dir: os.tmpdir() });
  const snap = contextFor({ kind: 'snap', token: 't', dir: os.tmpdir() });
  assert.equal(share.allowCodex, false);
  assert.equal(share.allowZcode, false);
  assert.equal(snap.allowCodex, false);
  assert.equal(snap.allowZcode, false);
  assert.equal(snap.allowClaude, true);
});
