// 外部 CLI agent 的服务面（routes/agent-cli.mjs）与凭据面（routes/admin.mjs 的
// /api/admin/agent-key、/api/admin/agent-install）的路由级契约。
//
// 为什么单有这一份：别的测试都在测纯函数与 runtime 层，**路由处理器本身没人跑过**——
// 少一个 import（比如 busPublishAll）就只在真机上点按钮时才炸，而且是 500 空回包。
// 这里把处理器直接请出来跑一遍，把「回包形状 + 落库后状态 + 只回尾 4 位」钉死。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.BRIDGE_DATA_ROOT = mkdtempSync(path.join(os.tmpdir(), 'bridge-agentroutes-'));
process.env.BRIDGE_AGENT_BIN_DIR = '';        // 不认随程序自带的那份，断言只看 PATH / 用户目录
delete process.env.OPENAI_API_KEY;
delete process.env.ZAI_API_KEY;

const { registerAgentCliRoutes } = await import('./agent-cli.mjs');
const { registerAdminRoutes } = await import('./admin.mjs');
const { agentKeyState } = await import('../runtime/agent-keys.mjs');

// 假 router：把注册进来的处理器收进表里，测试按方法 + 路径取出来直接调用。
function collect(register) {
  const routes = new Map();
  const router = { on: (m, p, fn) => routes.set(m + ' ' + p, fn) };
  register(router);
  return async (method, url, { body = null, headers = {}, socket = { remoteAddress: '127.0.0.1' } } = {}) => {
    const fn = routes.get(method + ' ' + new URL(url, 'http://x').pathname);
    assert.ok(fn, '没注册 ' + method + ' ' + url);
    const req = new EventEmitter();
    req.headers = headers; req.socket = socket; req.url = url;
    if (body != null) req.push = null;
    let code = 200, text = '';
    const res = {
      writeHead(c) { code = c; },
      write(chunk) { text += chunk; },
      end(chunk) { if (chunk) text += chunk; },
    };
    const p = fn(req, res, new URL(url, 'http://x'));
    if (body != null) { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end'); }
    await p;
    return { code, text, json: () => JSON.parse(text) };
  };
}

const cliRoutes = collect((r) => registerAgentCliRoutes(r, { identify: () => ({ kind: 'admin' }) }));
const adminRoutes = collect((r) => registerAdminRoutes(r, { authOk: () => true, adminCredential: null, adminGen: 'test' }));

test('GET /api/agents/status：四个 agent 都在，外部 CLI 带 keyEnv / install / docs', async () => {
  const r = await cliRoutes('GET', '/api/agents/status');
  assert.equal(r.code, 200);
  const { agents } = r.json();
  assert.deepEqual(agents.map((a) => a.id), ['claude', 'dimensio', 'codex', 'zcode']);
  const codex = agents.find((a) => a.id === 'codex');
  assert.equal(codex.keyEnv, 'OPENAI_API_KEY');
  assert.ok(codex.install.startsWith('curl -fsSL https://chatgpt.com/codex/install.sh'));
  assert.ok(codex.docs.includes('github.com/openai/codex'));
  assert.equal(typeof codex.installed, 'boolean');
  const zcode = agents.find((a) => a.id === 'zcode');
  // zcode 没有 key 面（Z.ai 是账号制，CLI 不读厂商 key 变量）：认证只有官方登录这一条。
  assert.equal(zcode.keyEnv, undefined, 'zcode 不该有可填的 key');
  assert.equal(zcode.login, 'zcode login');
  assert.ok(zcode.install.includes('install-zcode.sh'), 'zcode 的安装命令指向自带脚本');
  assert.ok(zcode.docs.includes('github.com/zai-org/ZCode'));
  assert.equal(zcode.allowed, true, 'admin 四个都放行');
  // codex 两样都有：可以填 key，也可以登录
  assert.equal(codex.login, 'codex login');
});

test('POST /api/admin/agent-key：存 → 回包只给尾 4 位；清 → 回包也是 JSON', async () => {
  const saved = await adminRoutes('POST', '/api/admin/agent-key', {
    headers: { 'content-type': 'application/json' },
    body: { id: 'codex', key: 'sk-route-test-9876' },
  });
  assert.equal(saved.code, 200, '处理器不能 500 空回包：' + saved.text);
  const j = saved.json();
  assert.equal(j.ok, true);
  assert.ok(!saved.text.includes('sk-route-test-9876'), '整把 key 不出网');
  const listed = (j.keys || []).find((k) => k.id === 'codex');
  assert.equal(listed.tail, '9876');
  assert.equal(listed.has, true);
  // 状态面同步：authed 变真（分页的「接入」卡据此收起来）
  const st = (await cliRoutes('GET', '/api/agents/status')).json();
  assert.equal(st.agents.find((a) => a.id === 'codex').authed, true);
  assert.equal(st.agents.find((a) => a.id === 'codex').keySource, 'store');

  const cleared = await adminRoutes('POST', '/api/admin/agent-key', { body: { id: 'codex', key: '' } });
  assert.equal(cleared.code, 200);
  assert.equal(cleared.json().ok, true);
  assert.equal(agentKeyState('codex').has, false);
});

test('POST /api/admin/agent-key：不认识的 agent 400；zcode 明确拒绝并指向登录', async () => {
  const bad = await adminRoutes('POST', '/api/admin/agent-key', { body: { id: 'claude', key: 'x' } });
  assert.equal(bad.code, 400);
  assert.ok(bad.json().error);
  // zcode 走官方登录（Coding Plan），不给存 key
  const zc = await adminRoutes('POST', '/api/admin/agent-key', { body: { id: 'zcode', key: 'sk-x' } });
  assert.equal(zc.code, 400);
  assert.ok(zc.json().error.includes('登录'), zc.text);
  const r = await adminRoutes('GET', '/api/admin/agent-key');
  assert.equal(r.code, 200);
  assert.deepEqual(r.json().keys.map((k) => k.id), ['codex'], '只有 codex 有 key 面');
});

test('POST /api/admin/agent-install：只认表里有安装命令的 agent（不传命令）', async () => {
  const bad = await adminRoutes('POST', '/api/admin/agent-install', { body: { id: 'nope' } });
  assert.equal(bad.code, 400);
  assert.ok(bad.json().error);
  const self = await adminRoutes('POST', '/api/admin/agent-install', { body: { id: 'claude' } });
  assert.equal(self.code, 400, '自带 / 走部署脚本的 agent 不在这个接口里装');
});

// ── 工作目录（每个软件一间自己的文件夹） ─────────────────────────────────────────
// 分页里换目录走的就是这一对接口：状态里读当前值、POST 改。少了任何一条，
// 手机上的「工作目录」要么永远显示 `—`，要么点了没反应。
test('状态面带 cwd：三个 CLI 面各自一间文件夹，不必先聊一轮才知道', async () => {
  const { agents } = (await cliRoutes('GET', '/api/agents/status')).json();
  const zcode = agents.find((a) => a.id === 'zcode');
  const codex = agents.find((a) => a.id === 'codex');
  assert.ok(zcode.cwd.endsWith('/zcode'), 'zcode 在自己的文件夹里干活：' + zcode.cwd);
  assert.ok(codex.cwd.endsWith('/codex'), 'codex 同上：' + codex.cwd);
  assert.notEqual(zcode.cwd, codex.cwd, '两家不该共用一个目录');
  // Claude / dimensio 不走这套（它们各有自己的项目 / 工作空间机制）
  assert.equal(agents.find((a) => a.id === 'claude').cwd, '');
});

test('POST /api/<agent>/cwd：换成新目录 → 状态面立刻跟着变；坏路径 404', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bridge-routecwd-'));
  const r = await cliRoutes('POST', '/api/zcode/cwd', { body: { path: dir } });
  assert.equal(r.code, 200, r.text);
  assert.equal(r.json().cwd, dir);
  const after = (await cliRoutes('GET', '/api/agents/status')).json().agents.find((a) => a.id === 'zcode');
  assert.equal(after.cwd, dir, '改完状态面要跟着变（抽屉靠它显示）');
  // 另一家不受影响
  const codex = (await cliRoutes('GET', '/api/agents/status')).json().agents.find((a) => a.id === 'codex');
  assert.ok(codex.cwd.endsWith('/codex'));

  const bad = await cliRoutes('POST', '/api/zcode/cwd', { body: { path: path.join(dir, '没有这个') } });
  assert.equal(bad.code, 404);
  assert.ok(bad.json().error);
});

