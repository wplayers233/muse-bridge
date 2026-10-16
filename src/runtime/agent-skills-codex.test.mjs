// Codex 技能清单（runtime/agent-skills-codex.mjs）：假 codex 桩喂 skills/list，
// 验归一（显示名/短描述优先级/启用默认真/无名过滤）+ 缓存 + 没装时回 null。
// 回包形状依据：本机 codex 0.149.0 真跑 skills/list 的实测（{ data: [{ cwd, skills: [...] }] }）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { codexSkills } from './agent-skills-codex.mjs';

const FAKE_CODEX = `
const readline = require('node:readline');
const fs = require('node:fs');
if (process.env.FAKE_SKILLS_CWD) { try { fs.writeFileSync(process.env.FAKE_SKILLS_CWD, process.cwd()); } catch {} }
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => { try { process.stdout.write(JSON.stringify(o) + '\\n'); } catch {} };
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id == null) return;
  if (m.method === 'initialize') { send({ jsonrpc: '2.0', id: m.id, result: {} }); return; }
  if (m.method === 'skills/list') {
    if (process.env.FAKE_SKILLS_CALLS) { try { fs.appendFileSync(process.env.FAKE_SKILLS_CALLS, JSON.stringify(m.params || {}) + '\\n'); } catch {} }
    send({ jsonrpc: '2.0', id: m.id, result: { data: [{ cwd: '/tmp/skill-test-cwd', skills: [
      { name: 'imagegen', description: '完整描述很长', shortDescription: '生成图片', interface: { displayName: 'Image Gen', shortDescription: '接口短描述' }, path: '/home/u/.codex/skills/imagegen/SKILL.md', scope: 'system', enabled: true },
      { name: 'notes', description: '记笔记', interface: { displayName: 'Notes', shortDescription: '接口短描述' }, path: '/w/.codex/skills/notes/SKILL.md', scope: 'project', enabled: false },
      { name: 'bare', path: '/w/bare/SKILL.md', scope: 'user' },
      { description: '没名字的不要', path: '/w/noname/SKILL.md', scope: 'user' },
    ] }] } });
    return;
  }
  send({ jsonrpc: '2.0', id: m.id, result: {} });
});
`;

