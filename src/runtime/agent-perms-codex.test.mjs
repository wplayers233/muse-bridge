// P4：permissionProfile/list 探针（假 codex 回 3 个内置 profile；失败回 null）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { codexPermissionProfiles } = await import('./agent-perms-codex.mjs');

function fakeBin(reply) {
  const binDir = mkdtempSync(path.join(os.tmpdir(), 'bridge-profiles-bin-'));
  const realDir = path.join(binDir, 'real');
  mkdirSync(realDir, { recursive: true });
  const script = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => { try { process.stdout.write(JSON.stringify(o) + '\\n'); } catch {} };
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id == null) return;
  if (m.method === 'initialize') { send({ jsonrpc: '2.0', id: m.id, result: {} }); return; }
  if (m.method === 'permissionProfile/list') { send({ jsonrpc: '2.0', id: m.id, result: ${reply} }); return; }
  send({ jsonrpc: '2.0', id: m.id, result: {} });
});
`;
  writeFileSync(path.join(realDir, 'codex.js'), script);
  const sh = path.join(binDir, 'codex');
  writeFileSync(sh, '#!/bin/sh\nexec ' + JSON.stringify(process.execPath) + ' ' + JSON.stringify(path.join(realDir, 'codex.js')) + ' "$@"\n');
  chmodSync(sh, 0o755);
  return binDir;
}

test('profile 清单：归一成 id/allowed/description；没 description 的回 null', async () => {
  const binDir = fakeBin(JSON.stringify({
    data: [
      { id: ':read-only', allowed: true, description: null },
      { id: ':workspace', allowed: true },
      { id: ':danger-full-access', allowed: true, description: 'Everything' },
      { allowed: true }, // 没 id 的丢掉
    ],
  }));
  const env = { ...process.env, BRIDGE_AGENT_BIN_DIR: '', PATH: binDir + path.delimiter + (process.env.PATH || '') };
  const profiles = await codexPermissionProfiles({ env, cwd: mkdtempSync(path.join(os.tmpdir(), 'bridge-profiles-cwd-')) });
  assert.deepEqual(profiles, [
    { id: ':read-only', allowed: true, description: null },
    { id: ':workspace', allowed: true, description: null },
    { id: ':danger-full-access', allowed: true, description: 'Everything' },
  ]);
});

test('探针失败（回包里没 data 数组）回 null——调用方据此隐藏 profile 选择区，不抛', async () => {
  const binDir = fakeBin(JSON.stringify({ error: { code: -32600, message: 'nope' } }));
  const env = { ...process.env, BRIDGE_AGENT_BIN_DIR: '', PATH: binDir + path.delimiter + (process.env.PATH || '') };
  const profiles = await codexPermissionProfiles({ env, cwd: mkdtempSync(path.join(os.tmpdir(), 'bridge-profiles-cwd2-')) });
  assert.equal(profiles, null, 'result 里没 data 数组 = 畸形回包，当失败');
});
