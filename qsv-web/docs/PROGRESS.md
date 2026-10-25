# Web 项目进度

最后更新：2026-10-24。

| 阶段 | 状态 | 证据与下一步 |
|---|---|---|
| 文档初始化 | 已完成 | PRD、PPD 已集中到独立目录；文档地图、需求、决策和进度索引已建立。 |
| 前端演示页面（历史） | 已结束 | 原 P01—P16 演示版本曾用于布局核对；2026-09-26 已移除 mock 数据层和演示页面代码，历史记录见 [REQ-20260925-002](Requirements/REQ-20260925-002.md)。 |
| 开发前核验 | 本机部分完成 | macOS ARM64 qsv 23.0.1 发布包 hash、索引、计数、行块和文本保真已核验；本机 SQLite 绑定版本已检查。懒猫移植与真机适配按用户要求暂缓。见[核验记录](ENGINE_VERIFICATION.md)。 |
| V1 功能实现 | 进行中 | P01—P16 的主要页面与实际 API 已分批写入，覆盖导入、浏览、清洗、合并关联、核对、质量检查、统计、受限 SQL、模板流程及任务管理。当前没有 mock 数据。 |
| V1 统一验证与验收 | 进行中 | 2026-09-29 首轮本机浏览器检查发现 P07、P09、P13 阻断及启动/类型问题；2026-10-11 已修复这些阻断与全部 `pnpm typecheck` 错误，并复验 P01—P16 核心路径（关联、核对、SQL、模板、导出均通过）。同日按用户要求实现懒猫 OIDC 登录页与登录门禁（`AuthProvider` 抽象、`/login` 页面、manifest 注入应用来源、放行静态资源），用本机 stub 提供方端到端跑通登录→授权→回调→会话→退出。2026-10-24 用 `test-data/` 每页测试数据完成 P01—P16 逐页浏览器测试：修复 10-17 遗留的工作簿预览 422 与核对提交 PREFLIGHT_STALE（时区字段被 schema 剥离）、favicon 404，共 3 条；工作簿预览、核对边界容差、质检多规则、统计/透视/图表、模板批量均按测试数据设计验证。回归：`pnpm typecheck` 0 错误、`pnpm test:web` 1/1、`pnpm test:server` 15/15。Bug 台账 34 条全部闭合。仍未验证：文件选择/上传队列与工作表勾选的界面验证（本轮浏览器不支持文件选择器，服务端路径已 API 验证）、百万行、Parquet/ODS 导入、批量取消与失败重试、配额与清理、断电恢复全流程、懒猫真机 OIDC/入口隔离。详见[第三轮测试记录](QA-20261024-V1-per-page-test.md)、[Bug 台账](BUG_TRACKER.md)、[OIDC 决策](Decisions/DEC-20261011-005.md)与[QA 进度](Progress/PROG-QA-20261024-web-v1-per-page.md)。 |
| V2 增量 | 未开始 | 依赖 V1 稳定；范围见 PRD 第 8—10、13.2 节。 |
| 懒猫 lpk 打包 | 本机打包完成 | 2026-10-24 按 lazycat-transplant-spec 建立 LPK V2 打包（`qsv-web/package.yml`、`lzc-manifest.yml`、`lzc-build.yml`、`lzc/` 脚本），应用户要求采用自定义镜像方案：应用代码、生产依赖与 qsv 引擎 23.0.1 全部进 linux/amd64 镜像（`lzc/build-image.sh` + `lzc/Dockerfile`），经 Docker Hub 与 `lzc-cli appstore copy-image` 拷入懒猫官方仓库（`registry.lazycat.cloud/u30387910/c1own123/qsv-web:3472c4cc3f9ed883`）；lpk 内容目录只保留官方文件拦截器脚本，产物 `cloud.lazycat.app.qsv-web-v0.1.0.lpk`（1.03 MiB、v2、lint 无警告）。前端 15 处直接下载锚点统一改为 fetch+Blob 下载以接入拦截器（`fileInput`、`fileSystemAccess`、`downloadAnchor` 全开），上传入口保持原生 `input type=file`。回归：typecheck 0 错误、`pnpm test:web` 1/1、`pnpm test:server` 15/15。真机部署、OIDC 登录与拦截器实际行为未验证。详见[懒猫打包进度](Progress/PROG-20261024-lazycat-lpk-v2.md)。 |

本文件只记录项目级状态。功能阶段、依赖与验证证据见 `Progress/LEDGER.md` 下的对应记录。
当前前端没有 mock 数据；P01—P16 已在 2026-10-24 用每页测试数据逐页复验。PRD 的完整 V1 验收仍未完成。
