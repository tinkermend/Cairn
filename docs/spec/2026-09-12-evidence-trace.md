# 识途 Evidence / Trace / 授权下载：让证据可读、可判定完整性

日期：2026-09-12。状态：**已落地**。
对应路线图 P6（Evidence ObjectStore Trace）的其余部分，以及 RF14 / RF15 / RF18 的证据部分、S04、A06、VS2。
前置：[对象存储内核](2026-09-10-object-store.md)（已落地）、[执行内核](2026-09-10-execution-kernel.md)（已落地）、[RunLease / Fencing / 恢复](2026-09-11-run-lease.md)（已落地）、[BrowserSession / SessionLease](2026-09-10-browser-session-manager.md)（已落地）、[Browser Surface 与浏览器步骤](2026-09-11-browser-surface.md)（已落地）。

范围：把「证据是否齐全」变成与「业务是否成功」分开的一根轴；给必要证据一条有界的补传路径；让截图和 Trace 真的能被人打开；写入证据之前脱敏；按类型和结局决定保留多久。
不是 SSE / `run_events` / NOTIFY（P7）、不是 AI（P8 / P9）、不是 Sequence Editor（P11）、不是 Recorder（P12）。

## 1. 为什么现在写

P6 的存储内核已经在仓里，但它是别的方案的产出，不是 P6 的验收：

| 已在仓内 | 来自 | 覆盖 |
| --- | --- | --- |
| `put` / `get` / `delete`、`PENDING → AVAILABLE` 账本、保留期清理 | 对象存储内核（2026-09-10） | 存储内核 |
| 逐 Attempt 的 `input` / `output` / `error`，与 Attempt 同事务 | 执行内核（P2） | 结构化主证据 |
| 失败截图落对象与 `evidences` 指针行 | Browser Surface（P5） | 浏览器现场 |

对象存储那份方案自己写明「本方案从 P6 拆出这一截，**不宣称 RF14 / RF15 通过**」（§1），并把 `evidenceStatus` 分列、授权下载、Trace、脱敏、按类型保留全部列进「刻意留给后续」（§8）。本方案是那张表的兑现。

剩下的每一件都不是「还没做」，而是今天能在代码里指出来的破口：

### 1.1 证据缺失不改写业务结论

截图上传失败时 `attachScreenshot` 吞掉异常，回一个 `missingReason`（`packages/worker/src/browser/port.ts` 71–73）；`finishAttempt` 据此插一行 `type = 'screenshot'`、`missing_reason` 非空、`object_key` 为空的证据（`packages/db/src/runs/runs.ts` 642–653），然后**照常**把 Attempt 写成 `SUCCEEDED`、Run 写成 `SUCCEEDED`。

页面上没有任何位置说「这次的现场没留下」——`GET /runs/:id` 不返回任何证据完整性字段，Web 详情页也不看 `missingReason`。RF14 要的恰是反面：「对象上传失败显示证据缺失原因，**不能把无证据结果标成完整成功**」。

### 1.2 记完就判死，重试入口建好了没接

`ObjectService.putObject` 早就有重投入口：传 `objectId` 时走 `requirePending`，只允许重投尚未提交的 PENDING 对象（`packages/worker/src/objects/object.service.ts` 212–221）。**全仓零调用方**。

原因在写入顺序：今天是 `reserve → store.put → commit → 插 evidences 行`（`object.service.ts` 148–176）。证据行只在上传成功之后出现。上传一失败，走的是 `recordMissingObjectEvidence`，直接写一行终态的 `MISSING`。库里因此**没有「这个 Attempt 欠一张截图」这种可重试的中间态**——只有「没有」和「已死」。

顺带一个更隐蔽的窗口：字节在 `port.execute` 里就上传了，而 Attempt 结论要等 `finishAttempt`。两者之间崩溃会留下一个 AVAILABLE 对象、没有任何证据行指向它，只能等 `retain_until` 到期被清理扫走。

### 1.3 存进去的截图打不开

`GET /runs/:runId/evidence` 只回元数据，HTTP 测试明确钉住「有指针、无正文」（`packages/api/src/runs/runs.http.spec.ts`）。API 侧零引用 `@cairn/storage`；`tools/check-deps.mjs` 的 `ALLOWED_EDGES` 里 `@cairn/api` 的允许边是 `db / secret / shared`，**根本不允许**依赖 storage（第 29 行）。Web 详情页对截图只渲染一行 `· 对象 v1/runs/…/…` 的字符串（`packages/web/src/features/runs/detail.tsx` 255）。

一张存得进、永远取不出的 PNG 不构成 Evidence 能力。宪法 §10 说 Evidence 是产品能力，不是附属日志。

### 1.4 明文进证据

`fill` 步骤的 `value` 由 Engine 解析完 context 引用后，原样进 `input` 证据的 payload（`runs.ts` 485–494 的 `inputPayload`）。今天只有两层脱敏，都不覆盖这里：

- pino 的路径清单（`packages/shared/src/logging.ts` 26–34），只管 HTTP 头与登录请求体；
- 截图里把 `input[type=password]` 的值换成圆点（`packages/worker/src/browser/runtime.ts` 的 `screenshotPage`）。

`insert(evidences)` 之前没有任何 redact。RF18 要求「日志、SSE、Evidence 不含测试用密钥明文」。

### 1.5 Trace 一行都没有

`EVIDENCE_TYPES` 里有 `'trace'`，`0006` 的 CHECK 约束也放行，但没有任何生产代码写过这个类型，`context.tracing` 全仓零调用。RF15 的四条（Debug 可打开、失败保留、成功清理、不混入前后两个 Run）整段未做。

### 1.6 三层验收

沿用 P3 / P5 的口径，本期 Gate = L1 ∧ L2 ∧ L3：

| 层 | 证明什么 | 证明不了什么 |
| --- | --- | --- |
| L1 库与 Worker | 两根轴分开、PENDING 债务可重试、崩溃只补账、Trace 分 chunk 不串 Run、脱敏在写入前生效 | 人能不能看懂、下载权限对不对 |
| L2 API 与控制台 | 授权下载、Evidence Viewer、缺失原因与不完整结论在页面上说得出来 | 真实页面上截图有没有意义 |
| L3 受控站点与真实系统 | S04 的开销与体积实测、上传中断与浏览器 Crash、逐 Run Trace 不串联 | 覆盖率——不承诺任意站点 |

