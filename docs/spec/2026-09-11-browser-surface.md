# 识途 Browser Surface 与浏览器步骤：Engine 第一次开浏览器

日期：2026-09-11。状态：**已落地**（2026-09-12）。L3 只读打 [SNC DPM](../targets/snc-dpm.md)，未找到嵌套 iframe 的稳定页，不得宣称该企业系统已全面兼容。
对应路线图 P5（Browser Surface 与 TargetResolver），以及 RF13、S03、VS2、A05。
前置：执行内核（P2，已落地）、RunLease / Fencing / 恢复（P3，已落地）、BrowserSession / SessionLease 第一截（P4，已落地）、[P4 后半：Affinity / 容量等待 / 失联隔离](2026-09-11-session-affinity.md)（**已落地，本方案的接线顺序与回交契约取自它**）。
范围：让 Engine 通过 `BrowserPort` 真正拿到会话并驱动真实页面；注册第一批确定性 Web Step；把「找不到元素 / 多匹配 / Frame 失效」变成可判定的结构化结果。
不是 AI Step（P8 / P9）、不是 Trace 与全量截图策略（P6 其余）、不是 SSE（P7）、不是 Sequence Editor（P11）、不是 Recorder（P12）。

## 1. 为什么现在写

P4 交付了会话纳管、三列状态、租约四操作、丢租即停、回收与重启自愈，测试全绿。但它**今天零消费者**：

- `ExecutionEngine` 注入了 `BrowserPort`，`this.browser` 只出现在构造函数那一行（`packages/worker/src/engine/engine.ts` 50–54）。`acquire` / `release` 从未被调用。
- RF04 集成测试反过来把这件事钉住了：跑完 Echo Run 后 `browser_sessions` 是空表，注释写「Engine 本期不调用 BrowserPort」（`engine.integration.spec.ts` 176–191）。
- `finishAttempt` 的会话提交栅栏写好了（`packages/db/src/runs/runs.ts` 493–509：丢租时 `SIDE_EFFECT` → `NEEDS_REVIEW`，其余 → `FAILED`，不写 `SUCCEEDED`），但 Engine 的 `close()` 从不传 `sessionLease`，这条分支在生产路径上一次都没跑过。
- `SessionGuard`（`packages/worker/src/browser/guard.ts`）能在丢租后拒绝浏览器命令，但没有任何命令经过它。
- RunLease 方案自己记了债务 5：「Session 一侧没有真实 `acquire` 调用，只有签名与 Repository 注释。P5 第一次 `acquire` 必须加双锁集成测试。」

一个建好、测绿、却没有真实调用方的子系统，正确性只在纸面上。双 Lease 的锁顺序、丢租的真实时机、认证等待与执行槽的交接，都要等第一个真实浏览器步骤才会暴露。空转越久，回头改的代价越大。

同时 `EXECUTABLE_STEP_TYPES` 仍然只有 `echo | delay | fail`。这不是遗漏——`step.ts` 6–10 的注释写明「提前占位等于告诉调用方平台已经能跑」。但它让后面每一件事都悬空：P6 没有东西可截图，P7 的 SSE 只能推夹具 Run 的进度，P11 的编辑器只有三个测试类型可编排，P12 录完的操作没有对应 Step 可以落地。

### 1.1 三层验收

沿用 P3 的口径，本期 Gate = L1 ∧ L2 ∧ L3：

| 层 | 证明什么 | 证明不了什么 |
| --- | --- | --- |
| L1 Worker 与库 | `acquire` / `release` 真发生；双锁顺序；丢租即停；提交栅栏改写结果；Resolver 四种结果可判定 | 真实企业页面能不能定位 |
| L2 受控站点 | 两层 iframe、popup、动态重挂载、小图标各连续 20 次无误点 | 单次成功不等于稳定 |
| L3 真实目标系统 | 至少一条含嵌套 iframe 与小图标的关键链路跑通，未支持项成文 | 覆盖率——本期不承诺任意站点 |

L3 在真实系统上**只读**：本期不在真实业务系统跑 `SIDE_EFFECT` 步骤（D6）。

## 2. 目标与非目标

### 目标

1. Engine 消费 `BrowserPort`。只有包含浏览器步骤的 Run 才 `acquire`，且在第一个 Attempt 之前；Run 以任何方式结束（成功、失败、取消、丢租、停机）都必须 `release`。占不到会话时按 Affinity 方案的回交契约退回 `RECOVERING`，不是失败。
2. 注册第一批确定性 Web Step：`navigate` / `click` / `fill` / `extract` / `assert` 五个，进 `stepSchema` 与 `DEFAULT_EXECUTOR_VERSIONS`。
3. 冻结 `TargetDescriptor`：语义候选 + FramePath。每次执行重新解析，不存运行期句柄、不存 frame 下标。
4. Resolver 返回四种可判定结果：`FOUND` / `NOT_FOUND` / `AMBIGUOUS` / `SURFACE_LOST`。多匹配绝不默认取第一个。
5. 浏览器步骤的 `finishAttempt` 必须带 `sessionLease`，让 P4 写好的提交栅栏第一次真被测试卡住。
6. `extract` 的输出按 `outputKey` 进 Execution Context；`assert` 把期望与实际分开落进证据。
7. `effectType` 继续不推断。它已经是 `stepCommon` 的必填字段，本期只要**不**给浏览器步骤加默认值或按 `click` / `navigate` 名字猜。
8. 还掉 RunLease 债务 5：双 Lease 锁顺序的真实 `acquire` 集成测试。
9. Attempt 失败时截一张脱敏截图进对象存储（D7），让定位失败可复盘。
10. 交出一个受控测试站点，覆盖 RF13 的五类现场。没有它 L2 无从谈起（D10）。

