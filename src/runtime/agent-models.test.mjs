// Codex 模型清单（走官方 app-server 的 model/list）：这一层要钉住的是
//   ① 帧协议对得上——initialize 握手 → initialized → model/list，JSON-RPC 2.0 的 id 配对；
//   ② 归一成界面要的形状（displayName / supportedReasoningEfforts / defaultReasoningEffort）；
//   ③ 上游任何一步出问题（子命令不存在、超时、坏 JSON、回 error）都回空清单而不是抛——
//      界面据此不摆选择器，而不是崩掉；而且失败要缓存一小会儿，别把每次开页面都拖成超时。
import { test } from 'node:test';
import assert from 'node:assert';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.env.BRIDGE_DATA_ROOT) process.env.BRIDGE_DATA_ROOT = mkdtempSync(path.join(os.tmpdir(), 'bridge-models-'));
process.env.BRIDGE_AGENT_BIN_DIR = '';   // 别让随程序自带的那份真 codex 顶掉桩

const { codexModels, resetModelCache, mergeUnion } = await import('./agent-models.mjs');

// 一个会数自己被打了几次的桩：每次拉起都往 counter 里追加一行。
function stubAppServer(name, counter, body) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'stub-appserver-'));
  mkdirSync(dir, { recursive: true });
  const js = path.join(dir, name + '-impl.js');
  writeFileSync(js, body);
  const sh = path.join(dir, name);
  writeFileSync(sh, '#!/bin/sh\necho x >> ' + JSON.stringify(counter) + '\n' + 'exec ' + JSON.stringify(process.execPath) + ' ' + JSON.stringify(js) + ' "$@"\n');
  chmodSync(sh, 0o755);
  return dir;
}

const REPLY_MODELS = `
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
    if (m.method === 'initialize') reply({ userAgent: 'stub/1.0', codexHome: '/tmp/x', platformFamily: 'unix', platformOs: 'linux' });
    else if (m.method === 'model/list') reply({ data: [
      { id: 'gpt-6.1-sol', model: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', description: 'workhorse',
        supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }, { reasoningEffort: 'max' }],
        defaultReasoningEffort: 'low', isDefault: true, hidden: false },
      { id: 'legacy', model: 'legacy', displayName: 'Legacy', hidden: true, supportedReasoningEfforts: [] },
      { displayName: '没有 id 的坏条目' },
    ] });
  }
});
setTimeout(() => process.exit(0), 20000);
`;

test('桩 app-server：握手 → model/list → 归一成界面形状（隐藏的也带上，由界面决定要不要摆）', async () => {
  resetModelCache();
  const counter = path.join(mkdtempSync(path.join(os.tmpdir(), 'cnt-')), 'n.txt');
  const dir = stubAppServer('codex', counter, REPLY_MODELS);
  const env = { ...process.env, PATH: dir + ':' + process.env.PATH, BRIDGE_AGENT_BIN_DIR: '' };
  const models = await codexModels({ env });
  assert.equal(models.length, 2, '没有 id 的坏条目要丢掉：' + JSON.stringify(models));
  const m = models[0];
  assert.equal(m.id, 'gpt-6.1-sol');
  assert.equal(m.label, 'GPT-6.1-Sol');
  assert.deepEqual(m.efforts, ['low', 'high', 'max'], '可选思考深度要原样带出来：' + JSON.stringify(m));
  assert.equal(m.defaultEffort, 'low');
  assert.equal(m.isDefault, true);
  assert.equal(models[1].hidden, true, 'hidden 标记要带出来（界面自己决定摆不摆）');
  assert.deepEqual(models[1].efforts, []);

  // 第二次不该再起进程（缓存 10 分钟）
  const before = readFileSync(counter, 'utf8').split('\n').filter(Boolean).length;
  await codexModels({ env });
  const after = readFileSync(counter, 'utf8').split('\n').filter(Boolean).length;
  assert.equal(after, before, '缓存期内不该再拉起 app-server');
  // 显式 refresh 才重跑
  await codexModels({ env, force: true });
  const forced = readFileSync(counter, 'utf8').split('\n').filter(Boolean).length;
  assert.equal(forced, before + 1, 'refresh 要真的重跑一次');
});

