#!/bin/sh
# 在 Linux 上装 zcode（Z.ai 的 ZCode CLI）。
#
# 为什么是「自己构建」：官方只发 macOS / Windows 的安装包（zai-org/ZCode 的 release 资产里只有
# .dmg 与 .exe），官网那个 install.sh 地址已经 404。官方 README 给的 Linux 路径就是源码构建：
#   pnpm install && pnpm build:zcode   →   dist/zcode/releases/<ver>/zcode-<ver>.tar.gz
#
# 两条路，一路能走通就成：
#   ① 官方发行包：build:zcode 打出的 tarball（含 web / server / agent / TUI 资源，最完整）。
#   ② 退路：直接落地 CLI 的构建产物（apps/zcode-cli/packages/cli/dist，一个自包含的 zcode.cjs
#      加一份 provider/ 配置）。bridge 只用 `zcode --prompt … --output-format stream-json` 这种
#      headless 用法，用不到 TUI/网页/服务端那几块，所以这条路跑起来是一样的；只是没有交互式
#      TUI（本程序不需要）。打包那一步依赖 TUI 的 SEA 资源，在只走出口代理的机器上容易失败，
#      所以留这条退路。
#
# 装出来的目录结构与官方 install.sh 的落点一致（以后有真发行地址时可以直接换官方安装器）：
#   $HOME/.zcode/runtime/releases/<ver>/…                     ← 运行时
#   $HOME/.zcode/runtime/current -> releases/<ver>            ← 当前版本
#   $HOME/.local/bin/zcode                                    ← 命令（exec node current/bin/zcode.mjs "$@"）
#
# 用法：sh scripts/server/install-zcode.sh [--force|--rebuild]
#   默认：装过了就什么都不做。
#   --force   重新落地一次（用现成产物，几秒钟；修 shim / 换版本时用）。
#   --rebuild 连装依赖 + build:zcode 一起重跑（十几分钟起）。
set -eu

FORCE=''
REBUILD=''
case "${1:-}" in
  --force)   FORCE=1 ;;
  --rebuild) FORCE=1; REBUILD=1 ;;
  '') ;;
  *) printf '未知参数：%s（可选 --force / --rebuild）\n' "$1"; exit 2 ;;
esac

WORK="${ZCODE_BUILD_DIR:-$HOME/.zcode-build}"
REPO="${ZCODE_REPO:-https://github.com/zai-org/ZCode.git}"
# 机器上已经有源码树（比如别人已经构建过）就指过来：ZCODE_SRC_DIR=/path/to/ZCode-main
# 有它就跳过 clone（也不会 git pull），直接用那棵树 —— 省掉一次全量 clone。
SRC="${ZCODE_SRC_DIR:-}"
RUNTIME="${ZCODE_DIST_HOME:-$HOME/.zcode/runtime}"
BIN_DIR="${ZCODE_DIST_BIN_DIR:-$HOME/.local/bin}"
PNPM_VERSION='10.33.2'

say() { printf '%s\n' "$*"; }

[ -n "$FORCE" ] || [ ! -x "$RUNTIME/current/bin/zcode.mjs" ] || {
  say "已经装好了（$RUNTIME/current/bin/zcode.mjs），跳过构建。要重装：sh $0 --force"
  exit 0
}

command -v git >/dev/null 2>&1 || { say "缺少 git，先装上（apt install git / dnf install git）"; exit 1; }
if ! command -v pnpm >/dev/null 2>&1; then
  say "没找到 pnpm，先装一个（npm install -g pnpm@$PNPM_VERSION）…"
  if command -v npm >/dev/null 2>&1; then npm install -g "pnpm@$PNPM_VERSION"
  else say "也没有 npm：请自行安装 pnpm $PNPM_VERSION 后重试"; exit 1; fi
fi

say "① 取源码 → $WORK/ZCode"
if [ -n "$SRC" ]; then
  [ -d "$SRC" ] || { say "ZCODE_SRC_DIR 指的不是目录：$SRC"; exit 1; }
  say "   用现成的源码树：$SRC"
  cd "$SRC"
else
  mkdir -p "$WORK"
  if [ -d "$WORK/ZCode/.git" ]; then
    git -C "$WORK/ZCode" pull --ff-only || true
  else
    git clone --depth 1 "$REPO" "$WORK/ZCode"
  fi
  cd "$WORK/ZCode"
fi

# 桌面端（Electron）与浏览器测试用的二进制对 CLI 毫无用处，而且在只走出口代理的机器上多半下不动
# （EPROTO / 证书），下不动就会让整个 install 以非零退出。build:zcode 只构建
# @zcode/cli + @zcode/server + @zcode/web（见 scripts/build-zcode.mjs），不碰桌面端，所以跳过是安全的。
export ELECTRON_SKIP_BINARY_DOWNLOAD=1
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
export CI=1

CLI_DIST="$PWD/apps/zcode-cli/packages/cli/dist"

