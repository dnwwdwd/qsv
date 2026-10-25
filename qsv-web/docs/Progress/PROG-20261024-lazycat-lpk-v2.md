# 懒猫微服 LPK V2 打包与文件拦截器接入进度

- 需求/任务：将 qsv 数据工作台按懒猫移植规范打包为可安装的 lpk；所有文件上传与下载入口接入懒猫文件拦截器。2026-10-24 当日应用户要求，运行时从"内容目录随包分发"改为自定义镜像并拷入懒猫官方仓库。
- 状态：本机打包完成（自定义镜像已入懒猫官方仓库），真机部署未验证。
- 最近更新：2026-10-24

## 交付物

### 运行时（自定义镜像方案，用户指定）

- `lzc/build-image.sh`：一条龙构建并推送 linux/amd64 应用镜像。在本机完成前端构建、服务端编译、`pnpm deploy --legacy --prod` 收集生产依赖（better-sqlite3 使用 npm 包自带 linux-x64 预编译二进制）、下载 qsv 引擎 23.0.1（x86_64 gnu 版，SHA-256 校验 `df3a5200…`；支持断点续传、低速自动重连与已下载引擎复用）到 `.lzc-image-src/`，再 `docker build --platform linux/amd64` 出镜像；推送前先做容器冒烟验证（入口文件与前端产物存在性 + better-sqlite3 绑定加载 + `qsv --version` 实跑），通过后才 `docker push` 到 Docker Hub（`c1own123/qsv-web:0.1.0`）。
- `lzc/Dockerfile`：收集型镜像（node:24-trixie 基座，GLIBC 2.41——qsv 23.0.1 gnu 构建要求 GLIBC 2.38/2.39，bookworm 的 2.36 不满足；补装 tini/libssl3/liblzma5/libwayland-client0/libxkbcommon0/ca-certificates），只 COPY `.lzc-image-src/` 已构建产物，不在镜像内执行构建；预建 `/lzcapp/var/data`、`/lzcapp/cache`。注意 `qsv-web/.dockerignore` 原有 `**/node_modules`、`**/dist` 排除（旧容器内构建方案防源码树垃圾），已加 `!.lzc-image-src` 例外，否则收集产物进不了镜像（见 BUG-20261024-004）。
- `lzc/run.sh`：随 LPK 内容目录分发（`/lzcapp/pkg/content/lzc/run.sh`，调整启动逻辑无需重建镜像）。先创建并修正数据目录（`chown` 给当前用户、`chmod 700`——instance-lock 要求"当前用户拥有的 0700 目录"，平台挂载目录属主与权限不可控；容器以 `user: "0"` root 运行），再设置 `NODE_ENV=production`、`TMPDIR=/lzcapp/cache`，启动 `node /app/server/dist/main.js`；只启动服务，不做任何安装或构建。曾因沿用内容目录方案旧路径导致真机启动失败（BUG-20261024-004）。
- 镜像流转：Docker Hub（`c1own123/qsv-web:0.1.0`，公网可访问，digest `d8bda086…`）→ `lzc-cli appstore copy-image` 拷入懒猫官方仓库 → 官方地址 `registry.lazycat.cloud/u30387910/c1own123/qsv-web:8e7e09728b67d930`（每轮重新 copy-image 会生成新哈希 tag，须同步更新 manifest）。
- `lzc-manifest.yml`（LPK V2，仅运行时结构）：单服务 `web` 使用上述官方镜像地址，`user: "0"`（root，配合启动脚本修正数据目录权限），`command: sh /lzcapp/pkg/content/lzc/run.sh`；路由 `/=` 指向服务；持久数据绑定 `/lzcapp/var/data`，缓存绑定 `/lzcapp/cache`（`TMPDIR` 指向后者）；环境变量中 `QSV_WEB_DIST=/app/web`、`QSV_BIN=/app/bin/qsv`、`QSV_SHA256_FILE=/app/bin/qsv.sha256` 均指向镜像内路径（曾因遗留内容目录路径导致启动失败，见 BUG-20261024-004）；OIDC 回调 `/auth/oidc/callback` 与平台凭据环境变量（`LAZYCAT_AUTH_OIDC_*`）；注入两条：请求级懒猫文件桥（`/__lazycat_file_bridge/*` 代理云盘文件域）与浏览器级官方文件拦截器脚本（`fileInput`、`fileSystemAccess`、`downloadAnchor` 钩子全开）。
- 说明：移植规范默认不建议为预装依赖发布自定义镜像；本次按用户明确要求改为自定义镜像方案（应用依赖、qsv 引擎全部进镜像），偏离已记录于此。

### LPK 打包（内容目录只保留平台注入资源）

