# qsv Web 数据工作台文档

这里存放基于 qsv CLI 规划的 Web 数据工作台文档，与仓库原有的 `docs/` 分开。文档路径的完整索引见仓库根目录 `DOCUMENT_MAP.md`。

- [产品需求与 V1/V2 边界](qsv_Web_PRD_V1_V2.md)
- [技术架构与实现设计](qsv_Web_PPD.md)
- [固定 qsv 二进制核验](ENGINE_VERIFICATION.md)
- [本机备份与恢复](BACKUP_RECOVERY.md)
- [需求台账](Requirements/LEDGER.md)
- [决策台账](Decisions/LEDGER.md)
- [项目进度](PROGRESS.md)与[功能进度台账](Progress/LEDGER.md)
- [UI 规范](UI_GUIDE.md)与[Bug 台账](BUG_TRACKER.md)
- [V1 本机业务流程测试记录（2026-09-29）](QA-20260929-V1-business-flow-test.md)
- [V1 本机修复与回归测试记录（2026-10-11）](QA-20261011-V1-business-flow-test.md)
- [懒猫 OIDC 登录入口与身份来源决策（2026-10-11）](Decisions/DEC-20261011-005.md)

## 当前可运行范围

`apps/web` 已连接 `apps/server`，不再包含 mock 数据层。目前可在本机将多份 UTF-8 CSV 放入上传队列，查看进度、暂停或继续分块上传，再分别后台导入；也可查看资源和任务、浏览索引行段并下载完整文件，并使用清洗、去重、导出、关联、拆分、双表核对、质量检查、统计与透视、受限 SQL、模板与批量流程。新提交的文件带有提交凭据，服务重启时会核对文件、索引与数据库状态。本机离线备份恢复已演练，断电和目标设备上的恢复仍未验收。工作簿、Parquet/JSON 导入与百万行边界尚未统一验证。服务端使用本地 SQLite 与私有文件目录。运行方式：

```bash
# Requires Node.js 24 and Corepack; pnpm 10.18.0 is declared in package.json.
corepack enable
cd qsv-web
pnpm install
QSV_BIN=/path/to/qsv QSV_SHA256=<该二进制的 SHA-256> QSV_DATA_DIR=/path/to/private-data pnpm dev:server
pnpm dev          # 另开终端；浏览器 http://127.0.0.1:5273，/api 转发到 5274
pnpm typecheck    # 类型检查
pnpm build        # 生产构建
pnpm test:web     # 前端导航回归测试
pnpm test:server  # API 测试
# 停止 API 后运行；命令和限制见 BACKUP_RECOVERY.md
pnpm --filter @qsv-web/server backup create /path/to/private-data /path/to/new-backup
```

`QSV_BIN` 必须指向 qsv 23.0.1；服务启动时核对 SHA、版本及固定 CSV 操作。未配置或核对失败时页面仍可查看已有资源，但上传和导入会拒绝。开发模式仅监听本机环回地址，使用单用户空间；数据目录必须由当前系统用户拥有，权限为 0700。同机其他系统账户仍可能访问本机端口并共用这一身份，因此仅在可信单用户开发环境运行。当前阶段与剩余限制见[功能进度](Progress/PROG-REQ-20260926-003-web-integration.md)。

`AUTH_MODE=lazycat` 会启动真正的懒猫 OIDC 登录门禁：未登录时页面跳转 `/login`、API 返回 401，用户完成 OIDC 登录后才能使用工作台。身份只来自 OIDC 会话（不信任入口请求头）。本机已用 stub 提供方端到端验证；真机 `{{ .S.AppDomain }}` 渲染、平台 issuer 连通性与入口隔离仍未在设备上验证。服务端初始配额为每用户 40 GiB、全局 100 GiB，并保留至少 1 GiB 或当时可用空间的 10%（取较大值）。这些保护值尚未在目标设备验证。

PRD 和 PPD 描述完整目标，不表示其余 V1 工具或懒猫平台能力已经验证。已确认的数据方案见 [DEC-20260926-002](Decisions/DEC-20260926-002.md)。