### 非目标

- 不做 AI Action / Extract / Assert，不接 Model Gateway、Midscene、Page Agent。
- 不做 Trace、不做成功 Attempt 的截图、不做授权下载与保留策略（P6 其余）。
- 不做 SSE、`run_events`、NOTIFY。进度仍然只有手动刷新 GET。
- 不实现 Affinity / Placement / 容量排队（那是前置的 P4 后半，本方案只消费它的回交契约）。
- 不做 Sequence Editor、草稿发布、Compiler。浏览器步骤本期只能通过 API 与现有最小创建表单写入。
- 不做 Select / Keyboard / Wait / Screenshot 等其余 Step Type（D8）。
- 不做 closed Shadow DOM、Canvas 内目标、视觉定位。识别到就明确报能力缺口。

## 3. 决策

### D1. 需要页面的 Run，在第一个 Attempt 之前 acquire

Engine 在加载 Snapshot 后扫一遍步骤：**不含**浏览器步骤的 Run，整条路径与今天完全一致，不 `acquire`、不建会话。RF04 的「Echo Run 后 `browser_sessions` 为空」必须继续通过——它从「Engine 还没接线」的说明，变成「按需开会话」的断言。

**含**浏览器步骤的 Run，`acquire` 必须发生在第一个 `startAttempt` **之前**，哪怕第一个步骤是 Echo。判据只能落在 Attempt 上：`step_runs` 在 `createRun` 里随 Run 一起整批插入，Run 被领取时它们已经存在，Worker 侧不存在「创建 StepRun」这个时机。这条顺序不是本方案的自由选择，是 Affinity 方案 D4 定死的：`placement_yield` 回交只允许在本轮执行开始之前发生，否则「结果未知」和「没占到座位」会混在同一个现场。该方案债务 2 直接点名：「P5 不得把『先执行再 acquire』当成优化。」

本条只覆盖**首次领取**。被恢复重领的 Run 身上已有上一轮的终态 Attempt，那条路径见 D1c。

代价是含浏览器步骤的 Run 里，前置 Echo / Delay 期间会占着一个浏览器。接受：把座位攥在手里换回的是「占不到会话时能干净地回交」，比省一个空闲浏览器重要。

会话获取一次，整个 Run 复用（宪法 §7：同一次 Run 默认共享同一 Session）。`release` 走 Engine 的收尾路径，与 `close()` 同一个 `finally`。异常退出不指望 `finally` 一定执行——那是 P4 的 reap 与 TTL 负责的事，本期不重复造。

### D1b. acquire 失败按 Affinity 方案 D5 分流，不自行发明失败

`acquire` 的失败码不是本方案定义的，直接用 Affinity 方案 D5 的表：`SESSION_BUSY` / `SESSION_CAPACITY_EXCEEDED` / `SESSION_NOT_CLAIMABLE` / `PROFILE_LOCKED` / `BROWSER_UNAVAILABLE` / `BROWSER_LAUNCH_FAILED` 一律走 Worker 的 `yieldPlacement` 回交 `RECOVERING`（内部才是 `yieldClaimedRun(..., 'placement_yield')` + `rememberPlacementYield(runId)`），**不计**恢复次数，**不**把 Run 标 `FAILED`；只有 `SESSION_ACCOUNT_REQUIRED` / `SESSION_TARGET_MISSING` / `SESSION_POLICY_INVALID` 三个配置错误码才是真失败。

分流**不得**把这两组码抄成 Engine 里的字面量数组。`packages/shared/src/session.ts` 已经冻好 `PLACEMENT_YIELD_CODES` 与 `SESSION_CONFIG_ERROR_CODES`，Engine 按集合判断即可；抄一遍等于给同一条规则开第二个事实源，Affinity 下次调表时必然漏改一处。

**冷却是 `yieldPlacement` 的组成部分，不是可选项。** 「浏览器不可用时本进程会自禁重试（Affinity D5）」只覆盖 `BROWSER_UNAVAILABLE` / `BROWSER_LAUNCH_FAILED` 这两个码，其余四个没有自禁；漏掉冷却就退回 Affinity D3b 点名要挡掉的「1 s 一轮领取—回交」空转。这不是理论风险：`packages/worker/src/runtime/placement-backoff.ts` 今天只有 `placementYieldExcludes()` 被 `lifecycle.service.ts` 消费，`rememberPlacementYield` **全仓零生产调用方**——D3b 的第二道闸在生产路径上是空的，`yieldPlacement` 是它的第一次接线。所以 Engine 侧不得直接调 `yieldClaimedRun`，只能走 `yieldPlacement`。

