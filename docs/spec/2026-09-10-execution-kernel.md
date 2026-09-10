# 执行内核：账本与无浏览器引擎

日期：2026-09-10。状态：**已落地**（同日修订一版后实现：参数化 `from` 三层校验、副作用未知一律 `NEEDS_REVIEW`、`runs` 列清单与摘要生产位置、外键列名、场景停用语义、证据索引）。**同日复查后又修**：取消请求的收口点、停机与领取的竞态、执行器异常分类、步骤跑完但 Run 未收尾。  
对应路线图 P1 剩余 + P2，以及 RF03 / RF04 / RF05 / RF09。两处对 P2 验收的主动下修（退避、Run 级总超时）已写进非目标。  
前置：[最小执行契约](2026-09-10-runtime-contracts.md)（已落地）、[目标系统（接入目录）](2026-09-10-target-catalog.md)（已落地）。

范围：把一次 Run 写成可查询的事实，并用 Echo / Delay / Fail 在没有浏览器的情况下跑完。  
不是 Scenario Studio，不是登录，不是会话，不是录制。

## 1. 为什么现在写

目标系统目录已经能回答「仿真哪套外部系统、用哪个号」。执行契约已经冻了 Step / Snapshot / 状态词表。缺的是中间这一截：

- 没有 Scenario / Version 表，快照上的 `scenarioId` 无处可指。
- 没有 Run / StepRun / Attempt / Evidence 表，状态只能活在进程里。
- 没有 Engine，契约里的 Echo → Delay → Fail 没有执行者。

没有这一截，后面的会话、登录绑定、编排页、AI 步骤都没有共同的「一次运行」可以挂。

本期要回答的产品问题不是「用户怎么编排业务脚本」，而是：

> 已经有一个 Target。我用接口提交一份最小步骤定义，平台能跑完，刷新之后记录还在。

第一份可跑的东西是测试场景，不是业务脚本。编辑器以后写出来的，和现在接口提交的，是同一种 Structured Step。

## 2. 目标与非目标

### 目标

1. 能创建绑定 Target 的场景，每改一次步骤就留下一个不可变版本；改名与停用只动场景本身，不产生新版本。
2. 能从某个版本创建 Run：当时的步骤、输入、策略、执行器版本写进 Snapshot，之后改场景不影响这次 Run。
3. 同幂等键重发返回同一 Run；同键不同输入返回冲突。
4. Worker 领取 QUEUED Run，Engine 顺序执行 Echo / Delay / Fail，解释 `from` / `outputKey`。
5. 有限重试、步骤超时、取消、失败即停；先失败后成功保留两个 Attempt。
6. 副作用结果未知一律进 `NEEDS_REVIEW`，不自动再做一次：`SIDE_EFFECT` + `UNKNOWN`，以及 `SIDE_EFFECT` Attempt 被 abort 或超时、结果无法确认。
7. 每步的输入、输出、错误作为结构化 Evidence 与 Attempt 同事务落库。
8. API 只创建、查询、取消；真正执行只在 Worker。API 不 import 执行器。

### 非目标

- 不做 Scenario Studio、步骤拖拽、诊断面板、试跑按钮页。
- 不把 `workflow` 权限改名为 `scenario`。
- 不实现 Draft / Publish 双轨、Compiler、Analyzer、Business Action。
- 不注册 Navigate / Click / Input / Assert / AI 等类型；`stepSchema` 已拒绝它们。
- 不打开浏览器，不读目标账号密文，不创建 BrowserSession，不写 SessionLease / RunLease。
- 不做多 Worker 竞争验收、租约 TTL、fencing、崩溃恢复扫描（P3）。崩溃后 Run 可能停在 `RUNNING`，本期接受并写进限制。
- 不做 SSE、NOTIFY、`run_events` 表（P7）。查询只走 GET。
- 不做 ObjectStore、截图、Trace（P6）。
- 不改已有 RBAC 的 PATCH / DELETE 债。
- 不做退避与 Run 级总超时。路线图 P2 列了这两项，本期主动下修：退避固定 0 ms；快照 `policy.timeoutMs` 是**步骤级默认超时**，不是整条 Run 的预算。P3 连同租约一起补。
- 不做 `NEEDS_REVIEW` 的处置流程。本期它只是终态，没有 API 出口，收敛靠人工 SQL；恢复路径属 P3。

## 3. 决策

### D1. 场景是可跑定义的家，不是编辑器

没有编辑器也能跑，是因为场景先是 API 资源。

```text
POST /scenarios          绑定 Target，写入 version 1
POST /scenarios/:id      只增新版本，不改旧版本
POST /runs               冻结某个版本 → Snapshot → QUEUED
Worker 领取              Engine 只读 Snapshot
```

- Scenario 必须带 `targetId`。Target 停用后不能新建场景、不能新建 Run；已经创建的 Run 仍按快照执行。
- 不在场景上绑默认目标账号。账号是创建 Run 时的可选输入。
- 本期没有草稿。每次**步骤**变化产生一个不可变 `scenario_versions` 行，`version_no` 从 1 递增。改名与停用只更新 `scenarios` 行，不产生版本。
- 创建 Run 默认用最新版本，也可显式指定 `scenarioVersionId`。
- 步骤 1–32 条。空数组 400。
- 场景名在同一 Target 下唯一。
- 场景 `status = disabled` 后不能创建新 Run；已有 Run 不受影响。
- 写入路径唯一：`validateScenarioDefinition(definition)`（见 §5）。场景创建、追加版本、创建 Run 三处都调它，不各写一份。

这不是 P10 的 Compiler。本期只做：Zod 校验 → 步数与 id / outputKey 不重复 → `from` 不得前向引用。`from` 的解析分三层，各自的边界见 §4。

场景定义本期**不声明输入清单**（`definition` 只有 `schemaVersion` 与 `steps`）。这是有意的：arch/04 §9 的参数化要求用户确认后才把固定值转成 Scenario Input，那属于 P10 Compiler。P10 落地时 `definition` 增一个显式 `inputs` 字段，保存期校验从「非前向引用」收紧为「非前向引用 ∪ 已声明输入」；已有版本仍可解析。