## 2. 目标与非目标

### 目标

1. `evidenceStatus` 与 `executionOutcome` 分成两根轴。必要证据缺失不得表现为干净的成功，也不得把已经成功的业务动作改判成失败。
2. 证据债务先登记后上传：`evidences` 出现 `PENDING` 态，是补传的凭据，接上已有的 `putObject({ objectId })` 重投入口。
3. 有界补传：只补字节，绝不重放业务动作。预算耗尽或字节已不可得，判 `MISSING` 并把 Run 的证据轴置为 `INCOMPLETE`。
4. 授权下载：API 能按权限取回对象正文；Web 能看图、能下载 Trace。
5. Trace：操作前开录，按 Attempt 分 chunk，失败保留、成功丢弃、Debug 明确保留，复用 Session 时不混入另一个 Run。
6. 脱敏在写入证据与日志之前生效，判定不靠猜字段名。
7. 保留期按证据类型与 Run 结局决定，不再是一个全局天数。
8. Evidence Viewer：按 StepRun / Attempt 组织，输入输出、错误、截图、Trace、缺失原因都看得见。
9. Evidence Policy 冻进 RunSnapshot，历史 Run 用自己的策略解释。
10. S04 出报告：Trace 开启前后的延迟与体积、上传中断、浏览器 Crash、逐 Run Trace 不串联。

### 非目标

- 不做 `run_events`、NOTIFY、SSE。进度仍然只有手动刷新 GET（P7）。
- 不做视频、不做报告设计器、不做跨地域对象复制。
- 不做流式 `get` 与分片上传。本期对象仍整包进内存，只调上限（债务 3）。
- 不做预签名 URL。字节一律经 API 鉴权后转发。
- 不做对象正文加密（桶级加密属基础设施）。
- 不做视觉差异比对、不做截图 OCR。
- 不新增 Step Type。没有 Screenshot Step——截图是平台策略，不是用户步骤（路线图 P10 的原话）。
- 不改 Affinity、Placement、租约语义。

## 3. 决策

### D1. `evidenceStatus` 与 `executionOutcome` 是两根轴，不合成一个状态

路线图原文是「**单独记录** evidenceStatus 与 executionOutcome」。两条走法都错：

| 走法 | 错在哪 |
| --- | --- |
| 证据不全就把 Run 判 `FAILED` | 业务步骤确实成功了。更糟的是 `SIDE_EFFECT` 步骤——判失败会诱导重跑，把一次已经发生的提交变成两次。宪法 §19 禁止盲目重试未知副作用，这是同一个坑的另一侧 |
| 只在证据行上留 `missing_reason` | 就是今天。Run 是干净的 `SUCCEEDED`，除非有人逐行翻证据列表，否则看不出来 |

本期取两根轴：

```text
runs.status          执行结论：QUEUED / RUNNING / … / SUCCEEDED / FAILED / NEEDS_REVIEW / …（不变）
runs.evidence_status 证据结论：PENDING / COMPLETE / INCOMPLETE（新增）
```

`evidence_status` 的判定只看**冻结策略要求的**证据类型（D10），不看可选证据：

- Run 未终态，或仍有 `PENDING` 证据行且补传预算未耗尽 → `PENDING`；
- 策略要求的证据全部 `AVAILABLE` → `COMPLETE`；
- 任一必要证据终态为 `MISSING` → `INCOMPLETE`，并在 Run 上挂一条 `type = 'error'`、code 为 `EVIDENCE_INCOMPLETE` 的证据说明缺了什么、为什么。

API 的 Run 详情同时返回两根轴；控制台把「成功」与「证据不完整」并列显示，不合成一个词（D9）。

终态 Run 的证据轴允许停留 `PENDING` 最长 `pending_ttl`（默认 3600 s）：Worker 失联时补传窗口没关，要等收尾扫描判死。收集窗口对执行结论在终态关闭，对证据轴开到 `pending_ttl` 为止。D9 必须给「执行已终态、证据仍 `PENDING`」这个组合独立文案，不得把它渲染成执行进行时。

证据轴迁出 `PENDING` 的入口必须闭环，否则会出现「必要证据都齐了、轴却永远停在收集中」：

- Engine `execute` 的 `finally` 调 `settleRunEvidence`（已有）。
- **`reviewRun` 在执行结论落入 `FINISHED` 之后、同一请求内再调一次 `settleRunEvidence`。** 核查结论已提交就不得因收尾失败回滚——执行轴已落；收尾失败留给下一轮扫描。
- **cleanup tick：先 commit「对象已 `available`」的 pending 证据，再把过期 pending 判 `worker_lost`，再扫已终态且 `evidence_status = PENDING` 的 Run，最后 `purgeExpiredObjects`。** 后一道扫描覆盖：`finally` 收尾失败、`NEEDS_REVIEW` 当时未终态、以及没有任何 `pending` 证据行可被 TTL 谓词扫到的成功 Run。只扫执行已终态的行，不扫 `RUNNING` / `NEEDS_REVIEW`。

**Attempt 一级不加列。** 单个 Attempt 的证据齐不齐可以从它名下的证据行直接数出来，多存一份就是多一个会漂移的事实源。Run 一级要存，是因为策略在 Run 终态时冻结，收集窗口已经关闭，事后重算会被后来的清理（`markStoredObjectPurged` 会把过期对象的证据行改成 `object_purged`）污染成假的 `INCOMPLETE`。

### D2. 债务先登记再上传：`evidences.status`

把写入顺序倒过来：

```text
今天：reserve(PENDING obj) → store.put → commit(AVAILABLE) → insert evidence(有指针)
                              ↑ 这中间崩溃 = 没有任何行记得欠一张截图

本期：reserve(PENDING obj) + insert evidence(PENDING, 带 objectKey)   ← 同一事务
      → store.put → commit(AVAILABLE) + evidence → AVAILABLE          ← 同一事务
```

`evidences` 增三列：

| 列 | 取值 | 说明 |
| --- | --- | --- |
| `status` | `pending` / `available` / `missing` | 采集状态。结构化 payload 行建出来就是 `available` |
| `object_id` | UUID → `stored_objects.id` | PENDING 阶段 `object_key` 还不能证明字节在，靠 id 定位要重投哪个对象 |
| `upload_attempts` | INT | 有界补传的计数，与 `stored_objects.purge_attempts` 同一套写法（单语句自增） |