`placement-backoff` 在 `runtime/`，Engine import 它不触 `engine.boundary.spec.ts`（那只禁 playwright / `../browser` / `@cairn/storage`），但方向上是 Engine → Lifecycle 的反向依赖。本期把 `yieldPlacement` 收成 Worker 侧一个出口，Engine 只认它；要拆层，等 P7 把回交变成 `run_events` 里的可观察事件再说。

Affinity 方案里占不到会话的生产入口是 `yieldPlacement`。Engine 正式路径仍未接线；**本方案是它的第一个真实调用方**——这也意味着两份方案的落地顺序不能倒过来。

### D1c. 恢复重领的 Run，acquire 失败走同一条回交

D1 的「第一个 `startAttempt` 之前」只覆盖**首次领取**。被恢复重领的 Run（`RECOVERING` → 再 claim）身上已经有上一轮留下的终态 Attempt，此时 `acquire` 占不到会话，D1b 的回交在库里会被直接挡掉：`yieldClaimedRun` 只要数到**任何** Attempt 就返回 `has_attempts`，既不设 `RECOVERING` 也不放租约（`packages/db/src/runs/recover.ts`）。

后果不止「回交没成功」这么轻。Engine 返回后 Lifecycle 把它从 `inFlight` 删掉，而续租循环只遍历 `inFlight`（`lifecycle.service.ts`），租约不再续 → 过期写 `EXPIRED` → `countFailedRecoveries` 只数 `EXPIRED` / `REVOKED`，计数 +1 → 三轮之后 `NEEDS_REVIEW`。D1b 承诺的「不计恢复次数、不标失败」在恢复路径上全部反过来，而且 Run 被静默判成需要人工核查。L1 第 3 条若只测首次领取，测不到这条。

出路是修订 Affinity D4 的判据，不是在本方案里绕开：`placement_yield` 的守卫从「Attempt 数为 0」改成「不存在 `RUNNING` Attempt」。完整理由、等价性论证与代码改动见 [Affinity 方案 D4](2026-09-11-session-affinity.md)；要点是 `reconcileOrphanAttempts` 已经保证 Engine 进入步骤循环时没有在途 Attempt，所以新谓词恰好等价于「本轮还没执行过」，而 Affinity 自己的 L1 第 9 条写的一直就是这个口径——脱节的是那份方案的正文与实现，不是验收。

改动随本方案 PR 1 落地（`recover.ts` 的计数加一个 `status = 'RUNNING'` 条件，`has_attempts` 的含义收窄为「有在途 Attempt」），因此**本方案的 PR 1 同时是那条修订的落地方**。在它合入之前，「恢复重领 + 占不到会话」没有正确行为，不得先把 Engine 的 `acquire` 接上去。

### D2. 扩 `BrowserPort` 的命令面，不把 Page 交给 Engine

`engine.boundary.spec.ts` 禁止 Engine 引用 `playwright` 与 `../browser`。这条边界不放宽。`BrowserPort` 增加第三个方法：

```ts
export type BrowserPort = {
  /** 失败不抛异常，走返回值里的码（见本节末）。 */
  acquire(run: RunSnapshot, grant: RunGrant, signal?: AbortSignal): Promise<SessionAcquireOutcome>
  release(grant: SessionGrant, reason: string): Promise<void>
  /** Engine 传结构化命令与结构化结果，不传句柄。Playwright 不越过这条边界。 */
  execute(
    grant: SessionGrant,
    command: BrowserCommand,
    signal?: AbortSignal,
  ): Promise<BrowserCommandResult>
}
```

`BrowserCommand` 与 `BrowserCommandResult` 是 `@cairn/shared` 里的 Zod 契约（宪法 §4：跨模块的核心结构必须有 Runtime Schema），不是 TypeScript 接口。命令是「已解析完 context 引用」的形态——`from` 的解析仍在 Engine，Browser 侧不碰 Execution Context。

适配器在 `browser.module.ts` 里把 `execute` 接到新的 `BrowserSurface` + `TargetResolver`，并在**每条命令之前**调 `SessionGuard.assertHeld(grant.leaseId, grant)`（`session-manager.ts` 的 `assertCommand` 已经封好这一层，但今天零生产调用方）。本期它成为浏览器命令的唯一入口——D7 的失败截图也必须走它，否则刚立的规矩自己先破。

