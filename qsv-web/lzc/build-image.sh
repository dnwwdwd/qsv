#!/bin/sh
# 构建并推送 qsv 数据工作台自定义应用镜像（linux/amd64）。
# 用法：sh lzc/build-image.sh [镜像名:标签]，默认 c1own123/qsv-web:0.1.0。
# 推送后需执行 lzc-cli appstore copy-image <镜像名> 将其拷入懒猫官方仓库，
# 并把 lzc-manifest.yml 的镜像地址替换为返回的 registry.lazycat.cloud 地址。
set -eu

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_ROOT="$REPO_ROOT/.lzc-image-src"
IMAGE="${1:-c1own123/qsv-web:0.1.0}"
QSV_VERSION=23.0.1
QSV_ZIP_SHA256=df3a52004d3f3d7aaacec9326749967eaf2aa60cb8552253123b8487a0c6796c

cd "$REPO_ROOT"
# 清理上次产物，保留已下载好的 qsv 引擎（qsv 二进制或部分下载的 zip）避免重复下载
if [ -d "$SRC_ROOT" ]; then
  find "$SRC_ROOT" -mindepth 1 ! -path "$SRC_ROOT/bin/qsv" ! -path "$SRC_ROOT/bin/qsv.sha256" ! -path "$SRC_ROOT/bin/qsv.zip" -delete
else
  mkdir -p "$SRC_ROOT"
fi
mkdir -p "$SRC_ROOT/bin" "$SRC_ROOT/licenses"

echo "[lzc-image] 构建前端"
pnpm --filter @qsv-web/web build

echo "[lzc-image] 编译 API 服务"
pnpm --filter @qsv-web/server build

echo "[lzc-image] 收集服务端代码与生产依赖"
pnpm --filter @qsv-web/server deploy --legacy --prod "$SRC_ROOT/server"
cp -R apps/web/dist/. "$SRC_ROOT/web/"
cp ../LICENSE-MIT "$SRC_ROOT/licenses/qsv-LICENSE-MIT"

if [ -f "$SRC_ROOT/bin/qsv" ] && [ -f "$SRC_ROOT/bin/qsv.sha256" ]; then
  echo "[lzc-image] 复用已下载的 qsv 引擎"
else
  echo "[lzc-image] 下载 qsv 引擎 ${QSV_VERSION}（linux-amd64）"
  curl -fL --retry 20 --retry-all-errors --continue-at - --speed-time 30 --speed-limit 51200 --output "$SRC_ROOT/bin/qsv.zip" \
    "https://github.com/dathere/qsv/releases/download/$QSV_VERSION/qsv-$QSV_VERSION-x86_64-unknown-linux-gnu.zip"
  SUM_CMD="sha256sum"
  command -v sha256sum >/dev/null 2>&1 || SUM_CMD="shasum -a 256"
  ACTUAL_SHA256="$($SUM_CMD "$SRC_ROOT/bin/qsv.zip" | cut -d' ' -f1)"
  if [ "$ACTUAL_SHA256" != "$QSV_ZIP_SHA256" ]; then
    echo "[lzc-image] qsv 引擎压缩包校验失败：$ACTUAL_SHA256" >&2
    exit 1
  fi
  MEMBER="$(unzip -Z1 "$SRC_ROOT/bin/qsv.zip" | grep -E '(^|/)qsv$' | head -n 1)"
  if [ -z "$MEMBER" ]; then
    echo "[lzc-image] 压缩包内未找到 qsv 可执行文件" >&2
    exit 1
  fi
  unzip -p "$SRC_ROOT/bin/qsv.zip" "$MEMBER" > "$SRC_ROOT/bin/qsv"
  chmod 755 "$SRC_ROOT/bin/qsv"
  $SUM_CMD "$SRC_ROOT/bin/qsv" | cut -d' ' -f1 > "$SRC_ROOT/bin/qsv.sha256"
  rm "$SRC_ROOT/bin/qsv.zip"
fi

echo "[lzc-image] 构建镜像 ${IMAGE}（linux/amd64）"
docker build --platform linux/amd64 -f lzc/Dockerfile -t "$IMAGE" .

echo "[lzc-image] 推送前冒烟验证"
docker run --rm --platform linux/amd64 --entrypoint sh "$IMAGE" -c '
  set -eu
  test -f /app/server/dist/main.js || { echo "缺 /app/server/dist/main.js" >&2; exit 1; }
  test -d /app/server/node_modules/better-sqlite3 || { echo "缺 better-sqlite3 依赖" >&2; exit 1; }
  test -f /app/web/index.html || { echo "缺前端产物" >&2; exit 1; }
  node -e "require(\"/app/server/node_modules/better-sqlite3\")" || { echo "better-sqlite3 绑定加载失败（架构不符）" >&2; exit 1; }
  /app/bin/qsv --version >/dev/null 2>&1 || { echo "qsv 引擎无法运行（缺动态库或 GLIBC 不符）" >&2; /app/bin/qsv --version 2>&1 | head -3 >&2 || true; exit 1; }
  echo "smoke-ok: $(/app/bin/qsv --version | head -1)"
'

echo "[lzc-image] 推送镜像 $IMAGE"
docker push "$IMAGE"
echo "[lzc-image] 完成。下一步：lzc-cli appstore copy-image $IMAGE"
