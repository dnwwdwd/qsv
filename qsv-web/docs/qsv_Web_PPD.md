# qsv Web 数据工作台｜PPD 技术架构与实现设计

文档版本：1.0  
编制日期：2026-09-25  
配套文档：`qsv_Web_PRD_V1_V2.md`  
产品名称：暂称“qsv Web 数据工作台”，未确定品牌名。  
文档范围：技术架构、框架选型、数据模型、接口、执行机制、性能工程、安全与部署实现。页面功能与产品验收见 PRD；本文不规定视觉布局。

> 本文是一份待开发系统的设计基线。性能数字均为验收目标或初始保护阈值，未在用户的懒猫设备上实测。上游能力以固定版本的实际二进制、帮助文本和契约测试为准，不用 README 的性能宣传替代测试。

## 1. 架构决策

| 决策 | 本项目采用的方案 | 约束与理由 |
|---|---|---|
| 产品形态 | 浏览器 SPA + HTTP API + 后台数据任务 | 不使用 Electron、Tauri、Wails；浏览器不承担全量数据运算 |
| 前端 | React + TypeScript + Vite | 无公开页面 SEO/SSR 需求；按功能拆包，减少运行时服务 |
| 表格 | TanStack Table v8 + TanStack Virtual | 表格状态与双向虚拟化分开；全量排序、筛选、聚合在服务端执行 |
| 后端 | Node.js 24 LTS + Fastify 5 + TypeScript | 负责 I/O、鉴权、任务编排；CPU 密集任务交给 qsv 子进程或受限 Worker |
| 数据处理 | 固定版本 qsv；首个适配基线为 23.0.1 | 复用转换、清洗、关联、排序、统计和校验能力；不 Fork qsv 主体 |
| 元数据 | SQLite + better-sqlite3，单独 DB Worker | V1 仅 3 张业务表，不将用户的全部表格内容存进 SQLite |
| 文件存储 | 本地持久化目录 + 不可变资源版本 | 原文件、处理结果和检查点可追溯；不强依赖对象存储 |
| 队列 | SQLite 持久化任务 + 进程内调度 | 不引入 Redis、RabbitMQ、Kafka 或独立队列服务 |
| 实时反馈 | SSE；断线后以任务快照恢复 | 不为任务进度引入 WebSocket 服务 |
| 上传 | tus 协议，`tus-js-client` + `@tus/server`/文件存储适配 | 分块、断点续传；不把整个上传读成 Buffer [S25] |
| 精确业务规则 | 受限 TypeScript Worker + decimal.js | 金额容差、重复键裁决和结果分类由业务代码定义 |
| V2 AI | AI SDK + Provider Adapter + 受限 Agent Runner | 共用 V1 的 Plan、权限和执行入口，不另建一条无校验执行通道 |

Node.js 24 在官方版本表中属于 LTS；qsv 的最新 Release 接口在本次核验中返回 23.0.1，发布日期为 2026-09-13。前端与 Node 库的 patch 版本在建仓时锁入 lockfile；不能把“latest”留在生产镜像或 qsv 下载配置中。[S01][S09]

### 1.1 明确不引入的组件

V1 不引入 LLM SDK、Agent Loop、MCP Server、向量数据库、RAG、DuckDB 服务、独立 Polars Python 服务、Office 编辑器、浏览器自动化运行时或通用脚本执行器。qsv 自身编译所含的 Polars 属于 qsv 内部依赖，不额外运行一个 Polars 服务。

V1 的“完整 Web UI”覆盖 PRD 指定的离线结构化数据工作流，不等于把 qsv 所有命令原样公开。`foreach`、任意 Python/Luau、网络抓取、数据库写出和 LLM 子命令均不进入 V1 操作白名单。

### 1.2 性能原则

一次性导入大文件，表示服务端能接收并处理完整数据集。浏览器只读取当前需要的行列及有限缓存。分页减少传输和内存；虚拟化减少渲染节点；两项必须同时实现。TanStack Table 不内置虚拟化，需单独接入 TanStack Virtual。[S10][S11]

qsv 的 `slice` 在存在索引时只解析指定记录；没有索引时需要读过起始行之前的数据。因此，深分页必须依赖已完成的索引，不能用无索引 `slice` 模拟随机访问。[S02]

## 2. 运行结构

```text
浏览器
  React SPA / Table / Virtual / 有界缓存 / 可选样本 Worker
      │ 同源 HTTPS：JSON、上传流、下载流、SSE
      ▼
Fastify API 进程
  Auth / Resource Service / Plan Compiler / Job Scheduler / Result API
      ├── DB Worker ─────────────── SQLite 元数据
      ├── 文件流与 tus ──────────── 持久化目录
      ├── 受限计算 Worker ───────── 精确比较、结果分类、报告格式化
      └── qsv 子进程 ────────────── 文件处理与索引

V2 增量
  AI SDK / Provider Adapter / Context Builder / Agent Runner
      └── 同一个 Plan Validator → Scheduler → qsv Adapter
```

生产环境一个应用容器、一个 HTTP 端口。Vite 仅用于构建和开发；构建后的静态文件由 Fastify 提供。用轻量 init 管理 PID 1 与子进程回收。qsv 无需开启一个长期监听端口。

Fastify 支持发送 Node.js Stream；文件下载走流，不能先 `readFile()` 再序列化。Node 主线程只处理有界请求和调度；数据库同步调用放进 DB Worker，避免大量写入状态或慢查询阻塞 HTTP。[S12][S13]

### 2.1 仓库组织

```text
apps/web/                 React SPA
apps/server/              Fastify、鉴权、资源/任务 API
packages/contracts/       JSON Schema、DTO、Plan、错误码
packages/engine/          Operation Registry、qsv Adapter、能力清单
packages/compare/         精确比较、分类、守恒校验
packages/export/          CSV/XLSX/JSONL 与报告导出
packages/ai/              V2 新增；V1 不安装/打包 AI 依赖
workers/db/               SQLite 单写者 Worker
workers/compute/          有界 CPU 任务
migrations/               有序 SQL 迁移
fixtures/                 边界数据与黄金结果
bench/                    性能场景、采样和结果格式
lazycat/                  package.yml / manifest / build / 文件适配
Dockerfile
pnpm-lock.yaml
```

使用 pnpm workspace。公共模块只共享契约和纯函数；前端不能导入服务端模块、密钥配置或 qsv 执行代码。

## 3. 框架与依赖职责

| 组件 | 职责 | 使用限制 |
|---|---|---|
| React / TypeScript / Vite | 应用页面、状态、按路由拆包 | 图表、SQL 编辑器、V2 AI 组件延迟加载 |
| TanStack Router | 类型化页面路由、URL 状态 | URL 不存敏感原始行或密钥 |
| TanStack Query | 小型元数据请求、失效与请求去重 | 大表块缓存另设字节上限；不能无限累积 infinite pages |
| TanStack Table + Virtual | 字段、选区、排序状态、虚拟视窗 | manualSorting / manualFiltering；不能对局部页执行“全表”计算 |
| Zustand | 当前工具配置、临时选区等局部交互 | 不存全量数据；按 selector 订阅 |
| React Hook Form | 参数表单 | 大表单按操作拆分，字段变更不触发整张数据表重绘 |
| JSON Schema + Ajv | API、Plan、规则的双端校验 | 公共 Schema 为唯一契约来源，禁用额外未声明字段 |
| Apache ECharts | 聚合后的小型图表 | 按需导入；禁止把百万行原始点直接送给图表 |
| CodeMirror 6 | SQL 编辑、语法提示 | SQL 页面进入时才加载；语法提示不等于服务端授权 |
| Fastify 5 | API、静态资源、流式响应、日志 | SSE 不缓存、不压缩缓冲；响应 Schema 避免泄露内部字段 |
| better-sqlite3 | SQLite 访问 | 仅 DB Worker 持有写连接；不把 Database 对象跨线程共享 |
| csv-parse / csv-stringify | 有界预览、结果适配、流式报告 | 不替代 qsv 的通用运算；设最大记录字节数 |
| decimal.js | 十进制金额比较与明确舍入 | 从原始数字字符串构造；禁止先转 Number |
| ExcelJS Streaming Writer | 样式化报告、精确文本列导出 | 只用于导出；不用它在浏览器解析大 Excel |
| SQL AST 解析器 | 检查受限 SQL 的语句、标识符与函数 | 采用 node-sql-parser 的 PostgreSQL 模式并锁版本；仅接受两端都支持的子集 |
| openid-client | 标准 OIDC 授权码流程 | 校验 issuer、audience、签名、state、nonce、PKCE |
| Vitest / Playwright | 单元、集成、浏览器和性能回归 | Playwright 只在测试环境；不打进生产镜像 |

不能因为上述库被选用，就承诺它们组合后天然达到性能目标。表格、SQL AST 兼容、SQLite 原生模块及 qsv 二进制需分别验证。

## 4. qsv 能力适配

### 4.1 固定版本与功能探测