**`acquire` 的失败也要是可验证契约，不是抛出来的字符串。** 现网适配器把 `BrowserSessionManager.acquire` 的 `{ ok: false, code }` 包成 `Error & { code, waitingForAuth }` 抛出，而 `BrowserPort.acquire` 的签名是 `Promise<SessionGrant>`（`engine/ports.ts`）。D1b 的生死分流建立在「是哪个码」上，靠 `catch` 去读一个没有 Schema 的字段做这件事，既踩宪法 §18.17「关键跨边界契约必须可运行时验证」，也和本节刚给 `BrowserCommand` 立的 Zod 标准自相矛盾——同一个端口，命令面要 Zod，决定 Run 死活的那一面靠 `any`。本期把 `acquire` 也改成判别联合：

```ts
type SessionAcquireOutcome =
  | { ok: true; grant: SessionGrant }
  | { ok: false; code: SessionErrorCode; message: string; waitingForAuth?: boolean }
```

这就是 `BrowserSessionManager.acquire` 今天的返回形态原样上抬到端口，适配器不再把它转成异常。`code` 用 `sessionErrorCodeSchema` 校验。真正的异常（进程崩、DB 断）仍然抛，不混进这条枚举。

### D3. TargetDescriptor：语义候选加 FramePath，每次重解析

```text
TargetDescriptor
  framePath : FrameStep[]      // 空数组 = 主 frame，最多 4 层
  candidates: LocatorCandidate[]  // 有序，1..5 个
  anchor    : RelativeAnchor?     // 可选，行内锚点

FrameStep       { urlPattern? , name? , selector? }   // 至少一项；没有 index 字段
LocatorCandidate  by = role | label | text | title | testId | css
RelativeAnchor  { withinText: string, scope: 'row' | 'nearest' }
```

`FrameStep` 里**根本不设 `index` 字段**——把「不存下标」写进 schema，而不是写进注释靠人记。仅存下标的 FramePath 在微前端和动态重挂载下必然漂移，这是 S03 要回答的问题之一。

候选有序，`css` 只能作为最后一档。Resolver 按顺序试，命中恰好一个即停。每次执行重新解析，不缓存跨 Attempt 的句柄；Frame 重载、detach、popup 切换之后必须重建。

### D4. 四种结果，多匹配不猜

对每个候选统计匹配数：

| 匹配数 | 处理 |
| --- | --- |
| 1 | `FOUND`，停止后续候选 |
| 0 | 记下，试下一个候选 |
| >1 | 记下匹配数与候选，试下一个候选；**不取 `.first()`** |

全部候选试完：出现过 >1 → `AMBIGUOUS`；否则 → `NOT_FOUND`。Frame 在解析途中 detach、Page 已关闭、导航使上下文失效 → `SURFACE_LOST`。

错误码与 `executionErrorCategorySchema` 的映射：

| code | category | retryable | 说明 |
| --- | --- | --- | --- |
| `TARGET_NOT_FOUND` | `EXECUTOR` | true | 等待超时后仍无匹配 |
| `TARGET_AMBIGUOUS` | `EXECUTOR` | false | 重试不会让候选变清晰，必须改 Descriptor |
| `SURFACE_LOST` | `INFRASTRUCTURE` | true | Frame / Page 失效，重解析可能恢复 |
| `ASSERT_FAILED` | `EXECUTOR` | false | 业务断言不成立，不是基础设施问题 |
| `BROWSER_CAPABILITY_MISSING` | `EXECUTOR` | false | closed Shadow DOM、Canvas 目标等已知缺口 |
| `SESSION_LEASE_LOST` | 见 D5 | false | 已有码，由 guard 与提交栅栏产生 |

`retryable` 只是提示，是否真重试仍由执行策略与 `effectType` 决定（`runtime-error.ts` 21–24 已经写明这一点）。

失败证据必须带上：走到第几个候选、每个候选的匹配数、解析到的 FramePath 实际落点。只说「没找到」的诊断在真实系统上没有用。

### D5. 浏览器步骤的提交必须带会话租约

浏览器步骤的 `finishAttempt` 传 `sessionLease: { ...grant, holderWorkerId, effectType }`。丢租时按 P4 已写好的分流：`SIDE_EFFECT` → `NEEDS_REVIEW`（`UNKNOWN`），其余 → `FAILED`（`INFRASTRUCTURE`），一律不写 `SUCCEEDED`。

这条不是新逻辑，是**让已有逻辑第一次进生产路径**。验收必须包含负向用例：命令执行成功之后、提交之前撤销租约，断言 Attempt 没有写成 `SUCCEEDED`。

`acquire` 的双锁顺序（先 Run 后 Session）此前只有签名和注释。本期补真实并发集成测试，还掉 RunLease 债务 5。

### D6. effectType 不推断，真实系统只读

`effectType` 已经是 `stepCommon` 的必填字段。本期唯一要做的是**克制**：不给 `navigate` 默认 `READ_ONLY`，不给 `click` 默认 `SIDE_EFFECT`，不加任何按名字推断的便利函数。路线图第 7 章的工程禁止事项与宪法 §19 都点了这条。

L3 在真实目标系统上只跑 `READ_ONLY` 链路。误点与提交类实验放在 L2 的受控站点完成——真实业务系统没有可重置的数据，一次误提交换不回一条验收记录。

