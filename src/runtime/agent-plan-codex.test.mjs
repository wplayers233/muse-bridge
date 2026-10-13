// Codex coding plan（走官方 app-server 的 account/rate_limits/read）：钉住
//   ① 帧协议与归一——initialize → account/rate_limits/read → {planType, primary{usedPercent,...}, credits}；
//   ② API-key / 未登录（上游 error 或缺 rateLimits）一律 null，不抛；
//   ③ 缓存：成功 5 分钟 / 失败 60 秒，缓存期不再起进程；没装不 spawn。
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.env.BRIDGE_DATA_ROOT) process.env.BRIDGE_DATA_ROOT = mkdtempSync(path.join(os.tmpdir(), 'bridge-plan-codex-'));
process.env.BRIDGE_AGENT_BIN_DIR = '';   // 别让随程序自带的那份真 codex 顶掉桩

const { codexPlan, resetPlanCache, normRateLimits } = await import('./agent-plan-codex.mjs');

// 桩：照本机真 codex 的布局摆（node_modules/.bin/codex.cmd 垫片 → @openai/codex/bin/codex.js 真身）。
// findCliBin 在 Windows 上找到 .cmd 后会按 WIN_SHIM_REAL_JS 解析出 .js 真身、用 node 直起——
// 两条路都绕开 .cmd/.sh（无扩展名 sh 桩 + PATH':'分隔符是 agent-models.test 在 Windows 挂 2 个的老坑）。
// 计数器在真身 impl 里自己记（垫片不会被执行）。
function stubAppServer(counter, body) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'stub-appserver-'));
  const binDir = path.join(dir, 'node_modules', '.bin');
  const realDir = path.join(dir, 'node_modules', '@openai', 'codex', 'bin');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(realDir, { recursive: true });
  const js = path.join(realDir, 'codex.js');
  // 起进程即计数（垫片不执行，计数在真身里）。
  writeFileSync(js, `require('fs').appendFileSync(${JSON.stringify(counter)}, 'x\\n');\n` + body);
  writeFileSync(path.join(binDir, 'codex.cmd'), '@echo off\r\nnode "%~dp0\\..\\@openai\\codex\\bin\\codex.js" %*\r\n');
  // findCliBin 在 PATH 目录的直接下层找 codex.cmd：PATH 要指到 .bin 那层。
  return binDir;
}

const REPLY_RL = `
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
    if (m.method === 'initialize') reply({ userAgent: 'stub/1.0' });
    else if (m.method === 'account/rate_limits/read') reply({
      accountId: 'acc_1',
      rateLimits: {
        planType: 'plus',
        primary: { usedPercent: 42, resetsAt: 1760000000, windowDurationMins: 300 },
        secondary: { usedPercent: 7, resetsAt: 1760500000, windowDurationMins: 10080 },
        credits: { balance: '12.50', hasCredits: true, unlimited: false },
      },
    });
  }
});
setTimeout(() => process.exit(0), 20000);
`;

test('normRateLimits：schema 形状 → 界面要的三个数；缺 primary = 没有 plan', () => {
  const ok = normRateLimits({ rateLimits: { planType: 'pro', primary: { usedPercent: 5 }, secondary: null, credits: { balance: '0', hasCredits: true } } });
  assert.equal(ok.planType, 'pro');
  assert.equal(ok.primary.usedPercent, 5);
  assert.equal(ok.secondary, null);
  assert.equal(ok.credits.balance, '0');
  // API-key 模式 / 未登录：没有 rateLimits 或没有 primary 窗口 → null
  assert.equal(normRateLimits(null), null);
  assert.equal(normRateLimits({}), null);
  assert.equal(normRateLimits({ rateLimits: { planType: 'plus' } }), null, '没有 primary 窗口 = 无 plan 可显示');
  assert.equal(normRateLimits({ rateLimits: { primary: { usedPercent: 'NaN?' } } }), null, 'usedPercent 非数字 = 无 plan');
});

test('桩 app-server：握手 → rate_limits/read → 归一 plan；缓存期内不再起进程', async () => {
  resetPlanCache();
  const counter = path.join(mkdtempSync(path.join(os.tmpdir(), 'cnt-')), 'n.txt');
  const dir = stubAppServer(counter, REPLY_RL);
  const env = { ...process.env, PATH: dir + path.delimiter + process.env.PATH, BRIDGE_AGENT_BIN_DIR: '' };
  const plan = await codexPlan({ env });
  assert.equal(plan.planType, 'plus');
  assert.equal(plan.primary.usedPercent, 42);
  assert.equal(plan.primary.windowMinutes, 300);
  assert.equal(plan.secondary.usedPercent, 7, '周窗口（secondary）也要带出来');
  assert.equal(plan.credits.balance, '12.50');

  // 第二次不该再起进程（缓存 5 分钟）
  const before = readFileSync(counter, 'utf8').split('\n').filter(Boolean).length;
  await codexPlan({ env });
  const after = readFileSync(counter, 'utf8').split('\n').filter(Boolean).length;
  assert.equal(after, before, '缓存期内不该再拉起 app-server');
  // force 才重跑
  await codexPlan({ env, force: true });
  const forced = readFileSync(counter, 'utf8').split('\n').filter(Boolean).length;
  assert.equal(forced, before + 1, 'force 要真的重跑一次');
});

test('上游 error / 进程秒退：回 null，不抛也不卡死；失败也要短缓存', async () => {
  resetPlanCache();
  const counter = path.join(mkdtempSync(path.join(os.tmpdir(), 'cnt-')), 'n.txt');
  // rate_limits/read 一律回 error
  const dir = stubAppServer(counter, `
let buf='';
process.stdin.setEncoding('utf8');
process.stdin.on('data',(c)=>{ buf+=c; let i;
  while((i=buf.indexOf('\\n'))>=0){ const line=buf.slice(0,i); buf=buf.slice(i+1);
    if(!line.trim())continue; let m; try{m=JSON.parse(line);}catch{continue;}
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'no such method'}})+'\\n');
  }});
setTimeout(()=>process.exit(0),20000);
`);
  const env = { ...process.env, PATH: dir + path.delimiter + process.env.PATH, BRIDGE_AGENT_BIN_DIR: '' };
  assert.equal(await codexPlan({ env }), null, '上游报错（API-key 模式常见）= null');

  // 失败也缓存：再来一次不再起进程
  const n1 = readFileSync(counter, 'utf8').split('\n').filter(Boolean).length;
  assert.equal(await codexPlan({ env }), null);
  const n2 = readFileSync(counter, 'utf8').split('\n').filter(Boolean).length;
  assert.equal(n2, n1, '失败缓存期内不该再拉起');
});

test('没装 codex：直接回 null，不去 spawn', async () => {
  resetPlanCache();
  const empty = mkdtempSync(path.join(os.tmpdir(), 'stub-empty-'));
  assert.equal(await codexPlan({ env: { PATH: empty, HOME: empty, BRIDGE_AGENT_BIN_DIR: '' } }), null);
});