- `package.yml`：静态元数据。包名 `cloud.lazycat.app.qsv-web`，版本 0.1.0，名称"数据工作台"，描述"基于 qsv 表格引擎的数据工作台，在个人空间内导入 CSV、Excel、JSON、Parquet 等表格文件，进行清洗、转换、核对、统计分析并导出结果"（按用户要求重写；homepage 与 author 字段按用户要求移除），`min_os_version: "1.5.0"`，四语种（zh、zh_CN、en、ja）名称与描述同步，权限 `net.internet`。
- `lzc-build.yml`：`buildscript: sh lzc/build-package.sh`，内容目录 `./lzc-dist`，图标 `./lzc-icon.png`（512×512）。
- `lzc/build-package.sh`：清理并重建 `lzc-dist`，只复制官方文件拦截器脚本（`lzc/lazycat-injects/lzc-file-chooser-inject.js`，基于 `@lazycatcloud/lzc-file-pickers 2.1.3` 的官方构建产物，未做本地修改）——注入脚本必须随包分发（平台侧 `file:///lzcapp/pkg/content/...` 引用），其余运行时内容已全部进镜像。
- 产物：`qsv-web/cloud.lazycat.app.qsv-web-v0.1.0.lpk`（1.03 MiB，lpk_version v2，未签名）。
- 关系说明：`qsv-web/lazycat/` 是更早的 LPK V1 草案（`embed:` 内嵌镜像 + `exec://` 路由），被本轮 V2 + 自定义镜像方案取代，目录暂保留作历史参考。

### 前端下载入口统一改造（接入拦截器的前提）

- `apps/web/src/api/client.ts` 新增 `downloadFromUrl` / `downloadResource`：先 `fetch` 二进制，再经 `URL.createObjectURL` + 锚点 `download` + `click` 触发保存；文件名优先取响应 `Content-Disposition`（支持 `filename*=UTF-8''`），否则用资源名兜底；60 秒后回收对象 URL。
- 将 15 处直接 `<a href=下载接口>` 锚点全部改为按钮调用统一下载：资源下载 10 处（资源列表、资源详情、数据集页顶栏、拆分 ZIP、核对明细、统计、质检、流程步骤产物、任务详情主输出与产物表），任务报告下载 5 处（清理步骤报告、关联未匹配清单、JSON 异常记录、JSON 值转换清单、CSV/工作表异常记录）。上传入口不变：4 个原生 `<input type="file">`（accept 均为具体类型，无 `*/*`）与拖拽队列已由 `fileInput` 钩子覆盖，本地文件与懒猫文件走同一上传路径。

## 验证证据

- `pnpm --filter @qsv-web/web typecheck` 0 错误；`pnpm test:web` 1/1；`pnpm test:server` 15/15，与既有基线一致。
- 修复后的镜像在本机 amd64 容器完成最终验证：以真机同款参数（`--user 0`、docker volume 模拟平台 0755 数据目录、挂载内容目录 run.sh）启动，数据目录被自动修正为 `root:root 700`，`/api/v1/capabilities` 返回 `engine.verified: true`（qsv 23.0.1，Debian 13 基座），`/health` 正常，前端静态服务正常（BUG-20261024-004）。
- `lzc-cli appstore copy-image c1own123/qsv-web:0.1.0` 完成并返回官方地址 `registry.lazycat.cloud/u30387910/c1own123/qsv-web:8e7e09728b67d930`（`lzc-cli appstore my-images` 可查）。
- `lzc-cli project build` 产出 1.03 MiB lpk；`lzc-cli lpk info` 报 `lpk_version: v2`；`lzc-cli lpk lint` 无警告（镜像地址符合上架要求）。
- 内容目录 `lzc-dist` 仅含注入脚本（1.0 MiB）；运行数据路径 `/lzcapp/var/data`、缓存 `/lzcapp/cache`，不写包内容目录与镜像层。

## 边界与未验证项

- 真机部署（`lzc-cli project deploy` 或安装 lpk）未执行，懒猫 OIDC 登录、文件拦截器（上传选择、下载保存到本地/懒猫云盘）、文件桥请求级注入的实际行为未在真机验证；需用户授权后进行。
- 基础镜像 node:24-bookworm-slim 的 Node 版本满足 better-sqlite3 v13 要求（Node ≥ 22），但服务未在 linux 容器内实际启动过；首次真机启动需留意日志。
- 上架商店还差平台验收项（参考官方审核规则）：数据持久化验证（重启/升级不丢数据）、启动速度（≤ 5 分钟）、工具类应用与懒猫网盘文件类型关联（`file_handler`）等；lpk 未签名，推送、发布均未执行（按仓库规则需用户授权）。
