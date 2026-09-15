# 资源生命周期与列表管理补齐方案

日期：2026-09-14。状态：**已落地（2026-09-14）**。二次对照后补齐会话关闭意图、在途证据 busy、历史目录「已删除」、运行完整筛选、插件分页与版本桶按 VersionId 清理。实施与验收见[接续实施报告](../reviews/2026-09-14-resource-lifecycle-and-lists-implementation.md)；先前缺口见[管理闭环复查](../reviews/2026-09-14-resource-lifecycle-and-lists-review.md)。

依据：用户本次提出的软删除、删除人 / 时间、活跃运行阻止删除、运行对象物理清理和列表筛选分页要求，以及 [管理闭环复查](../reviews/2026-09-14-resource-lifecycle-and-lists-review.md)。本方案补充 [Target 目录](2026-09-10-target-catalog.md)、[执行账本](2026-09-10-execution-kernel.md)、[对象存储](2026-09-10-object-store.md)、[Evidence](2026-09-12-evidence-trace.md)和[录制回填](2026-09-13-recording-studio-integration.md)的管理生命周期；详细缺陷与实测结果只维护在复查报告。

## 1. 建议决策与范围

1. 目标系统、目标账号、场景、录制草稿和 Run 采用软删除，记录时间及操作者；所有普通管理与执行入口排除已删除对象。
2. 删除整个 Target 时级联软删除其目录资源、源录制和已结束 Run；删除 Run 时必须物理清理该 Run 在对象存储中的数据。
3. 单独删除 Scenario 时保留历史 Run，关闭编写与新运行入口；历史记录独立管理。单独删除录制草稿不撤销已回填到 Scenario 的步骤。这是本方案建议，尚未作为既有行为实施。
4. 保留 Run / StepRun / Attempt、Snapshot、必要审计和对象清理账本，第一版不物理删除整套运行账本。它们承担复盘、关联完整性、清理恢复与幂等去重；先清理占空间的大对象更直接。
5. 目标、账号、场景、运行和录制管理表统一具备服务端筛选与分页；复用现有审计页的分页和日期组件。

目标删除表示清理整个系统的关联资源，确认框必须列明会删除历史运行及不可恢复的附件。单独删除场景只是移出编写目录，确认框明确历史运行保留。由这两种明确的对象作用域表达差异，不增加任意组合的级联配置开关。

本期不建通用删除工作流引擎、独立消息队列、第二套步骤编辑器、全量回收站恢复或批量永久删库工具。统计范围与必需分页直接补齐，不等待通用表格框架。

## 2. 删除语义与审计

每个可删除的主资源保存：

- `deletedAt`：UTC 删除时间，空值表示未删除，是删除可见性的事实源。
- `deletedBy`：操作时冻结的操作者快照 `{ id, displayName, kind }`，由认证主体和数据库生成，不能接受请求体自报；使用 Runtime Schema 验证。保留 ID 快照，不因控制台账号后续改名或删除而丢失归属；`kind` 区分控制台账号（`console`）与自动化调用凭据（`service`）。

既有 `status` 保留业务语义。Target / Scenario 的启用、停用与删除分开；Run 的 `SUCCEEDED / FAILED / CANCELLED` 不改成 `delete`。界面可以显示“已删除”，同时在获授权的审计详情展示原运行结果。

成对约束与数据库一致性保障：
1. **数据库表级约束**：PostgreSQL、MySQL 8.0 和 SQLite 在三库 SQL 迁移脚本中统一增加表级 CHECK 约束：`CHECK ((deleted_at IS NULL AND deleted_by IS NULL) OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL))`，保证删除时间与操作者快照必须成对存在。
2. **持久化仓储校验**：`@cairn/db` 在构建与执行软删除时作严格的入参类型与运行时断言，防止应用层逻辑产生单列写入的脏数据。

删除事实与操作审计同事务提交；审计记录根资源、关联数量、对象数量和已知字节数、请求关联 ID。级联行写同一操作人的快照和时间，不覆盖此前已经删除的行的原始删除信息。重复删除返回原结果，不重复重置删除时间、操作者或创建新的清理意图。