### D2. 快照与版本分开放，快照禁止改

`RunSnapshot` 沿用已落地契约，整份 JSONB 存在 `runs.snapshot`，不另开 `run_snapshots` 表。逻辑上仍是独立对象。

创建 Run 的同一事务写入：

- `runs` 行（`QUEUED`，含 `snapshot` 与 `snapshot_digest`）
- 每个步骤一行 `step_runs`（`PENDING`，`ordinal` 从 0）
- 审计 `run.create`

此后任何 `UPDATE` 不得改 `snapshot`、`snapshot_digest`、`target_id`、`scenario_id`、`scenario_version_id`。用 `BEFORE UPDATE` 触发器挡住，比较方式是**列级 `IS DISTINCT FROM`**——写成「任何 UPDATE 都拒绝」会把状态更新一起挡死。测试用 SQL 尝试改快照必须失败。

`digest` 是定义摘要，不是 Run 身份：

- 参与哈希：`schemaVersion`、`targetId`、`targetAccountId`、`secretRef`、`scenarioId`、`scenarioVersionId`、`steps`、`input`、`policy`、`executorVersions`
- 不参与：`runId`、`createdAt`、`digest` 自己
- 算法：对抽出对象做键排序的 JSON，再 SHA-256 hex
- 分工：规范化 payload 的纯函数（`snapshotDigestPayload`、`idempotencyDigestPayload`）放 `@cairn/shared`，不引入 `node:crypto`；SHA-256 用 Node `createHash`，生产实现在 `packages/db/src/runs/digest.ts`，由 `createRunWithSnapshot` 调用。api / worker 不各自重算。

创建 Run 时先算摘要，再嵌回 `snapshot.digest` 一起写入，`runs.snapshot_digest` 与该值恒等。契约里 `runSnapshotSchema.digest` 是可选字段（`run.ts:64`），但本模块**必须填**，DB 列 `NOT NULL`——验收与 D2 的触发器都靠这一点。

摘要不能代替内嵌的 `steps`。GET 必须能读出当时的完整步骤。

`executorVersions` 创建时冻结为 `{ echo: "1", delay: "1", fail: "1" }`。契约里它是开放 `record`（`run.ts:62`），写错键名也能过 `parse`，所以 Engine 启动时断言这三个键存在且值匹配，不匹配按 `VALIDATION` 失败，不静默回落默认执行器。

### D3. 执行上下文显式持久化

`runs.context` 是 JSONB 对象，初始为 Snapshot 的 `input` 浅拷贝（创建 Run 时写入，领取后 Engine 以此为准）。

某步成功且带 `outputKey` 时，把该步输出写进 `context[outputKey]`，与 Attempt、Evidence、状态同一事务提交。未成功的输出不得写入。

Echo 的输出就是解析后的值。Delay 的输出是 `{ waitedMs }`（实际等待的墙上毫秒）。Fail 没有成功输出。

`from` 只读 `context`。缺 key → Attempt `FAILED`，`category: VALIDATION`，`retryable: false`。

键的合法性要三层收口，不能只靠 `contextKeySchema` 的正则：

- `contextKeySchema`（`step.ts:24`）要求首字符为字母，`__proto__` 因此过不了；但它是形状校验，不是 denylist，`constructor` / `prototype` / `toString` / `valueOf` / `hasOwnProperty` **都能通过**。
- `Snapshot.input` 与 `createRunBodySchema.input` 现在是 `z.record(z.string(), …)`，只约束值（`run.ts:59`）。本期把 `input` 的键改用 `contextKeySchema`，并把键数限到 64。
- Engine 判存在性必须用 `Object.hasOwn(context, from)`，不得用 `in` 或裸取值——否则 `from: "constructor"` 会取到 `Object` 构造函数并当成合法输出。写入 `context` 前先过 `jsonValueSchema.parse`。

### D4. API 建单，Worker 干活，Engine 不碰浏览器

```text
Web / 测试 ──GET/POST──→ API（鉴权、建场景、建 Run、取消、查询）
                              ↓ 只写 PostgreSQL
Worker tick ──领取 QUEUED──→ Engine ──Executor Registry──→ Echo / Delay / Fail
                              ↓ 只写 PostgreSQL
                         GET /runs/:id 能看到终态
```

- Engine 放在 `packages/worker/src/engine/`。API 不得依赖 `@cairn/worker`，不得 import 执行器。
- 跑库操作抽成 `@cairn/db` 上的具名函数（`createRunWithSnapshot`、`claimQueuedRun`、`startAttempt`、`finishAttempt` 等），API 与 Worker 都走这些函数，禁止两边各写一套 Drizzle。
- 不新建 `@cairn/engine` 包。
- Engine 源码与其测试禁止出现 `playwright`、`midscene`、`page-agent` 字样的 import。用 worker 单测钉住。

领取（本期最小，不是 P3 租约）：

```sql
UPDATE runs
SET status = 'RUNNING', started_at = now(), updated_at = now()
WHERE id = (
  SELECT id FROM runs
  WHERE status = 'QUEUED' AND cancel_requested_at IS NULL
  ORDER BY created_at, id
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
RETURNING *;
```

有 `SKIP LOCKED` 是为了两个 Worker 不要抢同一行。没有 owner、没有 TTL、没有 fencing token、没有恢复扫描。进程被 kill 后，该 Run 会停在 `RUNNING`，直到人工或 P3 处理。这是写明的限制，不是遗漏。

Worker 现有 tick（`packages/worker/src/runtime/lifecycle.service.ts` 里 1000 ms 的空转 `setInterval`）改成：有空位就 `claimQueuedRun`，拿到则 `engine.execute(runId, { signal })`。同时只跑一个 Run。

优雅停机：停止领取 → 向在途 Engine 发 AbortSignal → 等在途 Attempt 收尾。收尾按 `effectType` 分流，不是一律 `CANCELLED`：

- 在途 Attempt 是 `READ_ONLY` / `IDEMPOTENT`，或 `SIDE_EFFECT` 且确认没有发出 → `CANCELLED`；
- `SIDE_EFFECT` 且 abort 时无法确认结果 → `NEEDS_REVIEW`。不得写成 `SUCCEEDED`，也不得写成 `CANCELLED`。