构建保存 `engine-manifest.json`，记录 qsv 版本、源码 tag、二进制 SHA-256、目标架构、完整命令列表、已适配参数及契约测试版本。23.0.1 是首个候选基线；若某个所需命令未包含在发行二进制中，则从相同 tag 定制构建，不假定 amd64 与 arm64 的 Feature 完全相同。

`GET /api/v1/capabilities` 返回产品级能力，例如 `table.compare.exact`、`table.compare.tolerance`、`convert.parquet`，不把 CLI 列表直接变成可执行 API。

每个操作至少通过：标准输入、空表、中文列名、重复表头、空值、超长值、取消、错误退出、资源超限和输出格式契约测试。构建缺少 V1 必需能力时阻止发布，不能悄悄把功能移到 V2。

### 4.2 Operation Registry

每项操作声明：`operationId`、输入数量/格式、参数 Schema、输出 Schema 推导、风险等级、资源等级、确定性、是否保持行数/行序、是否保留来源、允许的 qsv 参数与验证器。

| 产品操作 | 优先采用的上游能力 | 本应用补充实现 |
|---|---|---|
| 导入 Excel/ODS | `excel` | 工作表与范围确认、类型保真、来源定位 |
| 记录数、预览、随机行 | `index` / `count` / `slice` / `select` | 有界分页、列投影、缓存 |
| 文本、空值、日期处理 | `apply` 的非 AI 子命令 / `fill` / `datefmt` | 类型规则、异常分流、结果摘要 |
| 排序、去重 | `sort` / `extsort` / `dedup` / `extdedup` | 内存分级、保留策略、全部重复组呈现 |
| 合并、关联、集合运算 | `cat` / `join` / `joinp` / `exclude` | 字段映射、基数检查、输出膨胀保护 |
| 拆分、列展开、转置 | `split` / `explode` / `implode` / `transpose` | 文件数上限、命名去冲突、基数预估 |
| 严格双表差异 | `diff` | 对齐列、预检主键、修改记录归并 |
| 容差双表核对 | 字符串模式关联或外排 + 流式合并 | 十进制/日期比较、互斥结果分类 |
| 数据质量 | `schema` / `validate` + 分组/过滤 | 唯一性、跨字段约束与逐行报告 |
| 统计、频率、透视、SQL | `stats` / `frequency` / `pivotp` / `sqlp` | 类型确认、采样标识、受限 SQL、聚合图表 |
| 数据格式导出 | `to` / `tojsonl` / `fmt` / `sqlp` | 超限拆分、公式注入保护、格式化报告 |
| 单元格修正 | `edit` 或流式 patch 适配器 | 按稳定行 ID 修改副本；避免每单元格启动一次全表扫描 |

该映射依据 qsv 固定 tag 的命令目录和相应帮助文档。`clean` 在 qsv 中清理的是缓存，不是业务数据清洗；不得把命令名机械翻译成产品功能。[S03][S04][S05][S06]

### 4.3 禁止透传的能力

不接受“qsv 命令字符串”或任意 argv。`foreach`、任意脚本、`fetch`、`fetchpost`、`get` 的网络入口、数据库连接串、远程 Schema、自动下载资源和所有 AI 子命令默认不可调用。qsv 自带 MCP 也不能绕过本应用 Gateway。

命令使用 `spawn(executable, args, { shell: false })`。输入路径由资源 ID 解析；输出路径由任务 ID 生成。即使没有 Shell，也必须校验文件路径、SQL、正则、输出格式和具体子命令，防止“合法 qsv 参数”触发越权读写。

## 5. 数据模型：V1 仅三张业务表

### 5.1 表的边界

| 表 | 合并承载的对象 | 不再拆出的表 |
|---|---|---|
| `resources` | 原文件、解析数据集、衍生版本、报告、导出文件、持久化结果视图 | uploads、files、datasets、dataset_versions、exports、reports |
| `jobs` | 单工具任务、流程任务、比较任务、导入任务；执行快照与汇总 | compare_jobs、conversion_jobs、task_history、job_steps、execution_queue |
| `recipes` | 清洗配方、对账模板、校验模板、SQL 模板、批处理流程及版本 | compare_templates、validation_templates、pipeline_templates、recipe_versions |

三表分开，是因为资源、执行与可复用配置拥有不同生命周期和查询方式。将三种对象塞进一个任意 JSON 表会削弱约束与索引。全局配置采用小型原子 JSON 文件，用户偏好写入各 owner 目录的有界配置文件并带 revision；日志和高频事件采用任务目录中的轮转文件；不为了每种页面建一张表。

V1 使用单应用实例、OIDC 用户私有空间。各表带 `owner_key`；不建立本地用户/角色/组织表。`owner_key` 从已验证的 `(issuer, subject)` 派生，与文件路径使用的 opaque workspace ID 绑定，不能来自请求体。

### 5.2 建表基线

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;

CREATE TABLE resources (
  id                TEXT PRIMARY KEY,
  owner_key         TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK(kind IN
                     ('raw','dataset','report','export','view')),
  status            TEXT NOT NULL CHECK(status IN
                     ('staging','building','ready','failed','trashed')),
  name              TEXT NOT NULL,
  format            TEXT NOT NULL,
  group_id          TEXT NOT NULL,
  version           INTEGER NOT NULL CHECK(version > 0),
  source_ids_json   TEXT NOT NULL DEFAULT '[]'
                     CHECK(json_valid(source_ids_json)),
  producer_job_id   TEXT,
  storage_relpath   TEXT,
  content_hash      TEXT,
  byte_size         INTEGER CHECK(byte_size IS NULL OR byte_size >= 0),
  row_count         INTEGER CHECK(row_count IS NULL OR row_count >= 0),
  column_count      INTEGER CHECK(column_count IS NULL OR column_count >= 0),
  metadata_json     TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  deleted_at        INTEGER,
  UNIQUE(owner_key, group_id, version)
);
CREATE INDEX resources_owner_list
  ON resources(owner_key, kind, status, updated_at DESC);
CREATE INDEX resources_producer ON resources(owner_key, producer_job_id);

CREATE TABLE jobs (
  id                TEXT PRIMARY KEY,
  owner_key         TEXT NOT NULL,
  kind              TEXT NOT NULL,
  name              TEXT NOT NULL,
  state             TEXT NOT NULL CHECK(state IN
                     ('draft','queued','running','cancel_requested',
                      'cancelled','succeeded','failed','interrupted')),
  priority          INTEGER NOT NULL DEFAULT 0,
  parent_job_id     TEXT,
  retry_of          TEXT,
  input_ids_json    TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(input_ids_json)),
  spec_json         TEXT NOT NULL CHECK(json_valid(spec_json)),
  spec_hash         TEXT NOT NULL,
  engine_version    TEXT NOT NULL,
  idempotency_key   TEXT,
  progress_json     TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(progress_json)),
  summary_json      TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(summary_json)),
  error_json        TEXT CHECK(error_json IS NULL OR json_valid(error_json)),
  work_relpath      TEXT NOT NULL,
  event_seq         INTEGER NOT NULL DEFAULT 0,
  heartbeat_at      INTEGER,
  created_at        INTEGER NOT NULL,
  started_at        INTEGER,
  finished_at       INTEGER,
  updated_at        INTEGER NOT NULL,
  UNIQUE(owner_key, idempotency_key)
);
CREATE INDEX jobs_owner_list ON jobs(owner_key, created_at DESC);
CREATE INDEX jobs_queue ON jobs(state, priority DESC, created_at)
  WHERE state IN ('queued','running','cancel_requested');
CREATE INDEX jobs_parent ON jobs(owner_key, parent_job_id);

CREATE TABLE recipes (
  id                TEXT PRIMARY KEY,
  owner_key         TEXT NOT NULL,
  family_id         TEXT NOT NULL,
  version           INTEGER NOT NULL CHECK(version > 0),
  kind              TEXT NOT NULL CHECK(kind IN
                     ('pipeline','compare','validate','sql','transform')),
  name              TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  spec_json         TEXT NOT NULL CHECK(json_valid(spec_json)),
  parameter_schema  TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(parameter_schema)),
  compatibility_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(compatibility_json)),
  is_current        INTEGER NOT NULL DEFAULT 1 CHECK(is_current IN (0,1)),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  deleted_at        INTEGER,
  UNIQUE(owner_key, family_id, version)
);
CREATE UNIQUE INDEX recipes_current
  ON recipes(owner_key, family_id)
  WHERE is_current = 1 AND deleted_at IS NULL;
