#!/bin/sh
# 启动 qsv 数据工作台服务。只做启动，不安装依赖、不构建前端。
# 运行时代码在镜像内 /app（见 lzc/Dockerfile），运行数据落在 /lzcapp/var，
# 本脚本随 LPK 内容目录分发（/lzcapp/pkg/content/lzc/run.sh）。
set -eu
mkdir -p /lzcapp/var/data /lzcapp/cache
# instance-lock 要求数据目录是"当前用户拥有的 0700 目录"；
# 平台挂载的 /lzcapp/var 由宿主创建，属主与权限不可控，这里统一修正（容器以 root 运行）
chown "$(id -u):$(id -g)" /lzcapp/var/data /lzcapp/cache
chmod 700 /lzcapp/var/data
export NODE_ENV=production
export TMPDIR="${TMPDIR:-/lzcapp/cache}"
exec node /app/server/dist/main.js