`recordObjectEvidence` 今天要求对象已 `available`（`packages/db/src/objects/objects.ts` 216–219），这条**保留**——它挡的是「把不存在的字节挂成证据」。新增 `reserveObjectEvidence` 走 PENDING 分支，两者不合并：一个断言「字节在」，一个声明「字节欠着」，混成一个函数就没有断言了。

存量数据在 `0013` 里回填：`missing_reason` 非空的行 → `missing`，其余 → `available`。

`status` 与 `missing_reason` 之间是一条不变量：**对象类证据行 `status = 'missing'` 当且仅当 `missing_reason` 非空**，0013 的 CHECK 直接把它写进 Schema（宪法 §18 不变量 18：约束由数据库约束卡住，不靠自觉），不是只靠回填检查兜底。现有的 `markStoredObjectPurged` 只写 `missing_reason` 不写 `status`（`objects.ts` 176–181）——不改它，清理路径会持续制造 `available + missing_reason` 的矛盾行；而 CHECK 先上线、它后改，清理事务会开始失败，对象永远清不掉。它的证据行更新必须同步置 `status = 'missing'`（D8 有对应修订）。

### D3. 崩溃之后能补的是账，不是字节

补传要诚实：**截图和 Trace 的字节在崩溃的那个 Worker 的内存/临时目录里，进程没了就没了。**

所以补传分两种，不能混：

| 现场 | 能做什么 |
| --- | --- |
| 本进程上传失败（网络抖、S3 5xx、盘满） | 字节还在手上。有界重试 + 退避，走 `putObject({ objectId })` 重投同一个预留键（幂等，不产生第二份对象） |
| Worker 崩溃 / 失联 | 字节不可得。收尾只能把 `PENDING` 证据行判 `MISSING`，`missing_reason = 'worker_lost'`，Run 证据轴置 `INCOMPLETE` |

第二种是本决策的重点：不要写一个「恢复时重新截图」的分支。那时页面早就不是失败现场了，补出来的 PNG 比没有更有害——它看起来像证据，实际上是另一个时刻的东西。宪法 §10 说 Evidence 记录「实际上发生了什么」。

第一种必须发生在**字节还在本次调用栈**的时候：`putObjectEvidence` 在同一调用内按 `CAIRN_EVIDENCE_UPLOAD_MAX_ATTEMPTS` 循环重试，退避默认 200 ms（测试置 0）。`attachObjectEvidence` 只调一次，等这次调用自己重试完。**禁止把「再调一次 `putObjectEvidence` 并重新传入 body」当成生产补传路径**——那条路生产走不到，字节已经丢了。预算耗尽才把行判 `MISSING`。

还有第三种现场，和崩溃不同、和「字节还在手上」也不同：

| 现场 | 能做什么 |
| --- | --- |
| `store.put` 已成功、`stored_objects` 已 `available`，但 `commitObjectEvidence` 未落 | 字节在桶里。**进程内与进程死后同一条路**：只 commit 证据行，用账本上的 `contentType` / `byteSize` / `digest`。禁止再走 `requirePending` / 再 `put`，也禁止收尾把它写成 `worker_lost` |

`putObjectEvidence` 每次重试前重读对象行：`available` → 只 commit 证据；`pending` → `putObject({ objectId })`；其它状态 → 按预算判缺失。

进程若在 `put` 成功、`commitObjectEvidence` 之前死去：字节已不在调用栈，但仍在桶里。cleanup 扫 `pending` 证据时**先**处理「对象已 `available`」——`commitObjectEvidence`，再谈 TTL / `worker_lost`。只补账，不重放、不重新截图。

收尾扫描挂在 Worker 已有的 cleanup tick 上（先 commit「对象已在」的 pending 证据，再把过期 / 超限的 pending 判 `worker_lost`，再扫已终态且轴仍 `PENDING` 的 Run，最后 `purgeExpiredObjects`）。它**只写证据行与 `runs.evidence_status`，不写 Run / StepRun / Attempt 的执行状态**，因此不需要 RunLease——与对象存储方案 §8 对清理的判断同一条理由。这一点要有测试卡住：收尾路径不得调用任何带 `grant` 的写入。

判 `MISSING` 的触发条件：对象仍是 `pending` 且已被 `listPurgeCandidates` 按 `pending_ttl` 判为未完成上传（默认 3600 s），或 `upload_attempts` 超上限。对象已经 `available` 的 pending 证据不走这条，走上面的只 commit。两个 TTL 条件复用现有配置，不新造。

定序与并发要钉死，否则 `worker_lost` 这个死因看运气：

- **同一 cleanup tick 内：先 commit 已在对象，再 `worker_lost`，再扫终态轴，最后 `purgeExpiredObjects`。** 过期 pending 与 purge 共用 `pending_ttl` 谓词，purge 先到会把同一条证据行写成 `object_purged` 而不是 `worker_lost`。跨 Worker 并发时 purge 仍可能先到——死因字符串不同、结局相同（行 `MISSING`、Run 证据轴 `INCOMPLETE`），settle 对已非 `pending` 的行不再改写，两种死因都算数；L1 第 5 条的 `worker_lost` 在单进程受控时序下断言。对象已 `available` 的行不得被写成 `worker_lost`——`commitObjectEvidence` 与 `markEvidenceMissing` 都是 `WHERE status = 'pending'`，commit 先到则输家不落笔。
- **settle 的写入全部走条件更新。** 每个 Worker 的 cleanup tick 都扫全局 `listPendingEvidence`，两个 Worker 同时收尾同一批行时输家一笔不落：证据行 `UPDATE … WHERE status = 'pending'`（沿用 `markStoredObjectPurged` 的 `expectedStatus` 惯用法），`runs.evidence_status` 只从 `pending` 迁出，`EVIDENCE_INCOMPLETE` 错误证据行不存在才插。

### D4. 授权下载：API 第一次依赖对象存储

新增一条路由：

```text
GET /runs/:runId/evidence/:evidenceId/content     @RequirePermissions('run:read')
```

GET 用于无副作用读取，符合宪法 §12 与不变量 19。

四件事必须一起做：

