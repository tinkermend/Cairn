# 最小执行契约

日期：2026-09-10。状态：**已落地**。  
对应路线图 P0 / F01，以及 RF02 的契约部分。

范围：跨进程 Runtime Schema。  
不建表、不写 Engine、不接线日志里的 `runId`。

## 1. 为什么现在写

地基收口冻住了 HTTP 信封、`requestId` 和启动配置。下一块是 P1 建表和 P2 写 Engine。没有一份 Web / API / Worker 共用的执行协议，表和执行器会各写各的形状。

本方案只冻 **Slice 1 跑 Echo → Delay → Fail 所需的结构**。Navigate / Click / AI Step 不出现在可执行类型里；未知 `type` 直接校验失败。

## 2. 目标与非目标

### 目标

1. 用 Zod 定义跨进程结构，TypeScript 类型由 schema 推导。
2. 先覆盖 Step 公共字段、Echo / Delay / Fail、Run / StepRun / Attempt 状态、RunSnapshot、执行域 Error、Evidence 元数据、事件信封、TargetAccount 凭据引用。
3. 结构不合法则 `parse` 失败。引用是否存在、权限、状态能否迁移，由对应边界检查。
4. 未实现的 Step 不进入可执行注册表。
5. 正反例进 `@cairn/shared` 单测；破坏性变更会使这些测试失败。

### 非目标

- 不建 `targets` / `runs` 表，不写 Repository。
- 不实现 SecretProvider、不存凭证明文。
- 不定义 Navigate / Click / AI 等业务 Step 字段。
- 不把 HTTP `apiErrorSchema` 扩成万能错误。
- 不接 OpenTelemetry，不往日志里写 `runId`。
- 不新建 `@cairn/contracts` 包。契约继续住在 `@cairn/shared`。

## 3. 决策

### D1. 三层各管各的

| 层 | 职责 | 本轮 |
| --- | --- | --- |
| 跨进程 Schema | 形状、枚举、必填、字面量版本 | Zod，`schema.parse` |
| 持久化 Row | 列、约束、条件更新 | P1 |
| 领域边界 | 引用存在、权限、状态机、副作用恢复 | API / Engine |

Schema 拒绝：未知 Step Type、缺 `targetId`、非法字段、非 UTC 时间、凭据引用里夹带明文键。  
Schema **不**拒绝：指向不存在的 Target、`from` 引用尚未写入的 context key、非法状态迁移。这些留给创建 Run 和 Engine。

禁止用 `as` 把未校验的输入当成契约对象。

### D2. 可执行类型就是闭合枚举

`EXECUTABLE_STEP_TYPES = echo | delay | fail`。  
`stepSchema` 是以 `type` 为判别的联合；`navigate` 这类字会失败。  
`isExecutableStepType` 与枚举同一来源。新增 Step Type 必须同时改枚举、input schema 和测试。

副作用等级不从名字推断。`effectType` 必填，取值 `READ_ONLY` / `IDEMPOTENT` / `SIDE_EFFECT`。

### D3. HTTP 错误与执行错误分开

`apiErrorSchema`（`code` / `message` / `requestId`）继续给浏览器。  
执行域错误是 Attempt / Evidence 用的内部对象：

```text
{ code, category, retryable, safeMessage, cause? }
```

`retryable` 只是提示。是否重试由执行策略判断，不由错误对象决定。  
`cause` 只允许 `code` / `message`，禁止堆栈。  
`safeMessage` 可以进 Evidence 和前端；真实内部细节只进服务端日志。

### D4. 时间：存储 UTC，租约看库钟

跨进程时间字段是 ISO-8601，且必须带 `Z`（`z.iso.datetime()`，拒绝 `+08:00`）。展示时由 UI 转本地时区。

`durationMs` 是墙上时钟间隔，用于 Delay、timeout、耗时。  
`leaseExpiresAt` 与 `utcInstant` 同形状，但语义不同：到期比较用数据库时间，不得用进程 `Date.now()` 当租约真相。本轮只冻名字，不实现 Lease。

### D5. 凭据只存引用

```text
{ provider, secretId }
```

`strictObject`：多写 `password` / `value` / `secret` 即失败。  
`provider` 是非空字符串，不封闭枚举，避免把 Vault 挡在门外。本地实现约定 `'local'`。  
明文、密文、主密钥都不进契约。

### D6. Snapshot 必须绑定 Target

