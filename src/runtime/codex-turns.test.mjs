// Codex 后台轮次（runtime/codex-turns.mjs）的测试。
//
// 用 fake codex 桩（无扩展名 sh，`app-server --help` 故意非零 → 走 exec 回落；
// 选路与 app-server 协议本身由 src/agent-appserver.test.mjs 覆盖，
// 这里只测 turn 管理器的语义）：
//   断开不断进程 / attach 整轮重放 / 显式 stop / 审批超时按拒绝 /
//   点卡 resolve 等待者 / 并发上限顶掉最旧 / 同会话新轮顶掉旧轮。
//
// 计时：桩每轮约 6 秒（两段 sleep 3 秒），各用例按自己的节奏等，不互相等。

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  startCodexTurn, stopCodexTurn, attachCodexTurn,
  listCodexTurns, findCodexTurn, answerCodexApproval, turnWaitApproval,
} from './codex-turns.mjs';

// ── fake codex 桩 ─────────────────────────────────────────────────────────
// 无扩展名 sh（Linux 上 findCliBin 只认无扩展名，见 agent-appserver.test.mjs 的注释）。
// app-server 探测直接非零 → 被测代码走 exec 回落；exec 吐 codex exec --json 格式的 JSONL，
// 跑完在 $FAKE_CODEX_MARKER 写标记（断开测试靠它证明「进程没被杀」）。
const FAKE_CODEX = `#!/bin/sh
if [ "$1" = "app-server" ]; then
  # 探测会写一行 initialize 等握手回包；读掉它再退出 → 探测判 false，走 exec 回落。
  # （直接 exit 的话探测写 stdin 时管道已关，EPIPE 崩测试——时序看运气。）
  IFS= read -r line
  exit 1
fi
echo '{"type":"thread.started","thread_id":"th_test"}'
echo '{"type":"item.started","item":{"type":"agent_message","id":"m1","text":"第一段"}}'
sleep 3
echo '{"type":"item.started","item":{"type":"agent_message","id":"m2","text":"第二段"}}'
sleep 3
echo '{"type":"turn.completed"}'
echo done > "$FAKE_CODEX_MARKER"
`;

function makeEnv() {
  const tmp = mkdtempSync(path.join(tmpdir(), 'bridge-codex-turns-'));
  const binDir = path.join(tmp, 'bin');
  mkdirSync(binDir, { recursive: true });
  const stub = path.join(binDir, 'codex');
  writeFileSync(stub, FAKE_CODEX);
  chmodSync(stub, 0o755);
  const marker = path.join(tmp, 'marker');
  // BRIDGE_AGENT_BIN_DIR 置空 = 不用项目自带的 codex；binDir 前插 PATH = 钉住只找到假货。
  const env = { ...process.env, BRIDGE_AGENT_BIN_DIR: '', FAKE_CODEX_MARKER: marker };
  return { tmp, binDir, marker, env };
}

// 假 SSE res：收 chunk，支持 close 事件（模拟客户端断开）。
function fakeRes() {
  const chunks = [];
  const handlers = {};
  const res = {
    chunks,
    writeHead() {},
    write(c) { chunks.push(String(c)); return true; },
    on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); return this; },
    emit(ev) { for (const fn of handlers[ev] || []) fn(); },
    end() { res.emit('close'); },
    writableEnded: false,
  };
  return res;
}

function sseEvents(res) {
  return res.chunks.join('').split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice(6)));
}

async function waitFor(fn, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('超时没等到：' + label);
}