function makeFake() {
  const tmp = mkdtempSync(path.join(tmpdir(), 'bridge-fake-skills-'));
  const binDir = path.join(tmp, 'node_modules', '.bin');
  const realDir = path.join(tmp, 'node_modules', '@openai', 'codex', 'bin');
  mkdirSync(realDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(path.join(binDir, 'codex.cmd'), '@echo off\r\nnode "%~dp0\\..\\@openai\\codex\\bin\\codex.js" %*\r\n');
  writeFileSync(path.join(realDir, 'codex.js'), FAKE_CODEX);
  const sh = path.join(binDir, 'codex');
  writeFileSync(sh, '#!/bin/sh\nexec ' + JSON.stringify(process.execPath) + ' ' + JSON.stringify(path.join(realDir, 'codex.js')) + ' "$@"\n');
  chmodSync(sh, 0o755);
  const calls = path.join(tmp, 'calls.log');
  writeFileSync(calls, '');
  const workdir = path.join(tmp, 'work');
  mkdirSync(workdir, { recursive: true });
  const workdir2 = path.join(tmp, 'work2');
  mkdirSync(workdir2, { recursive: true });
  const cwdFile = path.join(tmp, 'spawn-cwd.txt');
  const env = { ...process.env, BRIDGE_AGENT_BIN_DIR: '', PATH: binDir + path.delimiter + (process.env.PATH || ''), FAKE_SKILLS_CALLS: calls, FAKE_SKILLS_CWD: cwdFile };
  return { tmp, env, calls, workdir, workdir2, cwdFile };
}

test('codexSkills：归一（显示名/短描述优先级/启用默认真/无名过滤）', async () => {
  const f = makeFake();
  try {
    const list = await codexSkills({ env: f.env, cwd: f.workdir });
    assert.equal(list.length, 3);
    assert.deepEqual(list[0], {
      name: 'imagegen', displayName: 'Image Gen', description: '生成图片',
      path: '/home/u/.codex/skills/imagegen/SKILL.md', scope: 'system', enabled: true,
    });
    assert.equal(list[1].description, '接口短描述'); // 顶层无 shortDescription → 用 interface 里的
    assert.equal(list[1].enabled, false);
    assert.deepEqual(list[2], {
      name: 'bare', displayName: 'bare', description: '',
      path: '/w/bare/SKILL.md', scope: 'user', enabled: true, // 没给 enabled = 默认启用
    });
  } finally {
    rmSync(f.tmp, { recursive: true, force: true });
  }
});

test('codexSkills：同 cwd 第二次走缓存；force 重新探并传 forceReload', async () => {
  const f = makeFake();
  try {
    const cwd = f.workdir2;
    await codexSkills({ env: f.env, cwd });
    await codexSkills({ env: f.env, cwd });
    await codexSkills({ env: f.env, cwd, force: true });
    const lines = readFileSync(f.calls, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(lines.length, 2); // 第二次缓存，没发请求
    assert.deepEqual(lines[0].cwds, [cwd]);
    assert.equal(lines[0].forceReload, false);
    assert.equal(lines[1].forceReload, true);
  } finally {
    rmSync(f.tmp, { recursive: true, force: true });
  }
});

test('codexSkills：探针进程跑在给的 cwd 里（skills/list 会重读 <cwd>/.codex/config.toml，跑错目录就 EACCES）', async () => {
  const f = makeFake();
  try {
    await codexSkills({ env: f.env, cwd: f.workdir, force: true });
    assert.equal(readFileSync(f.cwdFile, 'utf8'), f.workdir);
  } finally {
    rmSync(f.tmp, { recursive: true, force: true });
  }
});

test('codexSkills：没装 codex 回 null（不抛）', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'bridge-no-codex-'));
  try {
    const emptyHome = path.join(tmp, 'home');
    mkdirSync(emptyHome, { recursive: true });
    const env = { ...process.env, BRIDGE_AGENT_BIN_DIR: '', PATH: tmp, HOME: emptyHome };
    assert.equal(await codexSkills({ env, cwd: '/tmp/nobin-cwd' }), null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── P5.2：skills/config/write ──
// 假 codex 的 enabled 状态落文件（process.env.FAKE_SKILLS_STATE，JSON）：
// 真 codex 靠 config.toml 跨进程持久化，fake 也得文件级状态——否则写探针一死，
// 下一次 list 探针又是初始状态，验不出「写完清缓存」。
const FAKE_CODEX_WRITE = `
const fs = require('node:fs');
const readline = require('node:readline');
const stateFile = process.env.FAKE_SKILLS_STATE || '';
const readState = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return { 'alpha': true, 'beta': false }; } };
const writeState = (s) => { try { fs.writeFileSync(stateFile, JSON.stringify(s)); } catch {} };
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => { try { process.stdout.write(JSON.stringify(o) + '\\n'); } catch {} };
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id == null) return;
  if (m.method === 'initialize') { send({ jsonrpc: '2.0', id: m.id, result: {} }); return; }
  if (m.method === 'skills/config/write') {
    const p = m.params || {};
    const st = readState();
    // 只认 name 选择器（照真机：path 选择器不匹配时静默不动——这里直接回
    // effectiveEnabled 但不改状态，验「重拉验证」能抓到这种谎报）。
    if (p.name && p.name in st) { st[p.name] = !!p.enabled; writeState(st); }
    send({ jsonrpc: '2.0', id: m.id, result: { effectiveEnabled: !!p.enabled } });
    return;
  }
  if (m.method === 'skills/list') {
    const st = readState();
    send({ jsonrpc: '2.0', id: m.id, result: { data: [{ cwd: '/tmp/w', skills: Object.entries(st).map(([name, en]) => ({ name, enabled: en, scope: 'user', path: '/w/' + name + '/SKILL.md' })) }] } });
    return;
  }
  send({ jsonrpc: '2.0', id: m.id, result: {} });
});
`;
function makeFakeWrite() {
  const tmp = mkdtempSync(path.join(tmpdir(), 'bridge-fake-skills-write-'));
  const binDir = path.join(tmp, 'bin');
  const realDir = path.join(tmp, 'real');
  mkdirSync(realDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(path.join(realDir, 'codex.js'), FAKE_CODEX_WRITE);
  const sh = path.join(binDir, 'codex');
  writeFileSync(sh, '#!/bin/sh\nexec ' + JSON.stringify(process.execPath) + ' ' + JSON.stringify(path.join(realDir, 'codex.js')) + ' "$@"\n');
  chmodSync(sh, 0o755);
  const workdir = path.join(tmp, 'work');
  mkdirSync(workdir, { recursive: true });
  const stateFile = path.join(tmp, 'state.json');
  writeFileSync(stateFile, JSON.stringify({ alpha: true, beta: false }));
  const env = { ...process.env, BRIDGE_AGENT_BIN_DIR: '', PATH: binDir + path.delimiter + (process.env.PATH || ''), FAKE_SKILLS_STATE: stateFile };
  return { tmp, env, workdir };
}

test('codexSkillsConfigWrite：写 + 重拉验证通过；写完清清单缓存', async () => {
  const { codexSkillsConfigWrite } = await import('./agent-skills-codex.mjs');
  const f = makeFakeWrite();
  try {
    // 先拉一份进缓存（alpha=true），再写禁用——写完后重拉必须是新状态，不是缓存。
    const before = await codexSkills({ env: f.env, cwd: f.workdir });
    assert.equal(before.find((s) => s.name === 'alpha').enabled, true);
    const out = await codexSkillsConfigWrite({ env: f.env, cwd: f.workdir, name: 'alpha', enabled: false });
    assert.equal(out.effectiveEnabled, false);
    assert.equal(out.verified, true, '重拉验证到 alpha=false');
    assert.equal(out.skill.enabled, false);
    const after = await codexSkills({ env: f.env, cwd: f.workdir });
    assert.equal(after.find((s) => s.name === 'alpha').enabled, false, '缓存已清，重拉不是旧状态');
    const back = await codexSkillsConfigWrite({ env: f.env, cwd: f.workdir, name: 'beta', enabled: true });
    assert.equal(back.verified, true);
  } finally {
    rmSync(f.tmp, { recursive: true, force: true });
  }
});

test('codexSkillsConfigWrite：不存在的 name 不谎称成功（verified=false）', async () => {
  const { codexSkillsConfigWrite } = await import('./agent-skills-codex.mjs');
  const f = makeFakeWrite();
  try {
    const out = await codexSkillsConfigWrite({ env: f.env, cwd: f.workdir, name: 'no-such-skill', enabled: false });
    assert.equal(out.effectiveEnabled, false, '上游对不存在的 name 也回 effectiveEnabled');
    assert.equal(out.verified, false, '重拉没找到它 = 没改上');
    assert.equal(out.skill, null);
  } finally {
    rmSync(f.tmp, { recursive: true, force: true });
  }
});
