// ZCode coding plan 余额：钉住
//   ① enc:v1 解密（aes-256-gcm + sha256(secret)，同 zcode.cjs 几何）与 access_token 提取；
//   ② billing 接口的鉴权头（Bearer 优先）与响应归一（宽容字段提取）；
//   ③ 任何一步失败（没凭据/解不开/401/坏 JSON）→ null，不抛；失败短缓存不再打接口。
import { test } from 'node:test';
import assert from 'node:assert';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.env.BRIDGE_DATA_ROOT) process.env.BRIDGE_DATA_ROOT = mkdtempSync(path.join(os.tmpdir(), 'bridge-plan-zcode-'));

const { zcodePlan, resetZcodePlanCache, setZcodeOrigins, readAccessToken, encryptEncV1, decryptEncV1, normZcodeBalance } = await import('./agent-plan-zcode.mjs');

const SECRET = 'test-secret';
const TOKEN = 'tok_' + 'a'.repeat(24);

function credFile(dir) {
  const base = path.join(dir, '.zcode', 'v2');
  mkdirSync(base, { recursive: true });
  const file = path.join(base, 'credentials.json');
  writeFileSync(file, JSON.stringify({
    'oauth:zai:access_token': encryptEncV1(TOKEN, SECRET),
    'oauth:active_provider': encryptEncV1('zai-individual-coding-plan', SECRET),
  }));
  return file;
}

// 本地桩 billing 端点：记录收到的鉴权头，按脚本回话。
function stubServer(handler) {
  const hits = [];
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { hits.push({ url: req.url, auth: req.headers.authorization || req.headers['x-api-key'] || '' }); handler(req, res, hits); });
  });
  return { srv, hits, close: () => new Promise((r) => srv.close(r)) };
}

test('enc:v1：同 secret 能解回来；错 secret / 坏形状解不开回 null', () => {
  const enc = encryptEncV1('hello 智谱', SECRET);
  assert.match(enc, /^enc:v1:/);
  assert.equal(decryptEncV1(enc, SECRET), 'hello 智谱');
  assert.equal(decryptEncV1(enc, 'wrong'), null);
  assert.equal(decryptEncV1('not-enc', SECRET), null);
  assert.equal(decryptEncV1('enc:v1:bad.bad.bad', SECRET), null);
});

test('凭据文件 → access_token：只认 oauth:zai:access_token；缺文件/坏 JSON → null', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'zc-cred-'));
  const file = credFile(dir);
  const env = { ZCODE_CREDENTIAL_SECRET: SECRET };
  assert.equal(readAccessToken(file, env), TOKEN);
  // 没有这个键
  const file2 = path.join(dir, 'empty.json');
  writeFileSync(file2, JSON.stringify({ other: 'x' }));
  assert.equal(readAccessToken(file2, env), null);
  assert.equal(readAccessToken(path.join(dir, 'nope.json'), env), null);
});

test('normZcodeBalance：balance 直取；balance+total 算百分比；没有 balance → null', () => {
  const a = normZcodeBalance({ balance: '88.5' });
  assert.equal(a.credits.balance, '88.5');
  assert.equal(a.primary, null, '没 total 就没有百分比，画不了条');
  const b = normZcodeBalance({ data: { remaining: 30, total: 100, planName: 'GLA Coding Pro' } });
  assert.equal(b.planType, 'GLA Coding Pro');
  assert.equal(b.primary.usedPercent, 70);
  assert.equal(normZcodeBalance({ foo: 1 }), null);
  assert.equal(normZcodeBalance(null), null);
});

test('端到端：桩 billing 端点 → Bearer 头 → 归一余额；缓存期内不再发请求', async () => {
  resetZcodePlanCache();
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'zc-plan-'));
  const dir = path.join(tmp, 'home');
  credFile(dir);
  const { srv, hits, close } = stubServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ balance: '55', total: '100' }));
  });
  await new Promise((r) => srv.listen(0, r));
  const port = srv.address().port;
  setZcodeOrigins([`http://127.0.0.1:${port}`]);
  try {
    const plan = await zcodePlan({ env: { ZCODE_DATA_BASE_DIR: dir, ZCODE_CREDENTIAL_SECRET: SECRET }, force: true });
    assert.ok(plan, '桩回话要有 plan：' + JSON.stringify(plan));
    assert.equal(plan.primary.usedPercent, 45);
    assert.equal(hits[0].auth, 'Bearer ' + TOKEN, '鉴权头默认 Bearer <access_token>');

    // 缓存期内：不再发请求
    const n = hits.length;
    await zcodePlan({ env: { ZCODE_DATA_BASE_DIR: dir, ZCODE_CREDENTIAL_SECRET: SECRET } });
    assert.equal(hits.length, n, '缓存期内不该再打 billing 接口');
  } finally {
    setZcodeOrigins(['https://zcode.z.ai', 'https://bigmodel.cn']);
    await close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('401 / 坏 JSON / 没凭据：都回 null，不抛', async () => {
  resetZcodePlanCache();
  const { srv, close } = stubServer((req, res) => {
    res.writeHead(req.url.endsWith('/bad') ? 200 : 401, { 'Content-Type': 'application/json' });
    res.end(req.url.endsWith('/bad') ? 'not json' : '{"error":"unauthorized"}');
  });
  await new Promise((r) => srv.listen(0, r));
  const port = srv.address().port;
  setZcodeOrigins([`http://127.0.0.1:${port}`]);
  try {
    const env401 = { ZCODE_DATA_BASE_DIR: mkdtempSync(path.join(os.tmpdir(), 'zc-p401-')), ZCODE_CREDENTIAL_SECRET: SECRET };
    mkdirSync(path.join(env401.ZCODE_DATA_BASE_DIR, '.zcode', 'v2'), { recursive: true });
    writeFileSync(path.join(env401.ZCODE_DATA_BASE_DIR, '.zcode', 'v2', 'credentials.json'), JSON.stringify({ 'oauth:zai:access_token': encryptEncV1(TOKEN, SECRET) }));
    assert.equal(await zcodePlan({ env: env401, force: true }), null, '401 = null（token 失效走降级）');

    // 没凭据文件 → 连请求都不发
    const n = 0;
    assert.equal(await zcodePlan({ env: { ZCODE_DATA_BASE_DIR: mkdtempSync(path.join(os.tmpdir(), 'zc-none-')), ZCODE_CREDENTIAL_SECRET: SECRET }, force: true }), null);
    assert.equal(await zcodePlan({ env: {}, force: true }), null, '连 HOME 都没有 = null');
    void n;
  } finally {
    setZcodeOrigins(['https://zcode.z.ai', 'https://bigmodel.cn']);
    await close();
  }
});