这条与 arch/03 §10 / §14 和 RF08 同一口径：副作用结果未知只能进人工核查，不能被「停机」洗成干净取消。

### D5. 状态机本期只走得通的边

词表不改，沿用契约。Engine 不得写出未列出的迁移。

**Run**

| 从 | 到 | 何时 |
|---|---|---|
| （新建） | `QUEUED` | 创建成功 |
| `QUEUED` | `RUNNING` | 领取成功 |
| `QUEUED` | `CANCELLED` | 领取前取消 |
| `RUNNING` | `SUCCEEDED` | 全部 StepRun 成功 |
| `RUNNING` | `FAILED` | 某 StepRun 策略耗尽 |
| `RUNNING` | `CANCELLED` | 运行中观察到取消或停机中止，且非「副作用结果未知」（那条走下一行） |
| `RUNNING` | `NEEDS_REVIEW` | 副作用已发出且结果未知 |

本期不进入 `RECOVERING`、`WAITING_FOR_AUTH`。

取消请求用 `cancel_requested_at`，不把「正在取消」做成主状态。已经 `SUCCEEDED` / `FAILED` / `CANCELLED` / `NEEDS_REVIEW` 的 Run 再取消：200，状态不变（幂等），不倒退。

**StepRun**

| 从 | 到 | 何时 |
|---|---|---|
| `PENDING` | `RUNNING` | 开始第一步 Attempt |
| `RUNNING` | `SUCCEEDED` | 某次 Attempt 成功（覆盖本 StepRun 终态，旧 Attempt 保留） |
| `RUNNING` | `FAILED` | 重试耗尽，或不可重试失败 |
| `RUNNING` | `CANCELLED` | 运行中取消 |
| `PENDING` | `SKIPPED` | 因前面 StepRun 最终失败而失败即停 |
| `PENDING` | `CANCELLED` | 因 Run 取消，尚未开始的步骤 |

`NEEDS_REVIEW` 时，未开始的步骤保持 `PENDING`，不要标 `SKIPPED`：还没有判定这条 Run 失败。

**Attempt**：`RUNNING` → `SUCCEEDED` / `FAILED` / `CANCELLED`。一次逻辑重试 = 新行，`attempt_no` 从 1 递增。禁止更新已结束 Attempt 的 `status` / `output` / `error` / `finished_at`（触发器或条件更新，迟到回调必须 0 行）。

三条补充规则，Engine 与触发器都要落：

- **Snapshot 解析失败**：Engine 启动前 `runSnapshotSchema.parse` 失败 → Run `FAILED`（`VALIDATION`），剩余 `PENDING` StepRun 一并 `SKIPPED`，不留 `PENDING` 残渣。
- **条件更新 0 行必须当场收尾**：`startAttempt` 的 `PENDING → RUNNING` 若 0 行，说明该 StepRun 已被取消或已终态，Engine 立即按当前 Run 状态收尾，不重试、不继续下一步。
- **终态 Run 冻结全部写入**：Run 已是 `SUCCEEDED` / `FAILED` / `CANCELLED` / `NEEDS_REVIEW` 时，任何 StepRun / Attempt 的状态写入都必须 0 行。

### D6. 重试、超时、取消、未知副作用

默认策略（步骤与快照都没写 `policy` 时）：`retryLimit = 0`，`timeoutMs = 30000`。合并规则见下。

- `retryLimit` 是**失败后的额外次数**。最多 Attempt 数 = `retryLimit + 1`。
- 本期退避 0 ms，不引入指数退避配置。
- `retryable` 只是提示。最终是否再试由 Engine 看：步骤 `effectType`、错误 `category`、剩余次数、Attempt 是否已结束。`SIDE_EFFECT` + `UNKNOWN` 一律不重试。`VALIDATION` / `CANCELLED` 不重试。`TIMEOUT` / `EXECUTOR` 在次数剩余时可重试，**但 `SIDE_EFFECT` 步骤的 `TIMEOUT` 例外**：超时即结果未确认，不重试，转 `NEEDS_REVIEW`。
- 步骤超时：给 Executor 的 `AbortSignal` 在 `timeoutMs` 后 abort。Delay 的 `durationMs` 大于 `timeoutMs` 必须变成 `TIMEOUT`，不能傻等。
- 取消：Delay 与步骤间隙必须看 AbortSignal / `cancel_requested_at`。超时或取消之后才返回的成功，不得改写已关闭的 Attempt；`finishAttempt` 对已结束 Attempt 必须 0 行。
- 策略合并：快照级 `policy` 是步骤级默认值，步骤的 `policy` 逐字段覆盖同名项，未覆盖的回落快照级，快照级也没有则用本条默认。合并写成纯函数 `resolveStepPolicy`，放 `@cairn/shared`，Engine 与测试共用一份。
- Fail 步骤：按 `input` 构造 `executionErrorSchema`。`category` 默认 `EXECUTOR`，`retryable` 默认 `true`（仍受上面规则约束）。`effectType = SIDE_EFFECT` 且 `category = UNKNOWN` → 本 Attempt 记失败，Run 进 `NEEDS_REVIEW`，后续步骤保持 `PENDING`。

失败即停：StepRun 最终 `FAILED` 后，后面仍为 `PENDING` 的步骤改为 `SKIPPED`，Run `FAILED`。

### D7. Evidence 是结构化主证据，本期没有大对象

在已落地的 `evidenceMetadataSchema` 上**增量**可选字段 `payload`（`jsonValueSchema`）。`input` / `output` / `error` / `log` 用 `payload`；`screenshot` / `trace` 本期不写行。

Attempt 开始事务：插入 Attempt `RUNNING` + `type=input` 的 Evidence（Echo 写解析后的值，不是未解析的 `from`）。  
Attempt 结束事务：更新 Attempt、StepRun、必要时 Run 与 `context`、再写 `output` 或 `error` Evidence。任一步失败则整单回滚，禁止「状态成功、主证据不存在」。

