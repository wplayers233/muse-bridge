// ZCode 的 coding plan 余额：解本地凭据 → 调官方 billing 接口，缓存结果。
//
// 凭据：官方 `zcode login`（浏览器授权）写 `{ZCODE_DATA_BASE_DIR||$HOME}/.zcode/v2/credentials.json`，
// 值全是 `enc:v1:<iv>.<tag>.<ct>`（aes-256-gcm，key = sha256(secret)）。secret 来自
// $ZCODE_CREDENTIAL_SECRET，缺省回落 zcode.cjs 内置的那串 fallback（platform:homedir:username 拼的）。
// 我们只要 `oauth:zai:access_token`（coding plan 的 bearer）。
//
// 官方用量端点（zcode.cjs 内置 URL 表实测）：`{origin}/api/v1/zcode-plan/billing/balance`，
// origin 默认 https://zcode.z.ai（国内 bigmodel 变体 https://bigmodel.cn）。
//
// 【鉴权 header 形状未实测】——官方 CLI 的具体头名/前缀只能抓包确认。这里做成 AUTH_STYLES
// 常量表按序试（默认 Bearer），实测后把命中的挪到第一位即可。任何一步失败（没凭据/解不开/
// 网络/形状不符）一律 null + 60 秒短缓存：余额行整块隐藏，绝不摆一个错的。
// 成功缓存 5 分钟（余额是慢变量；也别把官方接口当轮询打）。

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OK_TTL_MS = 5 * 60_000;
const FAIL_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 8_000;

// 候选 origin（按序试；凭据里显式给了 origin 就只用那个）。
const ORIGINS = ['https://zcode.z.ai', 'https://bigmodel.cn'];
const BALANCE_PATH = '/api/v1/zcode-plan/billing/balance';
// 鉴权头的候选形状（实测后把命中的挪到首位）。token = 解密出的 access_token。
const AUTH_STYLES = [
  (token) => ({ Authorization: `Bearer ${token}` }),
  (token) => ({ Authorization: token }),
  (token) => ({ 'X-Api-Key': token }),
];

let cache = { at: 0, ttl: 0, plan: null };

// —— enc:v1 解密（与 zcode.cjs 的 ZZr/K7s 同一套几何）——
export function credentialSecret(env = process.env) {
  const s = String(env.ZCODE_CREDENTIAL_SECRET || '').trim();
  if (s) return s;
  return 'zcode-credential-fallback:' + os.platform() + ':' + os.homedir() + ':' + os.userInfo().username;
}

export function decryptEncV1(value, secret) {
  const v = String(value || '');
  if (!v.startsWith('enc:v1:')) return null;
  const body = v.slice('enc:v1:'.length);
  const parts = body.split('.');
  if (parts.length !== 3) return null;
  try {
    const iv = Buffer.from(parts[0], 'base64url');
    const tag = Buffer.from(parts[1], 'base64url');
    const ct = Buffer.from(parts[2], 'base64url');
    const key = createHash('sha256').update(String(secret)).digest();
    const d = createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch { return null; }
}

// （测试用）与解密配套的加密器：同一 secret 能来回。
export function encryptEncV1(plain, secret) {
  const iv = randomBytes(12);
  const key = createHash('sha256').update(String(secret)).digest();
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return 'enc:v1:' + iv.toString('base64url') + '.' + c.getAuthTag().toString('base64url') + '.' + ct.toString('base64url');
}

// 凭据文件 → access_token。只取 `oauth:zai:access_token` 这一个键（别的键不用碰）。
export function readAccessToken(file, env = process.env) {
  let raw;
  try { raw = readFileSync(file, 'utf8'); } catch { return null; }
  let obj;
  try { obj = JSON.parse(raw); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const secret = credentialSecret(env);
  const token = decryptEncV1(obj['oauth:zai:access_token'], secret);
  return token && token.trim() ? token.trim() : null;
}

// 响应 JSON → 归一 plan（与 codex 同形：planType + 余额）。官方字段名没实证，
// 这里做宽容提取：balance / remaining / remainder / credit 任意一个有值就算，
// 同时给 total 时算个百分比出来。什么都没有 → null（前端隐藏）。
export function normZcodeBalance(data) {
  const pick = (o, keys) => {
    for (const k of keys) {
      const v = o && typeof o === 'object' ? o[k] : undefined;
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return undefined;
  };
  // 官方有时包一层 data / result，剥一层再找。
  const root = (data && typeof data === 'object' && (data.data || data.result)) || data;
  if (!root || typeof root !== 'object') return null;
  const balance = pick(root, ['balance', 'remaining', 'remainder', 'credit', 'credits', 'left']);
  if (balance === undefined) return null;
  const total = pick(root, ['total', 'quota', 'limit', 'allowance']);
  const num = (v) => { const n = Number(String(v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : null; };
  const b = num(balance);
  const t = num(total);
  const usedPercent = b != null && t ? Math.max(0, Math.min(100, Math.round(((t - b) / t) * 100))) : null;
  return {
    planType: String(pick(root, ['planType', 'plan', 'planName', 'tier', 'package']) || 'coding-plan'),
    primary: usedPercent != null ? { usedPercent, resetsAt: null, windowMinutes: null } : null,
    secondary: null,
    credits: { balance: String(balance), unlimited: false },
  };
}

// billing 接口：origin 按序试、鉴权头按序试。任何失败回 null。
async function fetchBalance(token, origins) {
  for (const origin of origins) {
    for (const auth of AUTH_STYLES) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
        t.unref?.();
        const res = await fetch(origin + BALANCE_PATH, { headers: { ...auth(token), Accept: 'application/json' }, signal: ctrl.signal });
        clearTimeout(t);
        if (!res.ok) continue;
        const data = await res.json().catch(() => null);
        const plan = normZcodeBalance(data);
        if (plan) return plan;
      } catch {}
    }
  }
  return null;
}

/**
 * 这个身份的 zcode coding plan 余额。读缓存；过期才真发请求。
 * @returns {Promise<object|null>} null = 没有可显示的余额（没登录 / 解不开 / 接口不合），前端整行隐藏
 */
export async function zcodePlan({ env = process.env, force = false } = {}) {
  const now = Date.now();
  if (!force && cache.at && now - cache.at < cache.ttl) return cache.plan;
  const base = String(env.ZCODE_DATA_BASE_DIR || env.HOME || os.homedir() || '');
  const file = path.join(base, '.zcode', 'v2', 'credentials.json');
  const token = readAccessToken(file, env);
  if (!token) { cache = { at: now, ttl: FAIL_TTL_MS, plan: null }; return null; }
  const plan = await fetchBalance(token, ORIGINS);
  cache = { at: now, ttl: plan ? OK_TTL_MS : FAIL_TTL_MS, plan };
  return plan;
}

// 测试用：丢掉缓存。
export function resetZcodePlanCache() { cache = { at: 0, ttl: 0, plan: null }; }
// 测试用：注入 origin（桩测试钉住本地 http 端点）。
export function setZcodeOrigins(list) { if (Array.isArray(list)) ORIGINS.splice(0, ORIGINS.length, ...list); }