# 这棵树已经构建过（CLI 产物在）就别再折腾一遍：装依赖 + build:zcode 加起来要十几分钟，
# 而落地用的就是那两个产物。要重建加 --rebuild。
if [ -n "$REBUILD" ] || [ ! -f "$CLI_DIST/zcode.cjs" ]; then
  say "② 装依赖（pnpm install，几分钟到十几分钟）"
  pnpm install --no-frozen-lockfile

  say "③ 构建（先试官方发行包；不行就从 CLI 产物装）"
  # build:zcode 会打 web/server/agent 三块并按平台收集 TUI 资源，慢且依赖较多。失败不致命：
  # 下面还有退路，所以这里不让它把整个脚本带崩（set -e 下用 || 兜住，忽略它的非零退出）。
  if pnpm build:zcode --base-url "${ZCODE_DIST_BASE_URL:-https://zcode.z.ai/zcode/}"; then
    say "   官方发行包已产出"
  else
    say "   build:zcode 失败（多半卡在 TUI 资源那一步），走退路"
  fi
else
  say "② 这棵树已经构建过（$CLI_DIST/zcode.cjs），跳过装依赖与构建"
fi

VERSION=''
TARBALL=''
if [ -f dist/zcode/latest.json ]; then
  VERSION="$(node -p "require('./dist/zcode/latest.json').version" 2>/dev/null || true)"
fi
[ -n "$VERSION" ] && TARBALL="$PWD/dist/zcode/releases/$VERSION/zcode-$VERSION.tar.gz"

mkdir -p "$RUNTIME/releases" "$BIN_DIR"
STAGE="$RUNTIME/releases/.new"
rm -rf "$STAGE"; mkdir -p "$STAGE"

if [ -n "$TARBALL" ] && [ -f "$TARBALL" ]; then
  say "④ 解包官方发行包 $VERSION"
  tar -xzf "$TARBALL" -C "$STAGE"
  TARGET="$RUNTIME/releases/$VERSION"
else
  # 退路：CLI 产物是自包含的单文件 bundle（zcode.cjs）+ 一份 provider 配置。
  [ -f "$CLI_DIST/zcode.cjs" ] || { say "既没有官方 tarball，也没找到 $CLI_DIST/zcode.cjs，装不了"; exit 1; }
  VERSION="$(node -p "require('./apps/zcode-cli/package.json').version" 2>/dev/null || echo 0.0.0)"
  say "④ 从 CLI 产物落地 $VERSION（headless 够用；没有交互式 TUI）"
  mkdir -p "$STAGE/zcode/agent" "$STAGE/zcode/bin"
  cp -p "$CLI_DIST/zcode.cjs" "$STAGE/zcode/agent/zcode.cjs"
  [ -d "$CLI_DIST/provider" ] && cp -a "$CLI_DIST/provider" "$STAGE/zcode/agent/provider"
  [ -f "$CLI_DIST/THIRD-PARTY-NOTICES.md" ] && cp -p "$CLI_DIST/THIRD-PARTY-NOTICES.md" "$STAGE/zcode/agent/"
  printf '%s\n' '{"name":"zcode-runtime","private":true,"type":"module","version":"'"$VERSION"'"}' > "$STAGE/zcode/package.json"
  # 与官方 runner.mjs 同一套做法（这两句是配套的，少一句就找不到随包配置）：
  #   ① process.argv[1] 必须指向 agent/zcode.cjs —— CLI 是按 dirname(argv[1])/provider 找
  #      zcode-builtin.json 的（见 provider-runtime-env.ts 的 resolveBundledZCodeBuiltinProviderConfig），
  #      不指过去它就会去 bin/provider 找，装上却起不来；
  #   ② 用动态 import 而不是 require —— 保留 TTY 与全部原始参数，跟官方一致。
  cat > "$STAGE/zcode/bin/zcode.mjs" <<'RUNNER'
#!/usr/bin/env node
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const agentEntry = join(root, 'agent', 'zcode.cjs');
process.argv[1] = agentEntry;
await import(pathToFileURL(agentEntry).href);
RUNNER
  chmod +x "$STAGE/zcode/bin/zcode.mjs"
  TARGET="$RUNTIME/releases/$VERSION-fallback"
fi

rm -rf "$TARGET"
mv "$STAGE/zcode" "$TARGET" 2>/dev/null || { mkdir -p "$(dirname "$TARGET")"; mv "$STAGE"/* "$TARGET"; }
rm -rf "$STAGE"
ln -sfn "$TARGET" "$RUNTIME/current"

# 命令 shim：与官方 install.sh 写的那一句同形（用 node 跑 zcode.mjs，所以服务器上
# node 不在 PATH 里时装出来的命令也能跑）。用 printf 而不是 heredoc：$@ 必须原样落到
# 生成的文件里，heredoc 里写 "$@" 会被当前 shell 展开（`\\$@` 更会塌成 `"\"`）。
printf '%s\n' '#!/usr/bin/env sh' "exec node \"$RUNTIME/current/bin/zcode.mjs\" \"\$@\"" > "$BIN_DIR/zcode"
chmod +x "$BIN_DIR/zcode"

say "⑤ 验证"
"$BIN_DIR/zcode" --version || true
say "完成。装的是 $VERSION，命令在 $BIN_DIR/zcode（当前指向 $TARGET）。"
say "凭据走官方登录：在这台机器上跑一次 zcode login（浏览器打开它给的链接授权 Z.ai 账号）。"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "注意：$BIN_DIR 不在 PATH 上，要用它请把该目录加进 PATH（本程序自己会去 ~/.local/bin 找）。" ;;
esac