`payload` 与审计、日志一样脱敏：不得出现口令明文。本期步骤没有凭据字段，测试仍要钉住 Snapshot 里的 `secretRef` 只有 `{ provider, secretId }`。

### D8. 权限沿用 `workflow:*` 与 `run:*`

不新增权限码，避免再迁一轮 RBAC 种子。

| 资源 | 权限 | 说明 |
|---|---|---|
| 场景 | `workflow:read` / `workflow:write` / `workflow:delete` | 文案与审计仍说「场景」 |
| Run | `run:read` / `run:execute` / `run:cancel` | 创建 Run 要 `run:execute`；取消要 `run:cancel` |

只读角色能看场景步骤和 Run 快照（里面没有口令）。Viewer 已有 `workflow:read` 与 `run:read`。

### D9. 对外只 GET / POST，列表不静默截断

与目标系统模块同一套：更新、删除、取消都是 POST；创建 201，更新 200，删除 204，取消 200。

列表 `{ items, nextCursor? }`。本期一次返回，不截断，但 schema 带上 `nextCursor`。

排序：场景 `created_at, id` 升序；Run `created_at, id` 降序（新的在前）。

### D10. 目标系统删除规则补一条

目录方案只拦「还有目标账号」。现在有了场景和 Run：

- Target 下还有场景 → `409` `TARGET_HAS_SCENARIOS`（先删场景）
- 场景下还有 Run → `409` `SCENARIO_HAS_RUNS`
- 目标账号仍被某 Run 引用 → `409` `TARGET_ACCOUNT_HAS_RUNS`（外键 `RESTRICT` 映射）
- 停用的 Target / 账号：资料仍在，不能作为**新**场景或**新** Run 的绑定

不在本期做级联删除。

## 4. 形状

契约进 `@cairn/shared`（建议 `scenario.ts`、`run-api.ts`；执行态继续用已有 `run.ts` / `step.ts` / `evidence.ts`）。先合入 schema 再写 handler。

### 场景

```ts
scenarioSchema = {
  id, targetId, name, status,           // status: active | disabled；停用后不能创建新 Run
  latestVersionId, latestVersionNo,     // 由 scenario_versions 派生，不落列
  stepCount,                            // 由最新版本 definition 派生
  createdAt, updatedAt,
}

scenarioDetailSchema = scenarioSchema + { steps: Step[] }  // 最新版本

createScenarioBodySchema = strictObject({
  targetId: uuid,
  name: trim 1–128,
  steps: z.array(stepSchema).min(1).max(32),
  status: active | disabled, optional, 默认 active
})

updateScenarioBodySchema = strictObject({
  name: optional,
  steps: optional,                      // 有则新版本
  status: optional,
}).refine(至少一项)

// 更新体禁止 targetId
```

`from` 的解析分三层，边界不同：

| 时机 | 可用 key | 失败 |
|---|---|---|
| 保存场景 / 追加版本 | 本步**之前**步骤的 `outputKey` | `400 SCENARIO_UNRESOLVED_REF`（前向引用或自引用） |
| 创建 Run（冻结快照） | `input` 的键 ∪ 更早步骤的 `outputKey` | `400 SCENARIO_UNRESOLVED_REF` |
| 执行时 | 已写入的 `context` | Attempt `FAILED`，`VALIDATION`，不重试 |

保存期只看顺序，不要求目标已存在：参数化场景的 `from` 指向 Run `input` 的键，而保存时那个 Run 还不存在。同一个 `from` 在保存期合法、在创建 Run 时被拒，这是预期行为，不是漏洞。

场景侧没有 `input` 字段：Run 的输入只由 `createRunBodySchema.input` 提供。创建 Run 时用它计算 `context` 初值，并把键逐条过 `contextKeySchema`。

### Run

```ts
createRunBodySchema = strictObject({
  scenarioId: uuid,
  scenarioVersionId: uuid.optional(),   // 默认最新
  targetAccountId: uuid.optional(),
  input: record(contextKey, jsonValue).optional().default({}),  // 键过 contextKeySchema，≤ 64 条
  policy: executionPolicySchema.optional(),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/).optional(),
})

runSummarySchema = {
  id, status, cancelRequested: boolean,
  targetId, targetAccountId: uuid | null,
  scenarioId, scenarioVersionId,
  createdAt, startedAt, finishedAt,
}

runDetailSchema = runSummarySchema + {
  snapshot: RunSnapshot,                // 已落地契约
  context: record(string, jsonValue),
  stepRuns: [{
    // name / type 从快照回填，不在 step_runs 冗余
    id, stepId, name, type, ordinal, status,
    startedAt, finishedAt,
    attempts: [{
      id, attemptNo, status, startedAt, finishedAt,
      output: json | null,
      error: executionError | null,
    }]
  }]
}
```

创建成功体是 `runDetailSchema`（此时 Attempt 为空、StepRun 全 `PENDING`、`context` 等于 `input`）。

幂等：唯一键 `(created_by_console_account_id, idempotency_key)`（`idempotency_key` 为空则不参与）。同键则比较 `idempotency_digest`（`scenarioVersionId + input + targetAccountId + policy` 的同一套规范 JSON + SHA-256）。摘要相同 → 200 返回已有 Run（不是 201），返回的是该 Run **当前**的 `runDetail`，即使它已经 `SUCCEEDED` / `FAILED` / `CANCELLED`，也不重置为 `QUEUED`。摘要不同 → `409` `RUN_IDEMPOTENCY_CONFLICT`。

可选 `targetAccountId` 必须属于该场景的 Target，且账号启用。有已保存凭据则 Snapshot 带 `secretRef`；没有则只有 `targetAccountId`。请求体禁止出现 `secretRef` / `password`。

### Evidence DTO

列表 `GET /runs/:id/evidence` → `{ items, nextCursor? }`，item 为扩展后的 `evidenceMetadataSchema`（含可选 `payload`）。

### 领域码