1. **改依赖边表。** `tools/check-deps.mjs` 的 `ALLOWED_EDGES['@cairn/api']` 加 `@cairn/storage`。那个脚本的注释写着「这张允许边表就是架构决定本身」——所以这一改必须是显式决定，而不是顺手加个 import。理由：API 是 Evidence 的唯一对外读出口，Web 不得直连对象存储（宪法 §19「不得让 Web 直连数据库或正式 Worker」的同类边界）。
2. **API 并入同一份对象存储配置。** `apiEnvSchema` 加 `CAIRN_OBJECT_STORE` 那一段（`.env.example` 48–60 已有），与 Worker 共用同一份 env 片段，不各写一份。
3. **多机拓扑的诚实提示。** 对象存储方案债务 1：`local` 驱动 + API 与 Worker 不同机时，Worker 写下的对象 API 读不到。schema 检测不了拓扑，但可以在 `CAIRN_ENV != development` 且 driver 为 `local` 时启动告警——不硬失败（单机部署是合法的），但不能悄悄地让下载在生产上 404。
4. **越权与越 Run 的负向用例。** 路由要校验该 evidence 确实属于该 `runId`；`:evidenceId` 换成别的 Run 的证据必须 404 而不是照样吐字节。

响应带 `Content-Type`、`Content-Length`、`Content-Disposition`，以及 `X-Content-Type-Options: nosniff`。证据正文是不可信来源的字节（截图来自目标系统页面），不得让浏览器嗅探执行。

`evidences.status != 'available'` → 404 加缺失原因，不 500。

### D5. Trace 按 Attempt 分 chunk，失败保留、成功丢弃

Playwright 的能力刚好对上要求：`context.tracing.start()` 在 Context 上开一次，`startChunk()` / `stopChunk({ path })` 按段落切。Session 跨 Run 复用（宪法 §7）时，**分 chunk 就是「不串 Run」的实现**，不需要为 Trace 另开 Context。

时序：

```text
acquire 会话 → tracing.start({ screenshots, snapshots })      仅当策略非 `off`；随 lease 开停
  每个浏览器 Attempt：
    startChunk(title = attemptId)     ← 动作之前。事后开录留不下失败之前的过程
    …执行命令…
    stopChunk({ path: 临时文件 })
    按策略：失败 → 上传成 type='trace' 证据；成功 → 删临时文件
release 会话（归还 lease）→ tracing.stop()
```

四条约束：

- **必须在动作之前开录。** 「需要失败保留时提前录制」是 RF15 的原话，也是 Trace 唯一有价值的用法。
- **Trace 不取代平台断言。** `context.tracing` 记不下识途自己的 `assert` 结论（路线图 S6 已点明）。断言结果继续由 `finishAttempt` 写进平台证据，Trace 只是补充调试材料。宪法 §10。
- **不默认全开。** 宪法 §19「不得默认永久保存所有成功 Run 的重型 Trace」。平台默认是 `off`（D10）；要留的时候用 `on_failure`，不要 `always`。Debug Run 显式传 `always`。
- **`off` 就是不开录。** `tracing.start` 只在该 Run 冻结策略非 `off` 时调用——「开了但不保存」会让每个 Context 白付 snapshot/screenshot 开销，L3 第 25 条的「开启前后」也没有诚实基线。start / stop 跟随本次 Run 的 lease：Session 跨 Run 复用时，上一个 Run release 即 `stop`，本次 acquire 按自己的冻结策略决定是否 `start`，两次 Run 不共用一次开录。

体积：Trace zip 可能超过现有 32 MiB 默认上限（`CAIRN_OBJECT_MAX_BYTES`）。给 Trace 单独一档上限 `CAIRN_TRACE_MAX_BYTES`（默认 128 MiB），超限不上传、记 `missing_reason = 'trace_too_large'`，不静默截断。对象存储方案债务 5 说「采集方案里再调，不要在本核里预抬」——这里就是那个位置。

代码落点：`runtime.ts` 与 `session-manager.ts`（唯一碰 playwright 的边界不放宽），Engine 只通过 `BrowserPort` 拿到结构化的 Trace 指针，`engine.boundary.spec.ts` 继续禁止 Engine 引用 playwright 与 `@cairn/storage`。

### D6. 脱敏不靠猜字段名

两条判定，都不猜：

1. **Step 显式声明。** `fill` 的 input 加 `sensitive?: boolean`。作者说这是敏感值，证据里就写 `"[redacted]"`。
2. **本次 Run 解析过的 Secret 值做值级替换。** `SecretProvider` 解析出来的每个凭据值，在写入证据与日志之前对 payload 做一次值级匹配替换。这条覆盖「作者忘了标 `sensitive`，但值确实来自凭据」的情况，而且不依赖任何字段名。

**明确不做按字段名猜。** `password` / `token` / `secret` 之类的清单既会漏（`pwd`、`口令`），又会误伤（一个叫 `tokenCount` 的提取结果被打码）。启发式脱敏给人的安全感与它的实际覆盖率不匹配。

统一实现成 `@cairn/shared` 的一个纯函数 `redactJson(payload, secrets)`，Engine 与 `finishAttempt` 之间只有一个调用点——散在各处的 redact 迟早漏一处。

`secrets` 从哪来要说死，不能搭登录路径的便车：Engine 在 Run 启动、Snapshot 带 `secretRef` 时经 SecretProvider **自行解析一次**，明文只存在于 Worker 进程内存，供本次 Run 的脱敏与（需要时的）登录共用，Run 结束即弃。复用已认证会话的 Run 根本不登录——值级替换的匹配集不能因此为空。解密是只读幂等操作，Engine 与 session-manager 各解析一次不产生两份事实。

值级替换集只含 SecretProvider 解出的凭证明文（口令）。**不含** `targetAccounts.username`：短用户名会误伤 extract 结果。作者忘了标 `sensitive`、但值来自凭据的情况，仍靠口令值级替换覆盖。

截图侧：`screenshotPage` 已有的密码框遮罩保留；`evidencePolicy.screenshot = 'off'` 可整体关掉截图采集，对应路线图「未知敏感区域的采集策略必须可关闭」。Target 上可声明的遮罩选择器清单要动 Target 契约与迁移，本轮不做，见债务 9。

### D7. 截图默认仍是失败一张——对路线图的一处收窄

路线图 P6 的原话是「浏览器步骤**默认**采集脱敏截图」。本方案把默认收窄为 `on_failure`，`always` 做出来但不设默认。

