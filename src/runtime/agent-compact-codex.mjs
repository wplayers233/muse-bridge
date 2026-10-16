// Codex 手动压缩：thread/resume 接上已有线程 → thread/compact/start → 等 contextCompaction item。
//
// 探针结论（codex 0.162.1，临时仓 + 临时线程，真跑）：
//   · 新连接直接 compact/start 报 -32600 thread not found——必须先 thread/resume 接上线程。
//   · compact/start 本身 2ms 回 {}（压缩在后台跑）；压的过程发 item/started|completed，
//     item 只有 {type:'contextCompaction', id}，没有摘要文本（摘要写在线程里，不外发）。
//   · 空线程调 compact/start 不报错、也不发 compaction item（无操作）。
//   · 压完后线程照常能用，问「刚才让记住的词」能答对——摘要保住了关键信息。
//   · 压的过程不走 turn/start，所以 chat 的轮次管理器不适用；本模块是独立的一次性进程，
//     客户端断开（signal abort）= 杀掉进程 = 中止压缩（线程本身不受损，下次可重压）。
//   · 轮次排队：同一线程上若已有轮次在跑，压缩会排在后面；路由层用 listCodexTurns 挡 409，
//     这里不再重复查（刚起的轮次 sessionId 还没填，有一瞬的竞态，见路由注释）。
import { spawn } from 'node:child_process';
import { findCliBin } from './agent-status.mjs';

const RESUME_TIMEOUT_MS = 20_000;
const COMPACT_CALL_TIMEOUT_MS = 30_000;
// compaction item/started 没来：大概率是线程没东西可压（空线程）或排队中；60 秒没动静就收尾。
const SETTLE_MS = 60_000;
// 压开始后最长等 3 分钟（大线程的摘要是模型调用，别掐太死）。
const COMPLETE_TIMEOUT_MS = 180_000;

export async function compactCodexThread({ sessionId, cwd, env, keyEnv, binDir, onEvent, signal,
  // 测试注入：生产用默认值（settle 60s / complete 180s）。
  settleMs = SETTLE_MS, completeMs = COMPLETE_TIMEOUT_MS, resumeMs = RESUME_TIMEOUT_MS, callMs = COMPACT_CALL_TIMEOUT_MS }) {
  const emit = (ev) => { try { onEvent && onEvent(ev); } catch {} };
  if (!sessionId) return { ok: false, error: '缺少 sessionId' };
  // 找 bin 照 app-server 的 searchEnv 惯例：binDir 前插 PATH 再搜（测试靠它钉住 fake）。
  const searchEnv = binDir ? { ...env, PATH: binDir + ':' + (env.PATH || '') } : env;
  const bin = findCliBin('codex', searchEnv) || 'codex';
  const isJs = /\.(c|m)?js$/i.test(bin);
  let child;
  try {
    child = spawn(isJs ? process.execPath : bin, isJs ? [bin, 'app-server'] : ['app-server'], {
      cwd: cwd || undefined,
      env: { ...searchEnv, ...(keyEnv || {}), NO_COLOR: '1', TERM: 'dumb' },
      stdio: ['pipe', 'pipe', 'ignore'],
      detached: process.platform !== 'win32',
    });
  } catch (e) {
    return { ok: false, error: '启动 codex 失败：' + (e && e.message ? e.message : String(e)) };
  }

  let settled = false;
  let buf = '';
  let nextId = 1;
  const waiters = new Map();
  const timers = new Set();
  let settleTimer = null;
  let completeTimer = null;
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });

  const killTree = () => {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch { try { child.kill('SIGKILL'); } catch {} }
  };
  // 唯一的终态入口：清计时器、杀进程、发 end 事件、解开 done。
  // （start 之前失败也发 end——前端以 end 为准清掉「压缩中」，没 start 也无妨。）
  const finish = (value) => {
    if (settled) return value;
    settled = true;
    for (const t of timers) clearTimeout(t);
    if (settleTimer) clearTimeout(settleTimer);
    if (completeTimer) clearTimeout(completeTimer);
    killTree();
    emit({ type: 'compact', phase: 'end', ok: !!value.ok, compacted: !!value.compacted, error: value.error || null });
    resolveDone(value);
    return value;
  };
  const after = (ms, fn) => { const t = setTimeout(fn, ms); t.unref?.(); timers.add(t); return t; };
  if (signal) {
    if (signal.aborted) return finish({ ok: false, error: '已取消' });
    signal.addEventListener('abort', () => finish({ ok: false, error: '已取消' }), { once: true });
  }

  const call = (method, params, timeoutMs) => new Promise((res) => {
    const id = nextId++;
    waiters.set(id, res);
    const timer = after(timeoutMs, () => { waiters.delete(id); res({ error: { code: -1, message: 'timeout ' + method } }); });
    try {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    } catch {
      clearTimeout(timer); waiters.delete(id); res({ error: { code: -1, message: '写 stdin 失败 ' + method } });
    }
  });

  const onLine = (line) => {
    let m; try { m = JSON.parse(line); } catch { return; }
    if (m.id != null && m.method) {
      // 压缩不该触发审批；万一有，拒绝（免得压缩进程卡在等回答上）。
      try { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { decision: 'decline' } }) + '\n'); } catch {}
      return;
    }
    if (m.id != null && waiters.has(m.id)) {
      const r = waiters.get(m.id); waiters.delete(m.id); r(m);
      return;
    }
    if (m.method === 'item/started' || m.method === 'item/completed') {
      const item = (m.params || {}).item || {};
      if (item.type === 'contextCompaction') {
        if (m.method === 'item/started') {
          // 压真正开始了：取消 settle 计时，改等 completed。
          if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
          completeTimer = after(completeMs, () => finish({ ok: false, error: '压缩超时（3 分钟没压完）' }));
        } else {
          finish({ ok: true, compacted: true });
        }
      }
    }
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); onLine(line); }
  });
  child.on('error', () => finish({ ok: false, error: 'codex 进程启动失败' }));
  child.on('exit', () => {
    // 进程自己退了（比如 CLI 崩了）还没出结果：按「没压上」收尾。
    if (!settled) finish({ ok: false, error: 'codex 进程意外退出' });
  });

  // 1. 握手
  const init = await call('initialize', { clientInfo: { name: 'muse-bridge', version: '1' }, capabilities: { experimentalApi: true } }, 20_000);
  if (settled) return done;
  if (init.error) return finish({ ok: false, error: '握手失败：' + JSON.stringify(init.error) });
  try { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }) + '\n'); } catch {}

  // 2. 接上线程（新连接直接 compact/start 会报 thread not found，必须先 resume）。
  const resume = await call('thread/resume', { threadId: sessionId }, resumeMs);
  if (settled) return done;
  if (resume.error) return finish({ ok: false, error: '接不上这个会话：' + JSON.stringify(resume.error) });

  // 3. 开始压缩
  const cr = await call('thread/compact/start', { threadId: sessionId }, callMs);
  if (settled) return done;
  if (cr.error) return finish({ ok: false, error: '压缩失败：' + JSON.stringify(cr.error) });
  emit({ type: 'compact', phase: 'start' });

  // 4. 等 compaction item：started 来了转等 completed；60 秒没动静 = 没东西可压（空线程）或排队。
  settleTimer = setTimeout(() => {
    if (!settled) finish({ ok: true, compacted: false });
  }, settleMs);
  settleTimer.unref?.();
  return done;
}
