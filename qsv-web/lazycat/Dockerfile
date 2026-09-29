FROM node:24-bookworm AS build
WORKDIR /work
RUN npm install --global pnpm@10.18.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile
COPY apps ./apps
RUN pnpm build && pnpm --filter @qsv-web/server deploy --prod /out/server

FROM debian:bookworm-slim AS engine
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
  curl -fL --retry 3 --output /tmp/qsv.zip https://github.com/dathere/qsv/releases/download/23.0.1/qsv-23.0.1-x86_64-unknown-linux-gnu.zip; \
  echo 'df3a52004d3f3d7aaacec9326749967eaf2aa60cb8552253123b8487a0c6796c  /tmp/qsv.zip' | sha256sum --check --status; \
  mkdir -p /out; \
  member="$(unzip -Z1 /tmp/qsv.zip | grep -E '(^|/)qsv$' | head -n 1)"; \
  test -n "$member"; \
  unzip -p /tmp/qsv.zip "$member" > /out/qsv; \
  chmod 755 /out/qsv; \
  sha256sum /out/qsv | cut -d ' ' -f 1 > /out/qsv.sha256

FROM node:24-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libssl3 liblzma5 tini && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/server /app/server
COPY --from=build /work/apps/web/dist /app/web
COPY --from=engine /out/qsv /app/bin/qsv
COPY --from=engine /out/qsv.sha256 /app/bin/qsv.sha256
COPY lazycat/run.sh /app/run.sh
COPY lazycat/LICENSE-MIT /app/licenses/qsv-LICENSE-MIT
RUN chmod 755 /app/run.sh && mkdir -p /lzcapp/var/data /lzcapp/cache && chown -R 1000:1000 /lzcapp/var /lzcapp/cache
ENV NODE_ENV=production
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/app/run.sh"]