已删除对象默认不出现在普通列表、选项和统计中；普通详情返回现有风格的 404，不泄露越权对象的存在。具备删除权限者可以通过删除结果 / 清理状态接口查看本次删除时间、操作者、原运行状态和清理结果。第一版不提供恢复已删除附件的承诺。

## 3. 级联范围

| 删除入口 | 同步持久化处理 | 保留内容 / 后续清理 |
| --- | --- | --- |
| Target | 标记 Target、全部 TargetAccount、Scenario、Target 所属录制草稿与已结束 Run；关闭相关录制绑定；撤销该 Target / Account 的服务授权；登记对象及会话清理意图 | 保留历史版本、运行事实、导入回执、审计；Worker 清理运行对象，终止可关闭会话，清理该目标的认证状态及本地 profile |
| TargetAccount | 标记账号，禁止新绑定；撤销该账号授权；解除凭据可访问引用 | 保留历史 Run 和 Session 账本；确认无执行占用后经 SecretProvider 清理专属凭据，所属 Worker 清理认证会话与 profile |
| Scenario | 标记场景；关闭其录制绑定；禁止编辑、发布、试跑、正式运行及回填 | 保留版本、草稿事实、历史 Run / Evidence 与导入回执；源录制属于 Target，不随单个场景误删 |
| RecordingDraft | 标记草稿，关闭关联的未结束绑定；停止后续导入 | 保留幂等键、来源摘要和导入回执；已复制到 Scenario 的 Structured Step 不变。当前录制正文存数据库，不能误称为对象存储附件 |
| Run | 标记 Run；撤销证据对外发布；为所有 `stored_objects.runId` 对象登记删除请求 | 保留 Snapshot、运行结果、步骤 / 尝试 / 事件与审计，清理截图、Trace、报告等对象。Session 与 Run 解耦，不随单次 Run 删除 |

TargetAccount 的凭据只有确认独占归属才物理清理，禁止清掉其他账号或平台配置仍引用的 Secret。跨 Worker 的 profile 清理由拥有该文件的 Worker 执行，API 不直接访问运行文件系统。失联 / LOST 会话仍走已有安全处置路径，未确认旧进程停止时不能冒充清理完成。

调度尚未接入的部分不借本任务新建；后续调度创建 / 领取必须调用相同的目标与场景删除闸门。已有开放执行 API、插件上传、试跑和回填本次必须覆盖。

## 4. 删除前置条件与并发保护

Target、Scenario、TargetAccount 删除均检查其关联运行。Run 只有 `SUCCEEDED / FAILED / CANCELLED` 可以进入删除。`QUEUED / RUNNING / RECOVERING / WAITING_FOR_AUTH / NEEDS_REVIEW` 全部阻止删除，并返回阻塞数量及有权限查看的运行链接。先完成取消或人工核查，不能隐式替用户取消 / 判定结果。

业务终态仍不足以证明资源空闲：有效 RunLease、SessionLease、auth hold / control、尚在写入的证据均须检查。活跃执行占用返回 409；尚未完成的外部清理可以保留“清理中”，不能按成功完成报告。空闲、无租约的复用会话允许进入由所属 Worker 执行的关闭流程。

持久化层提供共同的删除 / 创建竞争规则：

1. 在同一事务中锁定 Target，按稳定顺序锁定相关 Scenario / Account / Run，并在锁内重验删除标记及阻塞条件。
2. 新建场景 / 账号 / Run、试跑、上传、录制绑定、回填、发布、启停 / 重命名，以及 Session 获取等写路径使用兼容的锁序与条件检查，禁止先在事务外读一次状态再盲写。
3. 领取 / 恢复 / 证据预留与提交检查删除标记及现有 fencing 条件；已删除资源不能重新排队、获得 Lease 或发布新证据。
4. 预览只用于展示，不是执行授权。删除预览返回快照影响计数（`expectedCounts: { accounts, scenarios, runs }`）。最终 POST 提交携带该预期计数并在锁内复核；若事务内重验发现实际级联受影响数量较预览扩大（如并发新建了场景或运行），必须返回 409 Conflict（错误码 `DELETE_SCOPE_EXPANDED`，文案“级联删除影响范围已发生变化，请刷新预览后重新确认”），严禁静默多删。删除与并发创建不能同时成功留下可运行孤儿。
5. PostgreSQL / MySQL / SQLite 由 `@cairn/db` 适配，API / Worker 不引入具体方言；三库共用验收验证同一结果。