test('上游回 error / 不回话：都回空清单，不抛也不卡死', async () => {
  resetModelCache();
  const counter = path.join(mkdtempSync(path.join(os.tmpdir(), 'cnt-')), 'n.txt');
  // model/list 一律回 error
  const dir = stubAppServer('codex', counter, `
let buf='';
process.stdin.setEncoding('utf8');
process.stdin.on('data',(c)=>{ buf+=c; let i;
  while((i=buf.indexOf('\\n'))>=0){ const line=buf.slice(0,i); buf=buf.slice(i+1);
    if(!line.trim())continue; let m; try{m=JSON.parse(line);}catch{continue;}
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'no such method'}})+'\\n');
  }});
setTimeout(()=>process.exit(0),20000);
`);
  const env = { ...process.env, PATH: dir + ':' + process.env.PATH, BRIDGE_AGENT_BIN_DIR: '' };
  assert.deepEqual(await codexModels({ env }), [], '上游报错 = 空清单');
});

test('起不来 / 子命令不存在（进程立刻退出）：回空清单，不做无谓的重试风暴', async () => {
  resetModelCache();
  const counter = path.join(mkdtempSync(path.join(os.tmpdir(), 'cnt-')), 'n.txt');
  const dir = stubAppServer('codex', counter, 'process.exit(2);\n');
  const env = { ...process.env, PATH: dir + ':' + process.env.PATH, BRIDGE_AGENT_BIN_DIR: '' };
  assert.deepEqual(await codexModels({ env }), []);
  const n1 = readFileSync(counter, 'utf8').split('\n').filter(Boolean).length;
  assert.deepEqual(await codexModels({ env }), []);
  const n2 = readFileSync(counter, 'utf8').split('\n').filter(Boolean).length;
  assert.equal(n2, n1, '失败也要缓存一小会儿，别把每次开页面都拖成一个超时');
});

test('没装 codex：直接回空清单，不去 spawn', async () => {
  resetModelCache();
  const empty = mkdtempSync(path.join(os.tmpdir(), 'stub-empty-'));
  assert.deepEqual(await codexModels({ env: { PATH: empty, HOME: empty, BRIDGE_AGENT_BIN_DIR: '' } }), []);
});

// —— 目录并集（对抗上游灰度翻动：见过的模型不再丢）——
test('mergeUnion：空 stored 全量收编 / 字段以 latest 为准 / latest 缺席的保留 / 新条目追加尾部', () => {
  // 空 stored：latest 全量收编，顺序不变
  const a = { id: 'x', label: 'X', efforts: ['low'] };
  assert.deepEqual(mergeUnion([], [a]), [a]);
  // 字段以 latest 为准（自愈：上游翻回全量桶时补全说明与档位），位置保持 first-seen
  const old = { id: 'x', label: 'X', description: '', efforts: [], defaultEffort: '', isDefault: false, hidden: false };
  const fresh = { id: 'x', label: 'X-new', description: 'workhorse', efforts: ['low', 'high'], defaultEffort: 'low', isDefault: true, hidden: false };
  const merged = mergeUnion([old, { id: 'y', label: 'Y' }], [fresh]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0], fresh, '同 id 的条目字段整体换成 latest，位置不动');
  assert.deepEqual(merged[1], { id: 'y', label: 'Y' }, 'latest 缺席的条目原样保留');
  // latest 新增的追加尾部
  const merged2 = mergeUnion([{ id: 'y', label: 'Y' }], [{ id: 'z', label: 'Z' }]);
  assert.deepEqual(merged2.map((m) => m.id), ['y', 'z']);
  // 坏条目（无 id）与非法入参不炸
  assert.deepEqual(mergeUnion(null, [null, {}, { id: 'ok' }]), [{ id: 'ok' }]);
});