test('POST /api/<agent>/cwd：这个 agent 不在这份身份名单里 → 403', async () => {
  // 注册用户目前拿不到 codex / zcode（multiUser:false）——identify 给的是原始身份，
  // ctx 由 contextFor 派生，所以这里就是真实形态：用户身份在这两个端点上恒 403。
  const usersRoot = mkdtempSync(path.join(os.tmpdir(), 'bridge-routecwd-users-'));
  const prev = process.env.BRIDGE_USERS_ROOT;
  process.env.BRIDGE_USERS_ROOT = usersRoot;
  try {
    const denied = collect((r) => registerAgentCliRoutes(r, { identify: () => ({ kind: 'user', user: 'p', tier: 'pro' }) }));
    const r = await denied('POST', '/api/zcode/cwd', { body: { path: os.tmpdir() } });
    assert.equal(r.code, 403);
    assert.ok(r.json().error);
  } finally {
    if (prev === undefined) delete process.env.BRIDGE_USERS_ROOT; else process.env.BRIDGE_USERS_ROOT = prev;
  }
});

test('授权边界与 Claude 新建项目同一把：Pro 越不出自己的空间（runtime 层已钉，这里钉接口回包）', async () => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'bridge-routecwd-pro-'));
  const proCtx = { kind: 'user', cwd: base, dataDir: path.join(base, '.bridge') };
  const { setCliCwd } = await import('../runtime/cli-cwd.mjs');
  mkdirSync(path.join(base, 'sub'), { recursive: true });
  assert.equal(setCliCwd(proCtx, 'zcode', path.join(base, 'sub')), path.join(base, 'sub'));
  assert.throws(() => setCliCwd(proCtx, 'zcode', os.tmpdir()), (e) => e.status === 403, 'Pro 不该能选到工作空间以外');
  // 处理器把 status 原样翻成 HTTP：404 路径不存在、403 越界（回包形状见下一个用例）
  const r = await cliRoutes('POST', '/api/codex/cwd', { body: { path: path.join(base, '不见了') } });
  assert.equal(r.code, 404);
});