### D7. 失败截一张，成功不截，Trace 不做

截图完整策略属于 P6（RF14 / RF15）。但 P5 的核心产出恰恰是「定位失败要可诊断」，没有失败现场的截图，`TARGET_NOT_FOUND` 的证据只是一行文字。

本期最小口径：**Attempt 失败时截一张脱敏截图**，经已有的 `ObjectService.putObjectEvidence` 落对象存储与 `evidences` 指针行。成功 Attempt 不截，Trace 完全不做，保留期与授权下载留 P6。

截图失败不得让业务结果变成成功：按 `evidence.missingReason` 记原因（`evidence.ts` 28 已有该字段），不靠「没有 objectKey」让调用方猜。

注意边界：`ObjectService` 属 Worker 侧，`engine.boundary.spec.ts` 禁止 Engine 引用 `@cairn/storage`。截图由 `BrowserSurface` 在失败路径上产出，经 `BrowserCommandResult` 把对象指针交回 Engine，Engine 只写指针不碰字节。

### D8. 只开五个 Step，不铺 Playwright API

`navigate` / `click` / `fill` / `extract` / `assert`。Select、Keyboard、Wait、Screenshot 等到这五个在真实目标系统上跑稳再加。宪法 §5 明确警告「不得因为 Playwright API 很多就无限膨胀 Step Type」。

`wait` 不单独成 Step：等待是每个定位的内建行为（复用 Playwright Locator 的自动等待），不让用户在场景里手工插一串 sleep。这也是路线图 P10 说的「默认超时、失败截图是平台策略，不向用户场景里塞系统步骤」。

各步骤的输入契约与 `effectType` 约束：

| type | input 要点 | 输出 | effectType 约束 |
| --- | --- | --- | --- |
| `navigate` | `url`（须在 Target 授权范围内） | `{ url }` 落点真实 URL | 任意，但跨站导航拒绝 |
| `click` | `target: TargetDescriptor` | 无 | 不设默认，由作者声明 |
| `fill` | `target`、`value`（支持 context 引用） | 无 | 同上 |
| `extract` | `target`、`as: 'text' \| 'value' \| 'attribute'` | 结构化值，配合 `outputKey` 进 context | 应为 `READ_ONLY`，非只读时校验告警 |
| `assert` | `target?`、`expect` 条件（存在 / 可见 / 文本等于 / 文本包含 / 数值比较） | `{ passed, expected, actual }` | 应为 `READ_ONLY` |

`navigate` 的 URL 必须落在 Target 的授权范围内（同源或 Target 显式声明的域）。这是宪法 §19「不得让 Executor 私自创建无法纳管的正式 Browser Session」的延伸：一个能导航到任意站点的步骤，等于绕开了 Target 边界。

`assert` 失败是 `ASSERT_FAILED`（业务结论），不是异常。取不到值必须报错而不是判过——路线图 P13 明确要求「不把异常当断言通过」。

### D8b. `DEFAULT_EXECUTOR_VERSIONS` 只冻结该 Snapshot 用到的 executor

加五个 Step Type 就要往 `DEFAULT_EXECUTOR_VERSIONS` 加五个键，而现状有两处会让这件事出事：`createRun` 把**整份** default map 冻进每个 Snapshot（`packages/db/src/runs/runs.ts`），`executorVersionsMatch` 却硬编码只校验 `echo` / `delay` / `fail`（`packages/worker/src/engine/engine.ts`）。

两条显而易见的走法都是坑：

| 走法 | 结果 |
| --- | --- |
| 校验继续硬编码三项 | 五个新 Step 的 executor 版本形同虚设，冻结了个寂寞 |
| 校验改成遍历全部键 | 库里存量 Snapshot 只有 3 键，立刻 `failRunValidation` → Run 变 `FAILED` |

本期取第三条：**冻结与校验都只覆盖该 Snapshot 的步骤实际用到的 executor**。`createRun` 按 `steps[].type` 收敛出用到的键写进 Snapshot；`executorVersionsMatch` 遍历 Snapshot 自己声明的键，缺键或版本不等才算不匹配。

这不只是为了兼容存量数据。整份冻结的真正代价在后面：`click` 的 executor 版本升到 `'2'` 的那天，一堆只有 Echo 的老 Run 会跟着失效——它们从来没用过 `click`。宪法 §2 说 Run 冻结的是「影响执行解释的配置」，没用到的 executor 版本不影响任何解释。

### D9. 认证等待沿用 P4，不新造通道

浏览器步骤遇到未认证会话时，`acquire` 已经会返回 `waitingForAuth`。Engine 按 P3 已有的路径释放 RunLease 进 `WAITING_FOR_AUTH`，认证完成后重新领取并增代。本期不改这条链路，只是第一次真正走它。

已知限制照抄 P3 债务 6：`resume-auth` 是声明式的，操作者说已登录，平台不开浏览器核对。按错了会领到仍未登录的会话，然后浏览器步骤失败。本期不修，但 L3 要跑一次这个分支并记录表现。