理由：一个 20 步的浏览器 Run 在 `always` 下产生 20 张全页 PNG，按当前 30 天保留期堆着，而其中 19 张是「一切正常」的截图。真正需要复盘的是失败现场。宪法 §10 反对默认保存重型产物的精神同样适用于成批截图。

这是一处**明确的偏离**，写在这里供评审推翻，而不是悄悄按自己的口径实现。`evidencePolicy.screenshot` 三档 `off / on_failure / always` 都实现，改默认只是改一个常量。

### D8. 保留期按类型与结局，不是一个全局天数

`stored_objects.retain_until` 列已经在，今天由一个全局 `CAIRN_OBJECT_RETAIN_DAYS` 算出来（`object.service.ts` 71–73）。改成在 `reserve` 时按证据类型与 Run 结局算：

| 证据 | 默认保留 |
| --- | --- |
| 结构化 `input` / `output` / `error` / `log`（PG payload 行，不进对象存储） | 随 Run 行 |
| `screenshot` | 30 天 |
| `trace`（失败保留） | 14 天 |
| `trace`（Debug Run 显式保留） | 7 天 |

`retainDays` 实际只有 `screenshot` / `trace` 两类消费——其余类型的证据是 PG payload 行，没有 `reserve()`，配了天数也没有读者，键控里留着它们只是噪音。Debug Run 的 Trace 反而比失败 Trace 短，是有意的：Debug 是当场打开当场看的材料，消费窗口以分钟计；失败 Trace 服务于事后复盘，窗口给长。要留得更久，先下载。

清理链路几乎不动：`listPurgeCandidates` 已经只看 `retain_until`，本期只改「`retain_until` 怎么算出来」。`markStoredObjectPurged` 有一处必须动：证据行更新补写 `status = 'missing'`（D2 的不变量）——它今天只写 `missing_reason` 的写法（`objects.ts` 176–181）会撞上 0013 的 CHECK，撞上就是清理事务失败、对象清不掉。

被清理**不等于**证据不完整：`markStoredObjectPurged` 改的是 `missing_reason`，`evidence_status` 已经在 Run 终态时定死（D1），不因过期清理翻转。这条要有用例卡住，否则所有历史 Run 会在 30 天后集体变成 `INCOMPLETE`。

### D9. Evidence Viewer：按 Attempt 组织，不是一条平铺列表

今天 Web 把证据渲染成一行行 `类型 · 对象 key` 的文本（`detail.tsx` 249–261）。按 UI 原则 11「测试步骤、断言、执行证据是平台核心信息，不得为了简洁而隐藏」和原则 12「渐进式展示」重做：

- 证据挂到步骤时间线上的对应 Attempt 下，默认折叠，展开看详情；
- `input` / `output` / `error` 结构化渲染，不是 JSON dump；
- `screenshot` 直接出图（走 D4 的下载路由），点开看大图；
- `trace` 给下载按钮，旁注「用 Playwright Trace Viewer 打开」；
- `missing_reason` 用橙色警告色而不是红色——证据缺失是待处理，不是执行失败（UI 原则 3 / 4）；
- Run 头部并列显示两根轴：执行结论用状态色，证据轴不完整时挂一枚橙色标记；
- 「执行已终态、证据仍 `PENDING`」（Worker 失联后补传窗口未关，最长 `pending_ttl`）用灰色给独立文案「证据收集中」——它还没被判缺失，不上橙色（D1）。列表同样：**「状态」与「证据」分两列**，不得把两枚徽章塞进同一格导致后面的场景 / 目标系统列错位。列表证据列只在 `INCOMPLETE`、或已终态仍 `PENDING` 时出徽章；`QUEUED` / `RUNNING` 的 `PENDING` 不出，避免把执行进行时渲染成「证据收集中」。

继续不加自动刷新：`detail.test.tsx` 已有的「无 `refetchInterval` / `setInterval` / `EventSource`」源码断言保持（那是 P7 的事）。

### D10. Evidence Policy 冻进 RunSnapshot，且不让存量 Snapshot 失效

「是否满足完整证据由**冻结策略**判断」是路线图 P6 的原话，也是宪法 §2：Run 启动时冻结影响执行解释的配置。策略进 `RunSnapshot`：

```ts
evidencePolicy: {
  screenshot: 'off' | 'on_failure' | 'always'   // 默认 on_failure
  trace:      'off' | 'on_failure' | 'always'   // 默认 off；Debug Run 为 always
  required:   EvidenceType[]                     // 默认 ['input']；另有隐含 outcome 槽（output | error 有一即可）
  retainDays: Partial<Record<EvidenceType, number>>
}
```

**存量 Snapshot 没有这个字段。** P5 的 D8b 刚踩过同一个坑：往 `DEFAULT_EXECUTOR_VERSIONS` 加键时，遍历全部键的校验会让库里只有 3 键的老 Snapshot 全部 `FAILED`。这里同理——把 `evidencePolicy` 设成必填，所有历史 Run 一读就炸。

做法：字段可选，解析时缺省走平台默认；`required` 的判定只对**该 Snapshot 声明过的**类型生效，没声明就用默认集合。存量 Snapshot 要有正反例用例。

## 4. 契约变更

`@cairn/shared`：

- `evidence.ts`：新增 `EVIDENCE_STATUSES` = `pending / available / missing` 与 `evidenceStatusSchema`；`evidenceMetadataSchema` 加 `status`（必填）、`uploadAttempts`（可选）。
- 新文件 `evidence-policy.ts`：`evidencePolicySchema`、`DEFAULT_EVIDENCE_POLICY`、`resolveEvidencePolicy(snapshot)`（存量缺省）。
- `run-api.ts`：`RunDetail` 加 `evidenceStatus`；新增证据正文路由的响应错误码。
- `step.ts`：`fill` 的 input 加 `sensitive?: boolean`。
- 新增 `redact.ts`：`redactJson(payload, secrets)`，纯函数，不依赖 node。
- `object-store.ts`：`OBJECT_MISSING_REASONS` 补 `workerLost` / `traceTooLarge` / `captureFailed`（`capture_failed` 今天是 `port.ts` 里的裸字符串字面量，收进常量）。
- 新增运行错误码 `EVIDENCE_INCOMPLETE`。

`@cairn/db`：

