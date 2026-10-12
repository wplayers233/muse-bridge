// 内置厂商的 API key（设置页「模型服务 → API Key」填的那一把）落盘。
//
// 修的是 known-issues 的 dimensio-web-key-not-saved：以前内置厂商的 key 只进 config.ts 的 overrideKeys（内存），
// 网页里填完能用，进程一重启就「缺 Key」——VM 重启、更新、注册用户的实例闲置 20 分钟被回收、开发时 node --watch
// 都算。用户看到的是「明明保存过，过一会儿又没了」。自定义模型服务（custom-providers.ts）从来没这个问题，
// 因为它的 key 一开始就是加密落盘的；这里把内置厂商的 key 收到同一套存储里。
//
//   provider-keys/connector-secrets.json  AES-256-GCM 密文：{ <厂商 id>: { headers: { apiKey } } }
//   provider-keys/connector-secrets.key   数据密钥（Windows 上用 DPAPI 包住，其余平台 0600 明文密钥文件）
//
// 复用 bridge 的 extension-secrets.mjs（与连接器凭据、自定义服务同源同格式）：密文单文件、原子替换、写完解回来核对。
// sandbox.ts 按位置挡这个目录（同账户进程能调 DPAPI 解开，所以整个目录不许 agent 读写）。
//
// 与 .env（HARNESS_ENV_FILE）的关系：两边都能给同一家配 key，优先级见 config.ts 的 resolveKey——网页里填的
// （overrideKeys / 这份存储）压过环境变量，与落盘前的老行为一致：用户在界面上刚填的那把必须生效。
import { existsSync } from "node:fs";
import { providerKeysDir } from "./paths.ts";

type SecretsMod = {
  readSecrets: (root: string) => Record<string, { headers?: Record<string, string> }>;
  writeSecrets: (root: string, map: Record<string, { headers?: Record<string, string> }>) => void;
};

// 每家厂商一条 { headers: { apiKey } }——沿用连接器凭据的形状，读写共用同一份实现。
type KeyMap = Record<string, { headers: Record<string, string> }>;

let secretsMod: SecretsMod | null = null;
let secretsOverride: SecretsMod | null = null;
const keys = new Map<string, string>();
let loadError = "";
let writeError = "";

async function loadSecretsMod(): Promise<SecretsMod> {
  if (secretsOverride) return secretsOverride;
  if (!secretsMod) secretsMod = (await import(new URL("../../src/extension-secrets.mjs", import.meta.url).href)) as SecretsMod;
  return secretsMod;
}

const SECRETS_FILE = "connector-secrets.json"; // 与 extension-secrets.mjs 的常量同名同义

// 用哪个目录。租户实例（DIMENSIO_TENANT=1）没拿到自己那份目录时（旧版 bridge 拉起的新 harness），
// 绝不落到共用的 <harness>/provider-keys——那里面是管理员的 key，租户既不该读也不该写
// （同 tenant.ts 那条「共享凭据不外带」）。宁可不落盘：本轮内存里照旧可用。
function storeDir(): string | null {
  if (process.env.DIMENSIO_PROVIDER_KEYS_DIR?.trim()) return providerKeysDir();
  if (process.env.DIMENSIO_TENANT === "1") return null;
  return providerKeysDir();
}

async function loadFromDisk(): Promise<void> {
  try {
    const dir = storeDir();
    if (!dir || !existsSync(`${dir}/${SECRETS_FILE}`)) return;
    const all = (await loadSecretsMod()).readSecrets(dir);
    for (const [id, rec] of Object.entries(all)) {
      const k = rec?.headers?.apiKey;
      if (typeof k === "string" && k) keys.set(id, k);
    }
  } catch (e) {
    // 解不开（换了机器 / 密钥文件丢了）只记账，绝不让 harness 起不来：那把 key 当作没有，
    // 用户在设置页重填一次就能落一把新的；失败的原文留在 providerKeysError() 里给诊断用。
    loadError = String((e as Error)?.message ?? e).slice(0, 160);
    console.warn(`[provider-keys] API key 解不开：${loadError}`);
  }
}

// 启动即等到位：config.ts 在模块初始化时就要读它（mimo 的 tp- / sk- 决定 baseUrl），第一次
// /api/config 也不能先回一次假的「缺 Key」。整条 import 链等这一下——读的是几十字节的密文，
// 贵的是 Windows 上的 DPAPI（约半秒，一次）。
export const providerKeysReady: Promise<void> = loadFromDisk();
await providerKeysReady;

// 测试用：换成内存里的假存储，不碰 DPAPI（同 custom-providers.ts）。返回重新加载的 promise。
export function setProviderSecretsForTests(mod: SecretsMod | null): Promise<void> {
  secretsOverride = mod;
  keys.clear();
  loadError = "";
  return loadFromDisk();
}

export function savedProviderKey(provider: string): string | undefined {
  return keys.get(provider);
}

export function providerKeysError(): string {
  return loadError || writeError;
}

// 写盘排队：同一进程里连续改几家不会交叠。测试用（先等写完再看盘上的文件）。
let writeQueue: Promise<void> = Promise.resolve();
export function providerKeyWritesSettled(): Promise<void> {
  return writeQueue;
}

// 设置页保存的 key：内存先生效（这一轮就能用），写盘排队跟上。写失败只 warn——本轮照旧可用，
// 下次保存再补；绝不因为写不了盘就把界面上刚填的 key 丢掉。
export function saveProviderKey(provider: string, apiKey: string): void {
  keys.set(provider, apiKey);
  writeQueue = writeQueue
    .then(async () => {
      const dir = storeDir();
      if (!dir) return; // 租户没拿到自己的目录：不落盘（见 storeDir）
      const mod = await loadSecretsMod();
      // 写之前重读盘上的（别的进程 / 手工加的厂商条目不被抹掉）。文件缺失 = 空表；
      // 解不开会抛——那种情况宁可不写，也不能用一份空表把别人的 key 盖掉。
      const map: KeyMap = {};
      for (const [id, rec] of Object.entries(mod.readSecrets(dir))) {
        const k = rec?.headers?.apiKey;
        if (typeof k === "string" && k) map[id] = { headers: { apiKey: k } };
      }
      for (const [id, k] of keys) map[id] = { headers: { apiKey: k } };
      mod.writeSecrets(dir, map);
      writeError = "";
    })
    .catch((e) => {
      writeError = String((e as Error)?.message ?? e).slice(0, 160);
      console.warn(`[provider-keys] key 写盘失败：${writeError}`);
    });
}