### D10. 受控站点是产出物，不是假设

仓里今天只有 `tests/target-login-hmi/`——一个登录夹具，没有 iframe、没有 popup、没有小图标。RF13 要的五类现场一个都测不了。

按同一体例扩一个 `tests/target-surface-lab/`：静态页 + 一个小 Node 服务，覆盖两层嵌套 iframe、定时重挂载的 Frame、`window.open` popup、只有 `aria-label` / `title` 的小图标（含同一图标在多行重复出现，用来逼出 `AMBIGUOUS`）、open 与 closed Shadow DOM 各一处。

必须**可重置**且不依赖外网：L2 要连续跑 20 次，任何外部波动都会把回归伪装成 flaky（路线图第 6 章「不以真实业务页面波动掩盖代码回归」）。

这是 PR 2 的第一件事，不是收尾时补的测试夹具。先有站点，才谈得上 Resolver 的验收。

## 4. 契约变更

`@cairn/shared`（新增，均为 Zod）：

- `step.ts`：`EXECUTABLE_STEP_TYPES` 加五项；新增五个 step schema 进 `stepSchema` 判别联合。
- `policy.ts`：`DEFAULT_EXECUTOR_VERSIONS` 加五项，均为 `'1'`。按 D8b 改冻结与校验口径：`createRun` 只冻结该 Snapshot 用到的 executor，`executorVersionsMatch` 只校验 Snapshot 自己声明的键；存量 3 键 Snapshot 的兼容行为要有正反例。
- 新文件 `target-descriptor.ts`：`TargetDescriptor` / `FrameStep` / `LocatorCandidate` / `RelativeAnchor`。
- 新文件 `browser-command.ts`：`BrowserCommand` / `BrowserCommandResult` / 新错误码常量。

`packages/worker/src/browser`（新增）：`surface.ts`（Page / Frame / popup 上下文）、`resolver.ts`（候选解析与四种结果）、命令执行落在 `runtime.ts` 或与其并列的新文件——**唯一碰 playwright 的模块**这条注释继续成立。

`packages/worker/src/engine`：`ports.ts` 加 `execute`，并把 `acquire` 的返回改成 D2 的判别联合；`engine.ts` 加按需 `acquire` / `release`、按 `PLACEMENT_YIELD_CODES` / `SESSION_CONFIG_ERROR_CODES` 分流、失败出口走 `yieldPlacement`、浏览器步骤分发、`sessionLease` 提交。`engine.boundary.spec.ts` 不放宽。`browser.module.ts` 的适配器不再把失败码转成异常。

`packages/worker/src/runtime`：新增 `yieldPlacement`（`yieldClaimedRun(..., 'placement_yield')` + `rememberPlacementYield`），把 D3b 的第二道闸第一次接进生产路径。

`@cairn/db`：`recover.ts` 的 `placement_yield` 守卫按 D1c 收窄为「存在 `RUNNING` Attempt 才挡」；`runs.ts` 的 `createRun` 按 D8b 只冻结用到的 executor 版本。这两处是本方案唯一的库改动。

数据库：**无迁移**。Step 定义在 `scenario_versions.definition` 的 JSONB 里，证据用已有的 `evidences` 与 `stored_objects`。

## 5. 验收

### L1 库与 Worker

1. 纯 Echo Run 不建会话：RF04 继续绿，`browser_sessions` 为空。
2. 含浏览器步骤的 Run：`acquire` 恰好一次、`release` 恰好一次，且 `acquire` 发生在第一个 `startAttempt` 之前（第一个步骤是 Echo 时同样成立）。
3. `acquire` 返回 `SESSION_BUSY` / `SESSION_CAPACITY_EXCEEDED` / `SESSION_NOT_CLAIMABLE` / `PROFILE_LOCKED` / `BROWSER_UNAVAILABLE` → 走 `placement_yield` 回交，Run 回 `RECOVERING`、无 Attempt、恢复次数不变；连续三次不得进 `NEEDS_REVIEW`。`SESSION_TARGET_MISSING` / `SESSION_POLICY_INVALID` 反向：Run 真失败，不回交。
3.1. **恢复重领**（D1c）：Run 已有上一轮的终态 Attempt、无在途 Attempt，再次领取时 `acquire` 返回 `SESSION_BUSY` → 仍然回交 `RECOVERING`、租约 `RELEASED`、`countFailedRecoveries` 不变。把 `recover.ts` 的 `status = 'RUNNING'` 条件撤掉，本条必须失败。
3.2. **在途 Attempt 仍然挡**：存在 `RUNNING` Attempt 时 `placement_yield` 返回 `has_attempts`，不动 Run 状态、不放租约（与 Affinity L1 第 9 条同一口径，原样保持）。
3.3. **回交必带冷却**（D1b）：回交一次后，冷却窗口内本进程不得再领同一 Run（钉住窗口内 `run_leases` 只多一行）。把 `yieldPlacement` 换成直接调 `yieldClaimedRun`，本条必须失败。
3.4. **失败经返回值不经异常**（D2）：Engine 不 `catch` 也能拿到 `code` 并分流；两组码取自 `PLACEMENT_YIELD_CODES` / `SESSION_CONFIG_ERROR_CODES`，Engine 里不得出现第二份字面量清单。
4. Run 失败 / 取消 / 丢租三条路径都 `release`。
5. 双锁顺序：真实 PostgreSQL 上并发 `acquire`，用屏障控制顺序，不出现交叉死锁；失败时已占资源立即释放。（RunLease 债务 5）
6. 提交栅栏：命令成功后、提交前撤销会话租约 → `SIDE_EFFECT` 进 `NEEDS_REVIEW`、其余 `FAILED`，均不写 `SUCCEEDED`。
7. guard：租约撤销后的命令返回 `SESSION_LEASE_LOST`，不落到 Playwright。
8. Resolver 四种结果各有用例；`AMBIGUOUS` 的证据带出候选与匹配数。
9. `extract` 写入 context 并被后续步骤 `from` 读到；`assert` 失败落 `{ expected, actual }`。
10. `navigate` 越出 Target 授权范围被拒绝。
11. 失败截图：正常落对象；对象存储不可用时记 `missingReason`，Attempt 结论不被改写成成功。
11.1. executorVersions（D8b）：只含 Echo 的存量 3 键 Snapshot 继续可执行；含 `click` 的 Snapshot 把 `click` 版本改成不存在的值 → `FAILED`；只含 Echo 的 Snapshot 不因 `click` 版本变化而失效。

