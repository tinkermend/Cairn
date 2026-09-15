# 资源生命周期与列表管理接续实施报告

日期：2026-09-14。对应方案：[资源生命周期与列表管理补齐方案](../spec/2026-09-14-resource-lifecycle-and-list-management.md)。先前缺口见[管理闭环复查](2026-09-14-resource-lifecycle-and-lists-review.md)。

开发曾停在契约、迁移、部分仓储与半成品前端。本次对照方案接续完成软删除写路径闸门、级联与清理闭环、服务端筛选分页，以及列表 / 详情的删除与筛选入口。

## 相对方案的进度

| 验收 | 状态 | 说明 |
| --- | --- | --- |
| LM01 | 已落地 | 三库 CHECK 成对约束；重复删除保留原 `deletedAt` / `deletedBy`；操作者改名后快照不改 |
| LM02 | 已落地 | Target 级联账号、场景、录制、终态 Run、绑定、授权与对象账本；`expectedCounts` 扩大返回 `DELETE_SCOPE_EXPANDED` |
| LM03 | 已落地 | 非终态全状态与取消已受理不可删；在途 pending 对象 / 证据返回 `RESOURCE_BUSY`；活跃租约 / auth 仍拦 |
| LM04 | 已落地 | 已删 Target / Scenario 不能再创建执行；幂等键返回 `RESOURCE_DELETED`；`createSession` 拒绝已删目录；删除后会话标 `CLOSING` |
| LM05 | 部分 | 删除登记 `delete_requested_at`；S3 适配在版本桶上按 VersionId 清全部版本 / 删除标记（MemoryS3 覆盖）。真 AWS 版本桶未连 |
| LM06 | 部分 | 迟到 commit / 新 reserve 拒绝已删 Run；清理账本可重试。存储断连与崩溃恢复未另做故障注入 |
| LM07 | 已落地 | 普通详情 / 证据下载 404；服务调用方 `ownRun` 排除已删；删除时撤销 `externalAccess`；已删 Run 的 SSE 观察为 404 |
| LM08 | 已落地 | 单独删 Scenario 保留历史 Run，详情标「已删除」且去掉可编辑链接；删录制不改已导入步骤 |
| LM09 | 已落地（测试） | 三库 51 条场景 / 运行 / 录制游标分页、关键词筛选、半开日期与非法游标；控制台现网未灌 50+ 条 |
| LM10 | 已落地 | 创建弹窗场景 / 账号远程 `search`；运行列表补 Scenario 与完整状态；插件 Target 选择支持 `search` / `limit` |
| LM11 | 已落地 | 预览 blockers 对有权限的运行给链接；Target 删除后可看清理面；日期筛选说明本地日历日与 UTC `[from, to)` |
| LM12 | 部分 | 相关定向回归已跑；根目录全量门禁与 `check:design` 未作为本线通过依据 |

## 接续补上的缺口

先前骨架已有迁移、预览和部分列表。真正停住的是写路径与删除闭环。本次额外收口：

- 删除 Run / Target 时撤销对外发布证据；服务证据入口检查 `deletedAt`
- `reserveStoredObject` 拒绝已删 Run
- 清理状态对不存在的资源返回 404，避免把未知 ID 报成「已清理完成」
- 目标详情账号表补服务端搜索、状态筛选与游标分页
- 运行详情终态删除，以及已删 Run 的清理状态 / 重试
- 修正 `deleteTargetAccount` 前端按 `DeleteResourceResult` 解析，避免 200 响应被旧 `targetSchema` 拒掉
- Target / Account 删除把空闲会话标为 `CLOSING`（`resource_deleted`），Worker reap 收口关闭
- 在途 pending 对象 / 证据视为 `RESOURCE_BUSY`
- 历史 Run 带 `scenarioDeleted` / `targetDeleted`，界面显示「已删除」且去掉目录链接
- 运行列表补齐 Scenario 与全部运行状态；插件 `fetchTargets` 接 `search` / `limit`
- 软删后重建占用提示「已删除记录占用」；删除审计写入关联数量与对象字节
- S3 删除先看桶版本状态，版本桶按 VersionId 清理；HTTP 删除有对象返回 202

## 验证范围

二次对照后已跑：

- `@cairn/db`：`resource-lifecycle` 三库 42 项（含非终态全状态、在途 pending、会话 `CLOSING`、占用文案、目标 / 运行 / 录制 50+ 分页）
- `@cairn/storage`：`object-store` 10 项（含 MemoryS3 版本桶按 VersionId 清理）
- `@cairn/api`：`runs.http` / `targets.http`（无对象 200、有对象 202）、`observe.service`（已删 / 不存在结束流）
- `@cairn/web`：运行列表完整状态与场景筛选、已删目录去链接、创建运行账号搜索、目标详情已删清理态
- `pnpm check:invariants` 通过
- 本机控制台（Vite `:5173`，已登录 Administrator）：运行列表可见排队 / 恢复中 / 需要登录 / 挂起中 / 待核查与场景筛选；日期弹层有 UTC `[from, to)` 说明；创建运行有账号搜索；终态运行删除预览可打开并已取消。未对现网数据执行真实删除。插件 Target 搜索未在浏览器里验

未跑或未宣称通过：

- 真 AWS S3 版本桶（LM05 仍只覆盖 MemoryS3）
- 存储断连、进程崩溃后的清理恢复故障注入（LM06）
- 根目录 `pnpm test` / `pnpm check:design` 全量。`check:design` 当前因既有 `browser-view.tsx` 硬编码色失败，与本线无关
- 窄屏断点与删除确认框的真实提交（避免误删本机联调 Target / Run）
- 现网历史 Run 上已删目录的真实展示（无对应 fixture）；该路径由前端单测覆盖
- `recordings-import` ready 计数与 Studio HOLDING 双按钮：既有失败，不是本 diff 引入

## 已知限制

- Target 编码、场景名、账号登录名软删除后不释放唯一键，重建需另案定义
- 清理状态展示「业务已删除 / 附件清理中」，不承诺恢复已删附件
- 运行中的 API 进程若仍是旧 `dist`，控制台真实删除 / 202 路径以本次源码测试为准，不把旧进程行为写成新实现通过
