// 外部 CLI agent（Codex / ZCode）的工作目录：每个软件一间自己的文件夹，可改、记得住。
//
// 这一层要钉住的不变量：
//   ① 默认目录是「身份工作空间/<agent>」——三家各干各的，不挤在 Claude 的项目目录里；
//   ② 目录不存在会被建出来（CLI 的 cwd 必须真实存在，否则 spawn 直接 ENOENT）；
//   ③ 改目录走 authorizeProjectPath（与 Claude 新建项目同一把授权尺）：Pro 越不出自己的空间；
//   ④ 落盘按身份隔离，换回来还在；
//   ⑤ 认不出的 agent 不给改（免得变成通用目录仓库）。
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataRoot = mkdtempSync(path.join(os.tmpdir(), 'bridge-clicwd-'));
process.env.BRIDGE_DATA_ROOT = dataRoot;

const { defaultCliCwd, getCliCwd, setCliCwd, getCliPrefs, setCliAgentPrefs, cliCwdMap } = await import('./cli-cwd.mjs');

// 两个身份：admin（整机可达）与 pro（只能在自己 cwd 之内选）。
const home = mkdtempSync(path.join(os.tmpdir(), 'bridge-clicwd-home-'));
const base = mkdtempSync(path.join(os.tmpdir(), 'bridge-clicwd-user-'));
const admin = { kind: 'admin', cwd: home, dataDir: path.join(home, '.bridge') };
const pro = { kind: 'user', cwd: base, dataDir: path.join(base, '.bridge') };

test('默认目录：工作空间下的同名子目录，且真的被建出来', () => {
  const dir = getCliCwd(admin, 'zcode');
  assert.equal(dir, path.join(home, 'zcode'));
  assert.ok(existsSync(dir), '目录该被创建');
  assert.ok(statSync(dir).isDirectory());
  // 两家不是同一个目录（这就是「每个软件一个单独的工作文件夹」）
  assert.notEqual(getCliCwd(admin, 'codex'), getCliCwd(admin, 'zcode'));
  assert.equal(defaultCliCwd(admin, 'codex'), path.join(home, 'codex'));
});

test('换目录：落盘、读回来还是它，且跨身份不串味', () => {
  const picked = mkdtempSync(path.join(os.tmpdir(), 'bridge-clicwd-pick-'));
  assert.equal(setCliCwd(admin, 'zcode', picked), picked);
  assert.equal(getCliCwd(admin, 'zcode'), picked);
  assert.equal(getCliCwd(admin, 'codex'), path.join(home, 'codex'), '改一家不该动另一家');
  assert.equal(getCliCwd(pro, 'zcode'), path.join(base, 'zcode'), 'pro 的目录不受 admin 影响');
});

test('pro 越不出自己的空间；admin 可以选任意本地目录', () => {
  assert.throws(() => setCliCwd(pro, 'zcode', os.tmpdir()), (e) => e.status === 403);
  assert.equal(getCliCwd(pro, 'zcode'), path.join(base, 'zcode'), '被拒之后不该落盘');
  const outside = mkdtempSync(path.join(os.tmpdir(), 'bridge-clicwd-out-'));
  assert.equal(setCliCwd(admin, 'codex', outside), outside);
});

test('坏输入：不存在的路径 / 文件 / 认不出的 agent 都拒绝', () => {
  assert.throws(() => setCliCwd(admin, 'zcode', path.join(home, '没有这个目录')), (e) => e.status === 404);
  const file = path.join(home, 'a-file.txt');
  writeFileSync(file, 'x');
  assert.throws(() => setCliCwd(admin, 'zcode', file), (e) => e.status === 400);   // 要的是文件夹
  assert.throws(() => setCliCwd(admin, 'nope', home), (e) => e.status === 400);
});

test('cliCwdMap：两家的当前目录都给全（状态接口用）', () => {
  const m = cliCwdMap(admin);
  assert.deepEqual(Object.keys(m).sort(), ['codex', 'zcode']);
  assert.ok(m.zcode && m.codex);
});