### L2 受控站点（RF13）

12. 普通 DOM、两层嵌套 iframe、动态重挂载 Frame、popup、小图标（role / title / 行内锚点）——各连续运行 20 次无误点。
13. 找不到、多匹配、Frame 失效分别返回对应结构化错误，并能定位到具体步骤后停止。
14. closed Shadow DOM 与 Canvas 目标返回 `BROWSER_CAPABILITY_MISSING`，不静默点别的东西。

### L3 真实目标系统

15. 至少一条含嵌套 iframe 与小图标的只读关键链路跑通，留 FramePath、候选与结果记录。
16. 跑一次 `WAITING_FOR_AUTH` → `resume-auth` → 继续执行，记录 D9 的已知限制表现。
17. 未支持区域写成 Target 适配限制清单，不并进「已兼容」。

L2 全部通过是硬条件。Engine × 真浏览器垂直切片（`packages/worker/src/browser/engine.lab.spec.ts`：Lifecycle → acquire → 登录 → navigate / click / extract → 提交栅栏 → release）进 CI，没有 Chromium 直接失败，不准 skip。

L3 外部系统是 [智慧运维管理平台（SNC DPM）](../targets/snc-dpm.md)，默认不进 CI（`CAIRN_L3_DPM=1` 才跑）。2026-09-12 已核：账密无验证码、总览 / 实例 / 主屏可进、壳上有 iconfont 小图标；**当时未见嵌套 iframe**，大屏是 Canvas。因此 L3 第 15 条只证明「登录 + 只读提取稳定壳文案」，iframe 关键链路仍以 L2 为准，不并进「已兼容」。

Popup 产品语义（P5）：点击可以打开 `window.open` 新窗并等它 load，**后续步骤仍留在原页**。本 DPM 实际用 `el-dialog` / `el-drawer`，不依赖这条切换。

L3 若暂时打不到该系统，可用受控环境走内部验收，但**不得宣称该企业系统已兼容**（路线图第 2 章 Gate 规则）。

## 6. 拆分与顺序

**硬前置**：Affinity 方案（P4 后半）必须先落地。本方案的 PR 1 是 `yieldPlacement` 的第一个生产调用方，顺序倒过来就只能自己发明一套 acquire 失败处理，然后再改回去。

之后建议三个 PR：

1. **契约 + 接线**：shared 的五个 Step 与两份新契约；`BrowserPort.execute`；Engine 按需 acquire / release、回交分流、提交栅栏；只实现 `navigate` 与 `click`，Resolver 先只支持 role / text / css 三档。交付 L1 的 1–7、10。
2. **受控站点 + Surface 与 Resolver**：先建 `tests/target-surface-lab/`（D10），再做 FramePath、popup、动态重挂载、全部候选档位、四种结果与诊断证据；补 `fill` / `extract` / `assert`。交付 L1 的 8–9、L2 全部。
3. **失败截图**：接 `ObjectService`，交付 L1 的 11。可与 2 并行。

L3 在 2 完成后开始，结论回写本文件与 Target 适配限制清单。

## 7. 刻意留给后续

| 阶段 | 本方案结束后仍缺的 |
| --- | --- |
| P6 其余 | 成功截图策略、Trace 分 chunk、保留期、授权下载、脱敏遮罩策略 |
| P7 | `run_events`、NOTIFY、SSE；步骤时间线与证据查看器 |
| P8 / P9 | AI Action / Extract / Assert；Model Gateway；视觉定位兜底 |
| P10 / P11 | Compiler 的定位诊断、Sequence Editor、可视化选点 |
| P12 | Recorder 产出 TargetDescriptor |

