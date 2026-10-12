# qsv Web V1 本机业务流程测试记录（第二轮）

日期：2026-10-11（Asia/Taipei）
范围：修复后重跑 P01—P16 页面与核心业务路径。第一轮记录见 [QA-20260929-V1-business-flow-test.md](QA-20260929-V1-business-flow-test.md)。

## 测试环境

- Web：`http://127.0.0.1:5273`；API：`http://127.0.0.1:5274`；Node.js 24.18.0；pnpm 10.18.0。
- 固定引擎：qsv 23.0.1，SHA-256 `82f5ae1cb2069c3acbee487d533501afa782470be0f9231ff54a01dbf4517fd7`（本轮从官方 Release 重新下载，发布包 hash `0cf0979…0942` 与 `ENGINE_VERIFICATION.md` 一致）。
- 浏览器：DimAgent 共享预览（Chrome）。
- 数据目录：`/tmp/qsv-web-data`（本机 QA 私有目录，非用户数据）。测试数据：6 行订单、4 行发货、4 行右侧对照，均为 UTF-8 CSV。

### 本机启动

第一轮需要 `/tmp` 临时 loader 才能启动 API。本轮修掉 parameter property 与 CommonJS 命名导入后，仓库命令可直接启动：

```bash
QSV_BIN=/tmp/qsv-23.0.1/qsv QSV_SHA256=82f5ae1c… QSV_DATA_DIR=/tmp/qsv-web-data \
  node src/main.ts    # API :5274，无需 loader
pnpm dev              # Web :5273
```

## P01—P16 页面结果

| 页面 | 结果 | 浏览器验证 |
|---|---|---|
| P01 概览 | 通过 | 显示资源、运行/排队、需处理、已登记空间与引擎状态；可进入工具页。 |
| P02 文件与数据集 | 通过 | 名称筛选、类型筛选（选“原文件”后剩 1 项）可用；原文件详情页改名（含“内置示例”标记校验）与保存成功；回收站入口可见。 |
| P03 导入与解析 | 通过 | 真实选择 `orders.csv`、`shipments.csv` 两份文件，分块上传后逐份预览（各 4 条样本、字段类型建议），确认导入各生成数据集（6 行 / 4 行）。 |
| P04 数据集详情与浏览 | 通过 | 浏览 6 行 6 列；全表文本筛选 `order_id=A002` 生成新数据集（4→1 行）；字段列表、复制范围、修正草稿入口正常。 |
| P05 清洗与转换 | 通过 | 对 `note` 去首尾空白（6→6 行）；按 `order_id` 去重（6→5 行，移除 1 行）。 |
| P06 格式转换与导出 | 通过 | 指定第 2—3 行导出 CSV：预检显示 2 行，完成文件 2 行。 |
| P07 合并、关联与集合 | 通过 | 首屏不再崩溃；按键关联 orders.csv 去重(5 行) × shipments.csv(4 行)，预检“预计 3 行”，提交后成功输出 3 行（A001/A002/A004），来源行号正确。 |
| P08 拆分与重组 | 通过 | 每份 2 行拆分 6 行数据集，预计 3 份，输出 ZIP 含 3 个 chunk 与清单。 |
| P09 双表核对配置 | 通过 | orders.csv(6 行) 对 right.csv(4 行) 全量预检：一致 0、差异 3、仅左 1、仅右 1、左侧重复组 1；确认后成功创建核对任务。 |
| P10 双表核对结果 | 通过 | 汇总与 7 行明细可见（字段差异/仅左/键冲突/仅右），左右行号可跳转；生成分类 CSV 报告成功。 |
| P11 数据质量检查 | 通过 | 对 `order_id` 做唯一性全表检查，6 行中输出 2 行异常记录。 |
| P12 统计、汇总与透视 | 通过 | 字段统计输出 7 行；按 `sku` 分组汇总输出 3 组；聚合结果图表显示 SKU-1=2、SKU-2=3、SKU-3=1（与结果表一致）。 |
| P13 SQL 查询 | 通过 | 默认 `SELECT * FROM t1 LIMIT 200` 样本预览返回 6 行；完整查询输出 6 行。 |
| P14 模板与流程 | 通过 | 从“去重 orders.csv”保存模板，替换输入后检查通过、样本试跑 6→5 行、`运行 1 组` 批量完成；另从“导出 orders.csv”保存范围导出模板，样本试跑 2 行、批量运行完成。 |
| P15 任务与结果 | 通过 | 任务列表 23 项，按状态筛选（“失败”）得 2 项；成功任务显示输入版本、固定规则、阶段、产物与下载；失败任务因 `retryable: false` 不显示重试按钮（符合预期）。 |
| P16 设置、空间与关于 | 通过 | 本机用户、占用分类、保护上限、引擎信息可见；把默认输出格式改为 TSV 保存成功，再恢复 CSV 保存。 |