| code | HTTP | 何时 |
|---|---|---|
| `SCENARIO_NOT_FOUND` | 404 | 场景不存在 |
| `SCENARIO_VERSION_NOT_FOUND` | 404 | 版本不存在或不属于该场景 |
| `SCENARIO_NAME_CONFLICT` | 409 | 同 Target 下重名 |
| `SCENARIO_HAS_RUNS` | 409 | 删除场景时还有 Run |
| `SCENARIO_UNRESOLVED_REF` | 400 | 保存场景时的 `from` 前向引用 / 自引用，或创建 Run 时 `from` 解析不到 `input` 与更早 `outputKey` |
| `TARGET_DISABLED` | 409 | 新建场景或新建 Run 时 Target 已停用 |
| `SCENARIO_DISABLED` | 409 | 场景已停用，不能创建新 Run |
| `RUN_NOT_FOUND` | 404 | Run 不存在 |
| `RUN_IDEMPOTENCY_CONFLICT` | 409 | 同键不同输入 |
| `RUN_ACCOUNT_MISMATCH` | 400 | 账号不属于该 Target |
| `RUN_ACCOUNT_DISABLED` | 409 | 账号已停用 |
| `TARGET_HAS_SCENARIOS` | 409 | 删除 Target 时还有场景 |
| `TARGET_ACCOUNT_HAS_RUNS` | 409 | 删除账号时还有 Run 引用 |

校验失败仍走 `ZodValidationPipe` → 400 `BAD_REQUEST`。未知 Step Type 到不了库。  
5xx 不带领域码，沿用过滤器现有保证。

抛出形状与目标系统相同：`throw new ConflictException({ code: '…', message: '…' })`。HTTP 测试钉住上表字面量。

码表按资源归属登记成封闭常量（既有约定 `TARGET_ERROR_CODES`，`shared/target.ts:28`）：新增 `SCENARIO_ERROR_CODES`、`RUN_ERROR_CODES`，并把 `TARGET_HAS_SCENARIOS`、`TARGET_DISABLED`、`TARGET_ACCOUNT_HAS_RUNS` 追加进 `TARGET_ERROR_CODES`。常量是唯一码表来源：api 抛字面量、测试比常量，不各写一份。

## 5. 持久化

迁移 `0006_execution.sql`，全文幂等，`__SCHEMA__` 占位。`0005_target_login_fields.sql` 已落地，本方案不得占用 0005。

Drizzle 与 schema-parity 同步，共三处要改：

1. 表清单字面量（`packages/db/src/__tests__/schema-parity.test.ts` 的「两张表都已建立」断言，现列 10 张）加 6 张新表；
2. 每张新表一条列名 / 可空性精确数组断言；
3. 「重复执行迁移不产生副作用」的 `skipped` 字面量追加 `0006_execution.sql`（现为 0001…0005 五条）。

`tools/check-migrations.mjs` 只查文件名、前缀唯一、序号连续，不需要改。

### 表

**scenarios**：`id`、`target_id`（FK `targets` `RESTRICT`）、`name`、`status`、`created_by_console_account_id`（FK `console_accounts` `RESTRICT`）、`created_at`、`updated_at`。唯一 `(target_id, name)`。CHECK `status IN ('active','disabled')`。

不落 `latest_version_id` / `latest_version_no` / `step_count`：三者都能从 `scenario_versions` 派生（`MAX(version_no)` 与 `jsonb_array_length(definition->'steps')`）。落冗余列会让 `scenarios ↔ scenario_versions` 形成循环外键——两边都 `RESTRICT`，场景就永远删不掉。

**scenario_versions**：`id`、`scenario_id`（FK `scenarios` `RESTRICT`）、`version_no INT`、`definition JSONB`、`created_by_console_account_id`、`created_at`。唯一 `(scenario_id, version_no)`。CHECK `version_no >= 1`、`jsonb_typeof(definition) = 'object'`。`BEFORE UPDATE`：列级比较，禁止改 `definition`、`version_no`、`scenario_id`。

`definition` 形状：`{ schemaVersion: 1, steps: Step[] }`。库不二次用 Zod 当 CHECK；写入前必须走 `validateScenarioDefinition()`。

**runs**：列全部显式列出——D2 引用的 `snapshot_digest` 是列，不靠「见 D2」兜底。

| 列 | 说明 |
|---|---|
| `id` | UUID 主键 |
| `target_id` | FK `targets` `RESTRICT`，`NOT NULL` |
| `scenario_id` | FK `scenarios` `RESTRICT`，`NOT NULL` |
| `scenario_version_id` | FK `scenario_versions` `RESTRICT`，`NOT NULL` |
| `target_account_id` | FK `target_accounts` `RESTRICT`，可空 |
| `created_by_console_account_id` | FK `console_accounts` `RESTRICT`，`NOT NULL` |
| `status` | `NOT NULL`，CHECK 属于 `RUN_STATUSES` 词表 |
| `cancel_requested_at` | `TIMESTAMPTZ`，可空 |
| `started_at` / `finished_at` | `TIMESTAMPTZ`，可空 |
| `snapshot` | `JSONB NOT NULL` |
| `snapshot_digest` | `TEXT NOT NULL` |
| `context` | `JSONB NOT NULL`，创建时等于 `snapshot.input` |
| `idempotency_key` | `TEXT`，可空 |
| `idempotency_digest` | `TEXT`，可空 |
| `created_at` / `updated_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` |

CHECK：`(idempotency_key IS NULL) = (idempotency_digest IS NULL)`。部分唯一索引：`idempotency_key IS NOT NULL` 时 `(created_by_console_account_id, idempotency_key)`（既有先例：`0001_initial.sql` 的 `console_accounts_email_idx`）。索引 `(status, created_at, id)` 供领取。`BEFORE UPDATE`：列级 `IS DISTINCT FROM` 禁止改 `snapshot`、`snapshot_digest`、`target_id`、`scenario_id`、`scenario_version_id`。

**step_runs**：`id`、`run_id`（FK `runs`）、`step_id`、`ordinal`、`status`、`started_at`、`finished_at`。唯一 `(run_id, step_id)`、`(run_id, ordinal)`。CHECK `ordinal >= 0`、`status` 属于 `STEP_RUN_STATUSES`。`step_id` 指向 Snapshot 内的 Step，是 JSONB 内部标识，不设外键。

