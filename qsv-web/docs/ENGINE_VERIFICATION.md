# qsv 固定二进制核验记录

日期：2026-09-26。范围：macOS ARM64 开发机上的引擎契约与第一轮真实 Web 流程核验；懒猫目标架构和真机尚未测试。

## 二进制与环境

- qsv：仓库 `Cargo.toml` 指定 23.0.1。下载官方 `qsv-23.0.1-aarch64-apple-darwin.zip` 到本机临时目录，未放入仓库。
- 发布包 SHA-256：`0cf097926616b3b5c91ce6cf7c724e41cd694db2f5289fd3c21787aa2ebe0942`，与 [官方 Release 资源](https://github.com/dathere/qsv/releases/tag/23.0.1)相符。
- 解压后 `qsv` SHA-256：`82f5ae1cb2069c3acbee487d533501afa782470be0f9231ff54a01dbf4517fd7`。
- `qsv --version` 报 `23.0.1`、`aarch64-apple-darwin`、Rust 1.98；`qsv --list` 报 75 个已安装命令，其中有 `index`、`count`、`slice`。命令出现只表示已安装，不等于所有边界行为已通过测试。
- 本机源码构建条件尚未满足：Rust 1.95.0 低于 `Cargo.toml` 的 1.98。系统 `sqlite3` 是 3.43.2；Web 服务实际使用的 better-sqlite3 13.0.3 报 SQLite 3.53.4，启动时拒绝低于 3.51.3 的绑定。

## 已运行的契约样本

用两行 UTF-8 CSV，字段包含中文、`000123`、20 位编号、金额字符串 `0.01`/`1.20`、中文日期和含逗号的引号字段。`qsv index` 成功，`qsv count` 返回 `2`；`qsv slice --start 1 --len 1` 和 `--json` 返回与原文相同的编号、金额及文本。此样本只证明这些命令在所选输入下的字符串保真，不代表所有导入格式和空值语义通过。

用 1,000,000 行、11,896,911 字节的两列 CSV 做深页检查。`qsv index` 用时 1.39 秒、最大 RSS 21,168,128 字节；有索引后 `qsv slice --start 999990 --len 10` 用时 0.15 秒、最大 RSS 22,691,840 字节，结果是尾部连续 10 行。数据由本机 `/usr/bin/time -l` 单次测量；它不是产品 p95 性能结论，也不是 PRD 的 5 GiB 或 1000 万行验收。

对一份只有“明细”工作表的最小 XLSX，`qsv excel --metadata json` 正确列出工作表；`qsv excel --sheet 不存在` **退出码仍为 0，并导出了第一张“明细”**。这与 PRD V1-IMP-05 的验收要求直接冲突。服务端在调用 `qsv excel` 前必须读取工作簿元信息并严格验证用户选择的 Sheet 名称或索引；元信息与解析间还需固定同一原文件版本，不能依赖 qsv 自身报错。当前导入 API 仅支持 CSV，不接受 XLSX；未来接入工作簿时仍须实现该防护。

## 接口现状

`apps/server` 在开发模式仅监听 `127.0.0.1`。启动时使用 `QSV_BIN` 与 `QSV_SHA256` 对固定二进制做 hash、版本、命令和上述两行 fixture 检查。`GET /api/v1/capabilities` 仅将通过的 `table.count`、`table.preview.indexed` 标成 `true`；未配置或检查失败时返回 `false` 和原因。已接入真实 CSV 上传、导入、SQLite 资源和任务、行块与下载；开发模式只提供本机单用户身份，不是可部署的多人 Web 服务。

本机 HTTP 验证了 1,000,000 行文件导入后从 `offset=999995` 读取末尾 5 行；浏览器跳至第 999,996 行后显示至第 1,000,000 行。此为一次功能检查，不是并发或 p95 性能结论。

## 未通过或未运行的关口

Excel 工作表列表和不存在 Sheet 时的回退行为已有单样本证据；Excel/ODS/JSON/Parquet 完整转换、精确核对与容差、SQL 防越权、取消、超长记录、空值与重复表头、5 GiB 上传/下载、并发、断电恢复、懒猫身份入口与文件入口均未验证。这些能力不得因命令出现在 `--list` 中就在界面标成可用。
