// Codex 的插件/连接器（官方 PC 端 `codex plugin` / `codex mcp` 的桥接）：
//   安装态 = CODEX_HOME/config.toml 的 [plugins."name@marketplace"] enabled 表（无 TOML 依赖，行级解析）
//   目录   = 本地市场目录扫描：curated（CODEX_HOME/.tmp/plugins/plugins/*）+ bundled（CODEX_HOME/plugins/cache/openai-bundled/*）
//   连接器 = `codex mcp list --json`（官方 JSON，直接透传）
//   装卸   = `codex plugin add PLUGIN@MARKETPLACE` / `codex plugin remove …`（一次性子进程，用完即收）
// 远程 `codex plugin list`（网络目录）实测静默返回空，目录一律走本地市场盘——离线也稳定。
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findCliBin } from './agent-status.mjs';

const CALL_TIMEOUT_MS = 120_000;

const codexHome = (env = process.env) => String(env.CODEX_HOME || '').trim() || path.join(os.homedir(), '.codex');

// —— 安装态：行级解析 config.toml 的 [plugins."name@marketplace"] 小节 ——
export function readInstalledPlugins(env = process.env) {
  const file = path.join(codexHome(env), 'config.toml');
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const head = /^\[plugins\."([^"]+)"\]$/.exec(line);
    if (head) {
      const at = head[1].lastIndexOf('@');
      cur = at >= 0
        ? { name: head[1].slice(0, at), marketplace: head[1].slice(at + 1), enabled: true }
        : { name: head[1], marketplace: '', enabled: true };
      cur.id = head[1];
      out.push(cur);
      continue;
    }
    if (cur && line.startsWith('[')) { cur = null; continue; }   // 进了别的小节
    if (cur) {
      const en = /^enabled\s*=\s*(true|false)\s*$/.exec(line);
      if (en) cur.enabled = en[1] === 'true';
    }
  }
  return out;
}

// —— 目录：本地市场盘扫描（离线可用）——
export function scanCatalog(env = process.env) {
  const home = codexHome(env);
  const out = [];
  const push = (name, marketplace, kinds) => {
    if (!name) return;
    const hit = out.find((x) => x.name === name && x.marketplace === marketplace);
    if (hit) { for (const k of kinds) if (!hit.kinds.includes(k)) hit.kinds.push(k); return; }
    out.push({ name, marketplace, kinds });
  };
  // curated：.tmp/plugins/plugins/<name>/（skills/ = 技能，.mcp.json = 连接器）
  const curated = path.join(home, '.tmp', 'plugins', 'plugins');
  try {
    for (const name of readdirSync(curated)) {
      const dir = path.join(curated, name);
      if (!isDir(dir)) continue;
      const kinds = [];
      if (isDir(path.join(dir, 'skills'))) kinds.push('skill');
      if (existsSync(path.join(dir, '.mcp.json'))) kinds.push('connector');
      push(name, 'openai-curated', kinds);
    }
  } catch {}
  // bundled：plugins/cache/openai-bundled/<name>/<version>/（官方自带，取最新版本目录判形态）
  const bundled = path.join(home, 'plugins', 'cache', 'openai-bundled');
  try {
    for (const name of readdirSync(bundled)) {
      const dir = path.join(bundled, name);
      if (!isDir(dir)) continue;
      const versions = readdirSync(dir).filter((v) => isDir(path.join(dir, v))).sort().reverse();
      const latest = versions[0] ? path.join(dir, versions[0]) : dir;
      const kinds = [];
      if (isDir(path.join(latest, 'skills'))) kinds.push('skill');
      if (existsSync(path.join(latest, '.mcp.json')) || isDir(path.join(latest, 'scripts'))) kinds.push('connector');
      push(name, 'openai-bundled', kinds);
    }
  } catch {}
  return out;
}

const isDir = (p) => { try { return existsSync(p) && readdirSync(p).constructor === Array; } catch { return false; } };

// —— 连接器：codex mcp list --json ——
export async function codexMcpList({ env = process.env, timeoutMs = 10_000 } = {}) {
  const out = await runCodex(env, ['mcp', 'list', '--json'], timeoutMs);
  if (!out) return [];
  try { const j = JSON.parse(out); return Array.isArray(j) ? j : []; } catch { return []; }
}

// —— 装卸：codex plugin add / remove ——
export async function codexPluginAdd({ env = process.env, selector }) {
  if (!/^[\w.-]+@[\w.-]+$/.test(String(selector || ''))) return { ok: false, error: 'bad selector' };
  const out = await runCodex(env, ['plugin', 'add', selector], CALL_TIMEOUT_MS);
  return out == null ? { ok: false, error: 'codex plugin add 超时或失败' } : { ok: true, output: out };
}
export async function codexPluginRemove({ env = process.env, selector }) {
  if (!/^[\w.-]+@[\w.-]+$/.test(String(selector || ''))) return { ok: false, error: 'bad selector' };
  const out = await runCodex(env, ['plugin', 'remove', selector], CALL_TIMEOUT_MS);
  return out == null ? { ok: false, error: 'codex plugin remove 超时或失败' } : { ok: true, output: out };
}

// 一次性子进程：stdout 收完即走（同 agent-models 的口径；bin 解析复用 findCliBin）
function runCodex(env, args, timeoutMs) {
  return new Promise((resolve) => {
    const bin = findCliBin('codex', env);
    if (!bin) return resolve(null);
    const isJs = /\.(c|m)?js$/i.test(bin);
    let child;
    try {
      child = spawn(isJs ? process.execPath : bin, isJs ? [bin, ...args] : args, {
        env: { ...env, NO_COLOR: '1', TERM: 'dumb' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch { return resolve(null); }
    let out = '', err = '', done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); try { child.kill('SIGKILL'); } catch {} resolve(v); } };
    const timer = setTimeout(() => finish(null), timeoutMs);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', () => finish(null));
    child.on('close', (code) => {
      // stderr 里只有无害的 arg0 警告且 stdout 有内容 → 算成功
      if (out.trim()) return finish(out.trim());
      finish(code === 0 ? '' : null);
    });
  });
}