CREATE INDEX recipes_owner_list ON recipes(owner_key, kind, updated_at DESC);
```

SQLite 版本必须包含官方已修复的 WAL-reset 问题；首版要求实际运行的 SQLite 为 3.51.3 或更新的已修复版本。检查 `SELECT sqlite_version()`，不能仅看 better-sqlite3 的包版本。SQLite WAL 同时仍只有一个写者，且不适合放在网络文件系统上。[S14]

### 5.3 JSON 与文件的分工

`metadata_json` 只保存解析配置、Schema 文件位置、缓存状态、摘要和血缘描述，默认上限 64 KiB。数千列的完整 Schema 写入 `schema.json`，按需读取。

`spec_json` 保存不可变执行快照，最大 256 KiB、最多 64 步、最多 128 个输入引用。`progress_json` 最大 16 KiB，最多每秒更新一次。当前实现还在其中保存最多 64 条任务状态事件，含时间、状态、阶段和错误代码；超过条数或 16 KiB 时删除最早事件并标记截断。旧任务没有历史事件时不补造。百万条差异、校验失败行、完整 stdout、上传分块和聊天全文不得写入这些 JSON 字段。

模板修改生成新版本行；创建任务时复制模板内容并计算 hash。历史任务不依赖模板后来是否改名或被删除。任务重试创建新 `jobs` 行，通过 `retry_of` 关联原记录。

数组引用不建关联表；这是针对有界输入列表的取舍。服务层在同一事务中验证所有引用的所有者、存在性和可用状态。资源物理删除前扫描仍有效任务/资源的引用，建立运行中的文件租约，禁止删除被执行器使用的文件。

### 5.4 V2 增量表

V2 仅增加 `ai_sessions` 与 `ai_events`。前者保存会话标题、模式、模型配置引用、上下文策略、状态和预算汇总；后者按 `(session_id, seq)` 追加用户消息、模型输出、工具调用、审批与运行事件。工具产生的数据任务仍落在 `jobs`。

`ai_events` 的 `payload_json` 保存单条有界事件，`artifact_id` 指向大结果；不将整个会话反复写成一个 JSON。会话与事件分表是为了会话列表和追加日志各自有稳定索引。V2 总计 5 张业务表，不预建记忆库、向量表、工具表或 Provider 表。

## 6. 文件、版本与一致性

```text
/lzcapp/var/data/
  meta.sqlite
  config/app.json
  owners/<workspace-id>/
    config/preferences.json   用户默认值；有界且原子更新
    resources/<resource-id>/
      original.<ext>          原文件；不可变
      data.csv               可预览、可索引的规范化数据
      data.csv.idx           与内容 hash 绑定的索引
      schema.json            字段 ID、显示名、类型、空值规则
      provenance.json        源文件、工作表、范围、操作血缘
      profile.json           有界统计摘要
      cellstate/             需要区分显式 null/缺字段时的稀疏状态
      commit.json             文件提交凭据
    uploads/<upload-id>/       可续传数据与 tus 元信息
    jobs/<job-id>/
      plan.json
      checkpoints/
      events.jsonl
      stderr.log
      result-manifest.json
    secrets/                  V2 加密凭据文件；不向执行器传递
/lzcapp/cache/
  previews/                   可重建的行块缓存
  scratch/                    可丢弃临时计算