## 本轮修复

按发现顺序，均记入 [Bug 台账](BUG_TRACKER.md)：

1. **服务端开发/测试启动阻断**（BUG-20260929-001、002）：parameter property、CommonJS 命名导入、重复 501 路由。修复后仓库命令可直接启动与测试。
2. **P07 关联全量执行失败**（BUG-20261011-001）：`qsv joinp` 需要列名而非数字下标，且会丢弃右侧连接列。改为两侧独立连接列。
3. **P09 核对提交 `PREFLIGHT_STALE`**（BUG-20260929-005）：提交 schema 未声明全部 `CompareConfig` 字段，被 Fastify 剥掉后 hash 不符。补全 schema。
4. **P13 合法 SELECT 被拒**（BUG-20260929-006）：`node-sql-parser` 对普通 SELECT 也返回 `into: { position: null }`。改为只在 `into` 含字符串 `type` 时判为写出语法。
5. **P07 首屏崩溃**（BUG-20260929-003）：11 处 `tone="warning"` 改为 `tone="warn"`。
6. **核对报告导出后服务无法重启**（BUG-20261011-002）：派生文件名含 `/` 写入 `commit.json`，被 `isCommit` 拒绝。派生名先去路径分隔符。
7. **模板跨重启误报引擎不兼容**（BUG-20261011-003）：`qsv --version` 含易变内存数字。比较前归一化。
8. **备份恢复版本上限陈旧**（BUG-20261011-004）：备份校验写死 ≤4，schema 已是 5。改用共享 `SCHEMA_VERSION`。
9. **恢复用例陈旧预期**（BUG-20261011-005）：补 `exportsRestored`。
10. **`pnpm typecheck` 全部错误**（BUG-20260929-007）：web + server 均清零。

## 补充命令校验

- `pnpm typecheck`：通过，0 错误（web 与服务端）。
- `pnpm test:web`：通过，1/1。
- `pnpm test:server`：15 个用例 9 个通过。6 个失败全部是 `lazycat` 模式下用 `X-HC-User-ID` 头区分用户、而实现只认 OIDC 会话的契约不一致（BUG-20261011-006，平台身份按用户要求暂缓，未改）。

## 懒猫 OIDC 登录门禁（2026-10-11 追加）

用户要求「必须登录懒猫 OIDC 之后才可以使用项目功能」，本轮实现并按用户选择「严格只用 OIDC 会话」处理身份来源。参考同级项目 `lazycat-search`（`/login` 页面 + OIDC 授权码流程）与懒猫技能文档（`oidc_redirect_path` 与 `LAZYCAT_AUTH_OIDC_*` 注入）。决策见 [DEC-20261011-005](../Decisions/DEC-20261011-005.md)。

实现要点：

- 服务端身份提供者抽成 `AuthProvider`；生产只用 `OidcAuth`（OIDC 会话 cookie），测试用 `src/test-auth.ts` 的 `StubAuth`，`main.ts` 永不构造 `StubAuth`。
- 新增前端 `/login` 页面；未登录时页面 302 到 `/login`、API 返回 401、静态构建产物放行；回调失败跳 `/login?authError=…`。
- `lazycat/lzc-manifest.yml` 注入 `QSV_APP_ORIGIN=https://{{ .S.AppDomain }}`，修复真机启动失败（BUG-20261011-007）。
- 本机验证需要回环 http 时，`QSV_OIDC_ALLOW_INSECURE=1` 且 issuer 为回环地址才放行；生产强制 HTTPS，该开关不写入 manifest。

本机 stub 端到端验证（临时 stub 实现 discovery/auth/token/userinfo，RS256 签发 id_token）：

| 步骤 | 结果 |
|---|---|
| 未登录 `GET /` | 302 → `/login` |
| 未登录 `GET /api/v1/session` | 401 `UNAUTHENTICATED` |
| `GET /login` | 200，渲染登录页 |
| 点击登录 → 授权 → 回调 | 建立会话，302 → `/`，进入工作台（`source: lazycat`、`role: admin`、独立空空间 0 项） |
| 篡改 state 回调 | 302 → `/login?authError=state`，页面显示“登录状态无效” |
| 退出后 `GET /` | 会话失效，302 → `/login` |

回归：`pnpm typecheck` 0 错误、`pnpm test:server` 15/15、`pnpm test:web` 1/1。真机 OIDC（`{{ .S.AppDomain }}` 渲染、平台 issuer 连通性、入口隔离）未验证。

## 未覆盖与后续

- 百万行边界、工作簿（XLSX/ODS）导入与 Sheet 拆分、Parquet/JSON 导入、取消与失败重试、配额与清缓存、断电恢复均未在本轮验证。
- 懒猫真机 OIDC 与入口隔离未验证；`{{ .S.AppDomain }}` 实际渲染结果需在设备上确认。