- 迁移 `0013_evidence_status.sql`：`evidences` 加 `status` / `object_id` / `upload_attempts` 三列与 CHECK（含 `status = 'missing'` 当且仅当 `missing_reason` 非空，D2 的不变量进 Schema）；`runs` 加 `evidence_status` 与 CHECK；回填存量行（`missing_reason` 非空 → `missing`，其余 → `available`；`runs.evidence_status` 终态 Run 一律 `complete`、未终态 `pending`——终态不按行回算：历史 Run 执行时证据轴与冻结策略都不存在，按行回溯等于用今天的契约追判当时的 Run）。
- `objects.ts`：新增 `reserveObjectEvidence`（PENDING 分支）、`commitObjectEvidence`、`markEvidenceMissing`、`bumpEvidenceUploadAttempts`（单语句自增）；`recordObjectEvidence` 的 `available` 断言保持不变；`markStoredObjectPurged` 的证据行更新补写 `status = 'missing'`，其余行为不动（D2 / D8）。
- 新增 `evidence.ts`：`settleRunEvidence`（按冻结策略算证据轴并写 `runs.evidence_status`）、`listPendingEvidence`、`settleFinishedPendingRuns`（已终态且轴仍 `PENDING`）、`getEvidenceForRun`（下载路由用，校验归属）；`settleExpiredPendingEvidence` 先 commit「对象已 `available`」的 pending 证据，再把过期 / 超限行判 `worker_lost`；`settleRunEvidence` 的写入全部走条件更新——证据行 `WHERE status = 'pending'`、`runs.evidence_status` 只从 `pending` 迁出、`EVIDENCE_INCOMPLETE` 行不存在才插（D3）。
- `runs.ts`：`startAttempt` / `finishAttempt` 写 payload 前经 `redactJson`。`finishAttempt` 对 `screenshot` 与 `trace` 同样处理：调用方带来的 `missingReason` 且尚无该类型行时补 `missing` 行；已有 `pending` / `available` 行不插。
- `recover.ts`：`reviewRun` 在执行结论提交后调 `settleRunEvidence`，失败不回滚核查。

`@cairn/api`：

- `package.json` 加 `@cairn/storage`，`tools/check-deps.mjs` 的 `ALLOWED_EDGES['@cairn/api']` 同步加边（D4）。
- `apiEnvSchema` 并入对象存储配置片段。
- `runs.controller.ts` 加 `GET :runId/evidence/:evidenceId/content`。
- `runs.service.ts` 的 Run 详情返回 `evidenceStatus`。

`@cairn/worker`：

- `object.service.ts`：`putObjectEvidence` 先登记后上传；**同一调用内**有界重试 + 退避；对象已 `available` 时只 commit 证据行。
- 新增 `evidence/settle.service.ts`：挂在已有 cleanup tick 上的证据收尾，只写证据不写执行状态；同一 tick 内先过期 pending、再扫已终态轴 `PENDING`、最后 `purgeExpiredObjects`（D3）。
- `runtime.ts` / `session-manager.ts`：Trace 的 `start` / `startChunk` / `stopChunk` / `stop`。
- `port.ts`：Trace 指针经 `BrowserCommandResult` 回传，与截图同一条路。空字节回 `capture_failed`，由 `finishAttempt` 落行。
- `engine.ts`：Run 启动、Snapshot 带 `secretRef` 时经 SecretProvider 解析一次**口令**，明文只在内存，传入 `startAttempt` / `finishAttempt` 的脱敏调用点（D6）。失败路径把 `screenshot` 与 `trace` 指针交给 `finishAttempt`。

`@cairn/web`：`detail.tsx` 的 Evidence Viewer 与两根轴展示；`runs-api.ts` 加下载地址构造。

## 5. 验收

### L1 库与 Worker

1. 两根轴分开：截图上传失败的浏览器 Run，`runs.status = 'SUCCEEDED'` 且 `runs.evidence_status = 'INCOMPLETE'`，并挂一条 `EVIDENCE_INCOMPLETE` 的错误证据。把 D1 的判定撤掉，本条必须失败。
2. 证据缺失**不**改写业务结论：同一条 Run 的 Attempt 仍是 `SUCCEEDED`，`SIDE_EFFECT` 步骤不进 `NEEDS_REVIEW`、不产生第二次执行。
3. 债务可重试：同一 `putObjectEvidence` 调用内注入一次 `store.put` 失败，退避后第二次成功；行变 `available`，`stored_objects` 只有一份对象。把重试做成第二次函数调用并重新传入 `body`，本条必须失败——那不是生产路径。
4. 有界：同一调用内连续注入失败直到 `upload_attempts` 超上限 → 行判 `missing`，Run 证据轴 `INCOMPLETE`。
5. 崩溃只补账：PENDING 对象超 `pending_ttl` 后收尾把证据行判 `missing`、`missing_reason = 'worker_lost'`，且**不重新截图**、不重放业务动作。
6. 收尾不碰执行状态：证据收尾路径不调用任何带 `grant` 的写入；Run / StepRun / Attempt 的状态与 `updated_at` 在收尾前后不变。并发两轮收尾同一 Run，`EVIDENCE_INCOMPLETE` 错误证据行只有一条（条件更新，输家不落笔）。已终态、轴仍 `PENDING`、没有任何 `pending` 证据行的 Run，cleanup 扫描后轴迁出 `PENDING`。`reviewRun` 给出结论后同一请求内轴迁出 `PENDING`。
7. 过期清理不翻转证据轴：把一条 `COMPLETE` Run 的对象 `retain_until` 改到过去、跑一轮清理，证据行 `missing_reason` 变 `object_purged`、`status = 'missing'`，但 `runs.evidence_status` 仍是 `COMPLETE`。清理路径不得制造 `available + missing_reason` 矛盾行——漏写 `status` 会被 CHECK 拦成清理失败，本条跟着红。
8. Trace 分 chunk 不串 Run：同一 Session 连续跑两个 Run，各自失败一次，产出两个 Trace 对象，各自只含本 Run 的 Attempt。
9. Trace 成功丢弃：`on_failure` 策略下成功 Attempt 不产生 `type = 'trace'` 证据，临时文件已删。
10. Trace 在动作之前开录：把 `startChunk` 挪到动作之后，本条必须失败（Trace 里读不到失败之前的导航）。
11. Trace 超限：构造超过 `CAIRN_TRACE_MAX_BYTES` 的 chunk → 不上传、记 `trace_too_large`，Attempt 结论不变。空字节留下 `type = 'trace'`、`status = 'missing'`、`missing_reason = 'capture_failed'` 的行，不把 Attempt 改写成成功。
12. 脱敏：`sensitive: true` 的 `fill` 值不出现在 `evidences.payload`；本次 Run 解析过的凭据值不出现在任何证据与日志里（全表扫一遍 payload 断言）。把 `redactJson` 撤掉，本条必须失败。
13. 脱敏不误伤：一个叫 `tokenCount` 的 `extract` 输出原样保留——本期不做按字段名猜。
14. 存量 Snapshot（无 `evidencePolicy`）继续可执行，走平台默认策略；显式声明 `screenshot: 'off'` 的 Snapshot 不产生截图证据。默认 `trace: 'off'` 时 `tracing.start` 零调用——`off` 是不开录，不是开了不保存（D5）。
15. Echo / Delay / Fail 的 Mock Run 仍有完整结构化证据、零 `screenshot`、零 `trace` 行（RF04 的既有断言保持）。
16. `0013` 在空库与存量库上都能升；回填后不存在 `status` 为空或与 `missing_reason` 矛盾的行。