let keySeq = 0;
// 开一轮（dataDir 传空 = 不碰真实数据目录；keyEnv 传 {} = 不读真实 key）。
// t.after 里停 turn + 删临时目录，保证桩进程不泄漏。
async function startTurn(t, { key, env, sessionId = '', plan = false } = {}) {
  const e = env || makeEnv();
  const k = key || ('codex:test-' + (++keySeq) + '-' + Date.now().toString(36));
  const r = await startCodexTurn({
    key: k, dataDir: '', prompt: '测试问题', sessionId,
    env: e.env, keyEnv: {}, binDir: e.binDir, plan,
  });
  assert.equal(r.ok, true, '开轮应该成功');
  const turn = r.turn;
  t.after(async () => {
    try { stopCodexTurn(k, turn.turnId); } catch {}
    await new Promise((r2) => setTimeout(r2, 300));
    rmSync(e.tmp, { recursive: true, force: true });
  });
  return { key: k, turn, env: e };
}

test('断开不断进程：SSE 断了，turn 在后台跑完', async (t) => {
  const { turn, env } = await startTurn(t);
  const res = fakeRes();
  const attached = attachCodexTurn(turn, res); // 不 await：它要等到 close 才返回
  // 第一段正文流到，模拟客户端断开
  await waitFor(() => sseEvents(res).some((e) => e.type === 'text'), 8000, '第一段正文');
  res.emit('close');
  await attached; // attach 只退订，不杀 turn
  // 进程没被杀：桩跑完写 marker；两段正文都在 turn 缓冲里
  await waitFor(() => existsSync(env.marker), 15000, '桩跑完写 marker');
  assert.equal(turn.done, true);
  const texts = turn.events.filter((e) => e.type === 'text').map((e) => e.text).join('');
  assert.match(texts, /第一段/);
  assert.match(texts, /第二段/);
});

test('attach 重放：跑完的 turn 能整轮重放', async (t) => {
  const { key, turn, env } = await startTurn(t);
  await waitFor(() => turn.done, 15000, 'turn 跑完');
  assert.ok(existsSync(env.marker), '桩应该跑完');
  // 列表与查找
  const list = listCodexTurns(key);
  assert.equal(list.length, 1);
  assert.equal(list[0].turnId, turn.turnId);
  assert.equal(list[0].status, 'done');
  assert.match(list[0].prompt, /测试问题/);
  assert.equal(findCodexTurn(key, turn.turnId), turn);
  assert.equal(findCodexTurn(key, 'nope'), null);
  assert.equal(findCodexTurn('codex:别人', turn.turnId), null); // 按 key 隔离
  // 重放
  const res = fakeRes();
  await attachCodexTurn(turn, res); // 已结束：replay 后直接 end
  const evs = sseEvents(res);
  assert.equal(evs[0].type, 'meta');
  assert.equal(evs[0].turnId, turn.turnId);
  const types = evs.map((e) => e.type);
  assert.ok(types.includes('text'), '重放里有正文');
  assert.ok(types.includes('done'), '重放里有收尾');
  const texts = evs.filter((e) => e.type === 'text').map((e) => e.text).join('');
  assert.match(texts, /第一段/);
  assert.match(texts, /第二段/);
});

test('计划模式 + 老版本回落：先给提示，这一轮按普通模式跑', async (t) => {
  // 桩的 app-server 探测故意非零 → 走 exec 回落（老版本没 collaborationMode），
  // 计划开关不能静默当普通轮跑：先给一句提示，再按普通模式跑完。
  const { turn } = await startTurn(t, { plan: true });
  await waitFor(
    () => turn.events.some((e) => e.type === 'notice' && /不支持计划模式/.test(e.text || '')),
    10000, '不支持计划模式提示');
  await waitFor(() => turn.done, 15000, 'turn 跑完');
});

test('显式 stop：进程被杀，turn 收尾', async (t) => {
  const { turn, env } = await startTurn(t);
  const key = turn.key;
  await new Promise((r) => setTimeout(r, 1000)); // 让桩跑起来（第一段已出，还在 sleep）
  const r = stopCodexTurn(key, turn.turnId);
  assert.equal(r.ok, true);
  await waitFor(() => turn.done, 10000, 'turn 收尾');
  // 「已中断」是异步到的（abort 发出后子进程退出、runCliTurn 才 yield），单独等它。
  // 能到 = abort 真的杀掉了子进程（runCliTurn 的 killed 路径），不只是标记了 done。
  await waitFor(
    () => turn.events.some((e) => e.type === 'notice' && /已中断/.test(e.text || '')),
    10000, '已中断通知');
  const notes = turn.events.filter((e) => e.type === 'notice').map((e) => e.text).join('|');
  assert.match(notes, /已手动停止/);
  assert.equal(existsSync(env.marker), false, '被杀的桩没机会写 marker');
  assert.equal(stopCodexTurn(key, 'nope').ok, false);
});