现有硬删除的外键约束不能替代软删除的并发保护。统一补到持久化边界和实际调用方，不只在 UI 禁用按钮。

## 5. 对象物理清理

复用 `stored_objects` 与 Worker 的 `purgeExpiredObjects`。在对象账本增加显式删除请求时间和原因，沿用现有次数 / 错误时间 / purged 状态。删除 Run 的同一事务标记所有对象，包含尚在 pending、未挂 Evidence 和上传失败的对象；不从 Evidence 可见列表反推全部对象。

执行过程：

1. 数据库提交软删除、撤销外部访问和对象清理意图，普通列表及新的证据下载立即不可访问。
2. Worker 停止新上传，并等待或中止相关在途上传。证据预留 / commit 拒绝已删除 Run；只加 commit 检查不足以阻止迟到 PUT 在清理后重建对象。未确认上传停止前不得把清理标为完成；未知结果保留可重试债务并补删。
3. Worker 根据持久化对象键物理删除。对象已不存在视为幂等成功；删除调用失败保留请求与错误。只有实际删除成功后才提交 `purgedAt`，不得先删账本或先报完成。
4. 复用生命周期清理任务在重启后继续；提供有权限的显式重试。清理状态按已清理 / 待处理 / 失败数量与已知字节汇总，区分“业务记录已删除”和“附件已清理”。
5. 对象已物理删除但数据库提交失败时，重试可再次删除并补记成功。数据库已提交删除但对象服务不可用时，记录继续不可下载，清理债务可恢复。

对象键必须精确来自账本，不接受用户输入的桶前缀进行递归删除。清理和重试不改变原 Run 的执行结果、Snapshot 或摘要；保留必要索引表达“用户删除”与“保留期到期”的区别。