### L2 API 与控制台

17. 授权下载：带 `run:read` 能取回截图正文，`Content-Type` 为 `image/png`，`X-Content-Type-Options: nosniff`。
18. 无 `run:read` → 403；`:evidenceId` 属于另一个 Run → 404，不吐字节。
19. `status != 'available'` 的证据 → 404 带缺失原因，不 500。
20. Run 详情返回两根轴；`INCOMPLETE` 的 Run 在列表与详情上都能看出来。列表「状态」与「证据」分两列，场景名出现在「场景」列下，不得错到「证据」列。
21. Evidence Viewer：证据挂在对应 Attempt 下，截图能出图，Trace 能下载，`missing_reason` 用橙色而非红色。
22. 页面仍无 `refetchInterval` / `setInterval` / `EventSource`（沿用 P3 / P4 的源码断言）。
23. `local` 驱动 + 非 development 启动时给出多机拓扑告警，且不硬失败。
24. `pnpm check` 在 `@cairn/api` 依赖 `@cairn/storage` 但没改允许边表时必须红——先跑一次未改边表的版本确认它确实红。

### L3 受控站点与真实系统（S04）

25. 在 `tests/target-surface-lab` 上测 Trace 开启前后的单 Attempt 延迟与产物体积，出数值，不出结论式描述。
26. 上传中断：在 `putObject`（对象已 `available`）与 `commitObjectEvidence` 之间注入中断，验证重试只 commit 证据行、`requirePending` 零调用、`stored_objects` 仍一份。进程在 commit 前死去：cleanup 同样只 commit，不标 `worker_lost`。把中断做成「再调一次并重传 body」，本条必须失败。
27. 浏览器 Crash：kill chromium 进程，验证截不到图时记 `capture_failed`，业务结论不被改写成成功。
28. 逐 Run Trace 不串联：复用同一 Session 的两个 Run 各自的 Trace 互不包含对方的 Attempt。
29. L3 打 [SNC DPM](../targets/snc-dpm.md)（`CAIRN_L3_DPM=1`，只读），跑通「失败截图 → 授权下载 → 页面看图」一条链路。
30. S04 报告落进本文件，含开销数值与失败分类；若某项开销过大，缩小默认策略并写明，不放宽阈值。

### 统一

31. `pnpm check`、`pnpm lint`、`pnpm typecheck`、`pnpm test` 通过。
32. 不得宣称 RF14 / RF15 在真进程 kill / 断网上通过——那是 P3 债务 4，本方案只证明本进程与库层（见债务 1）。

### 复查补条（2026-09-12 整改）

33. 同一 `putObjectEvidence` 调用内：第一次 `store.put` 失败、退避后第二次成功 → `available`，对象一份。
34. `stored_objects` 已 `available`、证据仍 `pending`：重试只 `commitObjectEvidence`，不 `requirePending`、不再 `put`。
35. `reviewRun` 之后，以及 cleanup 扫描「已终态 + 轴 `PENDING` + 无 pending 行」，证据轴迁出 `PENDING`。
36. 空 Trace 落 `capture_failed` 行；运行列表状态列与证据列分开。
37. 对象已 `available`、证据仍 `pending`：cleanup 只 commit 证据，行变 `available`，轴迁出 `PENDING`，`missing_reason` 不是 `worker_lost`。把这条收成 `worker_lost`，本条必须失败。

## 6. 拆分与顺序

建议四个 PR：

1. **两根轴 + 债务登记**：`0013` 迁移、`evidences.status`、`reserveObjectEvidence` / `commitObjectEvidence`、`putObjectEvidence` 改先登记后上传、有界重试、`settleRunEvidence`、证据收尾挂上 reap tick（先收尾后清理）、`markStoredObjectPurged` 补写 `status`。交付 L1 的 1–7、16。
2. **脱敏 + Evidence Policy**：`redactJson`、`fill.sensitive`、Secret 值级替换（Engine 启动时自行解析一次，D6）、`evidencePolicy` 进 Snapshot 与存量缺省、按类型保留。交付 L1 的 12–15，以及 D8 的清理不翻转（第 7 条与 PR 1 共同覆盖）。
3. **授权下载 + Viewer**：依赖边表、API env、下载路由、Web Evidence Viewer 与两根轴展示。交付 L2 全部。
4. **Trace**：`start` / `startChunk` / `stopChunk`、失败保留成功丢弃、体积上限、S04。交付 L1 的 8–11、L3 全部。

PR 1 是硬前置：没有 `evidences.status`，后面三个都没有可挂的地方。PR 2 与 PR 3 可并行。PR 4 最后——Trace 是本期体积最大、最容易被开销数据推翻默认策略的一块，让它踩在已经能下载、能看见的基础上。

## 7. 刻意留给后续

| 阶段 | 本方案结束后仍缺的 |
| --- | --- |
| P7 | `run_events`、NOTIFY、SSE；证据变化的实时推送；Run Observer 的时间线实时更新 |
| P8 / P9 | AI 调用的审计证据（模型、Token、成本、路由）、AI Decision / Reason 的证据形态 |
| P13 | Assert Builder 的断言证据视图（expected / actual 的结构化对比 UI） |
| 以后 | 流式 `get` 与分片上传、预签名下载、视频、按 Target 的证据保留合规策略、跨地域复制、证据全文检索 |

