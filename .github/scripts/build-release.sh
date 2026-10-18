#!/usr/bin/env bash
# 从同一份构建目录产出 ZIP 和 CRX，并逐项校验。Release 工作流和本地验证用的是同一个脚本。
#
# 用法：.github/scripts/build-release.sh <输出目录>
#
# 环境变量：
#   CRX_KEY_FILE     CRX 签名私钥（PEM）路径。必须在仓库和输出目录之外；脚本不会打印它的内容
#   CHROME_BIN       Chrome / Chromium 可执行文件，默认 google-chrome
#   CRX_EXPECTED_ID  可选：期望的扩展 ID。设置后 ID 对不上就失败（防止换错私钥导致扩展 ID 变化）
#
# 产物：<输出目录>/DualTrans-v<版本号>.zip 和 <输出目录>/DualTrans-v<版本号>.crx
# 在 GitHub Actions 里运行时，会把 version / zip / crx / crx_id 写进 $GITHUB_OUTPUT。
#
# 兼容 macOS 自带的 bash 3.2（本地验证用），所以不用数组和 bash 4 的语法。
set -euo pipefail

die() {
  echo "::error::$*" >&2
  exit 1
}

[ $# -eq 1 ] || die "用法：build-release.sh <输出目录>"

ROOT=$(cd "$(dirname "$0")/../.." && pwd -P)
mkdir -p "$1"
OUT=$(cd "$1" && pwd -P)
CHROME_BIN=${CHROME_BIN:-google-chrome}

case "$OUT/" in
  "$ROOT/"*) die "输出目录不能在仓库里面：$OUT" ;;
esac

# ---- 私钥：必须提供，且不能放在仓库或输出目录里（否则可能被打进包或被提交）----
[ -n "${CRX_KEY_FILE:-}" ] || die "没有提供 CRX 签名私钥（CRX_KEY_FILE）"
[ -s "$CRX_KEY_FILE" ] || die "CRX 签名私钥文件不存在或为空"
KEY="$(cd "$(dirname "$CRX_KEY_FILE")" && pwd -P)/$(basename "$CRX_KEY_FILE")"
case "$KEY" in
  "$ROOT/"* | "$OUT/"*) die "CRX 私钥不能放在仓库或输出目录里" ;;
esac
openssl pkey -in "$KEY" -noout > /dev/null 2>&1 || die "CRX 私钥不是有效的 PEM 私钥"

# ---- 仓库里不能出现任何私钥（防止误提交）----
if git -C "$ROOT" rev-parse --git-dir > /dev/null 2>&1; then
  if git -C "$ROOT" grep -lE -e '-----BEGIN [A-Z ]*PRIVATE KEY-----' > /dev/null 2>&1; then
    die "仓库里的文件包含私钥，先把它移出仓库"
  fi
fi

VERSION=$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["version"])' "$ROOT/manifest.json")
NAME="DualTrans-v$VERSION"
STAGE_PARENT="$OUT/stage"
STAGE="$STAGE_PARENT/DualTrans"
ZIP="$OUT/$NAME.zip"
CRX="$OUT/$NAME.crx"

echo "版本：$VERSION"

# ---- 1. 构建：只拷一次，ZIP 和 CRX 都从这个目录出 ----
# 排除所有点开头的文件/目录（.git、.github、.gitignore、.DS_Store）、本地打包脚本和任何私钥/包文件
rm -rf "$STAGE_PARENT" "$ZIP" "$CRX"
mkdir -p "$STAGE"
rsync -a \
  --exclude '.*' \
  --exclude 'package.ps1' --exclude 'package.bat' \
  --exclude '*.pem' --exclude '*.key' --exclude '*.crx' --exclude '*.zip' \
  "$ROOT/" "$STAGE/"

# ---- 2. ZIP（文件夹固定叫 DualTrans：已解压扩展的 ID 跟路径绑定，覆盖升级不丢设置）----
(cd "$STAGE_PARENT" && zip -qrX "$ZIP" DualTrans)

# ---- 3. CRX：用 Chrome 官方的 --pack-extension / --pack-extension-key ----
# Linux 上没有显示器时套一层 xvfb-run；输出的 CRX 会出现在构建目录的旁边（不在里面）
PROFILE=$(mktemp -d)
trap 'rm -rf "$PROFILE"' EXIT
WRAP=""
if [ "$(uname)" = "Linux" ] && [ -z "${DISPLAY:-}" ] && command -v xvfb-run > /dev/null 2>&1; then
  WRAP="xvfb-run -a"
fi
set +e
$WRAP "$CHROME_BIN" \
  --pack-extension="$STAGE" \
  --pack-extension-key="$KEY" \
  --no-message-box \
  --no-first-run \
  --user-data-dir="$PROFILE" > "$OUT/pack.log" 2>&1
PACK_EXIT=$?
set -e

# 给了私钥时 Chrome 不应该生成新私钥；万一生成了，立刻删掉并失败
if [ -e "$STAGE_PARENT/DualTrans.pem" ]; then
  rm -f "$STAGE_PARENT/DualTrans.pem"
  die "Chrome 生成了新的私钥，说明没有用上提供的私钥"
fi
if [ ! -s "$STAGE_PARENT/DualTrans.crx" ]; then
  tail -n 20 "$OUT/pack.log" >&2 || true
  die "Chrome 没有生成 CRX（退出码 $PACK_EXIT）"
fi
mv "$STAGE_PARENT/DualTrans.crx" "$CRX"

# ---- 4. 校验：ZIP 和 CRX 内容一致、版本号一致、资源完整、签名有效、不含私钥 ----
set -- --stage "$STAGE" --zip "$ZIP" --crx "$CRX" --version "$VERSION"
if [ -n "${CRX_EXPECTED_ID:-}" ]; then
  set -- "$@" --expected-id "$CRX_EXPECTED_ID"
fi
python3 "$ROOT/.github/scripts/verify-package.py" "$@"

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "version=$VERSION"
    echo "zip=$ZIP"
    echo "crx=$CRX"
  } >> "$GITHUB_OUTPUT"
fi

echo "产物："
ls -l "$ZIP" "$CRX"