本地存储验收检查实际文件不存在。S3 版本桶的普通无 VersionId 删除只建立删除标记，不能算物理清除；支持版本桶时必须清理同一精确 Key 的全部相关版本 / 标记，并处理保留锁导致的失败。第一版可限定为未启用过版本控制的专用桶，但须验证该部署边界并明确拒绝把不支持的版本桶标为清理成功，不能擅自修改用户桶策略。[AWS 官方说明](https://docs.aws.amazon.com/AmazonS3/latest/userguide/DeletingObjectVersions.html)

## 6. 历史解释、幂等与名称

- Run 详情继续使用自身 Snapshot；保留历史 Scenario / Target 行作为稳定关联，不因普通目录过滤而让历史 Run 的 inner join 漏行。被删除的目录对象显示“已删除”，不提供可编辑链接。
- 同幂等键再次创建已删除的 Run / 录制草稿返回明确的“原请求资源已删除”，不得复活旧记录，也不得创建第二次执行。保留现有唯一键与摘要；服务调用方同样适用。
- Target 编码是稳定系统身份，软删除后仍保留占用。Target 内场景名 / 账号登录名第一版同样不自动释放；重建时明确提示已删除记录占用，避免复用旧授权 / 会话。解除占用或恢复资源以后单独定义，不在本期暗改唯一性。
- 已删除录制的回填回执仍能解释已保存步骤来源。原始录制正文第一版软保留；本次“物理对象必须清理”针对 ObjectStore 中的数据，不虚报数据库正文已被抹除。

## 7. 修改与操作入口

| 页面 | 补齐操作 | 复用 |
| --- | --- | --- |
| Target 列表 / 详情 | 现有修改；删除影响预览、阻塞原因与级联确认 | `TargetFormDialog`、`ConfirmDialog` |
| Scenario 列表 / Studio | 重命名、启用 / 停用、删除；步骤仍由 Studio 保存 / 发布 | 已有 `updateScenario`、菜单、表单和草稿 OCC |
| RecordingDraft 列表 / 详情 | 重命名、删除、导入 / 前往对应 Studio；显示已回填关系 | 已有录制导入面板与 Sequence Editor |
| Run 列表 / 详情 | 终态删除、清理状态、失败重试；取消按返回状态显示已请求 / 已取消 | 既有 Run 观察、详情与确认组件 |

重命名录制仅修改展示名称，不改原始 events、摘要、导入回执或已生成步骤。Scenario 元信息更改使用并发版本条件，不能用旧表单覆盖他人变更，也不能使已删除行重新启用。Run 不提供历史输入、Snapshot 或执行结果编辑；重新执行产生新 Run。

删除放在行操作或“更多”的危险项，确认内容包含对象名称、级联数量、阻塞任务和附件不可恢复的影响。提交期间防止重复点击；失败保留上下文；空页删除最后一条后退回上一页，跨页缓存与关联详情同步失效。

## 8. 列表查询契约

所有正式业务接口继续只用 GET / POST。列表 GET 使用 Runtime Schema 校验查询参数；前端 query key、筛选、排序和分页共同组成查询上下文。

| 列表 | 第一版筛选 |
| --- | --- |
| Target | 名称 / 编码关键词、启用状态、认证方式 |
| TargetAccount | 固定 Target 范围，登录名 / 显示名关键词、状态 |
| Scenario | 名称关键词、Target、状态、是否有未发布草稿 |
| Run | Run ID / 场景名称关键词、Target、Scenario、运行状态、证据状态、正式 / 试跑、控制台 / 服务来源、创建时间范围 |
| RecordingDraft | 名称关键词、Target、有无待处理项、是否已回填、创建时间范围；保持当前所有者可见性 |

采用已有游标分页：`limit` 默认 20，支持 10 / 20 / 50；`cursor` 为不透明游标。默认 `(createdAt DESC, id DESC)` 稳定排序；返回 `items / nextCursor`。服务端只查 `limit + 1` 条摘要数据，筛选在 SQL 执行，不全量下载后切片。游标绑定查询条件，条件变化后重置；非法游标、非法日期或页大小返回 400。

复用 `useCursorPage / CursorPagination`，提供上一页、下一页、当前页和每页条数。无需为了页码跳转立即新建 COUNT / OFFSET 体系。无 total 时显示“本页 N 条”，不冒称总量；保留概览统计则用明确作用域的服务端聚合，不能把当前页统计显示成全部统计。

筛选、表体、分页位于同一张卡片，分页首屏可达；查询失败保留条件和旧数据并标记失败，空结果仍保留筛选入口。筛选或页大小变化返回第一页。日期使用既有 `DateRangePicker`，界面说明时区，服务端接收 UTC 半开区间 `[from, to)`；“是否已回填”来源于回执，不新增一个容易漂移的手工状态。

列表化同时检查所有消费方：创建运行的场景选择（`create-dialog.tsx`）、场景的 Target 选择、账号选择和插件 Target 选择都要避免因管理表分页导致下拉选项缺失。具体适配约定：
1. **服务端支持**：列表 GET 接口支持传入可选关键词 `search`，且在选择器消费方需要拉取候选集合时支持指定 `limit`（最高至 100，管理表默认仍为 20）；列表投影只返回轻量摘要字段，不加载 Snapshot、Context 或录制 events。场景最新版本 / 步数只对本页批量查询，避免逐行全表查询。
2. **前端消费方 Combobox 与单项回查保底**：创建运行或试跑弹窗中的资源选择支持带关键词的远程搜索过滤；当传入初始选中 ID（如 `defaultScenarioId` 或 `defaultTargetId`）且当前分页列表中未命中该项时，前端自动发起针对该 ID 的单条详情回查（`GET /scenarios/:id` 或 `GET /targets/:id`）完成选项回显，彻底杜绝首屏 20 条以外资源无法回显或在表单提交时丢失关联的问题。

Run 详情实时状态继续使用 SSE，分页 GET 用于列表查询和断线恢复；不引入高频轮询。删除引起的缓存与已打开观察面失效应可恢复，不把实时通知作为删除事实源。

## 9. API、权限与返回结果

所有业务接口恪守仅使用 GET 与 POST。端点清单与契约定义如下：

| Method | Path | 权限要求 | 响应状态码 | 业务功能与语义 |
| --- | --- | --- | --- | --- |
| `GET` | `/targets/:targetId/delete-preview` | `target:delete` | 200 | 预览目标系统删除影响范围、关联数量及阻塞项 |
| `POST` | `/targets/:targetId/delete` | `target:delete`, `run:delete` | 200 / 202 / 409 | 软删除 Target 及级联，受理对象清理（有对象异步清理返回 202，无对象返回 200） |
| `GET` | `/targets/:targetId/cleanup` | `target:read` | 200 | 查看目标系统级联对象的物理清理汇总进度 |
| `POST` | `/targets/:targetId/cleanup/retry` | `target:delete` | 200 | 手动重试该目标系统下失败对象的物理删除 |
| `POST` | `/targets/:targetId/accounts/:accountId/delete` | `target:delete` | 200 / 409 | 软删除目标账号，释放并清理专属凭据 |
| `GET` | `/scenarios/:scenarioId/delete-preview` | `workflow:delete` | 200 | 预览场景删除影响（关闭录制绑定，保留历史 Run） |
| `POST` | `/scenarios/:scenarioId/delete` | `workflow:delete` | 200 / 409 | 软删除场景，关闭活跃录制绑定，禁止新执行 |
| `POST` | `/recordings/:recordingId` | `workflow:write`（且属主匹配） | 200 | 重命名录制草稿（仅改展示名称） |
| `POST` | `/recordings/:recordingId/delete` | `workflow:delete`（且属主匹配） | 200 | 软删除录制草稿，关闭关联绑定，停止后续导入 |
| `GET` | `/runs/:runId/delete-preview` | `run:delete` | 200 | 预览单次 Run 删除影响与对象清理统计 |
| `POST` | `/runs/:runId/delete` | `run:delete` | 200 / 202 / 409 | 软删除终态 Run，撤销公开证据，登记对象物理清理 |
| `GET` | `/runs/:runId/cleanup` | `run:read` | 200 | 查看单次 Run 的对象物理清理状态与错误 |
| `POST` | `/runs/:runId/cleanup/retry` | `run:delete` | 200 | 手动重试该 Run 下清理失败的对象 |

### 核心 DTO 与契约 Schema

1. **删除预览响应 DTO (`DeletePreviewResponse`)**：
   ```typescript
   {
     previewToken: string,
     counts: {
       targetAccounts: number,
       scenarios: number,
       runs: number,
       storedObjects: number,
       totalBytes: number,
     },
     blockers: Array<{ code: string, id: string, message: string }>
   }
   ```
2. **删除请求 Body DTO (`DeleteResourceBody`)**：
   ```typescript
   {
     expectedCounts?: {
       targetAccounts?: number,
       scenarios?: number,
       runs?: number,
     }
   }
   ```
   传入 `expectedCounts` 时，服务端在同一锁序事务内重新汇总。若实际影响资源数量超出预期，立即返回 `409 Conflict`（错误码 `DELETE_SCOPE_EXPANDED`），阻止静默多删。
3. **清理状态响应 DTO (`CleanupStatusResponse`)**：
   ```typescript
   {
     resourceId: string,
     resourceType: 'target' | 'run',
     status: 'pending' | 'in_progress' | 'completed' | 'failed',
     totalObjects: number,
     purgedObjects: number,
     failedObjects: number,
     totalBytes: number,
     purgedBytes: number,
     lastError?: string,
     completedAt?: string,
   }
   ```

### 状态码与权限细则

- **200 vs 202**：删除接口提交后，若无任何在存或待传对象（`storedObjects === 0`），返回 200 OK；若存在对象存储附件已登记待 Worker 异步清理，返回 202 Accepted 并携带清理意图摘要，前端展示“业务已删除，附件清理中”。不能继续以 204 表示清理已完成。
- **409 冲突分类**：
  - `DELETE_SCOPE_EXPANDED`：并发创建导致删除影响范围扩大；
  - `RESOURCE_BUSY`：活跃 RunLease、SessionLease、auth control 或在途证据写入中；
  - `RUN_NOT_TERMINAL`：目标或场景下存在处于 `QUEUED / RUNNING / RECOVERING / WAITING_FOR_AUTH / NEEDS_REVIEW` 状态的运行。
- **权限与能力控制**：
  - Target / Scenario 保留 `target:delete / workflow:delete`；新增 `run:delete`，默认仅管理员，必须通过现有 RBAC 显式授予其他角色。
  - 录制重命名要求 `workflow:write` 且所有者匹配；删除要求 `workflow:delete` 且所有者匹配。管理员级联 Target 删除须覆盖其他用户的录制，但不因此开放普通草稿读取。
  - Target 删除涉及整个资源集合，必须同时具备 `target:delete` 与 `run:delete` 权限；若当前 Target 下存在历史 Run，缺乏 `run:delete` 权限将直接拒绝删除。预览不能泄露无权查看的草稿正文。
  - 补齐 `recording.update / recording.delete / run.delete` 及必要清理审计动作、标签和能力映射。目标、场景现有删除按钮也必须使用最终权限条件。
  - 删除检查覆盖控制台详情、Evidence 内容、开放服务已发布证据、幂等返回、SSE / Live View 和全部写入口。禁止只在列表里过滤。

## 10. 验收标准

| 编号 | 必须验证的行为 |
| --- | --- |
| LM01 | 三库中删除时间 / 操作者约束一致；空对象可软删除；重复请求保留原审计事实；操作者改名 / 删除后仍能解释是谁操作 |
| LM02 | Target 级联覆盖账号、场景、录制、终态 Run、绑定、授权与对象账本；回滚时没有半级联；预览扩大后不得静默多删 |
| LM03 | 排队、运行、恢复、等待认证、待核查、活跃租约均阻止相应资源删除；取消受理不等于可删除 |
| LM04 | 删除与 Run 创建 / 领取、录制上传 / 绑定、回填 / 发布、元信息更新并发，不能产生已删对象的新执行或复活 |
| LM05 | 本地文件与所支持的 S3 模式实际物理清除；包含 pending / 未挂索引对象；错误版本桶不能假成功；不会误删其他 Run |
| LM06 | 删除调用前后崩溃、存储断连、数据库提交失败、迟到上传均可恢复；清理账本不丢、任务不重跑，物理清理成功才显示完成 |
| LM07 | 删除后普通详情、证据下载、开放服务发布证据和实时观察拒绝新访问；获授权者仍能查看删除 / 清理结果 |
| LM08 | 独立场景删除保留历史 Run；录制删除不改已导入步骤；重复幂等请求不创建第二个任务；不破坏 Snapshot 摘要或对象关联 |
| LM09 | 目标 / 账号 / 场景 / 运行 / 录制各放入超过 50 条数据：组合筛选、下一页 / 上一页、重复时间排序、非法游标、删除空页和页大小变化正确 |
| LM10 | 下拉选择能找到第一页之外的合法对象；摘要接口不加载大 JSON；总量 / 本页文案一致；原有接口消费者完成迁移 |
| LM11 | 所有修改 / 删除入口、权限不足、重复提交、并发冲突、清理失败可操作且反馈准确；按前端验收 skill 检查代表页面的真实行为 |
| LM12 | 运行相关既有门禁、三库兼容检查和相应定向回归通过；根目录工程门禁与本次 UI 检查通过；未跑的真实存储 / 浏览器项明确登记 |

实施后按仓库规则记录 CHANGELOG，详细测试与整改结果回写复查报告。交付排序仍以唯一[工程实施计划](../plan/识途开发路线与工程实施计划.md)为准，本方案不另建里程碑排期。