// —— 模型 / 思考深度：与工作目录同一份存储，同一把授权尺 ——
test('模型 / 思考深度：落盘、读回来还是它；没选过就是空（= 用 CLI 自己的配置）', () => {
  const pro2 = { kind: 'user', cwd: mkdtempSync(path.join(os.tmpdir(), 'bridge-clicwd-p2-')), dataDir: '' };
  pro2.dataDir = path.join(pro2.cwd, '.bridge');
  const cleared = getCliPrefs(pro2, 'codex');
  assert.equal(cleared.model, '', '没选过 = 空，界面才会显示「用 codex 自己的配置」');
  assert.equal(cleared.effort, '');

  setCliAgentPrefs(pro2, 'codex', { model: 'gpt-6.1-sol', effort: 'high' });
  const p = getCliPrefs(pro2, 'codex');
  assert.equal(p.model, 'gpt-6.1-sol');
  assert.equal(p.effort, 'high');
  assert.equal(p.cwd, path.join(pro2.cwd, 'codex'), '模型不该影响工作目录');

  // 只改一个键时另一个留着（换模型把思考深度清掉、换深度不动模型）
  setCliAgentPrefs(pro2, 'codex', { effort: 'low' });
  assert.equal(getCliPrefs(pro2, 'codex').model, 'gpt-6.1-sol');
  setCliAgentPrefs(pro2, 'codex', { model: '' });
  assert.equal(getCliPrefs(pro2, 'codex').model, '', '传空串 = 清掉，交回 CLI 自己的配置');
  assert.equal(getCliPrefs(pro2, 'codex').effort, 'low', '清模型不该顺手清思考深度');

  // 跨身份不串味；认不出的 agent 不给改
  assert.equal(getCliPrefs(admin, 'codex').model, '');
  assert.throws(() => setCliAgentPrefs(pro2, 'nope', { model: 'x' }), (e) => e.status === 400);
});

test('老存储形状（裸字符串 = 只有 cwd）照旧读得出来，写回时升级成新形状', () => {
  // 升级前 cli-agents.json 里存的是 "/path/to/dir" 这种裸字符串，不能因为这次改动把它弄丢。
  const legacy = { kind: 'user', cwd: mkdtempSync(path.join(os.tmpdir(), 'bridge-clicwd-old-')), dataDir: '' };
  legacy.dataDir = path.join(legacy.cwd, '.bridge');
  const picked = mkdtempSync(path.join(os.tmpdir(), 'bridge-clicwd-oldpick-'));
  mkdirSync(legacy.dataDir, { recursive: true });
  const store = path.join(legacy.dataDir, 'cli-agents.json');
  writeFileSync(store, JSON.stringify({ codex: picked }));   // 老形状：裸字符串
  assert.equal(getCliCwd(legacy, 'codex'), picked, '老形状的 cwd 要读得出来');
  assert.equal(getCliPrefs(legacy, 'codex').model, '');

  // 改模型之后：目录还在，形状升成对象
  setCliAgentPrefs(legacy, 'codex', { model: 'm' });
  assert.equal(getCliCwd(legacy, 'codex'), picked, '升级形状不该把用户选的目录冲掉');
  assert.equal(getCliPrefs(legacy, 'codex').model, 'm');
});

test('权限档默认值 = 当前行为；落盘、读回来还是它；只改一个键时其余留着', () => {
  const u = { kind: 'admin', cwd: mkdtempSync(path.join(os.tmpdir(), 'bridge-clicwd-perms-')), dataDir: '' };
  u.dataDir = path.join(u.cwd, '.bridge');
  const p = getCliPrefs(u, 'codex');
  assert.deepEqual(p.perms, { sandbox: 'workspace-write', approval: 'on-request', reviewer: 'user', profile: '' });

  setCliAgentPrefs(u, 'codex', { perms: { sandbox: 'read-only', reviewer: 'auto_review' } });
  const p2 = getCliPrefs(u, 'codex');
  assert.equal(p2.perms.sandbox, 'read-only');
  assert.equal(p2.perms.reviewer, 'auto_review');
  assert.equal(p2.perms.approval, 'on-request', '没改的维度留着');
  assert.equal(p2.perms.profile, '', '没改的维度留着');

  setCliAgentPrefs(u, 'codex', { perms: { profile: ':read-only' } });
  const p3 = getCliPrefs(u, 'codex');
  assert.equal(p3.perms.profile, ':read-only');
  assert.equal(p3.perms.sandbox, 'read-only', '改 profile 不该顺手清 sandbox（运行时 profile 优先）');
});

test('权限档校验：白名单外的值回默认值；profile 只做 trim + 截长', () => {
  const u = { kind: 'admin', cwd: mkdtempSync(path.join(os.tmpdir(), 'bridge-clicwd-perms2-')), dataDir: '' };
  u.dataDir = path.join(u.cwd, '.bridge');
  setCliAgentPrefs(u, 'codex', { perms: { sandbox: 'nope', approval: 'nope', reviewer: 'guardian_subagent', profile: '  :workspace  ' } });
  const p = getCliPrefs(u, 'codex').perms;
  assert.equal(p.sandbox, 'workspace-write', '非法 sandbox 回默认');
  assert.equal(p.approval, 'on-request', '非法 approval 回默认');
  assert.equal(p.reviewer, 'user', 'legacy 的 guardian_subagent 不提供，回默认');
  assert.equal(p.profile, ':workspace', 'profile 只 trim，不认名单（名单由 probe 给）');
});