```

默认只下载用户主动选择的文件或读取已授权资源。不假定容器可以访问宿主机任意路径，也不把 `/lzcapp/documents` 当元数据目录。内部数据按官方规则放 `/lzcapp/var`，文稿输出与内部缓存分开。[S16]

正式输出先写入与目标资源目录处于同一文件系统的任务临时文件 `output.partial`，关闭并校验记录数/Schema/hash，对文件执行 fsync 后 rename，再同步父目录，最后在 SQLite 事务中标为 `ready`。多文件产物用 manifest 记录所有成员，所有成员提交完成后才发布 manifest。文件系统与数据库没有跨介质原子事务：进程重启必须核对 `commit.json`，恢复已完成文件登记，或回收未登记孤儿；不能只靠数据库状态判成功。

缓存可重建；原文件、用户保留的输出、任务快照和可恢复检查点不可放入随时可清的缓存目录。备份需使用 SQLite 在线备份/一致性快照并附带已提交资源清单；不能只拷贝 WAL 模式下的主数据库文件。[S14]

## 7. 导入和数据保真

### 7.1 导入流水线

`创建上传 → 有界分块写盘 → 完成长度校验 → 计算文件 hash → 解析配置确认 → 规范化 → 快速预览 → 建索引 → 后台统计`。

上传完成不等于数据可用。资源状态分别展示上传、解析、预览就绪、索引中和可用；精确总行数在计算完成前为未知。

CSV/TSV 可以在服务端读取到完整的前若干条记录后提供样本。浏览器可用 Worker 解析至多 2 MiB 前缀来辅助选编码/表头，但必须标记“本地样本”，服务端解析才是最终结果。截断在带引号的多行单元格中不能算作文件损坏。

XLSX、XLS、ODS 的首屏可能需要先完成工作表解析。不能承诺这些压缩容器在收到文件首段时就能完整预览。qsv `excel` 的 Sheet/范围/表头参数用于完成确认后的解析。[S07]

### 7.2 数据语义

字段使用稳定内部 ID（例如 `c_0001`），显示名与原表头另存。空表头、重复表头不会覆盖数据。公式、宏、图表和格式不属于本产品的运算对象；保留原文件，处理数据值。公式缓存缺失或可能陈旧时报告风险，不自动声称已重算 Excel。

编号、手机号、证件号及超长整数默认保留原始字符串。金额比较从字符串解析为 decimal；不能经过 JavaScript Number。类型推断只提出建议，不能静默去掉前导零或改写日期。

内部保留 `value / empty / explicit_null / missing / parse_error` 状态。CSV 空字段通常只能确定为 `empty`；不能反推出原业务 NULL。JSON 的 null、缺字段与空字符串在导入适配器中分别记录，必要时使用按行 ID 索引的稀疏 cell-state sidecar。转换若无法保留某状态，必须在 Plan 中声明映射并由用户确认，不能悄悄合并。

规范化表额外保存内部行 ID。行筛选/排序保持该 ID；合并时加来源命名空间；聚合或多表关联的来源以“输入资源 + 键 + 操作”记录，不为单个输出单元格展开无界血缘数组。内部列必须从 diff 的业务字段集合排除，避免原始行序差异被判成业务差异。

所有基于 qsv 的类型转换路径都要用长整数、前导零、货币、空值和中文日期 fixture 验证。qsv `joinp` 可强制字符串 Schema；自动推断可能移除数字列中的前导零，不能沿用默认推断处理业务键。[S05]

### 7.3 大文件与异常保护

初始限制：CSV/TSV/JSON/JSONL/Parquet 单文件 5 GiB，工作簿类 256 MiB，单条记录 8 MiB，单元格 1 MiB，字段 4096 列；这些是配置初值，不是 qsv 的理论上限。工作簿同时检查解压总量、条目数及实际资源预算。合法但超限的文件应明确拒绝或提示调整，不通过静默截断“成功导入”。

编码支持 UTF-8、UTF-8 BOM、GB18030、UTF-16 LE/BE；根据样本提供建议，用户确认。非法序列默认报错并定位；允许替换必须显式开启并计数。

JSON 顶层对象数组/JSONL 使用有界流式词法解析与字段路径投影，数字在进入 JavaScript Number 前保存原始词法文本；不得先全量 `JSON.parse()`。具体解析适配器须通过不可信输入、最大深度、记录尺寸、原型污染和数值保真测试，未通过不得发布 JSON 导入。数组展开、缺字段策略、类型冲突由用户选择；不默认把多个数组做笛卡尔展开。

## 8. 大表响应与前端性能

### 8.1 首屏与视图

初次进入数据集并行请求轻量 metadata 与首个行块；完整 profile、列频率和索引不阻塞页面外壳。未完成索引时仅开放已确认的前缀预览，深跳转返回 `INDEX_NOT_READY` 或排队，不能暗中扫描几百万行阻塞请求。

排序、筛选、投影形成不可变 `viewId`，内容为资源版本、规范化 filter AST、sort、columns 和语义配置。先完成全量视图计算，再对视图结果建立索引分页。首轮复杂筛选可能是后台任务；重复访问同一 view 使用缓存。不能宣传任意首次查询都达到毫秒级。

### 8.2 行块接口

```http
GET /api/v1/views/{viewId}/rows?offset=500000&limit=512&columns=c_0001,c_0002
```

```json
{
  "viewId": "view_01",
  "revision": "sha256:...",
  "offset": 500000,
  "nextOffset": 500512,
  "columns": [{"id":"c_0001","type":"string"}],
  "rowIds": ["r_500001"],
  "rows": [["000012345678901234"]],
  "totalRows": 1000000,
  "totalKnown": true,
  "hasMore": true,
  "truncatedCells": []
}
```

上例只展示一条记录以说明结构。实际响应按 `limit` 和字节预算返回，默认 512 行、上限 2048 行、未压缩上限 2 MiB；过长字段返回预览与截断标记，全文走单元格接口。大整数与 decimal 以字符串传输。不能因一个长单元格使一页响应变成数十 MiB。

普通行块路径为 `qsv slice` 先取行，再由有界适配器做列投影。不能先 `select` 扫完整表再取 512 行。qsv 子进程启动、磁盘 seek、CSV 解码与 JSON 序列化分别计时；若启动成本超预算，优先增加字节受限块缓存和合并相邻请求，不在未经测量时增加常驻查询数据库。

### 8.3 渲染、缓存与调度

行与列都虚拟化；桌面同时挂载单元格目标不超过 3000。不可创建 `Array(totalRows)` 当占位数据。超长表采用分段逻辑滚动范围和全局行号跳转，避免用“总行数 × 行高”的单个超高 DOM spacer。

浏览器数据块缓存桌面 32 MiB、移动端 8 MiB，按估算解码后内存和块数双重淘汰；不能只按压缩 HTTP 字节估算。服务端预览缓存默认 128 MiB；缓存键包含 owner、资源内容 hash、view hash、列集合、范围和引擎版本。

相邻预取最多前后各 2 块，同一视图并发请求最多 2 个。切换视图用 AbortController 取消旧请求，响应通过 request generation 防止覆盖新状态；旧数据可留在屏幕上，但必须标记新请求处理中。

大表数据不复制进多份 React state。行/单元格使用稳定 ID 与稳定引用，表单状态与表格数据隔离。高频指针和滚动状态放 refs；只有内容变化才触发渲染。Web Worker 用于有界样本解析、批量格式化与较大结果解码，传输可转移 Buffer，避免主线程长任务。[S15]

路由拆包；CodeMirror、ECharts、复杂规则编辑器按需加载。初始 JS gzip 目标 450 KiB 内，V1 不携带 AI 包。图表只接收聚合数据：默认最多 1000 分类或 5000 个采样点，必须显示采样/聚合口径。

### 8.4 下载也要有界

大结果使用鉴权下载端点、HTTP 流和浏览器原生下载。禁止 `fetch(result).blob()` 把整个结果放入内存后再下载。浏览器不重算导出结果；导出读取已固定 view 或任务产物。

懒猫原生文件选择若只能返回完整 `File/Blob`，可能产生“大文件从微服到浏览器、再上传微服”的回流。这条路径不能用于宣称极速服务端导入。实现独立 Platform File Adapter：有官方授权句柄/服务端读取能力时走受控流式复制；未验证时保留文件选择器兼容入口，并明确传输路径和限制，不能擅自将文件 URL 当宿主机路径。[S17]

## 9. 任务执行、恢复与资源管理

### 9.1 持久化状态机

任务转换为 `draft → queued → running → succeeded/failed`。取消走 `queued → cancelled` 或 `running → cancel_requested → cancelled`；进程重启后未终结的运行任务进入 `interrupted`。终态记录不可重用，重试产生新任务并保留 `retry_of`。

同一 `owner_key + idempotency_key` 只能创建一次执行。键相同、请求 hash 不同返回冲突。调度器在事务内领取任务；原型只有一个调度器，也必须防止浏览器重试和重复点击导致重复执行。

流程任务的步骤状态存入有界 `progress_json`，大日志写文件。批量子任务可以共用 `jobs.parent_job_id`；不增加 job_steps 表。当前 V1 阶段记录只保存服务端给出的阶段标签和错误代码，任务创建、状态转换、重启中断都会保留事件；下载的诊断摘要不包含规则、业务行或子进程原始输出。任务日志只记录操作 ID、耗时、计数和错误定位，默认不记录完整原始行。

任务详情从 `resources.producer_job_id` 按 owner 查询该任务的全部产物，包括尚未完成、失败或已移入回收站的记录；页面仅为已提交且状态可用的原文件、数据集和导出文件提供下载。批量任务的子步骤产物由各子任务关联，并在批量详情按组展示，不将子任务产物误归到批量父任务。

### 9.2 初始执行预算

| 项目 | 默认策略 |
|---|---|
| 重任务并发 | 全实例 1 个；包括全表排序、Join、Diff、Excel 解析与完整统计 |
| 轻量读任务 | 最多 2 个；预览缓存命中不占 qsv 重任务名额 |
| 每用户排队上限 | 20 个；全实例 100 个，可配置 |
| 调度公平性 | 按用户轮询取队首；不能由一个用户不断插队占满服务 |
| qsv 线程 | 按容器 CPU 配额设置已支持的 jobs/线程环境变量，默认最多 2 个；禁止每个进程都使用全部宿主机核心 |
| 超时 | 按操作类型设置；预览与全表任务使用不同超时，完整任务初始上限 30 分钟 |
| 输出保护 | 设置预计行数、文件数和磁盘预算；大 Join、展开、透视需预检 |
| 空间保留 | 执行前估算输入、输出和临时文件总量，预留至少 1 GiB 或可用空间的 10%，取较大者 |
| 进度写入 | 最多每秒一次；不能逐行更新数据库或发 SSE |

这些是保护初值，不是硬件能力承诺。无索引的全扫描、精确高基数字段统计和 in-memory 运算不能伪装为轻任务。Polars 的 lazy/streaming 路径也不能保证所有 Join、排序、聚合都只使用固定内存。[S05][S08]

容器设置整体 CPU/内存上限；调度器监测任务进程树 RSS、可用磁盘和超时。Linux 支持时额外设置进程级 CPU/文件尺寸限制。RSS 看门狗属于软保护，不能保证瞬时内存峰值一定不会触发容器 OOM；需要用重任务串行、输入预检与实测预算降低风险。未经实际验证，不宣称存在每任务独立 cgroup 或强隔离沙箱。

### 9.3 取消、检查点与提交

取消先停止新步骤，向目标进程组发送终止信号，宽限期后强制结束，并等待所有子进程退出。不可只取消 HTTP 请求、留下 qsv 在后台继续写文件。输出未提交前只在任务私有临时目录中存在。

每个已完成步骤保存输入 hash、操作参数、引擎版本和产物 hash。恢复只复用完整且校验一致的检查点；单个 qsv 命令运行到一半通常无法从内部偏移恢复，应重跑该步骤。更换输入、引擎或规则后，旧检查点不能混用。

日志断线不影响任务继续执行。SSE 事件带单调序号；客户端重连请求快照，必要时从有界日志补发。快照是状态依据，SSE 不承担唯一持久化职责。没有准确进度的命令展示阶段与已耗时，百分比为未知，不按时间编造进度。

## 10. Plan、模板与操作编排

### 10.1 公共 Plan 契约

V1 的表单生成 Plan；V2 的模型也只能生成相同契约。Plan 保存产品操作，不保存可任意执行的 Shell。示例省略响应元数据，但步骤引用完整：

```json
{
  "schemaVersion": 1,
  "inputs": {
    "left": {"resourceId": "res_left", "revision": "sha256:left"},
    "right": {"resourceId": "res_right", "revision": "sha256:right"}
  },
  "steps": [
    {
      "id": "map_left",
      "operation": "columns.map",
      "input": "left",
      "params": {"mapping": {"c_0001": "order_id", "c_0002": "sku", "c_0003": "amount"}}
    },
    {
      "id": "map_right",
      "operation": "columns.map",
      "input": "right",
      "params": {"mapping": {"c_0002": "order_id", "c_0004": "sku", "c_0005": "amount"}}
    },
    {
      "id": "compare",
      "operation": "table.compare",
      "inputs": ["map_left", "map_right"],
      "params": {
        "keys": ["order_id", "sku"],
        "keyNullPolicy": "reject",
        "duplicatePolicy": "quarantine",
        "fields": [{"field": "amount", "type": "decimal", "absoluteTolerance": "0.01"}],
        "emptyPolicy": "empty_equals_empty",
        "parseErrorPolicy": "quarantine"
      }
    },
    {
      "id": "export",
      "operation": "report.export",
      "input": "compare",
      "params": {"format": "xlsx", "template": "reconciliation", "safeText": true}
    }
  ],
  "outputs": ["compare", "export"],
  "policies": {"originals": "immutable", "overwrite": false}
}
```

Plan 校验依次检查 Schema、步骤有向无环图、引用存在性、字段 ID/类型、用户权限、支持的操作与参数、输出基数、资源预算和数据副作用。字段名称只用于呈现；编译生成的中间列采用受控 ID。缺少映射、同一个输出名冲突或两次使用不存在的步骤必须在运行前报告。

Plan 的规范化 JSON 与输入 revision、引擎 manifest、比较器版本共同计算执行 hash。V2 审批也绑定该 hash。模板复制时可替换数据槽位与参数，但不允许把恶意文件路径塞进参数占位符。

### 10.2 预览与正式运行

静态校验不读取全量数据；样本预览默认 1000 行，并明确行数和抽样方法。预览与正式运行调用同一编译器和相同业务语义。抽样不能证明全量唯一性、全量成功率或所有日期都可解析。

执行全量对账前，必须完成全量主键有效性与重复检查。正式结果记录 `scope=full`；样本输出记录 `scope=sample`，禁止用同一个“全部通过”状态表示二者。

流程以有界 DAG 支持多输入和多输出；V1 不做循环、递归、任意条件脚本或外部 HTTP 节点。UI 用何种方式编辑步骤由设计实现决定，本文只约束 Plan 语义。

## 11. 各类功能的实现方式

### 11.1 字段与行操作

文本清理、替换、空值填充、日期转换优先映射到 qsv 的受支持子命令。不同列使用不同参数时分组执行，避免每个单元格启动子进程。多个可融合操作合并成一次处理；涉及来源追溯和异常报告时保留明确阶段。[S03][S06]

日期规则需指定允许的输入格式、时区及输出格式。`2026/01/02` 一类可能有歧义的输入不能仅凭猜测改变月日。无法解析时按配置保留并标记或隔离，默认不删除。qsv `excel` 的 `--trim` 会移除内部换行，因此不得作为通用导入默认选项；Sheet 名称错误会回退第一张表，应用必须先通过元数据验证选择，禁止接受这个回退行为。[S07]

多步清洗的日期规则区分三种输入：纯日历日期只变更表示格式；带 `Z` 或 `±HH:MM` 的 ISO 时间点可换算到指定固定偏移；无偏移的 ISO 本地时间必须指定输入和输出 IANA 时区。第三种按时区规则确定真实时间点并写出输出时刻的明确偏移；夏令时跳过或重复的本地时间不自动选择，按规则的保留、隔离或停止策略记录。所有路径使用同一规则进行样本试跑和正式执行。

去重的“保留第一条/最后一条”按导入后的稳定来源顺序定义。需要保留最大时间戳时显式声明排序字段和并列策略。不能以 qsv 默认排序后的偶然顺序解释“第一条”。先产生重复组摘要，再按用户选择生成新资源；完整重复组成员通过分组结果查询，不能把 `--dupes-output` 当作完整成员清单。

单元格修正以 rowId + columnId + expectedRevision + expectedOldValue 形成有界 patch，累积后一次性生成副本。超过 10000 个单元格的交互补丁，提示转成批处理规则。支持撤销未提交补丁；已提交版本保留为历史，不回写原文件。

### 11.2 合并、关联、拆分

纵向合并先按字段 ID 对齐，区分严格一致、按列名并集、按列名交集；缺列填充值与类型冲突策略必须进 Plan。按行横向拼接时要求用户明确行位置是业务对应关系，默认不以行位置代替 Join。

Join 支持内、左、右、全、半、反关联。先计算键重复计数与预计输出量；一对一模式有重复直接报错。一般多对多 Join 必须显式选择并确认预计膨胀；默认输出保护阈值为 1000 万行或输入较大一侧的 10 倍，超过任一阈值要求重新确认预算。Cross Join 不进入 V1 普通工具入口。[S05]

拆分支持固定行数、字段值、Sheet。字段值不得直接用作文件路径；生成安全名称并建立原值到文件名清单。默认最多 1000 个输出文件，超限前提示调整。文件导出压缩包采用流式写入；不在内存创建所有结果的 ZIP。

### 11.3 双表核对的两条执行路径

**严格比较路径。** 两张表完成字段映射、相同列顺序、业务规范化与唯一键预检后，可调用 qsv `diff`。modified 的 delete/add 成对归并成一条业务修改记录；差异标签、左右值和来源定位由结果适配器产生。`--drop-equal-fields` 会把相等值变为空字符串，不能用这个精简输出恢复完整原始数据，应从输入资源读取。[S04]

**业务容差路径。** 有金额/日期容差、空值区分或逐字段类型规则时，用字符串键关联，或外排序后流式合并两侧键组，再在受限 Worker 内比较。每批最多 512 行或 2 MiB，结果边计算边写文件。重复键组超大时写临时文件，不能把整个组展开进内存。

主键按分量组成元组，不直接用 `a + "|" + b` 拼接，避免分隔符碰撞。规范化后再次检查唯一性，例如忽略大小写使 `AB` 与 `ab` 合并时，需要进入重复组处理。主键字段保持字符串；空键默认隔离；不自动做模糊匹配。

金额规则 `abs(L - R) <= tolerance` 使用 decimal.js，边界包含等号。容差、比例、精度配置均为十进制字符串。支持绝对容差；相对容差若启用，明确定义分母为 `max(abs(L),abs(R))`，两边均为零时差异为零。V1 不混算不同币种，不自动换汇。

日期可按“日历日期”或“时间点”核对：前者比较日历日差，后者转换成带明确时区的时间点并比较毫秒差；两种模式分开。不能把跨夏令时的一天固定视为 24 小时来解释所有日历日期规则。

`100.004` 与 `100.014` 在容差 `0.01` 下应相等；把两侧先四舍五入再严格比较会得到不同结论。因此，“保留两位小数”与“允许相差 0.01”是两个独立规则，不可互相替代。

### 11.4 分类与数量守恒

默认分类顺序：先排除无法解析的关键字段/无效键，再找出任一侧重复的键集合。这个集合在两侧的所有记录都进入 `key_conflict`：即使右侧该键只有一行，只要左侧有重复，也不能把右侧误报成“仅右存在”。剩余两侧均唯一的记录进行关联。对已匹配但被比较字段解析失败的记录，记为 `pair_error`，不进入“差异”或“相同”。

令 `E` 为一致的匹配对数、`D` 为有差异的匹配对数、`P` 为字段解析失败的匹配对数，必须满足：

```text
左输入行数 = 左无效记录 + 左键冲突记录 + left_only + E + D + P
右输入行数 = 右无效记录 + 右键冲突记录 + right_only + E + D + P
```

一条记录不能同时被记作仅左存在和键冲突；本侧重复组数与受对侧重复影响的行数分别展示。一对记录中多个字段不同只计为一条差异记录，但另外统计差异字段数。汇总明确“记录数、匹配对数、字段数、重复组数”，不能混在一个合计中。

重复政策默认为隔离，另提供终止任务、明确聚合后比较。聚合必须指定数值字段、SUM/COUNT 等规则，保留来源组索引，并将汇总口径单独记账。V1 不实现无共同标识的多笔收款自动凑单核销；一般 Join 允许一对多，不等于完成财务一对多对账。

结果包含稳定 resultId、分类、左右 rowId、映射后的键、原始值、规范化值、比较规则、差值与来源。页面排序筛选只改变视图，不能改变核对结论。人工标注“已核实/忽略”记录在独立的有界批量注释产物中，关联结果版本；不覆盖原计算分类，也不让一张 metadata JSON 无限增长。

### 11.5 质量检查与数据分析

字段类型、必填、枚举、范围、长度、格式优先使用 JSON Schema 与 qsv validate。唯一键、跨字段关系、跨表引用完整性通过分组、Join 或受限表达式补充；不能声称 JSON Schema 自带跨行唯一性检查。

Schema 的远程 `$ref`、网络 dynamicEnum 等功能禁用。用户导入的 Schema 只能引用已上传并授权的本地资源，递归深度与总尺寸受限。错误明细按记录 ID 与字段 ID 流式输出，汇总限制为规则级计数和少量例子。

基本统计优先 qsv stats/frequency；精确统计与近似/采样统计分别存储。高基数频率、唯一值列表、相关矩阵和透视的输出量设上限。跨字段金额乘法、容差与金额汇总需要按 decimal/整数最小单位路径验证，不把二进制浮点 SUM 直接包装成财务精确合计。一般探索图表允许浮点计算，但展示统计用途与精度口径。

### 11.6 受限 SQL

SQL 输入只用于用户已授权的当前数据资源，不连接元数据 SQLite。前端语法补全不能代替后端解析。

服务端 AST 只允许单条 SELECT 或 WITH…SELECT，递归检查所有子查询、CTE、UNION、JOIN、函数、标识符及字面量。表名只允许注册的 `t1/t2/...`；编译器转成 qsv 的受控表别名。函数采用明确白名单，未知函数拒绝。禁止文件/URL读取函数、数据库写入、扩展、PRAGMA、COPY、ATTACH、DDL/DML、多语句脚本以及任何路径构造。

qsv sqlp 本身支持文件表函数和多语句脚本，因此“SQL 是查询”不能被用作安全保证。node-sql-parser 与 Polars 支持语法不完全一致，只发布经过两端测试的交集，拒绝无法完整解析的语法，不能解析失败后直接转发。[S08]

预览默认最多 200 行；输出上限不能代替计算预算，因为 SELECT 的聚合和排序仍可能扫描全表。执行受限 SQL 同样进入任务调度。V1 不开放任意 Luau/Python 作为 SQL 失败的回退通道。

### 11.7 导出与报告

原始数据导出支持 CSV/TSV、JSON/JSONL、XLSX、ODS、Parquet；格式能力按引擎 manifest 与列类型检查，结构化嵌套值要求显式映射。普通数据导出优先 qsv；需要样式、稳定文本类型或逐单元格标注的 XLSX 报告使用服务端 Streaming Writer。

Excel 单工作表上限 1,048,576 行、16,384 列，单元格 32,767 字符。带一行表头时最多导出 1,048,575 条数据行。超限时拆 Sheet/文件，或改用 CSV/Parquet；长文本不得静默截断。[S21]

报告中的用户字符串强制作为文本单元格，不生成公式对象。CSV 默认提供“电子表格安全文本”策略，对可能被解释成公式的字符串进行保护，并提示此策略会改变 CSV 字面内容；需要精确保留原文本时明确选择原始 CSV，并提示在外部表格软件打开的风险。单纯加 CSV 引号并不能消除公式注入风险。负数数值与文本中的公式前缀应按类型分别处理。[S22]

完整 HTML 报告用转义后的静态内容生成，作为附件下载；应用内预览仅显示自身渲染的数据，不直接执行 qsv 或用户提供的 HTML。V1 不内置 PDF 渲染服务，报告以 XLSX/CSV/JSON 与可打印 HTML 交付。

## 12. API 与错误契约

所有端点位于同源 `/api/v1`。除健康检查和受控登录端点外均需认证。资源 ID 只在当前 owner 下解析；越权访问以统一的“未找到/无权访问”响应避免枚举。

| 类别 | 接口 | 行为 |
|---|---|---|
| 能力 | `GET /capabilities` | 固定引擎版本、支持的产品操作、资源上限 |
| 会话 | `GET /session` | 当前用户与功能开关，不暴露 token |
| 上传 | `POST/HEAD/PATCH /uploads` 及协议资源 URL | tus 流程；文件写入与配额归属已认证用户 |
| 导入 | `POST /imports` | rawResourceId + 解析配置；返回 jobId |
| 元数据 | `GET /resources`、`GET /resources/:id` | 有界列表与摘要；游标分页 |
| Schema | `GET /resources/:id/schema` | 字段列表分页、名称检索 |
| 文件元信息 | `GET /resources/:id/workbook` | 已缓存 Sheet/范围元信息 |
| 视图 | `POST /views` | 固定资源 revision + filter/sort/project，返回 ready 或 building |
| 行块 | `GET /views/:id/rows` | 有界行列块，无索引深页返回明确状态 |
| 单元格 | `GET /views/:id/cells/:rowId/:columnId` | 有界全文读取或附件方式；校验来源 |
| Plan | `POST /plans/validate`、`POST /plans/preview` | 校验与样本试跑，不修改原文件 |
| 执行 | `POST /jobs`、`GET /jobs`、`GET /jobs/:id` | 幂等创建、任务列表与快照 |
| 控制 | `POST /jobs/:id/cancel`、`POST /jobs/:id/retry` | 授权控制；重试生成新任务 |
| 事件 | `GET /events` | 按当前用户复用一条 SSE；不广播其他用户事件 |
| 模板 | `GET/POST /recipes`、`POST /recipes/:id/versions` | 模板与不可变版本 |
| 导出 | `POST /exports` | 固定数据/视图/报告配置，返回 jobId |
| 下载 | `GET /resources/:id/download` | Stream，认证、限速、租约与安全文件名 |
| 删除 | `DELETE /resources/:id` | 先软删除，依赖检查后回收 |
| 空间 | `GET /storage`、`POST /storage/cleanup` | 仅当前用户资源；清理目标必须预览 |
| 配置 | `GET/PATCH /settings` | 有界且按权限过滤，文件原子更新 |

JSON 响应返回 `requestId`；异步创建使用 202，不把“已接受”表示成“处理成功”。写接口要求幂等键或 expectedRevision。元数据列表默认 50、最多 200 条。

错误结构示例：

```json
{
  "error": {
    "code": "DUPLICATE_MATCH_KEY",
    "message": "匹配键包含重复记录，尚未执行一对一比较。",
    "details": {"side": "left", "groupCount": 12, "resourceId": "res_duplicates"},
    "retryable": false
  },
  "requestId": "req_01"
}
```

错误码至少覆盖 `UNSUPPORTED_FORMAT`、`PARSE_ERROR`、`HEADER_REQUIRED`、`SHEET_NOT_FOUND`、`INDEX_NOT_READY`、`RESOURCE_REVISION_CONFLICT`、`DUPLICATE_MATCH_KEY`、`INVALID_COMPARE_RULE`、`SQL_NOT_ALLOWED`、`DISK_QUOTA_EXCEEDED`、`OUTPUT_TOO_LARGE`、`TASK_TIMEOUT`、`ENGINE_UNAVAILABLE`、`ENGINE_CONTRACT_MISMATCH` 与 `TASK_INTERRUPTED`。内部路径、SQL 密钥、原始 stderr 不直接返回给普通用户。

## 13. 懒猫部署与平台适配

### 13.1 打包方式

采用 LPK V2 的元数据分离结构，[P01] 维护 `package.yml`、`lzc-manifest.yml`、`lzc-build.yml`、图标及官方文件选择器适配资源。生产镜像转存到 `registry.lazycat.cloud`，填写验证过的不可变镜像引用，不猜测 tag。

产品运行只有 Web 服务和 qsv。构建阶段安装依赖、生成 SPA、编译原生模块、装入固定 qsv 二进制与许可证；启动不执行 npm install、下载引擎或编译大型依赖。镜像基于 glibc Linux，先验证 amd64；arm64 只有通过同一能力与回归矩阵才声明支持。

项目打包基线可从 `min_os_version: 1.5.0` 开始验证；最终最小版本取打包格式、OIDC、文件接口和实测结果要求的最大值，不能在使用新接口时仍无条件宣称兼容旧系统。

应用使用单实例加 owner 隔离，不声明自动按用户复制整个容器。这样多个用户仍有各自文件空间，但 CPU、磁盘和队列配额必须由本应用管理。平台的多实例机制会改变资源用量，只有明确改动隔离模型才启用。[S18]

### 13.2 认证

声明 `application.oidc_redirect_path`，使用平台注入的 OIDC client、authorization、token、userinfo/issuer 配置进行标准授权码登录。回调验证 state/nonce/签名/issuer/audience；使用 PKCE，服务端持有 token，浏览器只持 HttpOnly、Secure、SameSite 会话 cookie。[S19]

会话 cookie 只存经过认证保护的短期身份引用；长期凭据不放 localStorage。无本地用户表时，签名会话采用短过期与密钥轮换；退出清 cookie，明确无法依赖不存在的会话表执行逐用户全局即时吊销。需要强吊销策略时应调整认证实现并补数据模型评审，不能隐含承诺。

OIDC 管理组不自动获得其他人的资源读取权。管理员可设置整体资源限额和诊断运行状态，查看原始用户数据需要单独明确授权。本产品 V1 不提供跨用户共享数据或协同编辑。

### 13.3 文件选择、关联和传输

普通浏览器支持拖放、本地文件输入与原生下载。懒猫中接入官方文件选择器或官方自动接管脚本；新应用优先使用经过验证的官方组件，不复制一套非官方网盘浏览器。[S17]

`file_handler` 声明已支持的 CSV/TSV/JSON/JSONL/XLSX 等 MIME/扩展名；“用当前应用打开”只能启动导入确认，不自动执行清洗。文件定位参数只接受白名单来源及平台授权范围，保留原始文件名，不直接拼接到磁盘路径。

平台文件 Adapter 的验收包括鉴权、断流、超时、超大文件与取消。不读取其他容器的认证文件，不挂 Docker socket，不用宿主机 SSH 实现普通文件处理，不将声明文稿权限视为获得全盘权限。私有文稿与内部文件位置按官方规则区分。[S16]

普通附件入口不设置会破坏官方 chooser 行为的 `accept="*/*"`。选择器和下载接口的确切能力以真机验证为准：只能经浏览器 File/Blob 转发的场景，必须显示额外传输成本并限制超大文件；不能伪称为服务端直读。

### 13.4 持久化与上架检查

映射 `/lzcapp/var/data` 为持久化数据，`/lzcapp/cache` 为可清缓存。包内容只读。OIDC 与核心 API 不使用 `public_path: /` 放行；不额外暴露系统端口。SSE 在平台代理下测试重连，上传在客户端和普通浏览器各做断点续传测试。

真实设备验收包括安装、免密登录、文件关联、文件选择、输出保存、重启、升级、取消任务、恢复中断任务、低空间和卸载数据说明。官方提交规范要求实际功能、文件关联及持久化符合产品声明，不能只验证容器端口打开。[S20]

## 14. 安全实现

qsv 进程使用固定可执行文件和精确白名单参数，`shell:false`；工作目录由服务端建立。原始文件路径、用户文件名和列名不能成为选项、输出路径或 SQL 片段。模板不能包含用户提供的 executable、env、cwd。

路径先做资源归属检查，再在服务端解析实际路径；拒绝绝对路径、路径穿越、符号链接逃逸与超出授权根目录的路径。写入使用唯一任务目录与防覆盖创建，限制读取特殊文件。仅做字符串 startsWith 不构成路径隔离。

qsv 与 API 在同一容器中并不自动形成操作系统级多租户沙箱。当前安全边界包括认证、资源目录、操作编译器、受限 SQL、非 root 运行、上传格式防护与受控进程权限；不得宣传可以安全执行任意不可信代码。高信任隔离需求需另加经过验证的沙箱/独立实例方案。

所有数据值按文本渲染。HTML/Markdown 预览经过净化且不允许脚本、事件属性、危险 URL；CSP 收紧默认源。外部 HTML、公式、单元格内容不得作为应用指令。导入检查压缩炸弹、超深 JSON、大字段、编码错误与畸形记录。正则只发布引擎支持的安全子集，长度/计算预算受限，不接受任意 JS 回调。

下载和 SSE 重新校验当前身份；临时下载 token 只能短期、单资源、只读使用，默认不生成公共链接。资源缓存和 URL 日志不得泄露其他用户的工作区信息。写请求防 CSRF；文件名必须安全编码进 Content-Disposition。

V1 默认不进行业务数据外发。版本检查或外部诊断需要单独开关，不能携带文件名、列名、样本或统计。V2 的网络白名单在下一节定义。

## 15. V2：LLM 与受限 Agent 的技术实现

### 15.1 公共工具入口

V2 新增 Context Builder、Provider Adapter、AI SDK 调用层、Agent Runner 和审批服务，复用 V1 的 Operation Registry、Plan Compiler、Scheduler、资源模型与验证器。AI 输出和 UI 输入具有相同校验标准，模型不能获得独立的 qsv 任意命令通道。

SDK 只处理模型传输、流式响应、结构化输出和工具协议；权限、预算、审批与持久化由本应用实现。AI SDK 目前支持 `generateText/streamText` 搭配结构化 output；仍需对输出执行服务端 Schema 与业务校验，结构合法不代表业务正确。[S23]

明确创建用户配置的 Provider，不使用隐式路由到云网关的默认模型字符串。支持 OpenAI-compatible API 与本地兼容服务；供应商特定适配作为显式选项。Base URL、模型 ID 与 Key 都由用户配置，测试连接使用无业务数据的小请求，并提示可能发生少量调用费用。[S24]

### 15.2 数据上下文

默认 AI 关闭。开启后按用户授权构建最小上下文：操作目录、确认后的字段类型、行数、有限统计、所选资源引用与用户要求。列名、频率表、极值和唯一值本身也可能敏感，不能把“仅元数据”自动称作脱敏。

提供三种发送级别：结构摘要、批准的脱敏样本、批准的原始样本。每次扩大范围必须重新确认；发送前可查看 payload 清单。样本行/列/字节/token 均有上限，禁用自动整表上传。不同来源保留 source/resource/revision/rowId 引用。

列名、单元格、文件名、远程错误消息均视为不可信数据。它们不能提升工具权限、改变系统指令、指定新的外发端点或要求读取密钥。最终事实陈述引用已运行任务和统计 ID；没有证据时只提出假设，不能把统计相关性写成确定原因。

### 15.3 LLM 助手

字段映射输出候选、理由、依据字段与待确认状态；不展示未经校准的百分比置信度。规则建议输出可编辑 Schema/Plan；业务数据质量建议不能自动认定负金额、空值或某类日期一定非法。SQL 仍走第 11.6 节白名单。

自然语言方案先生成结构化 Plan，再校验、样本试跑、展示影响并等待确认。模型只能申请创建新结果，不覆盖原始文件。结果解释优先读取实际统计，不让模型通过肉眼样本重算全表金额。

### 15.4 Agent 状态与工具

Agent 状态：`idle → observing → planning → awaiting_approval → executing → verifying → completed`，另有 `failed/cancelled/paused_budget`。状态迁移写入事件，页面刷新后可恢复展示。UI 可继续使用 V1 功能。

允许工具：`inspect_resource`、`read_bounded_sample`、`profile`、`validate_plan`、`preview_plan`、`propose_plan`、`submit_approved_plan`、`get_job_status`、`read_result_summary`、`read_bounded_result`。其中观察工具受现有数据发送授权限制，昂贵只读分析也受任务预算限制。

读取资源范围必须在会话建立时绑定；修改范围需要用户批准。生成新结果需批准固定 Plan。审批凭据绑定 owner、输入 hashes、Plan hash、输出种类、发送策略与有效期，且只能由真实用户会话生成；不能由模型自己调用“approve”完成授权。

同一已批准计划可以自动执行多个确定步骤。模型改变列映射、去重策略、容差或输入时，审批立即失效。结果验证失败最多提出两次修订计划；每个新计划都要重新确认。工具成功返回不等于任务成功，要检查 job 终态和结果守恒。

初始预算：单轮上下文最多 24000 token，单次 Agent 最多 6 轮模型请求、12 次工具调用、2 次修订；这些是产品保护值，可下调。模型决策累计超时 10 分钟；已经批准的数据任务采用 V1 独立超时，不因在队列中等待而反复请求 LLM。挂起等待任务完成不会自动增加工具调用或重复提交任务。

### 15.5 V2 数据表增量

```sql
CREATE TABLE ai_sessions (
  id            TEXT PRIMARY KEY,
  owner_key     TEXT NOT NULL,
  title         TEXT NOT NULL,
  mode          TEXT NOT NULL CHECK(mode IN ('assistant','agent')),
  state         TEXT NOT NULL,
  config_json   TEXT NOT NULL CHECK(json_valid(config_json)),
  context_json  TEXT NOT NULL CHECK(json_valid(context_json)),
  budget_json   TEXT NOT NULL CHECK(json_valid(budget_json)),
  next_seq      INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE(owner_key, id)
);
CREATE INDEX ai_sessions_owner_list ON ai_sessions(owner_key, updated_at DESC);
CREATE TABLE ai_events (
  id            TEXT PRIMARY KEY,
  owner_key     TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  kind          TEXT NOT NULL,
  payload_json  TEXT NOT NULL CHECK(json_valid(payload_json)),
  artifact_id   TEXT,
  created_at    INTEGER NOT NULL,
  UNIQUE(session_id, seq),
  FOREIGN KEY(owner_key, session_id) REFERENCES ai_sessions(owner_key, id)
);
CREATE INDEX ai_events_session ON ai_events(session_id, seq);
```

工具提交用 `sessionId + toolCallId + approvedPlanHash` 生成幂等键；审批消费、工具提交事件与 jobs 行创建在同一 SQLite 事务中完成，重连后先按幂等键查询真实任务，不重复执行。模型 streaming token 先在有界缓冲中积累，按完成消息/阶段持久化，不为每个 token 写一行。单事件 payload 最大 64 KiB；较大正文转为资源。审批、数据发送和工具执行事件要及时落盘。调用计数和预算更新与 event seq 分配在同一事务中完成。

Provider 配置与密钥文件分开，密钥采用认证加密，主密钥由部署配置提供且不与数据库备份一起导出；不能在前端回显。单容器无法抵抗拥有宿主机权限的管理员，产品不能宣称端到端加密或抵抗主机管理员读取。

### 15.6 网络、失败与停止

模型端点只允许用户显式配置的域名/地址，连接前检查目标与跳转，禁止任意工具请求指定端点。考虑自托管模型需访问局域网，本产品允许已确认的内网端点，不用一刀切“禁止私网 IP”破坏本地模型；云元数据地址和无关系统服务仍禁止。密钥按端点隔离，不随跨域重定向发送。

错误分为认证失败、限流、超时、不支持结构化输出、JSON/业务校验失败和预算超限。仅对可重试错误有限退避；不在用户没同意时切换供应商或将本地请求转发云端。无法提供 usage 时显示“未知/估算”，不伪造精确费用。

停止 Agent 时终止后续模型/工具调度；用户可选择同时取消它创建的运行任务。停止 UI 必须清楚显示哪些任务仍在执行。已提交结果保留，原文件不变；没有运行过的步骤不能显示完成。

## 16. 性能验收与观测

### 16.1 测试条件

初始实验基线：4 vCPU、8 GiB 系统内存、应用容器 4 GiB 内存限额、本地 SSD、1 Gbps 局域网；客户端为 8 GiB 内存以上桌面、1440×900 视窗、受支持的稳定版 Chromium。浏览器、Node、SQLite、qsv、镜像 digest 和实际 CPU 型号必须记录。该环境是测试设计，不代表用户当前设备。

远程链路另外记录网络 RTT、吞吐与代理行为，不套用局域网指标。iOS Safari 与懒猫客户端单独做有界内存和操作可用性测试，不将桌面 FPS 目标直接当作所有手机承诺。

### 16.2 数据集矩阵

| 编号 | 构造规模 | 验证对象 |
|---|---|---|
| B01 | CSV 100 万行 × 20 列，混合短文本/日期/数字 | 常规浏览、索引、排序与过滤 |
| B02 | CSV 1000 万行 × 20 列；记录实际字节数 | 深跳转、长任务、外排、取消与内存 |
| B03 | CSV 1 万行 × 1000 列 | 横向虚拟化、Schema 分页、列投影 |
| B04 | XLSX 10 万行 × 50 列，多个 Sheet | 解析峰值、Sheet 选择、首批可用时间 |
| B05 | 带重复键/空键/货币/超长整数/日期歧义的双表 | 语义正确性与容差边界 |
| B06 | 近阈值长单元格、多行 CSV、异常编码、畸形 JSON | 拒绝与错误定位，无无限内存增长 |
| B07 | 5 GiB CSV；工作簿接近 256 MiB | 上传、断点恢复、配额、磁盘与进程保护 |

### 16.3 初始目标

| 指标 | 初始验收目标 | 测量边界 |
|---|---|---|
| 页面可操作外壳 | 局域网冷缓存 p95 ≤ 2 秒 | 不含原始大文件上传与完整解析 |
| 初始 JS | gzip ≤ 450 KiB | 不含延迟加载的图表/SQL/AI |
| 已就绪数据首屏 | p95 ≤ 800 ms | 元数据与首行块；20 个可见列，普通短单元格 |
| 相邻已缓存行块 | 服务端 p95 ≤ 100 ms | 缓存命中，返回最多 512 行/2 MiB |
| 已索引未缓存行块 | 服务端 p95 ≤ 350 ms | 单轻量请求，真实子进程启动计入 |
| 常规滚动 | 目标中位帧率 ≥ 55 FPS，交互 p95 ≤ 200 ms | B01/B03，热视窗，不含网络等待；长任务次数另记录 |
| 浏览器内存 | 单工作区 JS heap 稳态目标 ≤ 250 MiB | 桌面 B01/B03；连续滚动 10 分钟，不能随已访问总行数线性增长 |
| 任务状态与取消受理 | 状态更新 ≤ 2 秒；取消接口 p95 ≤ 500 ms | 强制结束进程可再用最多 5 秒宽限期 |
| 包装层开销 | 同输入同操作的执行时间目标 ≤ 原生 qsv 基准的 1.25 倍 + 2 秒 | 不把原生命令未做的校验/报告算成“零额外工作” |
| 恢复 | 重启后能列出全部历史和中断状态 | 不要求在 qsv 命令内部断点继续 |

全部数值都要用构建后的 Release 模式测量；不以开发模式或 README 数字判定。未达标时先定位上传、解析、索引、计算、序列化、网络或渲染阶段，再调整实现。验收记录应包含冷/热缓存、p50/p95、峰值内存、输入字节数和错误率，不能只贴一次最快结果。

统计完成时间按每类任务报告，绝不把“页面两秒可打开”解释成“5 GiB 文件两秒解析完”。并发压力下保留页面响应是独立指标；提高 qsv 并发导致 API 饥饿时应降低并发。

## 17. 测试、发布与运维实现

测试分为纯语义单元测试、qsv 命令契约、API/数据库集成、真实浏览器、真机平台适配与性能回归。精确比较采用性质测试验证对称性、容差边界、主键元组无碰撞与数量守恒；不能只测四行演示表。

上传阶段断电、qsv 执行阶段崩溃、结果 rename 后 DB 提交前崩溃、数据库忙、磁盘满、JSON 状态损坏、强制取消与重复请求都要通过故障注入。用户 A 的资源 ID、视图 ID、上传 ID、SSE 和下载令牌被用户 B 使用时必须失败。

日志使用 requestId/jobId/resourceId 关联，不记录密钥与样本默认正文。暴露轻量健康检查与就绪检查；就绪检查确认数据库迁移、目录可写、引擎 manifest 匹配，不在每次探活运行全量数据任务。

引擎升级先生成新的 manifest 并跑黄金数据矩阵；旧任务保留原引擎版本信息。旧缓存按引擎版本失效，新模板用版本化 Schema 迁移。SQLite 使用有序、事务化、可恢复迁移，通过 `PRAGMA user_version` 记录版本，不另建业务迁移表。升级前一致性备份；降级需检查 Schema 兼容，不用旧代码直接打开未知新结构。

发布产物包含应用代码、qsv 及其依赖许可证说明、SBOM、校验和、支持架构、最小系统版本和兼容功能清单。AI 功能由 V2 构建/运行开关控制，V1 发布不能因未配置 API Key 无法启动。

## 18. 开发前验证关口

| 关口 | 必须得到的证据 | 未通过时的处理 |
|---|---|---|
| qsv 固定二进制 | 所需命令、Feature、版本与架构能运行，输出可解析 | 同 tag 定制构建或调整适配；不虚构命令支持 |
| 字符串/decimal/空值保真 | B05 黄金结果、CSV/JSON 往返、超过 15 位编号无改写 | 替换局部适配路径；不降低正确性要求 |
| 索引分页 | 百万行深跳转耗时与内存结果 | 优化有界缓存/切片实现；不能退回前端全量载入 |
| 大表虚拟化 | B03 横向滚动、键盘操作、无无限 spacer | 调整表格适配；不把只虚拟化行视为通过 |
| SQLite | 实际版本为已修复版本、断电恢复与 WAL 备份通过 | 升级/定制 SQLite 绑定后再发布 |
| SQL 防越权 | 文件表函数、嵌套调用、多语句与未知语法全被拒绝 | 收窄支持子集；不让解析失败透传 |
| 懒猫文件传输 | 实际授权、NAS 文件传输路径、断点上传及大文件下载 | 标注兼容路线和限制；不宣称未测的服务端直读 |
| V2 Provider | 结构化输出、取消、usage、端点路由与隐私测试 | 对不支持的特性显式禁用；禁止自动云端回退 |

本文不预估“几天能完成”，也不把接口文档核验当作已经部署成功。通过上述关口后，才能填写实际支持规模和性能结果。

## 19. 技术依据与来源

下列资料核验于 2026-09-25。带固定 tag 的 qsv 文档用于能力设计；部分框架文档随版本更新，开发时仍需锁定实际依赖并执行契约测试。本文的表结构、预算、页面接口、Agent 权限和性能目标为本项目设计，不是上游默认提供的能力。

- [S01] qsv 23.0.1 Release：<https://github.com/dathere/qsv/releases/tag/23.0.1>。
- [S02] qsv slice：<https://github.com/dathere/qsv/blob/master/docs/help/slice.md>，索引与切片读取；实现时对固定二进制复测。
- [S03] qsv 23.0.1 命令目录：<https://github.com/dathere/qsv/blob/23.0.1/docs/help/TableOfContents.md>。
- [S04] qsv 23.0.1 diff：<https://github.com/dathere/qsv/blob/23.0.1/docs/help/diff.md>，唯一主键、列对应与差异输出。
- [S05] qsv 23.0.1 joinp：<https://github.com/dathere/qsv/blob/23.0.1/docs/help/joinp.md>，Join 类型、Schema、顺序和资源限制。
- [S06] qsv apply / dedup：<https://github.com/dathere/qsv/blob/master/docs/help/apply.md>；<https://github.com/dathere/qsv/blob/master/docs/help/dedup.md>。对应行为须在选定 tag 回归。
- [S07] qsv 23.0.1 excel：<https://github.com/dathere/qsv/blob/23.0.1/docs/help/excel.md>。
- [S08] qsv sqlp：<https://github.com/dathere/qsv/blob/master/docs/help/sqlp.md>，SQL 方言、文件函数与执行路径。
- [S09] Node.js 官方版本状态：<https://nodejs.org/en/about/previous-releases>。
- [S10] TanStack Table v8 Virtualization：<https://tanstack.com/table/v8/docs/guide/virtualization>。
- [S11] TanStack Table v8 Pagination：<https://tanstack.com/table/v8/docs/guide/pagination>。
- [S12] Fastify Reply / Stream：<https://fastify.dev/docs/latest/Reference/Reply/>。
- [S13] better-sqlite3：<https://github.com/WiseLibs/better-sqlite3>。
- [S14] SQLite WAL 文档及 WAL-reset 修复说明：<https://www.sqlite.org/wal.html>。
- [S15] MDN Web Workers：<https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers>；React lazy：<https://react.dev/reference/react/lazy>。
- [S16] 懒猫文件存储与文稿权限：<https://developer.lazycat.cloud/advanced-file.html>。
- [S17] 懒猫官方文件选择器接管：<https://developer.lazycat.cloud/lazycat-file-picker-auto-intercept.html>。
- [S18] 懒猫多实例：<https://developer.lazycat.cloud/advanced-multi-instance.html>。
- [S19] 懒猫 OIDC：<https://developer.lazycat.cloud/advanced-oidc.html>。
- [S20] 懒猫上架检查：<https://developer.lazycat.cloud/store-submission-guide.html>。
- [S21] Microsoft Excel 规格限制：<https://support.microsoft.com/en-us/excel/excel-specifications-and-limits>。
- [S22] OWASP CSV Injection：<https://community.owasp.org/attacks/CSV_Injection>。
- [S23] AI SDK Structured Output：<https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data>。
- [S24] AI SDK OpenAI-compatible Provider：<https://ai-sdk.dev/providers/openai-compatible-providers>；Node.js 入口示例与显式路由注意事项：<https://ai-sdk.dev/docs/getting-started/nodejs>。
- [S25] tus 协议：<https://tus.io/protocols/resumable-upload>。
- [P01] 用户资料《懒猫微服移植与打包规范.md》，版本 1（本会话核验引用：fileciteturn23file1L95-L110）。本项目采用其 LPK V2、正式镜像仓库、可写目录和不增加重服务的约定；产品专用文件格式和身份隔离按本方案定义，不机械照搬其他应用的限制。
