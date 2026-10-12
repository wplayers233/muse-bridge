// 设置页填的内置厂商 key 必须活过重启（known-issues 的 dimensio-web-key-not-saved）。
//
// 修前：key 只进 config.ts 的 overrideKeys（内存），进程一重启就「缺 Key」——VM 重启、更新、
// 注册用户的实例闲置 20 分钟被回收、开发时 node --watch 都算。用户看到的是「保存过、过一会儿又没了」。
// 修后：与自定义模型服务同一套加密存储（provider-keys/connector-secrets.*），启动即读回，
// 优先级 override → 落盘 → 环境变量（config.ts 的 resolveKey）。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { configWritesSettled, hasKey, resolveKey, setConfig } from "./config.ts";
import { providerKeysDir } from "./paths.ts";
import { providerKeyWritesSettled, savedProviderKey, setProviderSecretsForTests } from "./provider-keys.ts";
import { readVerdict } from "./sandbox.ts";

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const harnessRoot = path.resolve(serverDir, "..");
const configUrl = pathToFileURL(path.join(serverDir, "config.ts")).href;

// 真·重启：另起一个干净进程（没有测试标记，也不会被 test-setup 改道）读同一份数据。
// 数据位置显式指到与测试进程相同的地方——这一条正是「服务重启后还在不在」的判据。
function harnessEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.DIMENSIO_TEST_ISOLATION;
  return { ...env, ...extra };
}

function inFreshProcess<T>(script: string, extra: Record<string, string> = {}, cwd = harnessRoot): T {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script, configUrl], {
    cwd,
    env: harnessEnv(extra),
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
  });
  assert.equal(r.status, 0, `子进程失败：${r.stderr}`);
  return JSON.parse(r.stdout.trim().split("\n").pop()!);
}

const reload = () => setProviderSecretsForTests(null);

test("设置页保存的 key 落加密盘：盘上没有明文，重启（新进程）后仍认这把 key", async () => {
  const KEY = "sk-DUMMY-web-key-survives-restart";
  setConfig({ provider: "openai", apiKey: KEY });
  await configWritesSettled();
  await providerKeyWritesSettled();

  const dir = providerKeysDir();
  const secrets = path.join(dir, "connector-secrets.json");
  const cipher = fs.readFileSync(secrets, "utf8");
  assert.equal(cipher.includes(KEY), false, "盘上是密文，不许出现明文 key");
  assert.match(cipher, /"alg":\s*"aes-256-gcm"/);
  assert.ok(fs.existsSync(path.join(dir, "connector-secrets.key")), "数据密钥与密文同目录");

  // 凭据存储按位置挡：agent 读不到、写不到（同自定义服务）
  for (const f of ["connector-secrets.json", "connector-secrets.key"]) {
    assert.match(readVerdict(path.join(dir, f)) ?? "", /secret guard/, f);
  }

  // 同一进程里重新读盘（模拟重启的第一步）与另起一个干净进程（真重启）都要认
  await reload();
  assert.equal(savedProviderKey("openai"), KEY);
  assert.equal(hasKey("openai"), true);

  const got = inFreshProcess<{ key: string | null; hasKey: boolean; model: string }>(
    `const c = await import(process.argv[1]);
     console.log(JSON.stringify({ key: c.resolveKey("openai") ?? null, hasKey: c.hasKey("openai"), model: c.getConfig().model }));`,
  );
  assert.equal(got.key, KEY, "重启后的进程应当从加密存储里读回这把 key");
  assert.equal(got.hasKey, true);
});

test("写一家的 key 不会抹掉盘上别家的（重读合并后整表写回）", async () => {
  const A = "sk-DUMMY-merge-a";
  const B = "sk-DUMMY-merge-b";
  setConfig({ provider: "openai", apiKey: A });
  await providerKeyWritesSettled();
  setConfig({ provider: "zhipu", apiKey: B });
  await providerKeyWritesSettled();
  await reload();
  assert.equal(savedProviderKey("openai"), A);
  assert.equal(savedProviderKey("zhipu"), B);
});

test("解不开的密文当没有 key，但保存时不拿空表盖掉它（宁可不写）", async () => {
  const dir = providerKeysDir();
  const secrets = path.join(dir, "connector-secrets.json");
  const key = path.join(dir, "connector-secrets.key");
  const before = { secrets: fs.readFileSync(secrets, "utf8"), key: fs.readFileSync(key, "utf8") };
  fs.writeFileSync(key, JSON.stringify({ v: 1, scheme: "file", key: Buffer.from("wrong-key-material").toString("base64") }));

  // 解不开：不抛（服务照起），这把 key 当作没有
  await reload();
  assert.equal(savedProviderKey("openai"), undefined);

  // 密钥对不上时写盘会失败——失败就当没写，绝不能把别人的密文覆盖成自己这一份空/半份表
  setConfig({ provider: "zhipu", apiKey: "sk-DUMMY-after-broken-key" });
  await providerKeyWritesSettled();
  assert.equal(fs.readFileSync(secrets, "utf8"), before.secrets, "解不开时不许覆盖盘上的密文");
  assert.equal(resolveKey("zhipu"), "sk-DUMMY-after-broken-key", "本轮内存里照旧可用");

  // 还原：密钥对上了，写回照常
  fs.writeFileSync(key, before.key);
  await reload();
  assert.equal(savedProviderKey("openai"), "sk-DUMMY-merge-a");
});

test("DEEPSEEK_API_KEY 与 OPENAI_API_KEY 等价（bootstrap.sh 写的是前者）", () => {
  const script = `const c = await import(process.argv[1]);
    console.log(JSON.stringify({ deepseek: c.resolveKey("openai") ?? null }));`;
  // 落盘的 key 优先于环境变量，所以这一条要在没有 provider-keys 存储的进程里看：指一个空目录。
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-ds-alias-"));
  const got = inFreshProcess<{ deepseek: string | null }>(script, { DIMENSIO_PROVIDER_KEYS_DIR: empty, OPENAI_API_KEY: "", DEEPSEEK_API_KEY: "sk-DUMMY-deepseek-alias" });
  assert.equal(got.deepseek, "sk-DUMMY-deepseek-alias");
  fs.rmSync(empty, { recursive: true, force: true });
});

test("租户实例没拿到自己那份目录时，不看也不写共用的 provider-keys（那里是管理员的 key）", () => {
  // 旧版 bridge 拉起的新 harness：DIMENSIO_TENANT=1 但没有 DIMENSIO_PROVIDER_KEYS_DIR。
  // 默认位置落在临时 cwd 下（不碰真正的 harness/provider-keys），断言：写盘不发生、内存里照旧可用。
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-tenant-keys-"));
  const script = `const c = await import(process.argv[1]);
    const k = await import(new URL("./provider-keys.ts", process.argv[1]).href);
    c.setConfig({ provider: "openai", apiKey: "sk-DUMMY-tenant-memory-only" });
    await k.providerKeyWritesSettled();
    console.log(JSON.stringify({ key: c.resolveKey("openai") ?? null, dir: "${cwd}/provider-keys" }));`;
  const got = inFreshProcess<{ key: string | null; dir: string }>(script, { DIMENSIO_TENANT: "1", DIMENSIO_PROVIDER_KEYS_DIR: "" }, cwd);
  assert.equal(got.key, "sk-DUMMY-tenant-memory-only", "本轮内存里照旧可用");
  assert.equal(fs.existsSync(path.join(cwd, "provider-keys")), false, "租户不许落到共用的 provider-keys");
  fs.rmSync(cwd, { recursive: true, force: true });
});
