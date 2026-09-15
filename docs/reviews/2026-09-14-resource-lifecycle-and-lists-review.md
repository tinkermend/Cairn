# 目标、场景、录制与运行的管理闭环复查

日期：2026-09-14。基线：`388bb4c` 加本次读取时的未提交工作区；不是只审查该提交的 diff。范围是 9 月 13 日交付后的删除、修改、筛选、分页与相关资源生命周期。工作区包含多个尚未提交的功能，本报告不把所有缺口都归因于昨天新增的代码。

对应补齐方案：[资源生命周期与列表管理](../spec/2026-09-14-resource-lifecycle-and-list-management.md)（待审，未实施）。已有依据包括 [Target 目录](../spec/2026-09-10-target-catalog.md)、[执行账本](../spec/2026-09-10-execution-kernel.md)、[对象存储](../spec/2026-09-10-object-store.md)、[Evidence](../spec/2026-09-12-evidence-trace.md)、[录制回填](../spec/2026-09-13-recording-studio-integration.md)与[表格规范](../design/front/components.md)。

结论：执行与编写主链路已有实现，管理退出路径没有闭环。用户指出的问题成立；其中删除语义是本次需要补定的产品契约，筛选与分页则已经有仓库规范要求。只加几个删除按钮无法完成整改。

## 1. 能力现状

| 对象 | 修改 | 删除 | 筛选 | 服务端分页 |
| --- | --- | --- | --- | --- |
| 目标系统 / 目标账号 | 已有表单与接口 | 已有按钮和接口，物理删除；有关联时拒绝 | 目标系统列表仅前端过滤；账号表缺少筛选 | 无 |
| 场景 | Studio 能编辑步骤；名称、启停接口已有但未接界面 | 后端已有物理删除；列表及详情未提供入口 | 仅前端关键词与状态过滤 | 无 |
| 录制草稿 | 创建时可命名；上传后详情只读，无重命名接口 | 无按钮、无接口 | 无 | 无 |
| 运行 | 输入、快照、结果应保持不可改；这是合理边界 | 无按钮、无接口，只有取消 / 核查等运行操作 | 无 | 无 |

场景编辑不是全部缺失。需要补的是元信息与管理操作；录制步骤纠错应继续进入已有 Scenario Studio，避免再建设一套独立编辑器。运行的“修改”不能变成篡改历史输入或结果。

## 2. L01 / P1：删除链路形成无法通过产品操作解除的阻塞

- [TargetsStore.deleteTarget](../../packages/db/src/console/targets.ts) 第 166–208 行：锁定父记录，检查目标账号、场景、录制草稿后执行物理删除；不支持软删除或级联。已有操作审计，但目标行没有删除时间与删除人字段。
- 同文件 `deleteAccount` 第 309–340 行：任何历史运行引用都会拒绝删除，不区分运行是否结束。
- [deleteScenario](../../packages/db/src/runs/scenarios.ts) 第 648–677 行：只要存在 Run，就提示“请先删除该场景下的运行”。
- [RunsController](../../packages/api/src/runs/runs.controller.ts) 没有删除入口；[RecordingsController](../../packages/api/src/recordings/recordings.controller.ts) 也没有草稿删除入口。

因此，一个曾经执行或上传录制的目标系统，往往无法通过控制台完成清理。现有外键保护避免了错误删除，但没有给用户提供可完成的管理流程。

隔离 SQLite 已验证：空目标删除后行不存在而审计仍在；仅挂录制的目标返回 `TARGET_HAS_RECORDINGS`；关联已经 `CANCELLED` 的运行仍使场景返回 `SCENARIO_HAS_RUNS`。

## 3. L02 / P1：关闭录制绑定后，零运行的场景也删不掉

[recordingBindings / recordingImportReceipts](../../packages/db/src/schema/authoring.ts) 第 48–110 行对场景及草稿使用 `ON DELETE RESTRICT`。`deleteScenario` 只处理 ScenarioDraft / ScenarioVersion / Scenario，未处理这两类新增关联。`closeRecordingBinding` 只修改状态，不解除外键引用。

隔离 SQLite 复现：创建场景 → 创建录制绑定 → 关闭绑定 → 确认运行数为 0 → 删除场景，仍收到外键错误。事务回滚，场景未被部分删除。