## 8. 债务

1. 候选顺序目前由作者手写。没有 Analyzer 检查「只给了一个 css 候选」这类弱定位，P10 的 Analyzer 才做。
2. `RelativeAnchor` 只支持 `row` / `nearest` 两种作用域，够小图标场景用，不够复杂表格。扩之前要有真实样本，不凭想象加档位。
3. 失败截图没有敏感区域遮罩。本期只做整页脱敏（隐藏已知凭据输入框），未知敏感区域的策略属 P6。
4. `navigate` 的授权范围校验按 Target 的 `entryUrl` 同源加显式域名单。跨域跳转登录（SSO）会被挡，需要在 Target 上显式声明；这是保守选择，不是最终形态。
5. Resolver 每次全量重解析，没有任何缓存。真实页面上的开销未测；若 L2 的 20 次连续运行显示定位耗时占比过高，再考虑单个 Attempt 内的短期缓存，不跨 Attempt。
6. P3 债务 4 仍在：RF06 的多进程与 RF07 的 kill / 暂停 / DB 断连故障注入没有做。浏览器进来之后这些测试只会更难写。本方案不承担，但建议与 PR 2 并行启动，不要拖到 P6 之后。
7. 含浏览器步骤的 Run 在前置 Echo / Delay 期间空占一个浏览器（D1 的代价）。D1c 的 D4 判据修订顺带解掉了它的**硬阻塞**——改判「无在途 Attempt」之后，前置 Echo 跑完再 `acquire` 失败也能干净回交。但本期仍然保持 D1 的「先 acquire 再执行」：改成惰性获取会让「跑了一半又回队列」成为常态现场，值不值得要看 L2 的实际会话占用，不在本期凭想象换。Affinity 债务 2「P5 不得把『先执行再 acquire』当成优化」对本期继续有效。
8. 承接 Affinity 方案债务 4：`resume-auth` 仍不打开浏览器核对。本期第一次真跑这条链路，L3 第 16 条只负责记录表现，不负责修。

## 9. 更新历史

- 2026-09-11：初稿。以 P4 空转（Engine 从不调用 `BrowserPort`）、`EXECUTABLE_STEP_TYPES` 仍只有三个夹具类型、RunLease 债务 5 为事实源。评审前修正一处：D1 原写「第一个浏览器步骤之前 acquire」，与 Affinity 方案 D4 / 债务 2 直接冲突，改为「第一个 StepRun 之前」。
- 2026-09-11：跟随 Affinity 方案的评审修订同步两处。「第一个 StepRun 之前」仍然不成立——`step_runs` 在 `createRun` 时就整批写入，Worker 侧没有这个时机，判据改为「第一个 `startAttempt` 之前」；D1b 的分流表按 Affinity D5 更新：`BROWSER_UNAVAILABLE` / `BROWSER_LAUNCH_FAILED` 改判回交，真失败只剩三个配置错误码。
- 2026-09-12：评审后修订四处，都带负向验证（把修补撤掉，对应用例必须失败）。
  - **新增 D1c**：恢复重领的 Run 身上有终态 Attempt，`yieldClaimedRun` 的守卫会把 D1b 的回交整条挡掉，Run 卡在 `RUNNING` 直到租约 `EXPIRED` 并计进 `countFailedRecoveries`，三轮后 `NEEDS_REVIEW`——与 D1b 的承诺正好相反。修订 [Affinity D4](2026-09-11-session-affinity.md) 的判据为「不存在 `RUNNING` Attempt」，与该方案 L1 第 9 条本来的措辞一致；代码改动随本方案 PR 1 落地。债务 7 同步改写。
  - **D1b 收紧 `yieldPlacement`**：把冷却写成该出口的组成部分而非「可以不加」——自禁只覆盖 `BROWSER_UNAVAILABLE` / `BROWSER_LAUNCH_FAILED` 两个码，其余四个没有；`rememberPlacementYield` 至今全仓零生产调用方，D3b 的第二道闸在生产路径上是空的。两组错误码改为直接取 `PLACEMENT_YIELD_CODES` / `SESSION_CONFIG_ERROR_CODES`，不在 Engine 里抄第二份。
  - **D2 补 `acquire` 契约**：现网适配器把失败码包成 `Error & { code }` 抛出，Engine 的生死分流靠读一个无 Schema 的字段，与本节给 `BrowserCommand` 立的 Zod 标准自相矛盾（宪法 §18.17）。改为判别联合上抬到端口，适配器不再转异常。
  - **新增 D8b**：`DEFAULT_EXECUTOR_VERSIONS` 扩到 8 键时，继续硬编码三项等于版本形同虚设，改成遍历全部键会让存量 3 键 Snapshot 全部 `FAILED`。改为冻结与校验都只覆盖该 Snapshot 用到的 executor。
