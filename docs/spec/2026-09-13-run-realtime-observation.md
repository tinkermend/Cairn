# P7：运行实时状态、SSE 与断线恢复

> 编号：A。日期：2026-09-13。状态：**已落地**。
> 对应 P7 状态观察部分、D1；开发顺序与三线协作统一见[工程计划第 5 节](../plan/识途开发路线与工程实施计划.md#5-当前交付顺序与验收样例)。
> 关联：[B 受管浏览器查看与认证](2026-09-13-managed-browser-view-and-auth.md)、[C 录制回填 Studio](2026-09-13-recording-studio-integration.md)。

## 1. 要交付什么

用户在 Studio 试跑或打开运行详情后，能够自动看到运行、步骤、尝试和证据的最新状态；断网、刷新、API 重启或通知丢失后，页面恢复到数据库里的真实进度。

本线独立交付“可信的实时状态”。浏览器画面和认证输入由 B 提供，录制草稿由 C 提供，不阻塞本线开发与单独验收。这里只增加持久事件、查询一致性和观察通道，不重写 Execution Engine，也不建设全平台消息总线。

范围包括：单 Run SSE、持久事件游标、完整状态恢复、Studio 与运行详情接入、鉴权及慢消费者处理。全局运行列表订阅、跨 Run 游标、聊天消息、模型逐 Token 输出、视频录制、Worker 取消/领取唤醒均不在本次范围。Engine 仍按既有间隔轮询 `cancel_requested_at`；本线通知只服务 Web 观察。

服务创建的 Run 写入同一事件账本，控制台可观察；开放服务 API 本期不同步开放 SSE。

## 2. 已有基础与实际缺口

以 2026-09-13 工作区为基线；配置中心已在同日记录落地，实施前复核其合入版本与受影响验证记录。

| 已有实现 | 本线复用与补齐 |
| --- | --- |
| `shared/src/event.ts` 已有 EventEnvelope 和事件枚举 | 复用信封；持久化变体要求 `runId`、`sequence ≥ 1`、`eventId`。现有注释“SSE / NOTIFY 只传这个”已过时：NOTIFY 只传提示 |
| `db/src/runs/` 已持久化 Run、StepRun、Attempt、取消与恢复 | 在实际状态事务内追加事件，覆盖第 4.3 节全部写入口 |
| `loadRunDetail` 与证据查询已有返回结构 | 增加一次加锁一致读取 `RunObservation` |
| API 已有 `GET /api/runs/:runId`、取消、核查、恢复认证 | 路径参数沿用 `:runId`；补 `GET .../observation` 与 `GET .../events` |
| Studio TrialPanel、Run Detail 使用 TanStack Query，需手动刷新 | 接入共同观察 hook；不覆盖 Scenario 草稿 |
| Web 使用 Bearer JWT；PG/MySQL/SQLite 已有持久化适配 | 流式请求沿用鉴权；通知通道按配置装配，不按业务代码分支驱动 |

## 3. 先冻结的公共契约

公共契约先经三线确认并由一个负责人合入。这里的 Run 序号与 Studio 草稿 `revision` 是两种不同概念，不能互相代替。

### 3.1 三层报文，互不替代

| 层 | 内容 | 不是什么 |
| --- | --- | --- |
| 持久事件 | `persistedRunEventSchema`：必填 `eventId`、`runId`、`sequence ≥ 1`、闭合 `type`、`occurredAt`、`payload`（已脱敏、不含凭证明文或大对象） | 不是变化提示，也不直接 patch 前端缓存 |
| 变化提示 | `{ namespace, runId, eventSeq }`，只含环境命名空间、Run ID 和该 Run 已提交最高序号 | 不含 Snapshot、业务输出、凭证、图片或完整信封 |
| SSE 传输 | 已持久事件帧 + 控制消息 `ready` / `reset` / `complete` / `error`；心跳为 SSE 注释行 | 控制消息不进事件账本，不带可恢复 `id` |

现有 `eventEnvelopeSchema` 仍允许缺 `runId` / `sequence`，只作兼容形状；**写入账本、SSE 补读和前端 Zod 校验一律走持久化变体**。进程内 EventEmitter 只用于同一 API 进程内把提示扇出到多条 SSE，不能充当跨进程通知。

### 3.2 事件类型

`RUN_EVENT_TYPES` 保持闭合枚举。本期冻结：

| type | 何时写入 |
| --- | --- |
| `run.created` | 新 Run 首次插入（幂等命中不写） |
| `run.status_changed` | Run 主状态或证据轴 `evidenceStatus` 变化（含领取、回交、恢复、核查、截止、证据收尾） |
| `run.cancel_requested` | 首次写下 `cancel_requested_at`（含截止取消） |
| `run.auth_wait` | 进入 `WAITING_FOR_AUTH` |
| `run.auth_resumed` | 认证恢复为可再领取（`RECOVERING`） |
| `step_run.started` | StepRun 首次进入 `RUNNING` |
| `step_run.finished` | 当前正在收口的 StepRun 离开运行中；批量 skip/cancel 剩余步骤不逐条写事件，完整状态以观察查询为准 |
| `attempt.started` / `attempt.finished` | Attempt 开始或结束 |
| `evidence.recorded` | 证据行变为 `pending` 或 `available`（只带 `evidenceId` / `type` / `status`，不带正文） |
| `evidence.missing` | 证据行变为 `missing` |

AI 调用结果与预算走 Attempt / Evidence，不另造 AI 事件名。B 线的页面交接与认证控制状态在落库后经本枚举扩展，不得使用未登记字符串。payload 只放状态词、标识和必要诊断，禁止未脱敏输入输出。

### 3.3 游标、观察结果与控制消息

| 契约 | 定义 |
| --- | --- |
| Run 观察版本 | `eventSeq` 为该 Run 已提交事件的最高序号；存量 Run 为 0，不虚构历史事件 |
| 流游标 / `Last-Event-ID` | `runId:sequence`（UUID 无冒号）。不是 `eventId`。Run 不匹配、格式错误、小于最早可补读序号、大于高水位分别诊断为 `cursor_run_mismatch` / `cursor_invalid` / `cursor_expired` / `cursor_ahead` |
| 一致观察结果 | `RunObservation = { run: 现有详情, evidence: 现有证据列表, eventSeq, earliestEventSeq }`。无事件时两者为 0 |
| 可结束观察 | `isFinishedRunStatus(run.status) && evidenceStatus !== 'PENDING'`。`WAITING_FOR_AUTH`、`NEEDS_REVIEW`、执行已结束但证据仍 `PENDING` 都继续推送 |
| 控制消息 | `ready` 带 `{ runId, eventSeq, earliestEventSeq, realtime }`；`reset` 带原因；`complete` 带最终 `eventSeq`；`error` 带 `UNAUTHORIZED` / `FORBIDDEN` / `INTERNAL`。心跳是 `: keepalive` 注释 |

SSE 帧里的持久事件用于推进游标和识别类型（例如未来 B 线使 `['runs', runId, 'browser']` 失效）。**UI 状态只来自观察 GET**：连续事件合并为一次读取，串行应用；仅当 `observation.eventSeq` 不小于已应用序号时写入 TanStack Query。不得用事件 payload 或提示 payload 拼 Run 缓存。

客户端顺序：先 GET 观察并应用版本，再以该版本作 `Last-Event-ID` 订阅；间隙由补读覆盖。较慢的旧 GET 不能覆盖较新缓存。只有完整观察成功写入缓存后才提高已应用序号。

### 3.4 接口路径

路径按现有路由风格，不用 `:id`：

| 接口 | 用途 |
| --- | --- |
| `GET /api/runs/:runId/observation` | 一致观察结果；权限与 `GET /api/runs/:runId` 相同（`run:read`） |
| `GET /api/runs/:runId/events` | `text/event-stream`；`Authorization` + `Last-Event-ID` |

保留原详情/证据接口。不把 JWT 放 URL。

## 4. 数据库事实与事务边界

### 4.1 状态与事件一起提交

在数据库包中增加 `run_events` 与 `runs.event_seq`（默认 0）。唯一约束至少包括 `(run_id, sequence)` 与 `event_id`，Run 外键，按 Run/序号补读索引。业务包只能调用数据库公开操作。

每次相关变更：

1. 按统一顺序锁定 Run，再改 StepRun、Attempt、Evidence 等。对象证据写入也先锁 Run，再锁对象行，避免“事件已递增、证据稍后提交”。
2. 同一事务内递增 `event_seq`、写入已校验且脱敏的事件。
3. 最外层事务提交后才发变化提示；回滚不得留事件或提示。`onCommit` 挂在最外层，savepoint 释放不发布。
4. 提示失败不撤销业务提交；记错误，由补读与 15 秒高水位核对消化。

纯租约心跳、Worker 心跳、对象 purge 计数等无产品观察变化的写入不产事件。

### 4.2 一致读取、存量与保留

观察查询在适配层短事务中按写入锁顺序读取 Run、步骤、尝试、证据索引和高水位后立即释放；不在事务里下载对象。三库同一语义。

存量 Run 的 `eventSeq = 0`。已终态且证据离开 `PENDING` 的历史 Run：首次补读后仍先发 `ready`（带当时 `realtime`），再发 `complete` 并关流；前端收到 `complete` 后停止重连。后续人工核查只发生在 `NEEDS_REVIEW`（不会 `complete`）；终态之后的保留清理通过重新进入页面的 GET 恢复。

事件保留用进程环境 `CAIRN_RUN_EVENT_RETAIN_DAYS`（默认 7），不进平台动态配置中心。只删除**已终态且证据轴非 PENDING** 的 Run 上、早于窗口的事件前缀；进行中或证据仍 PENDING 的 Run 不删事件。保留 `event_seq`。游标过期返回 `reset`，不是 Run 失败。运行状态、审计、Evidence 各用自己的保留规则。

### 4.3 必须接线的写入口

| 入口 | 至少产生 |
| --- | --- |
| `createRunWithSnapshot`（含试跑、服务 Run） | `run.created` |
| `claimRun` | `run.status_changed` → `RUNNING` |
| `yieldClaimedRun` / `yieldUnfinishedRun` | 回交导致的状态变化 |
| `startAttempt` | 可能的 `step_run.started`、`attempt.started`、输入 `evidence.recorded` |
| `finishAttemptTx` | `attempt.finished`、当前步 `step_run.finished`、可选 Run 状态/证据 |
| `finishRunIfDrained` | `run.status_changed` → `SUCCEEDED` |
| `requestRunCancel` / `expireRunDeadlines` | `run.cancel_requested`，以及结算带来的状态 |
| `markRunCancelled` / `settleRunCancellationTx` / `settleLeaselessRun` / `sweepDriftedRuns` / `settleRevokedRuns` | 恢复或取消导致的状态 |
| `reconcileOrphanAttempts` / `closeAttemptTx` | 孤儿 Attempt 与可能的 `NEEDS_REVIEW` |
| `failRunValidation` / `failRunAuthTimeout` | 失败状态与错误证据 |
| `markRunWaitingForAuth` / `resumeRunAfterAuth` | `run.auth_wait` / `run.auth_resumed` |
| `reviewRun` | 核查结论 `run.status_changed` |
| `recordObjectEvidence` / `reserveObjectEvidence` / `commitObjectEvidence` | `evidence.recorded` |
| `recordMissingObjectEvidence` / `markEvidenceMissing` / 证据轴收尾 | `evidence.missing` 或 `run.status_changed`（`evidenceStatus`） |

复用一个内部追加函数。一次提交可写多个连续序号。

## 5. 跨进程变化提示与部署

| 数据库 | 默认提示 | 交付边界 |
| --- | --- | --- |
| PostgreSQL | `CAIRN_CHANGE_HINT=auto` → LISTEN/NOTIFY，独立长连接 | 首个可独立交付组合 |
| MySQL | auto 且配置了 `CAIRN_REDIS_URL` → Redis Pub/Sub | 未配 Redis 则 `realtime: false` |
| SQLite | 同上；仍限单机本地文件 | 增加提示通道不扩大 SQLite 部署范围 |

`CAIRN_CHANGE_HINT` 取值 `auto` / `postgres` / `redis` / `none`。显式 `postgres` 但当前库不是 PG 时启动失败。Redis 只做 Pub/Sub，不做队列、锁、缓存或 Streams。命名空间默认 `CAIRN_ENV`，可用 `CAIRN_CHANGE_HINT_NAMESPACE` 覆盖。

提示允许迟到、合并、乱序；补读以序号为准。通知重连后对正在观察的 Run 补读高水位。另设每 `CAIRN_OBSERVE_RECONCILE_MS`（默认 15s）的服务端高水位核对，只覆盖“已提交、最后一条提示未发出”。浏览器不轮询。通知不可用时 `ready.realtime = false`，UI 显示“实时未配置”，不得用前端轮询冒充。

连接上限初值：每页 `CAIRN_RUN_EVENT_PAGE_SIZE=200`，单连接待发送 `CAIRN_SSE_BACKLOG=256`，心跳 `CAIRN_SSE_HEARTBEAT_MS=15000`。超限发 `reset` 或断开后补读。

`GET /health` 的 `checks.changeHint` 为 `up` / `down` / `unused`。Redis 故障不丢运行事实；库可用而提示不可用时整体可为 `degraded`。

## 6. API 与 SSE 协议

连接顺序：鉴权 → 确认 Run 存在且可读取 → 注册该 Run 监听 → 读高水位与保留边界 → 按页补读 → 追平监听期间变化 → 发 `ready`（`realtime` 反映提示通道是否真正订阅成功）→ 若此时已终态且证据离开 `PENDING` 再发 `complete` 并关流，否则持续推送。监听失败不得发假 `ready`；无提示通道时可以 `realtime: false` 后只靠手动刷新与重进页面。任何提示只触发按序补读。

HTTP：`Content-Type: text/event-stream`，`Cache-Control: no-cache, no-transform`，`Connection: keep-alive`，`X-Accel-Buffering: no`。跨域允许 `Authorization`、`Last-Event-ID`、`x-cairn-request-id`。页面卸载与切换 Run 用 AbortController。

流存活不等于授权永久有效：按 JWT `exp` 关闭；存活期间每 `CAIRN_SSE_AUTH_REFRESH_MS`（默认 15s）复核账号与 `run:read`。建连前 401/403 走 HTTP。中途失效发 `error` 后关流（SSE 已 200，不能改状态码）。前端：401 且 token 未变才清登录；旧流 401 不得清新登录 token；403 显示无权限并停观察；5xx/断网保留登录并退避重连。

采用 `fetch` + `ReadableStream`。一个公共解析器处理 UTF-8 分片、CRLF、空行、多行 `data`、注释心跳和 `id`，再经 Zod 校验。SSE 帧：持久事件 `id` 为游标、`event` 为 type；控制消息 `event` 为 `ready`/`reset`/`complete`/`error`，无 `id`。规则依据 [MDN SSE](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)。

## 7. Studio 与运行详情

沿用当前页面与[前端工作流](../design/front/ai-workflow.md)。只增加共同 `useRunObservation`、连接辅助状态和现有时间线更新。

- 连接状态是辅助信息：`连接正常` / `恢复中` / `实时未配置` / `无权限`。断线不得显示为 Run 失败或成功。橙色仅用于恢复中，灰色用于未配置与正常连接。
- 每页同一 Run 一条订阅。订阅更新 `['runs', runId]` 与 `['runs', runId, 'evidence']`，不替换草稿。
- 保留手动刷新。取消、核查、认证仍走正式 POST。
- 历史详情只解释 Snapshot。

覆盖：加载、无步骤、排队、运行中、等待认证、需要核查、证据处理中/缺失、断线恢复、权限撤销、实时未配置。

## 8. 改动归属与合入方式

| 位置 | 本线职责 |
| --- | --- |
| `packages/shared` 事件、观察、游标、控制消息、变化提示 env | 公共契约 |
| `packages/db`：`run_events`、`onCommit`、追加/观察/补读、PG/Redis/none 提示 | 三库 migration：PG `0023`，MySQL/SQLite `0007` |
| API `runs/`、ChangeHint、health | 授权 SSE、恢复、提交后提示 |
| Web `sse` 解析、`useRunObservation`、TrialPanel、Run Detail | 缓存版本保护与连接状态 |
| `.env.example`、`deploy/` | 通知组合说明；secret 不进动态业务配置 |

Worker 只装配发布端，不订阅、不向 Web 推 SSE。与配置中心共同修改的创建路径保持已合入的冻结配置与幂等，再落事务事件。

## 9. 验收与完成标准

复用现有测试工具，不另建 Harness。

| 编号 | 必须证明 |
| --- | --- |
| RT01 事务与顺序 | 提交有状态也有事件；回滚两者都无；同 Run 序号唯一；嵌套回滚不发布 |
| RT02 一致查询 | 观察结果与版本一致；创建、取消、恢复、认证、证据收尾各类入口有覆盖 |
| RT03 恢复 | 断 SSE、重启 API、通知重连、重复/乱序/丢失最后提示、游标过期后追平且不倒退 |
| RT04 协议与授权 | 分片/多行/无效帧、跨 Run 游标、JWT 到期、撤权、旧流 401、新登录、5xx；无 URL 凭证 |
| RT05 页面 | Studio 与 Run Detail 自动变化；手动刷新可恢复；事件与迟到 GET 不覆盖草稿 |
| RT06 资源 | 慢消费者与连续切 Run 后连接回落；有界积压 |
| RT07 部署 | PG 原生通知作为本线交付 Gate；MySQL+Redis、SQLite+Redis 实现存在并可单测装配，组合通过后才宣称该库实时支持；未配置者 `realtime: false` |
| RT08 实时效果 | 协议与恢复由自动化测试证明。RF16 的 p95 < 2 秒在受控 PG 样本上记录，不作为易抖的 CI 硬失败 |

可先关闭 PG 子项并独立交付 A。A 通过不代表 Live View、录制闭环或完整 D1 通过。

## 10. 与另外两线的依赖

**A 可以独立开发、先交付。** B 复用流解析与授权错误约定；浏览器帧是独立流，不进 `run_events`。C 的 OCC/幂等不依赖 SSE。

## 11. 审查修订

对照 2026-09-13 工作区审查后，原稿有这些必须改掉的缺口：

1. 公共契约只说“补齐取消/认证/证据”，没有冻结事件名，实现会各自发明动词。
2. 既有 `EventEnvelope` 注释与“NOTIFY 只传提示”互相矛盾；SSE 游标写成 `runId:sequence` 又要求“可恢复事件 ID”，未说明不是 UUID `eventId`。
3. 同时写“推持久事件”和“提示不得当状态”，未规定 UI 只经观察 GET 更新。
4. 路由写成 `:id`，与现网 `:runId` 不一致。
5. 要求“实施前列出写入口”但正文没有清单，容易漏 `claimRun`、证据提交、恢复扫描。
6. 7 天保留未排除仍可变化的 Run，长跑或证据 PENDING 时补读会被误 `reset`。
7. 未冻结无 Redis 的 MySQL/SQLite、历史 `eventSeq=0` 的 `complete`、中途 401/403 的 SSE `error`、health 字段和 Worker 唤醒是否在范围内。
8. RT08 若直接当 CI 门槛，会把网络抖动写成功能失败；改为协议测试 + 样本记录。

## 12. 实施对照

1. 补读串行化，避免并发 catch-up 重放同一序号。监听先注册，游标生效前忽略提示，再按序补读。
2. 单连接待发送超过 `CAIRN_SSE_BACKLOG` 时发 `reset(backlog)` 并把游标跳到当前高水位，不断开死循环；完整状态仍以观察 GET 为准。
3. 提示通道订阅失败不阻止进程启动：`ready.realtime = false`，健康检查 `changeHint=down`，仍保留 15 秒高水位核对。
4. 前端 UI 只写 `['runs', runId]` 与 `['runs', runId, 'evidence']`，已应用序号取自观察 GET；SSE 事件只唤醒合并刷新。
5. 首次补读后必须先发 `ready`；历史终态 Run 不得在 `ready` 之前 `complete` 关流。
6. savepoint / 嵌套事务的 `onCommit` 钩子只在该层成功后并入外层；内层回滚不得发布提示。
7. 前端连续事件合并为串行观察 GET；只在 `eventSeq` 不小于已应用序号时写入 Run/证据缓存，较慢的旧 GET 不得覆盖页面状态。