**attempts**：`id`、`step_run_id`（FK `step_runs`）、`attempt_no`、`status`、`started_at`、`finished_at`、`output JSONB`、`error JSONB`。唯一 `(step_run_id, attempt_no)`。CHECK `attempt_no >= 1`、`status` 属于 `ATTEMPT_STATUSES`。`BEFORE UPDATE`：若旧 `status` 已是终态，禁止改 `status` / `output` / `error` / `finished_at`。

**evidences**：`id`、`run_id`、`step_run_id`、`attempt_id`、`type`、`schema_version`、`payload JSONB`、`object_key`、`content_type`、`byte_size`、`digest`、`missing_reason`、`created_at`。索引 `(run_id, created_at)` 与 `(attempt_id)`（P3 按 Attempt 取证据会用到）。CHECK `type` 属于 `EVIDENCE_TYPES` 词表。

**外键列名**：`schema-parity.test.ts` 有一条硬断言「外键列名以『被引用表名单数形 + _id』结尾」，引用 `console_accounts` 的列必须叫 `console_account_id`。本模块三处审计人列一律 `created_by_console_account_id`（先例：`0002_rbac.sql` 的 `assigned_by_console_account_id`），不能写 `created_by`。

**步骤条数 1–32** 只在写入路径校验，DB 不设 CHECK（快照是 JSONB）。唯一入口是 `validateScenarioDefinition(definition)`：`stepSchema` 数组 `parse` → 条数 1–32 → id / outputKey 不重复 → `from` 非前向引用。

不建 `run_leases`、`workers` 业务表、`run_events`、`browser_sessions`。

### Repository 操作（`packages/db`，不是泛型 DAO）

| 函数 | 事务 |
|---|---|
| `createScenarioWithVersion` | `validateScenarioDefinition` + 插场景 + version 1 + 审计 |
| `updateScenarioMeta` | 只改名 / 停用；不产生版本、不动 steps |
| `appendScenarioVersion` | `validateScenarioDefinition` + 插新版本 + 审计（仅 steps 变化时） |
| `createRunWithSnapshot` | 解析 `from`（`input` ∪ 更早 `outputKey`）+ 算两份摘要 + 插 Run + 全部 PENDING StepRun + 审计；幂等冲突在这里判定 |
| `requestRunCancel` | 设 `cancel_requested_at`；若仍 `QUEUED` 则终态 `CANCELLED` 且 PENDING → `CANCELLED` |
| `claimQueuedRun` | D4 的单行领取 |
| `startAttempt` | StepRun→`RUNNING`（若还是 PENDING）、插 Attempt、插 input Evidence |
| `finishAttempt` | 关 Attempt + Evidence + context + StepRun/Run 状态。条件：Attempt 仍是 `RUNNING`；若 Run 有取消请求则改写成取消（`NEEDS_REVIEW` 除外） |
| `finishRunIfDrained` | 步骤全部 `SUCCEEDED` 且无取消请求时补写 Run `SUCCEEDED`（§7 第 4 步的兜底） |
| `skipRemainingStepRuns` / `cancelPendingStepRuns` | 失败即停与取消 |

`finishAttempt` 必须在同一事务里读当前 Run 行并确认仍是 `RUNNING`（或按取消请求改写）。本期没有 fencing token；P3 会把这段改成验租约。函数签名现在就留下明确的「状态写入入口」，避免以后只修一处、漏掉另一处。

**状态写入入口的完整清单**（P3 加 token 校验时一个都不能漏）：`createRunWithSnapshot`、`requestRunCancel`、`claimQueuedRun`、`startAttempt`、`finishAttempt`、`finishRunIfDrained`、`skipRemainingStepRuns`、`cancelPendingStepRuns`。

**摘要与校验的落点**：`snapshotDigestPayload` / `idempotencyDigestPayload` / `resolveStepPolicy` / `validateScenarioDefinition` 进 `@cairn/shared`（纯函数，零 Node 内置依赖；已核实 shared 现阶段只依赖 zod）。`createHash` 只在 `packages/db/src/runs/digest.ts`，由 `createRunWithSnapshot` 调用——不是「只在测试里用」。

**PG 错误映射**：唯一键冲突沿用 `targets.service.ts` 的 `pgCode` / `constraintName` → 领域码模式（23505）。外键 `RESTRICT` 是 **23503**，本模块首次用到：`runs.target_account_id` 的 23503 映射 `TARGET_ACCOUNT_HAS_RUNS`，`runs.scenario_id` 的映射 `SCENARIO_HAS_RUNS`，其余原样抛。删除路径仍以显式预检查为主（给稳定领域码），23503 只作兜底。

## 6. API

| 方法 | 路径 | 权限 | 成功 | 说明 |
|---|---|---|---|---|
| GET | `/scenarios` | `workflow:read` | 200 | 列表 |
| POST | `/scenarios` | `workflow:write` | 201 | 创建 + version 1 |
| GET | `/scenarios/:scenarioId` | `workflow:read` | 200 | 详情含最新 steps |
| POST | `/scenarios/:scenarioId` | `workflow:write` | 200 | 改名/停用/新版本 |
| POST | `/scenarios/:scenarioId/delete` | `workflow:delete` | 204 | 无 Run 才成功 |
| GET | `/scenarios/:scenarioId/versions` | `workflow:read` | 200 | `{ items }`，item 含 `definition` 全文与 `versionNo` |
| POST | `/runs` | `run:execute` | 201 或 200 | 200 = 幂等命中 |
| GET | `/runs` | `run:read` | 200 | 列表，不含 snapshot |
| GET | `/runs/:runId` | `run:read` | 200 | 详情含 snapshot / context / attempts |
| GET | `/runs/:runId/evidence` | `run:read` | 200 | 结构化证据 |
| POST | `/runs/:runId/cancel` | `run:cancel` | 200 | 写取消请求；QUEUED 当场终态 |

没有 `POST /runs/:id/execute`。执行不是控制面的事。