test('审批超时：没人点按拒绝收', async (t) => {
  process.env.CODEX_APPROVAL_WAIT_MS = '300'; // 只测逻辑，不真等 15 分钟
  try {
    const { turn } = await startTurn(t);
    const r = await turnWaitApproval(turn, 'a1');
    assert.deepEqual(r, { decision: 'decline' });
    assert.equal(turn.approvals.has('a1'), false, '超时后 waiter 已清理');
    const notes = turn.events.filter((e) => e.type === 'notice').map((e) => e.text).join('|');
    assert.match(notes, /自动拒绝/, '缓冲里留一句，重连回来的人知道卡为什么点不了');
  } finally {
    delete process.env.CODEX_APPROVAL_WAIT_MS;
  }
});

test('审批回答：点卡 resolve 等待者，找不到的卡 404', async (t) => {
  const { key, turn } = await startTurn(t);
  const p = turnWaitApproval(turn, 'a2');
  const r = answerCodexApproval(key, turn.turnId + ':a2', 'accept');
  assert.equal(r.ok, true);
  assert.deepEqual(await p, { decision: 'accept' });
  assert.equal(answerCodexApproval(key, turn.turnId + ':nope', 'accept').ok, false);
  assert.equal(answerCodexApproval(key, '格式不对', 'accept').ok, false);
});

test('并发上限：第四轮顶掉最旧的那轮', async (t) => {
  const e = makeEnv();
  const key = 'codex:test-max-' + Date.now().toString(36);
  const turns = [];
  for (let i = 0; i < 4; i++) {
    const r = await startCodexTurn({
      key, dataDir: '', prompt: '测试问题' + i, env: e.env, keyEnv: {}, binDir: e.binDir,
    });
    assert.equal(r.ok, true, '第' + (i + 1) + '轮应该开成功');
    turns.push(r.turn);
  }
  t.after(async () => {
    for (const tn of turns) { try { stopCodexTurn(key, tn.turnId); } catch {} }
    await new Promise((r) => setTimeout(r, 300));
    rmSync(e.tmp, { recursive: true, force: true });
  });
  const notes = turns[0].events.filter((e) => e.type === 'notice').map((e) => e.text).join('|');
  assert.match(notes, /同时进行的轮次太多/, '最旧的那轮被顶掉，缓冲里留通知');
  assert.equal(findCodexTurn(key, turns[3].turnId), turns[3], '新开的这轮还在');
});

test('同会话顶掉：新一轮取代旧轮', async (t) => {
  const e = makeEnv();
  const key = 'codex:test-sess-' + Date.now().toString(36);
  const mk = (prompt, sessionId) => startCodexTurn({
    key, dataDir: '', prompt, sessionId, env: e.env, keyEnv: {}, binDir: e.binDir,
  });
  const r1 = await mk('旧轮', 'sess-x');
  assert.equal(r1.ok, true);
  const r2 = await mk('新轮', 'sess-x');
  assert.equal(r2.ok, true);
  t.after(async () => {
    try { stopCodexTurn(key, r1.turn.turnId); } catch {}
    try { stopCodexTurn(key, r2.turn.turnId); } catch {}
    await new Promise((r) => setTimeout(r, 300));
    rmSync(e.tmp, { recursive: true, force: true });
  });
  const notes = r1.turn.events.filter((e) => e.type === 'notice').map((e) => e.text).join('|');
  assert.match(notes, /被同一会话的新一轮取代/);
});
