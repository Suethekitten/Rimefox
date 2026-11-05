#!/bin/sh
# 构建 macOS 连接器（通用二进制：arm64 + x86_64，最低 macOS 12）。只需要 Xcode 或 Command Line Tools 里的 swiftc。
# 输出：native/ocr-host/macos/build/rimefox-ocr-host
#
# 已知本机问题：部分 Command Line Tools 升级后 usr/include/swift 下同时留有 module.modulemap 与
# bridging.modulemap，都定义 SwiftBridging，导致 Foundation 编译失败（报错看起来像「SDK 与编译器版本不匹配」）。
# 根治需要重装 CLT；这里检测到该错误时用 VFS overlay 屏蔽重复的 modulemap 重试，不改动系统文件。
set -eu
cd "$(dirname "$0")"
mkdir -p build
MIN=12.0
CLT_SWIFT_INCLUDE=/Library/Developer/CommandLineTools/usr/include/swift
EXTRA=""

compile() {
  swiftc -swift-version 5 -O $EXTRA -target "$1-apple-macos$MIN" Sources/main.swift -o "build/rimefox-ocr-host-$1"
}

if ! compile arm64 2> build/swiftc.log; then
  if grep -q "redefinition of module 'SwiftBridging'" build/swiftc.log && [ -f "$CLT_SWIFT_INCLUDE/bridging.modulemap" ]; then
    echo "检测到 Command Line Tools 重复 modulemap，使用 VFS overlay 重试" >&2
    : > build/empty.modulemap
    cat > build/clt-overlay.yaml <<YAML
{ "version": 0, "roots": [ { "name": "$CLT_SWIFT_INCLUDE", "type": "directory",
  "contents": [ { "name": "module.modulemap", "type": "file", "external-contents": "$PWD/build/empty.modulemap" } ] } ] }
YAML
    EXTRA="-vfsoverlay build/clt-overlay.yaml"
    compile arm64
  else
    cat build/swiftc.log >&2
    exit 1
  fi
fi
compile x86_64
lipo -create build/rimefox-ocr-host-arm64 build/rimefox-ocr-host-x86_64 -output build/rimefox-ocr-host
lipo build/rimefox-ocr-host -verify_arch arm64 x86_64
# Ad-hoc integrity signature required by Apple Silicon; this is not Developer ID signing or notarization.
codesign --force --sign "${RIMEFOX_CODESIGN_IDENTITY:--}" build/rimefox-ocr-host
codesign --verify --strict build/rimefox-ocr-host
rm -f build/rimefox-ocr-host-arm64 build/rimefox-ocr-host-x86_64 build/swiftc.log
build/rimefox-ocr-host --version
build/rimefox-ocr-host --diagnose