审计 action 扩 `AUDIT_ACTIONS`：`scenario.create` / `scenario.update` / `scenario.delete` / `run.create` / `run.cancel`。`scenario.update` 覆盖改名、停用与追加版本三种情形，summary 里区分（「改名为 X」「停用」「追加了 N 步的版本 3」），不含步骤原文里可能出现的业务数据全量。与业务同一事务，写法同目标系统：直接 `tx.insert(consoleAuditEvents)`，不走 `rbac.service.recordAudit`。

## 7. Engine

入口：`execute(runId, { signal })`。只接受已存在且状态为 `RUNNING` 的 Run（领取之后）。Engine 一律以持久化的 `snapshot` 与 `context` 为准，不读 `scenarios` / `scenario_versions`。

伪流程（实现必须与第 3 节状态表一致）：

1. `runSnapshotSchema.parse`；失败 → Run `FAILED`（`VALIDATION`），剩余 StepRun `SKIPPED`，直接结束。
2. 读 Snapshot 与 `context`（应已等于 input）；断言 `executorVersions` 是本期那三个键且值匹配。
3. 若已有 `cancel_requested_at` 或 `signal` abort：按 D4 的 `effectType` 分流收尾。
   取消没有通知机制可依赖（NOTIFY 属 P7），因此 Engine 在整条 Run 的生命周期里轮询 `cancel_requested_at`（默认 250 ms，`cancelPollMs` 可覆盖），命中即 abort 在途步骤，跨步骤与跨重试都有效。写入侧的最终收口在 `finishAttempt`：取消请求到达后到达的成功一律改写成取消。
4. 按 `ordinal` 取下一个 `PENDING` StepRun。没有则 Run `SUCCEEDED`（最后一步成功时已在同一事务里写终态；循环结束时由 `finishRunIfDrained` 兜底）。
5. 解析输入：`from` 用 `Object.hasOwn(context, key)` 取值并过 `jsonValueSchema.parse`；`startAttempt`；0 行则按 D5 收尾。
6. Registry 取 Executor，`AbortSignal.any(signal, resolveStepPolicy(快照, 步骤).timeoutMs)`。
7. 成功 → `finishAttempt(SUCCEEDED)`，写 context，回 4。
8. 失败 → `finishAttempt(FAILED)`；按 D6 决定再试、失败即停，或 `NEEDS_REVIEW`。
9. 迟到的 Executor 返回必须看到 Attempt 已不是 `RUNNING`（`finishAttempt` 0 行），然后丢弃。

三个 Executor 用普通函数即可，不建类树。

| type | 行为 |
|---|---|
| `echo` | `value` 原样返回；`from` 读 context |
| `delay` | `setTimeout` + abort；输出 `{ waitedMs }` |
| `fail` | 立刻失败，错误来自 input |

时钟可注入，测试不要真的睡 30 秒。Delay 的集成样例用 ≤ 50ms。

日志字段：已有 pino 绑定补上 `runId` / `stepRunId` / `attemptId`。Worker 领取后设这些绑定。

## 8. 界面

本期**不改 Web**。没有场景页、没有 Run 页、没有侧栏入口。避免半残「运行」按钮。

权限矩阵里 `workflow` 仍显示「工作流」，不在本方案改名。

## 9. 实施顺序

1. **shared**：场景 / Run HTTP schema、`SCENARIO_ERROR_CODES` / `RUN_ERROR_CODES`、审计 action、`evidence.payload`、`snapshotDigestPayload` / `idempotencyDigestPayload`、`resolveStepPolicy`、`validateScenarioDefinition`；正反例（前向引用、`from` 指向不存在的 key、`input` 键非法、幂等键形状、payload 可选、策略逐字段合并）。
2. **db**：`0006_execution.sql` + Drizzle + schema-parity 三处（表清单 / 新表列断言 / `skipped` 字面量）+ 触发器测试（改 snapshot 失败、改已关闭 Attempt 失败）+ Repository 集成测试（幂等、摘要相等、23503 映射、事务回滚无半成品）。
3. **api**：scenarios / runs 模块；补 Target 删除的 `TARGET_HAS_SCENARIOS` 与账号删除的 `TARGET_ACCOUNT_HAS_RUNS`；HTTP 测试钉领域码（含 `SCENARIO_DISABLED` / `TARGET_DISABLED`）、201/200/204、响应无 password、无权 403。
4. **worker**：Engine + Registry + 三个 Executor + tick 领取；RF04 / RF05 集成测试（含 `SIDE_EFFECT` abort → `NEEDS_REVIEW`、`SIDE_EFFECT` `TIMEOUT` 不重试）；import 边界测试。
5. **联合**：同一测试库 API 建 Run → 调 `claimQueuedRun` + `execute` → GET 详情与创建时的 snapshot 字节级一致（digest 与 steps）。
6. **回写**：方案改为已落地；契约方案第 7 节加一句「表与 Engine 已在本方案落地」；按 AGENTS.md §22 往 `CHANGELOG` 追加一行。

## 10. 验收

对应 RF 的本期范围。P3 / 浏览器项不在此列。

