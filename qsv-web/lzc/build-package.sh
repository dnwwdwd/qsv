#!/bin/sh
# 构建 LPK 内容目录 lzc-dist。
# 运行时代码与依赖已随自定义镜像分发（见 lzc/build-image.sh），内容目录只保留
# 平台注入所需的官方文件拦截器脚本等静态资源。
set -eu

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST_ROOT="$REPO_ROOT/lzc-dist"

cd "$REPO_ROOT"
rm -rf "$DIST_ROOT"
mkdir -p "$DIST_ROOT/lzc/lazycat-injects"

echo "[lzc] 复制启动脚本与官方文件拦截注入脚本"
cp lzc/run.sh "$DIST_ROOT/lzc/run.sh"
chmod 755 "$DIST_ROOT/lzc/run.sh"
cp -R lzc/lazycat-injects/. "$DIST_ROOT/lzc/lazycat-injects/"

echo "[lzc] 内容目录就绪：$DIST_ROOT"