[错误映射](../../packages/db/src/runs/errors.ts) 第 99–117 行还会把包含 `scenario_id` 的外键错误笼统解释为“场景下有运行”。对 PostgreSQL 具体错误文案的影响来自静态检查，本次没有跑对应 HTTP 复现。整改应处理真实引用关系，不让用户去寻找不存在的运行。

## 4. L03 / P1：运行删除与物理对象清理尚未衔接

已有能力可以复用：

- [stored_objects](../../packages/db/src/schema/objects.ts) 已保存 Run 归属、对象键、保留期、清理次数、清理时间。
- [listPurgeCandidates](../../packages/db/src/objects/objects.ts) 第 139–167 行只选保留期到期或上传超时的对象，没有“用户已删除 Run”的清理条件。
- [ObjectService.purgeExpiredObjects](../../packages/worker/src/objects/object.service.ts) 已执行物理删除，成功后更新账本；失败记录次数并继续后续重试。

尚缺用户删除意图的持久化、清理进度查询、主动重试入口、删除后下载拒绝和迟到上传隔离。不能只删除 Evidence 索引或 Run 行：`stored_objects.run_id` 自身有外键，而且上传中 / 未挂 Evidence 的对象也必须被清理。

[S3ObjectStore.delete](../../packages/storage/src/s3-store.ts) 第 77–85 行仅传 Bucket / Key，没有 VersionId。**若桶启用了版本控制，当前调用不能证明数据已物理清除**：Amazon S3 会添加删除标记，旧版本仍保留；永久删除需要指定版本。此为条件性缺口，未读取用户桶配置，也未连接真实 S3 验证。[AWS 官方说明](https://docs.aws.amazon.com/AmazonS3/latest/userguide/DeletingObjectVersions.html)

## 5. L04 / P2：场景元信息维护与录制后续处理没有入口

[updateScenario](../../packages/web/src/lib/scenarios-api.ts) 第 63–68 行封装了名称 / 状态更新，但搜索生产调用方没有发现使用；[场景详情更多菜单](../../packages/web/src/features/scenarios/detail.tsx) 第 455–489 行只有发布、运行和导入录制。已停用场景会提示不可运行，却没有恢复启用的控制台操作。

[录制详情](../../packages/web/src/features/recordings/detail.tsx) 仅展示条目，文案仍称“本期只展示”，没有重命名、删除、关联场景信息或去 Studio 处理的入口。Studio 已支持导入，当前两端的任务衔接和文案没有同步收口。

## 6. L05 / P2：四类管理列表没有落实服务端筛选与分页

证据链：

- [运行页面](../../packages/web/src/features/runs/index.tsx) 第 29–33、67–150 行以及[录制页面](../../packages/web/src/features/recordings/index.tsx)直接渲染整个 `items`，没有查询工具栏或分页栏。
- [目标列表查询](../../packages/db/src/console/targets.ts) 第 65–74 行与账号查询第 210–220 行没有分页；目标前端 `items.filter` 仅过滤已加载内容。
- [场景查询](../../packages/db/src/runs/scenarios.ts) 第 226–243 行读取所有场景和全部草稿，并逐场景查询最新版本；前端也只是本地过滤。
- [运行查询](../../packages/db/src/runs/runs.ts) 第 99–142 行读取所有 Run，还把整个 Run 行（包括快照 / Context）从数据库载入，再只映射列表字段。
- [录制查询](../../packages/db/src/recordings/recordings.ts) 第 137–168 行读取当前用户的全部草稿及其完整 JSON，最后只返回摘要。
- 各列表 Controller 未接受筛选 / 分页 Query。部分响应 Schema 已有可选 `nextCursor`，不代表查询已经分页。

[组件规范](../design/front/components.md) 第 134–142 行已要求同一查询上下文和增长表服务端分页；不能等数据多了再补。场景和目标页分页化后，还要避免把“当前页条数”显示成“总数”，并修改创建运行、选择目标、插件等共用列表调用方，防止只能选到第一页的对象。

已有 [useCursorPage](../../packages/web/src/hooks/use-cursor-page.ts)、[CursorPagination](../../packages/web/src/components/data-table/cursor-pagination.tsx)、[审计查询](../../packages/db/src/audit/list.ts)和 [DateRangePicker](../../packages/web/src/components/date-range-picker.tsx)可复用。

## 7. L06 / P2：取消请求被提前显示成“已取消”

[运行列表](../../packages/web/src/features/runs/index.tsx) 第 130–135 行在取消接口返回后无条件提示“已取消”。[settleRunCancellationTx](../../packages/db/src/runs/recover.ts) 第 311–320 行在仍有活跃 RunLease 时返回 `pending`，尚未写成 `CANCELLED`。

这是静态确认的前后端语义差异。应根据返回的持久化状态显示“已请求取消”或“已取消”。取消已受理不能成为开放删除按钮的依据；仍须等待运行结束和相关占用释放。本次未执行活跃浏览器取消实测。

## 8. L07 / P2：仅保存当前控制台账号外键不能永久回答“谁删的”

[审计模型](../../packages/db/src/schema/audit.ts) 第 11–13 行对控制台账号使用 `ON DELETE SET NULL`；[recordAudit](../../packages/db/src/audit/record.ts) 明确只存 ID，名称在读侧关联当前账号。删除操作者账号后，事件仍在，但操作者字段会丢失；改名也会改变历史显示。

新删除契约应保存操作当时的主体标识和显示信息快照，再保留现有审计关联。该结论来自 Schema 和读写链路，本次未执行账号删除测试。

## 9. 级联设计必须一起处理的边界

以下是补齐方案的约束，不声称已有软删除实现发生了这些错误：

- 不能只阻止 `RUNNING`。`QUEUED`、`RECOVERING`、`WAITING_FOR_AUTH` 和 `NEEDS_REVIEW` 同样不能直接删除；业务终态之外还需检查 Lease、认证控制和上传收尾。
- TargetAccount / Secret、BrowserSession / 双 Lease / profile、服务凭据的 Target 授权、录制绑定 / 导入回执均在关联范围。删除某个 Run 不能顺手销毁仍可复用的 Browser Session。
- 录制草稿属于 Target，可被不同场景导入；删除一个场景不能误删其他场景还需使用的源草稿。已导入步骤是独立 Structured Step，删除源草稿不应撤销已保存步骤。
- 删除校验和新建 Run / 上传 / 回填必须在共同事务规则下竞争；现有硬删除依赖外键拦插入，改成软删除后这种保护不会自动保留。
- 所有查询、试跑、发布、服务执行、证据下载与 SSE / Live View 都要遵守删除可见性。只隐藏列表行不能完成删除。
- Run 和录制上传已有幂等键。直接物理删行会丢失去重事实，使重试可能重新创建已删除任务 / 草稿。

此前 [A/B/C 衔接复查](2026-09-14-abc-integration-review.md)还记录了通知故障、认证输入时序、录制敏感信息和工程门禁问题。它们有独立整改记录，本次没有重新验证，不能把本报告的管理闭环复查当成这些问题已经关闭。

## 10. 本次验证与范围

使用已有 `openContractDb('sqlite')` 创建临时数据库并运行迁移；验证结束自动关闭并清除临时库。没有操作开发业务库、真实目标系统、凭据或对象桶。

| 现状探针 | 实测结果 |
| --- | --- |
| 空目标物理删除，审计保留 | 确认 |
| 目标挂录制草稿后无法删除 | 确认，`TARGET_HAS_RECORDINGS` |
| 场景挂终态取消 Run 后无法删除 | 确认，`SCENARIO_HAS_RUNS` |
| 零运行场景挂已关闭绑定后无法删除 | 确认，SQLite 外键错误 |

共 4 项探针完成；探针断言当前行为，所以 **4/4 通过表示缺口已被复现，不表示整改已通过**。最终运行约 0.83 秒。临时探针保留在 `.run/reviews/2026-09-14-resource-lifecycle/`（本地诊断材料，不进入 CI）：

```sh
pnpm --filter @cairn/db exec vitest run --config /Users/tinker/src/singe/Cairn/.run/reviews/2026-09-14-resource-lifecycle/vitest.config.mts
```

其余结论来自源码、Schema、调用方和规范核对；未跑全仓回归、三库并发测试、浏览器验收或真实 S3 删除。业务实现未修改。整改范围及验收要求集中在对应待审方案。