1. 空库迁移与上一版本升级通过；parity 含 6 张新表与每表列断言，重复执行迁移的 `skipped` 含 `0006_execution.sql`。
2. 未绑定 Target 的场景创建失败；停用 Target 不能新建场景或 Run；停用场景不能新建 Run。
3. 创建「Echo(value=hello) → Delay(50) → Echo(from=上一步 outputKey)」并执行：第三个 Echo 输出 `"hello"`，context 含该键，三个 StepRun `SUCCEEDED`，Run `SUCCEEDED`。
4. 参数化端到端：保存 `Echo(from=orderId)`（`orderId` 不来自任何步骤输出）成功；创建 Run 带 `input = { orderId: "A-1" }` 执行输出 `"A-1"`；不带该键创建 → `400 SCENARIO_UNRESOLVED_REF`。保存 `from` 指向更晚步骤的 `outputKey` → 同样 400。
5. `input` 的键受 `contextKeySchema` 约束：`{"__proto__": 1}` 与 `{"constructor": 1}` 均被拒；`from: "constructor"` 不得取到 `Object` 构造函数。
6. 同一 `idempotencyKey` 重发返回同一 `runId`；改 `input` 再发 → `409` `RUN_IDEMPOTENCY_CONFLICT`；幂等命中返回该 Run 的当前状态，不重置为 `QUEUED`。
7. 执行后改场景步骤（新版本），旧 Run 的 GET `snapshot.steps` 与 `snapshot.digest` 不变，且 `runs.snapshot_digest` 与 `snapshot.digest` 相等；用 SQL 改 `snapshot` 被触发器拒绝；只改名不产生新版本。
8. Fail（可重试，`retryLimit=1`）→ 两次 Attempt：第一次 `FAILED`，第二次若仍失败则 StepRun `FAILED`、后续 `SKIPPED`、Run `FAILED`。先失败后成功则 StepRun `SUCCEEDED`，两次 Attempt 都在。
9. Delay 的 `durationMs` 大于步骤 `timeoutMs` → Attempt `TIMEOUT`，没有成功写入。
10. 快照解析失败（非法 Snapshot）→ Run `FAILED`（`VALIDATION`），StepRun 全部 `SKIPPED`，无 `PENDING` 残留。
11. QUEUED 时取消 → Run `CANCELLED`，步骤 `CANCELLED`，Engine 领取不到这条。RUNNING 中取消（Delay 进行时）→ 不出现迟到的 `SUCCEEDED`，`finishAttempt` 对已关闭 Attempt 写 0 行。
12. Fail + `SIDE_EFFECT` + `UNKNOWN` → Run `NEEDS_REVIEW`，不出现第二次 Attempt，后续步骤仍为 `PENDING`。
13. `SIDE_EFFECT` Attempt 被 abort（停机或取消）且结果未确认 → Run `NEEDS_REVIEW`，不是 `CANCELLED`，也没有第二次 Attempt。
14. `finishAttempt` 事务中途失败（测试注入）后，库中无「Run 成功但无 output Evidence」的行。
15. Snapshot 带 `targetAccountId` 时，GET 与日志无口令；`secretRef` 不含明文键。
16. 无 `run:execute` 不能 POST `/runs`；无 `workflow:write` 不能建场景；无 `run:read` 不能看详情。
17. 删除仍有场景的 Target → `TARGET_HAS_SCENARIOS`；删除仍有 Run 的场景 → `SCENARIO_HAS_RUNS`；删除仍被 Run 引用的账号 → `TARGET_ACCOUNT_HAS_RUNS`（含 FK 23503 兜底路径）。
18. Engine 源码与其测试不出现 `playwright` / `midscene` / `page-agent` 的 import（worker 单测钉住）。worker 现在就没有这三个依赖，「删依赖仍能跑」不作为验收项。
19. 页面与菜单没有新增「场景」「运行」入口。
20. `pnpm test` 与 `pnpm lint` 通过；`pnpm check:deps` 不破（api 不依赖 worker）。

## 11. 主要改动面

| 区域 | 动作 |
|---|---|
| `packages/shared/src/scenario.ts`、`run-api.ts`、`evidence.ts`、`rbac.ts`、`target.ts`、`index.ts` | HTTP 契约、摘要 payload、策略合并、定义校验、审计 action、`evidence.payload`、领域码常量 |
| `packages/db/migrations/0006_execution.sql`、`schema/`、`src/runs/` | 表、触发器、摘要、Repository |
| `packages/db/src/__tests__/schema-parity.test.ts` | 表清单、每表列断言、`skipped` 字面量 |
| `packages/api/src/scenarios/`、`src/runs/` | 控制面 |
| `packages/api/src/targets/targets.service.ts` | 删除时拦场景；23503 映射 |
| `packages/worker/src/engine/`、`runtime/lifecycle.service.ts` | Engine 与领取 |
| [最小执行契约 §7](2026-09-10-runtime-contracts.md) | 落地后回写一句 |
| `CHANGELOG` | 落地后追加一行（AGENTS.md §22） |

对照现有目标系统模块写 API：对象体领域码、事务内审计、列表信封。不另开视觉方案。

## 12. 刻意留给后续

| 阶段 | 本方案结束后仍缺的 |
|---|---|
| P3 | RunLease、fencing、心跳、崩溃恢复、`NEEDS_REVIEW` 的处置与恢复入口、3 Worker × 100 Run |
| P4 | 浏览器、Session、登录态、读密文、`WAITING_FOR_AUTH` |
| P6 存储内核 | [对象存储内核](2026-09-10-object-store.md)：put / get / delete、本地与 S3、保留清理 |
| P6 其余 | 截图、Trace、授权下载、`evidenceStatus` |
| P7 | `run_events`、NOTIFY、SSE、Run Observer 页 |
| P10–P11 | Draft/Publish、Compiler、Sequence Editor |
| P12+ | 录制进 IR、断言搭建、AI Step |

P3 替换领取函数时，所有权检查要覆盖 §5 列出的全部状态写入入口（不只是 `claimQueuedRun` 与 `finishAttempt`），但不改 Snapshot 形状，不改三个 Executor。

## 13. 债务

1. 单行领取没有租约：Worker 崩溃后 Run 可永久 `RUNNING`。P3 Gate 前不得宣称可恢复。
2. `workflow:*` 名实不符。与目标目录登记的「不改 workflow 名」一致，改名另开。
3. 审计 `.limit(200)` 静默截断仍在。本模块新事件一样会被截。
4. 宪法 §19：旧 RBAC 端点仍是 PATCH / DELETE。本模块新接口遵守 GET/POST。
5. 退避与 Run 级总超时未做（路线图 P2 已列）。快照 `policy.timeoutMs` 只是步骤级默认超时，跨步骤的总预算在 P3 补。
6. `NEEDS_REVIEW` 没有 API 出口，本期只能人工 SQL 收敛。
7. 场景定义不声明输入清单，保存期的 `from` 只校验顺序，参数化引用要到创建 Run 才被判死。P10 加 `definition.inputs` 后收紧。
8. 取消靠轮询 `cancel_requested_at` 发现（默认 250 ms），期间每个 Run 会持续读一行 `runs`。P7 接 NOTIFY 后应改为事件驱动，轮询只作兜底。