## 8. 债务

1. 进程维度的故障注入仍然没有（P3 债务 4）。本期第 5 条「崩溃只补账」用的是「PENDING 对象超 TTL」这个库层谓词模拟，不是真的 SIGKILL 一个 Worker。真进程的 kill / SIGSTOP / DB 断连需要子进程编排与可注入连接代理，那是独立一档工作——**而且它同时是 P7 的 S05（NOTIFY 丢失、SSE 重连）的前提**，建议在 P7 之前单独排，不要再往后推。
2. 下载与元数据列表同权限（`run:read`）。viewer 能看 Run 就能下载该 Run 的截图。要更细的粒度得单独加权限位并改系统角色种子，本期不做。
3. 对象整包进内存。Trace 上限抬到 128 MiB 之后，一次并发下载几份大 Trace 会明显吃内存。流式 `get` 要改 `ObjectStore` 契约（对象存储方案 §2 明确把 `list` / 流式排除在外），等真有大 Trace 的实测再改。
4. `local` 驱动的多机拓扑只能靠告警，检测不了。沿用对象存储方案债务 1。
5. 值级 Secret 替换对「凭据被目标系统变形后回显」无效（例如只回显后四位、或做了 URL 编码）。这是脱敏的固有上限，不假装覆盖。
6. Trace 的敏感内容没有遮罩。Trace 里含完整 DOM 快照与网络记录，截图那层的密码框遮罩管不到它。本期只靠「默认 `off`、失败才留、保留期短」控制暴露面；真要遮罩得先有 Playwright 侧的可行手段，不凭想象写。
7. `evidencePolicy` 目前只能按平台默认与 Run 创建参数决定，没有 Target 级默认。等 P10 的 Compiler 把策略合并做出来再接。
8. 作者标 `sensitive: true` 的值只在该步 `input` 行整体打码；它经 Execution Context 流进后续步骤的 input / output（例如 extract 回显）时仍可见——值级替换只认本次 Run 解析过的凭据，不认作者标记。要覆盖得把 sensitive 解析值也并进替换集，本期不做。
9. Target 级截图遮罩选择器清单。D6 原文要「另加 Target 上可声明的遮罩选择器」，要动 Target 契约、迁移与控制台表单。本轮只保留 `input[type=password]` 遮罩和 `screenshot: 'off'`；选择器清单单独做，不塞进这次补传 / 收尾修补。

## 9. 更新历史

- 2026-09-12：初稿。以对象存储方案 §8「刻意留给后续」、P5 方案 §7 的 P6 条目、路线图 P6 / RF14 / RF15 / S04，以及仓内现状为事实源：`port.ts` 的 `attachScreenshot` 吞异常、`putObject({ objectId })` 重投入口零调用方、`ALLOWED_EDGES` 不许 API 依赖 storage、`context.tracing` 全仓零调用、`insert(evidences)` 前无 redact。D7 明确记下一处对路线图原文的收窄（截图默认 `on_failure` 而非全采），供评审推翻。
- 2026-09-12：评审修订。补三处设计缺口：`markStoredObjectPurged` 须同步写 `status`、status↔missing_reason 一致性进 CHECK（D2 / D8）；收尾与清理在同一 tick 的定序、跨 Worker 竞争的死因口径、settle 全条件更新（D3）；Secret 值到达脱敏点的管道——Engine 启动时自行解析一次，不搭登录便车（D6）。另：`off` 不开录写成硬约束（D5）、终态 + 证据 `PENDING` 的展示口径（D1 / D9）、`0013` 终态回填的 rationale、D8 表删掉 `log` 死配置行并给 Debug 保留期一句理由、验收 6 / 7 / 14 加对应断言、新增债务 8。
- 2026-09-12：按评审修订落地。`0013`、两根轴、债务先登记后上传、授权下载、Evidence Viewer、Trace 分 chunk、写入前脱敏。S04 数值见 §10。不宣称 RF14 / RF15 在真进程 kill / 断网上通过。
- 2026-09-12：对照落地复查后整改。钉死三处生产路径：`putObjectEvidence` 在字节仍在调用栈时重试（禁止二次调用冒充补传）；对象已 `available` 时只 commit 证据；`reviewRun` 与 cleanup 扫描闭环迁出证据轴。顺带：空 Trace 落 `capture_failed` 行、列表状态 / 证据分列、值级替换不含 username。Target 遮罩选择器降为债务 9。
- 2026-09-12：复查补洞。`store.put` 已成功、进程在 commit 证据前死去：cleanup 只 commit 已在对象，不标 `worker_lost`。D5 默认口径与 D10 对齐为 Trace `off`；§10 上传中断改成与 D3 同一条路。

## 10. S04 报告

受控站点：`tests/target-surface-lab`。先暖机一次登录/会话，再对单 Attempt `navigate` 测 `trace: off` 与 `trace: always`。

| 项 | 数值 |
| --- | --- |
| Trace off 墙钟 | 1518 ms |
| Trace always 墙钟 | 1793 ms |
| 增量 | +275 ms |
| off 产物体积 | 0 |
| always Trace zip | 12 575 B |
| 失败分类 | 定位失败 → 业务 `FAILED`，截图/Trace 按 `on_failure` 保留；空字节记 `capture_failed`，不改写成成功 |
| 上传中断 | 同一调用内 `put` 失败则退避再 `put`；`put` 已成功、证据未 commit 则只 commit。进程在 commit 前死去，cleanup 同样只 commit，不标 `worker_lost` |
| 逐 Run 不串联 | 同一 Session 连续两个失败 Run，各有一条 Trace，`objectKey` / `runId` 不同 |

默认策略不收窄：`screenshot: on_failure`、`trace: off`。单页 Trace 约 12 KiB、墙钟多约 0.3 s，未到需要改默认的量级。

chromium 进程 kill 未在真进程编排里做（债务 1）；本方案用「截不到图 → `capture_failed`、结论仍是失败」覆盖采集失败路径。SNC DPM 只读失败截图链路在 `CAIRN_L3_DPM=1` 时跑 `engine.dpm.spec.ts`，未宣称任意企业系统已兼容。