`runSnapshotSchema.targetId` 必填。未绑定 Target 的 Snapshot 过不了 `parse`。  
TargetAccount 与 `secretRef` 可选——Echo / Delay / Fail 不需要登录。有 `secretRef` 时必须同时有 `targetAccountId`。

快照内嵌完整 `steps`，不只存版本指针。可选 `digest` 预留给 P1；摘要不能代替原始快照。

### D7. 状态枚举先冻词表，不冻迁移图

Run：`QUEUED` / `RUNNING` / `RECOVERING` / `WAITING_FOR_AUTH` / `NEEDS_REVIEW` / `SUCCEEDED` / `FAILED` / `CANCELLED`。  
取消请求单独记录，不把「正在取消」做成主状态。  
StepRun 另有 `PENDING` / `SKIPPED`。Attempt 只有 `RUNNING` / `SUCCEEDED` / `FAILED` / `CANCELLED`。

合法迁移由 Engine 与条件更新卡住，不在 Zod 里画状态机。

## 4. 形状

`schemaVersion` 只出现在顶层信封：RunSnapshot、Evidence 元数据、事件信封。当前字面量 `1`。Step 跟快照走，不单独版本。

### Step

公共字段：`id`（UUID）、`name`、`type`、`effectType`、`input`、可选 `outputKey`、可选 `policy`（`timeoutMs` / `retryLimit`）。

| type | input | 说明 |
| --- | --- | --- |
| `echo` | 恰好一个：`value`（JSON）或 `from`（context key） | 把值写入后续 context |
| `delay` | `durationMs`（0–300000） | 墙上等待，不是租约 |
| `fail` | `message`；可选 `code` / `category` / `retryable` | 供重试与 UNKNOWN 样例使用 |

`from` / `outputKey` 只校验形状。key 是否已写入由 Engine 检查。

### RunSnapshot

`schemaVersion`、`runId`、`targetId`、可选 `targetAccountId` / `secretRef`、`scenarioId`、`scenarioVersionId`、`steps`、`input`、`createdAt`、可选 `policy` / `executorVersions` / `digest`。  
同快照内 `id` 与 `outputKey` 不得重复。

### Evidence 元数据

关联 `runId`，可选 `stepRunId` / `attemptId`。  
`type`：`input` / `output` / `error` / `screenshot` / `log` / `trace`。  
大对象只存 `objectKey` / `contentType` / `byteSize` / `digest`；缺证据用 `missingReason`，不得假装成功。二进制不进 schema。

### 事件信封

通知用，不是事实源：`eventId`、`type`、`occurredAt`、可选 `runId` / `stepRunId` / `attemptId` / `workerId` / `requestId` / `sequence`、`payload`。  
本轮闭合的 `type`：`run.created`、`run.status_changed`、`step_run.started`、`step_run.finished`、`attempt.started`、`attempt.finished`、`evidence.recorded`。

## 5. 文件

全部在 `@cairn/shared`，只从 `index.ts` 导出：

| 文件 | 内容 |
| --- | --- |
| `wire.ts` | UUID、JSON 值、UTC 时刻、时长、租约时刻 |
| `runtime-error.ts` | 执行域 Error |
| `secret-ref.ts` | 凭据引用 |
| `step.ts` | Step 联合、可执行注册表 |
| `run.ts` | 状态、RunSnapshot |
| `evidence.ts` | Evidence 元数据 |
| `event.ts` | 事件信封 |

HTTP `error.ts` 不改形状；只补 `requestIdValueSchema`，给事件字段复用同一套 ID 规则。

## 6. 验收

1. 合法 Echo / Delay / Fail 与带 Target 的 Snapshot 能 `parse`。
2. `type: navigate`、缺 `targetId`、非 UTC 时间、`secretRef` 夹带 `password`、执行错误带 `stack`，均失败。
3. `isExecutableStepType('fail') === true`，`'navigate' === false`。
4. Web 依赖面不出现 `@cairn/db`；契约里没有凭证明文。
5. `pnpm --filter @cairn/shared test` 通过。

## 7. 刻意留给后续

- P1 / P2 的表、digest、引用存在性，以及 Engine 解释 `from` / `outputKey`、执行策略读取 `retryable`，已在 [执行内核](2026-09-10-execution-kernel.md) 落地。
- P3：Lease 写入与库钟比较。
- 业务 Step Type、SSE 补读、领域错误码词表。
