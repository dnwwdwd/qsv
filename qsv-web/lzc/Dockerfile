# qsv 数据工作台自定义应用镜像（linux/amd64）。
# 产物由 lzc/build-image.sh 先在本机构建到 .lzc-image-src/，本文件只做收集，不在镜像内执行构建。
# 基座用 trixie（GLIBC 2.41）：qsv 23.0.1 gnu 构建要求 GLIBC 2.38/2.39，bookworm(2.36) 不满足（BUG-20261024-004）。
FROM node:24-trixie

# libwayland-client0：qsv gnu 构建链接的运行时库；libxkbcommon0 为其常见伴随依赖
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libssl3 liblzma5 libwayland-client0 libxkbcommon0 tini \
  && rm -rf /var/lib/apt/lists/*

COPY .lzc-image-src/server /app/server
COPY .lzc-image-src/web /app/web
COPY .lzc-image-src/bin /app/bin
COPY .lzc-image-src/licenses /app/licenses
# 启动脚本随 LPK 内容目录分发（lzc-dist/lzc/run.sh），不再打进镜像
RUN chmod 755 /app/bin/qsv && mkdir -p /lzcapp/var/data /lzcapp/cache

ENV NODE_ENV=production
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/app/run.sh"]
