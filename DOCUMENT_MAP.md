# 文档地图

本表只记录职责与实际路径。`docs/` 是 qsv 原有项目文档；`qsv-web/docs/` 是 Web 数据工作台的独立文档目录。

| 职责 | 实际路径 |
|---|---|
| 仓库协作规则 | `AGENTS.md` |
| 文档地图 | `DOCUMENT_MAP.md` |
| qsv 项目入口与技术概览 | `README.md`、`docs/contributor/PROJECT_TECHNICAL_OVERVIEW.md` |
| qsv 命令、功能与验证资料 | `docs/help/`、`docs/FEATURES.md`、`tests/` |
| Web 文档入口 | `qsv-web/docs/README.md` |
| Web 产品需求与页面/业务流程 | `qsv-web/docs/qsv_Web_PRD_V1_V2.md`（第 3、6—10、12 节含流程与状态） |
| Web 技术设计 | `qsv-web/docs/qsv_Web_PPD.md` |
| 固定 qsv 二进制核验记录 | `qsv-web/docs/ENGINE_VERIFICATION.md` |
| Web UI 规范 | `qsv-web/docs/UI_GUIDE.md` |
| Web 需求台账与详细记录 | `qsv-web/docs/Requirements/LEDGER.md`、`qsv-web/docs/Requirements/REQ-*.md` |
| Web 决策台账与记录 | `qsv-web/docs/Decisions/LEDGER.md`、`qsv-web/docs/Decisions/DEC-*.md` |
| Web Bug 台账 | `qsv-web/docs/BUG_TRACKER.md` |
| Web 项目进度 | `qsv-web/docs/PROGRESS.md` |
| Web 功能进度台账与记录 | `qsv-web/docs/Progress/LEDGER.md`、`qsv-web/docs/Progress/PROG-*.md` |
| Web 前端代码（React，真实 API） | `qsv-web/apps/web`，工作区根 `qsv-web/package.json`、`qsv-web/pnpm-workspace.yaml` |
| Web API、数据库迁移与后台导入 | `qsv-web/apps/server` |

首次接入：2026-09-25。沿用原有 `docs/` 作为 qsv CLI 文档；将已有 Web PRD、PPD 移入 `qsv-web/docs/`，其余 Web 协作文档在该目录下建立。
2026-09-25 新增的演示前端已于 2026-09-26 移除 mock 数据层。CSV 上传、导入、资源、任务和行段 API 已接通；其余 V1 工具代码正在按需求进度记录分批实现，尚未统一测试与验收。数据方案与开发机二进制已核验；懒猫适配按用户要求暂缓。
