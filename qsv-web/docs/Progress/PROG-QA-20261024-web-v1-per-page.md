# PROG-QA-20261024-web-v1-per-page

- 需求/任务：[QA-20261024-001] V1 每页测试数据逐页测试与修复
- 状态：本轮完成（V1 完整验收仍未结束）
- 最近更新：2026-10-24

## 目标

使用 `test-data/` 按页面准备的测试文件（P03—P16 各一份或一对），在浏览器中逐页验证 P01—P16，修复发现的问题并回归。

## 交付物

- 测试记录：[QA-20261024-V1-per-page-test.md](../QA-20261024-V1-per-page-test.md)
- 修复：
  - BUG-20261024-001 工作簿工作表预览 422（`apps/server/src/service.ts` 的 `previewWorkbookSheet` 按元信息夹取 `qsv excel --range` 范围）
  - BUG-20261024-002 核对提交 PREFLIGHT_STALE（`apps/server/src/app.ts` 的 `/api/v1/compares` schema 补齐 `leftTimeZone`/`rightTimeZone`）
  - BUG-20261024-003 favicon 404（`apps/web/index.html` 内联 SVG 图标）
- 截图证据：仓库 `gui-test-screenshots/`（P01—P16 关键状态 11 张）

## 验证证据

- 浏览器黑盒测试：P01—P16 全部通过（P03 的文件选择/上传队列与工作表勾选界面因浏览器运行时不支持文件选择器未能界面验证；工作表预览服务端路径已用 API 验证，上传导入链路经"使用内置示例"在界面走通）。
- P09 修复后按流程重测：预检数字与 test-data 设计一致（边界容差通过/拒绝正确），提交→任务完成→P10 明细 12 条。
- 回归：`pnpm typecheck` 0 错误；`pnpm test:web` 1/1；`pnpm test:server` 15/15。
- 报告文件生成后 API 重启恢复检查通过（BUG-20261011-002 修复保持）。

## 下一步

- 补足界面文件选择/上传队列/工作表勾选的人工验证（换支持文件选择器的环境即可）。
- V1 未覆盖场景不变：百万行、Parquet/ODS 导入、批量取消与失败重试、配额与清理、断电恢复全流程、懒猫真机 OIDC 与入口隔离。
