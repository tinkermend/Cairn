# 识途 P4 后半：Affinity、容量等待与失联隔离

日期：2026-09-11。状态：**已落地**。  
对应路线图 P4 剩余（Browser Runtime 与 Session 所有权的后半截），以及 RF10 / RF11 / RF12、F14、S02、A04。  
前置：BrowserSession 第一截（已落地）、RunLease / Fencing（已落地）。  
范围：有健康会话的 Run 必须回到 owner；容量不足就等，不在别的 Worker 上开第二份；owner 失联时先隔离账号键，未确认旧浏览器已停不得重建。  
不是页面定位（P5）、不是 Engine 消费 `BrowserPort` / 新 Step Type（P5）、不是截图 Trace（P6）、不是 SSE 与会话菜单（P7）。

## 1. 为什么现在写

P4 被拆成两截。第一截把会话、租约、认证占用、`LOST` 和人工处置做成了库事实。P3 补上了 Worker 心跳、RunLease 和「失联 Worker 名下会话标 `LOST`」。

领取还是「任何 `READY` Worker 谁先抢到谁执行」。后果已经写在两份落地方案的待办里，不是新发现：

- 账号 A 的健康会话在 Worker-1 上，Worker-2 仍能领走绑定该账号的 Run。P5 一旦 `acquire`，要么 `SESSION_BUSY` 把 Run 标失败，要么再开一份登录——两条都踩宪法 §19。
- `CAIRN_BROWSER_MAX_SESSIONS` 满了直接 `SESSION_CAPACITY_EXCEEDED`。路线图 RF11 的口径是「无容量则等待」，不是失败。
- `LOST` 已经占住唯一索引，但 `claimRun` 不看它。别的 Worker 领到 Run 之后仍会去 `createSession`，再被唯一索引弹回。`PROFILE_LOCKED` 时第一截还会把刚插入的行标 `CLOSED`（`launch_failed`）——键被放开，旧 Chromium 可能还占着同一 `userDataDir`。这是双开的缝。
- `WAITING_FOR_AUTH` 已经释放 RunLease（P3）。`resume-auth` 之后任何 Worker 都能领，浏览器句柄却只在原 owner 进程里。
- `claimRun` 不在事务里数本 Worker 的 `ACTIVE` 租约。Lifecycle 用 `inFlight.size` 挡一层，两个空闲 Worker 并发时仍可能超员。owner 满员时「等待」因此不是库不变量。

P5 可以并行写 Surface / Resolver 方案，但不能假装本截已经过了。本方案把 F14 冻成可审查的领取规则。正式 Run 仍然没有浏览器 Step；本方案不靠新 Step 证明所有权，靠 `claimRun`、`acquire` 夹具和回交。

## 2. 目标与非目标

### 目标

1. 冻结领取时的 Affinity：`(target_id, target_account_id)` 上存在活会话时，只有该会话的 `owner_worker_id` 能领这份 Run；其他 Worker 跳过，Run 留在 `QUEUED` / `RECOVERING`。
2. 活会话处于 `CREATING` / `CLOSING` / `LOST` 时，任何 Worker 都不领绑定该账号的 Run。未确认前等待，不换人开第二份。
3. 无活会话时保持今天的行为：任何 `READY` Worker 可领。同账号两份 Run 被两个 Worker 同时领到，允许发生在领取层；随后 `createSession` 仍由部分唯一索引保证只有一份活会话，失败者必须回交，不得把 Run 标失败。
4. 容量检查进 `claimRun` 事务：锁 Worker 行后，该 Worker **未过期**的 `ACTIVE` RunLease 数已达 `workers.capacity` 则返回 `null`。超员是正常空闲，不是错误码。
5. 会话容量与「占不到会话」不得结束 Run。`SESSION_BUSY` / `SESSION_CAPACITY_EXCEEDED` / `SESSION_NOT_CLAIMABLE` / `PROFILE_LOCKED` / `BROWSER_UNAVAILABLE` / `BROWSER_LAUNCH_FAILED` 一律回交 `RECOVERING`，释放 RunLease，不计恢复次数。只有永久性配置错误才失败，且每种必须有自己的码（D5）。
6. 回交不得变成空转：会话位满先腾掉本进程空闲且无租约的会话，腾不出才回交，回交后本进程对该 Run 退避一段再领。默认单 Worker 部署下「让有空位的同伴领」没有同伴，1 s 一轮的领取—回交必须被挡住（D3b）。
7. `PROFILE_LOCKED` 视为「旧浏览器可能仍在」，不得再走 `close_reason = launch_failed` 放键。
8. `LOST → CLOSED` 只走确认路径：人工处置（已有）、owner 本进程停掉句柄并确认退出、owner 失联自愈后确认本进程句柄已停。新进程重启不得自动关掉别人标的 `LOST`。
9. `resume-auth` 之后的领取仍走 Affinity，回到持有认证占用的 owner。
10. GET 运行详情给出派生的 `placement`，控制台能看见「为什么还在排队」。不存第二份事实，不加会话菜单。
11. S02 交出可复跑证据包：受控夹具必须通过；真实系统有则记限制，没有不得宣称该系统已兼容。

### 非目标

- 不做活会话跨 Worker 迁移，不做浏览器集群，不做网络 zone / 评分 Placement（`docs/arch/03` §13 的完整 Placement 留到容量成为真实问题再做）。
- 不注册 Navigate / Click / AI 等 Step Type；Engine 正式路径仍不调用 `BrowserPort`。P5 第一次接线必须使用本方案的回交契约。
- 不改 Session 键、三列状态机、租约四操作、认证占用的语义。
- 不做 `NEW_CONTEXT`，不自动解验证码 / MFA。
- 不扩 `RUN_EVENT_TYPES`，不发 NOTIFY / SSE，不加会话菜单或处置页（处置 API 已有）。
- 不补 P3 债务里的真进程 kill / SIGSTOP / DB 断连注入。

## 3. 决策

### D1. Affinity 在领取时判定，不在执行时退单

「有健康会话的 Run 必须回到 owner」是领取谓词，不是 Executor 里的 if。

执行时再发现 `SESSION_BUSY` 再失败，会把一份本该排队的 Run 做成业务失败，而且已经占过执行槽。P5 的 `acquire` 只处理领取之后的竞态（两份无会话 Run 同时被领走、会话在领取后被标 `LOST`），正常路径必须在 `claimRun` 里就被 Affinity 挡住。

判定键与会话键相同：`runs.target_id + runs.target_account_id`。没有 `target_account_id` 的 Run 不参与 Affinity（纯 Echo 夹具、未绑账号），任何 `READY` Worker 可领——RF04 不得退化。

有账号、且该键上存在活会话（`CREATING` / `OPEN` / `CLOSING` / `LOST`）时，即使这份 Run 的步骤全是 Echo，也走 Affinity。账号键是隔离单位；同一账号在已有活会话时不应被第二个 Worker 当成「随便谁都能跑」。

### D2. 领取谓词（唯一实现，写进 `claimRun`）

同一事务、同一条 SQL。先锁本 Worker 行（已有：`READY` + `instance_id`），再数容量，再挑 Run：

```text
本 Worker 可领 run r 当且仅当：

1. r.status ∈ {QUEUED, RECOVERING}，cancel_requested_at IS NULL
2. RECOVERING 时无 ACTIVE run_lease
3. 本 Worker **未过期**的 ACTIVE run_lease 数 < workers.capacity
4. 放置：
   - r.target_account_id IS NULL                        → 可领
   - 该 (target_id, target_account_id) 无活会话        → 可领
   - 活会话 status = OPEN 且 owner_worker_id = 本 Worker → 可领
   - 其余（他人 OPEN / CREATING / CLOSING / LOST）      → 不可领
```

```sql
-- 伪代码：claimOneStatus 替换现有「只按 created_at 取一条」
-- Worker 行已 FOR UPDATE；capacity 用行内值，不信进程内存。

SELECT count(*) FROM run_leases
 WHERE holder_worker_id = $worker
   AND status = 'ACTIVE'
   AND expires_at > now();
-- >= capacity → 整次 claimRun 返回 null（本进程本轮不领）

UPDATE runs
   SET status = 'RUNNING',
       started_at = COALESCE(started_at, now()),
       updated_at = now()
 WHERE id = (
   SELECT r.id
     FROM runs r
     LEFT JOIN browser_sessions s
       ON s.target_id = r.target_id
      AND s.target_account_id = r.target_account_id
      AND s.status IN ('CREATING', 'OPEN', 'CLOSING', 'LOST')
    WHERE r.status = $1                  -- 先 RECOVERING 再 QUEUED，顺序不变
      AND r.cancel_requested_at IS NULL
      AND /* RECOVERING 时无 ACTIVE 租约，与现网相同 */
      AND (
        r.target_account_id IS NULL
        OR s.id IS NULL
        OR (s.status = 'OPEN' AND s.owner_worker_id = $worker)
      )
    ORDER BY r.created_at, r.id
    LIMIT 1
    FOR UPDATE OF r SKIP LOCKED
 )
 RETURNING id;
```

容量只数**未过期**的 `ACTIVE` 租约。已过期但还没被 `expireStaleRunLeases` 收掉的租约不占槽位：它的持有者早就不在续租了，把它算进容量等于让一条死票长期吃掉一个执行槽——再配合 Affinity，同账号的 Run 也换不了人，最终是无人可领、无人报错的排队。回收仍归 reaper，领取谓词只是不被它的延迟绑架。

不锁会话行。领取与会话状态的竞态由 D5 回交兜住。活会话每键至多一行（`browser_sessions_key_live_idx`），JOIN 不会放大。

被 Affinity 挡住的 Run **不会进入** `FOR UPDATE` 候选，因此不会挡住同队列里「无会话 / 无账号」的后来者。Worker-2 满手都是别人的会话绑定时，本轮 `null`，下个 tick 再看。

### D3. 容量不足是等待，不是失败

两件容量，两处处理，都不产生「容量」错误码（P3 已否决 `WORKER_CAPACITY_EXCEEDED`；本套沿用）：

| 容量 | 事实 | 满了怎么办 |
| --- | --- | --- |
| 执行槽 | `workers.capacity` vs 该 Worker **未过期**的 `ACTIVE` RunLease | `claimRun` 返回 `null`。owner 满员时别人因 D2 也领不走同账号 Run → 排队 |
| 会话数 | `CAIRN_BROWSER_MAX_SESSIONS`（登记进 `workers.max_sessions`） | 领取不看它。`acquire` 先按 D3b 腾位，腾不出才回交，不把 Run 标 `FAILED` |

`workers.max_sessions` 只用于观察面和登记，不参与领取谓词。会话还没建出来时，任何有执行槽的 Worker 都可以领；建不出来先腾位，腾不出再回交。多 Worker 时让有空位的同伴领，单 Worker 时靠 D3b 的腾位与退避收敛，不靠同伴。全部 Worker 都满时，Run 留在 `QUEUED` / `RECOVERING`，这就是 RF11 的「无容量则等待」。

第一截把 `SESSION_CAPACITY_EXCEEDED` 当成 `acquire` 的失败码，调用方若直接 `FAILED` 就违反本决策。本方案改调用契约：该码是回交信号。枚举保留，语义从「Run 失败原因」改成「这次占不到会话」。

### D3b. 会话位满先腾位，回交必须退避

D3 的「让有空位的同伴领」在默认部署下没有同伴：`CAIRN_WORKER_CAPACITY` 默认 1、`CAIRN_BROWSER_MAX_SESSIONS` 默认 2、会话 idle TTL 默认 600 s。一台 Worker 上账号 A、B 的会话空闲占着两个会话位时，账号 C 的 Run 会被反复「领取 → `SESSION_CAPACITY_EXCEEDED` → 回交 → 1 s 后再领」，直到 600 s 后 idle 回收：每轮写一次 Run 状态、插一行 `run_leases`、`fencing_token` 往上爬，而 `countFailedRecoveries` 按 D4 恒为 0，没有任何东西会让它停。这不是边角情况，是 MVP 默认形态下的常态。

两道闸，缺一条这个循环就还在：

1. **腾位优先。** `acquire` 发现本进程会话位已满时，先找本进程名下、`OPEN`、无 `ACTIVE` SessionLease、`last_used_at` 最旧的一份会话，按 D6 的确认路径 `close()` 掉（等价于把 idle 回收对这一份提前触发），腾出位子再建新会话。会话是缓存不是资产；被腾掉的账号下次用到时重新登录，这笔成本记在债务里。`capacity < max_sessions` 时至少有一份会话不在 `ACTIVE` 租约里，默认配置（1 / 2）满足，这道闸就消掉了上面的循环。不把这个关系写成 env 约束：不满足时（或那一份正持有认证占用）还有第二道闸兜底，多一条硬校验只会在部署时添堵。
2. **回交退避。** 腾不出（会话位全部在 `ACTIVE` 租约里）才回交。Worker 生产入口是 `yieldPlacement`：库回交成功（`yielded`）后本进程对该 runId 记一个冷却窗口（模块常量 `PLACEMENT_YIELD_BACKOFF_MS`，不新开 env），冷却内 `pump` 跳过它。`has_attempts` / `unknown` 不记冷却。这是进程内节流，不是事实源（宪法 §11）：进程重启即失效，别的 Worker 不受影响，最坏结果只是回到未退避的频率，不会把 Run 卡住。不得只调 `yieldClaimedRun(..., 'placement_yield')` 而把冷却留给调用方自觉。

腾位不引入新的关闭语义：走的仍是 `close()` → `stopSession` → 确认停掉才 `CLOSED`，停不干净照样 `LOST`（D6）。不得为了腾位放宽 D6，也不得腾掉带 `ACTIVE` 租约或持有认证占用（`auth_hold_worker_id` 非空）的会话——后者正等着人工登录，腾掉就把 `WAITING_FOR_AUTH` 的现场也一起丢了。

### D4. 回交不是恢复失败

把 `yieldUnfinishedRun` 扩成带原因：

```ts
yieldClaimedRun(db, grant, reason: 'worker_shutdown' | 'placement_yield'): Promise<void>
```

停机继续传 `worker_shutdown`。占不到会话传 `placement_yield`。两者都：

- 先锁 Run 行，再验 RunLease；
- Run 回到 `RECOVERING`（已是 `WAITING_FOR_AUTH` / 停机终态则不动状态）；
- RunLease → `RELEASED`；
- **不计** `countFailedRecoveries`（只数 `EXPIRED` / `REVOKED`，现网已如此，测试必须钉住 `placement_yield` 不进计数）。

`placement_yield` 只允许发生在**本轮执行尚未开始**时，判据是该 Run 名下不存在 `RUNNING` 状态的 Attempt。有在途 Attempt 再回交，会把「结果未知」和「没占到座位」混在一起；那种现场走现有恢复 / `NEEDS_REVIEW`，不走本条。

**判据从「一行 Attempt 都没有」改成「没有在途 Attempt」（2026-09-12 修订）。** 初稿写成「`startAttempt` 还没写过任何一行」，那只对**首次领取**成立。被恢复重领的 Run 身上已经有上一轮的终态 Attempt，`acquire` 一旦占不到会话，回交就被守卫挡掉——`yieldClaimedRun` 返回 `has_attempts`，既不设 `RECOVERING` 也不放租约，Run 卡在 `RUNNING` 直到租约过期；而过期写 `EXPIRED`，`countFailedRecoveries` 只数 `EXPIRED` / `REVOKED`，三轮之后 `NEEDS_REVIEW`。本决策承诺的「不计恢复次数、不标失败」在恢复路径上正好反过来。§7 L1 第 9 条的措辞（「已有 `RUNNING` Attempt 时不得……」）其实一直写的就是修订后的口径——脱节的是本节正文与实现，不是验收。

改判 `RUNNING` 成立，理由是危险的从来不是「执行过」，而是**在途 Attempt 结果未知**。已终态的 Attempt 是写在 `attempts` 表里的事实，回交不会把它和「没占到座位」混淆——现场自己说得清。而 `reconcileOrphanAttempts` 在 Engine 进入步骤循环之前已经把在途 Attempt 收干净（`SIDE_EFFECT` → `NEEDS_REVIEW` 并放租约，其余 → `CANCELLED`），所以「无 `RUNNING` Attempt」恰好等价于「本轮还没执行过」，且库侧自己可判定，不需要 Engine 传「这是第几轮」。首次领取时 Attempt 数为 0，谓词同样成立。

对应代码改动只有一处：`packages/db/src/runs/recover.ts` 的 Attempt 计数加 `status = 'RUNNING'` 条件，`has_attempts` 的含义随之收窄为「有在途 Attempt」。现有用例原样通过——`session-affinity.test.ts` 用 `startAttempt` 造的正是 `RUNNING` Attempt。改动随 [Browser Surface 方案](2026-09-11-browser-surface.md) 的 PR 1 落地；在它合入之前，恢复重领 + 占不到会话的组合没有正确行为。

判据只能落在 Attempt 上，不能写成「创建 StepRun 之前」：`step_runs` 在 `createRun` 里随 Run 一起整批插入（`packages/db/src/runs/runs.ts`），Run 被领取时它们已经存在，Worker 侧根本不存在「创建 StepRun」这个时机。P5 的接线顺序因此是：先 `acquire`，成功再 `startAttempt`——哪怕第一个步骤是 Echo。代价是含浏览器步骤的 Run 在前置 Echo / Delay 期间空占一份会话，这笔账记在 P5 方案里，不在本截换口径。

`yieldClaimedRun` 仍是库原语（停机走 `yieldUnfinishedRun`）。占不到会话的生产入口是 Worker 的 `yieldPlacement`：回交成功才记冷却。本期正式 Engine 仍不 `acquire`，夹具与 P5 第一次接线必须走 `yieldPlacement`，避免只回交、不退避。

### D5. `acquire` 哪些码回交、哪些码失败

| 码 | 含义 | 处置 |
| --- | --- | --- |
| `SESSION_BUSY` | 同键已被别人占住，或刚输给唯一索引 | 回交 |
| `SESSION_CAPACITY_EXCEEDED` | 本进程会话位已满且按 D3b 腾不出 | 回交 |
| `SESSION_NOT_CLAIMABLE` | 会话 `LOST` / 非 OPEN / 本进程无句柄 / 非 owner——**本期只剩这一种暂态含义** | 回交 |
| `PROFILE_LOCKED` | `userDataDir` 被另一份 Chromium 锁住 | 回交；**不得**把本进程插入的行标 `CLOSED` |
| `BROWSER_UNAVAILABLE` / `BROWSER_LAUNCH_FAILED` | 本机浏览器没装或拉不起来 | 回交 + 本进程自禁重试 |
| `SESSION_ACCOUNT_REQUIRED` | Run 没绑账号却要会话 | 真正失败（配置错误） |
| `SESSION_TARGET_MISSING`（新） | Target 行不存在，拿不到入口与登录信息 | 真正失败（配置错误） |
| `SESSION_POLICY_INVALID`（新） | 会话策略非法（`maxLifetimeSeconds <= idleTtlSeconds`） | 真正失败（配置错误） |
| `SESSION_AUTH_UNSUPPORTED` / `SESSION_AUTH_TIMEOUT` | 既有认证路径 | 不改 |

**按码分流的前提是一码一义，现网不满足。** `SESSION_NOT_CLAIMABLE` 今天同时表示暂态（本进程无句柄、置 `OPEN` 失败）和永久配置错误（`ensureAuth` 取不到 Target 行）；`createSession` 的 TTL 校验更糟——它抛的是 `SessionDomainError('SESSION_NOT_CLAIMABLE')`，而 `acquire` 的 catch 只认 `SESSION_BUSY`，其余原样 rethrow，这个码根本到不了本表。不拆就等于把「配置写错的 Run」判成永久排队。本期：两种永久错误各拆一个码，`createSession` 改成返回 `SESSION_POLICY_INVALID` 而不是抛异常，`SESSION_NOT_CLAIMABLE` 只保留暂态含义。回交与失败的边界从此由码本身承担，不靠调用方记住是哪一行代码返回的。

**`BROWSER_UNAVAILABLE` 从「真正失败」改判回交。** 初稿的理由（换一台也不会好）与代码分类正好相反：`packages/worker/src/browser/runtime.ts` 把 `Executable doesn't exist` / `Failed to launch` 归到这个码，那恰恰是**本机**缺浏览器，换一台正会好。按初稿直接 `FAILED`，一台漏装 Playwright 的 Worker 会不停领取并把整条队列烧成业务失败，Affinity 还挡不住它——会话根本没建出来，键上是空的。这是本截唯一会造成批量误失败的分支。

**自禁，避免把误失败换成 1 Hz 重试。** 回交的同时 `BrowserSessionManager` 置「本机浏览器不可用」标志并打一条 error 日志；置位后 `acquire` 遇到需要新建会话时直接回交，不再尝试 launch（已有句柄的会话不受影响，仍可复用）。标志每轮 reaper 清一次，允许下一轮重试：装好浏览器不必重启进程，重试频率被节流到 reaper 周期，而不是 tick 周期。

代价写在明处：全集群都没浏览器时，Run 是永久排队而不是失败，而 `placement` 只会显示 `claimable`（键上确实没有活会话），页面说不出「没有一台机器能开浏览器」。见债务 5。

`PROFILE_LOCKED` 是失联隔离的牙齿：旧进程可能还活着。第一截 `launchAndOpen` 在任何启动失败时 `CLOSED` + `launch_failed`，等于放键。本期改成：

```text
PROFILE_LOCKED → 该行 status = LOST，close_reason = profile_locked
其它 launch 失败 → 仍可 CLOSED + launch_failed（确定没拉起进程）
```

`LOST` 继续留在部分唯一索引里。下一次领取按 D2 全员跳过，直到某条确认路径放键。

### D6. `LOST → CLOSED` 只走确认路径

三条，都要能指出「谁确认旧浏览器不在了」：

| 路径 | 谁 | 条件 | `close_reason` |
| --- | --- | --- | --- |
| 人工处置 | 控制面 `POST /browser-sessions/:id/dispose` | 已有；`OPEN` 仍拒绝 | `operator_disposed` |
| owner 主动停干净 | 持有句柄的 owner 进程 `stopSession === 'stopped'` | 现有 `close()` 已走这条 | 调用方传入的 reason |
| owner 失联自愈 | 同一进程 `healIdentity` 之后 | 必须先停掉 `lives` 里所有句柄；停得干净才关 `LOST` | `owner_confirmed_stopped` |

**新进程重启不得关 `LOST`。** `closeWorkerSessions` 继续只收 `CREATING` / `OPEN` / `CLOSING`。新进程没有句柄，不能证明旧 Chromium 已死；暂停的旧进程被标 `LOST` 后，同 ID 新进程若放键再 `launch`，就是双开。OS 层的 `userDataDir` 锁是第二道防线，不是放行理由。

`healIdentity` 今天只停 Run、不碰浏览器句柄。本期补：`fenceSelf` 之后、重新 `register` 之前，对 `lives` 全部 `stopSession`；能确认退出的本进程 `LOST`/`OPEN`/`CLOSING` 标 `CLOSED`；确认不了的标 `LOST` 并留下键。然后才允许重新领取。

同伴的 `markLostWorkers` → `markSessionsLostForWorkers` 不改：只标 `LOST`，不关浏览器（控制面没有句柄）。

### D7. 认证等待不占执行槽；恢复领取仍走 Affinity

P3 已做：`WAITING_FOR_AUTH` 释放 RunLease，认证占用保住会话。本方案不重做一遍。

`resume-auth` 把 Run 放回 `RECOVERING`。此时活会话仍 `OPEN` 且 `owner` / `auth_hold_worker_id` 是原 Worker，D2 会把它领回原 owner。若原 Worker 已 `LOST`，会话也是 `LOST`，全员不领，直到处置——不得让另一台「确认已登录」后去开新浏览器。

控制面 `resume-auth` 仍然是声明式的（P3 债务 6）。本期不增加可达的人工登录通道（headful / 远程可视化 / 扩展桥）。

### D8. Placement 是 GET 派生，不落库

不给 `runs` 加 `hold_reason`。谁跳过、何时跳过是领取时的观察，写回去会变成第二事实源，和活会话状态抢真相。

`GET /runs/:id`（及列表需要时同一函数）按当前库行计算：

```ts
export const RUN_PLACEMENT_STATES = [
  'not_applicable',    // 无账号，或 Run 已停机 / 已在跑且无需解释
  'claimed',           // 有 ACTIVE RunLease
  'claimable',         // 无活会话，任何 READY Worker 可领
  'owner_required',    // 活会话 OPEN，等 owner
  'owner_at_capacity', // owner 的 ACTIVE RunLease >= capacity
  'session_not_ready', // CREATING / CLOSING
  'session_lost',      // LOST，须处置
] as const

export const runPlacementSchema = z.strictObject({
  state: z.enum(RUN_PLACEMENT_STATES),
  sessionId: entityIdSchema.nullable(),
  ownerWorkerId: z.string().min(1).max(128).nullable(),
  sessionStatus: sessionStatusSchema.nullable(),
})
```

计算规则：

1. 终态 / `NEEDS_REVIEW` / `WAITING_FOR_AUTH` / 无 `targetAccountId` → `not_applicable`（等待认证本身已有状态色与按钮）。
2. 有 `ACTIVE` RunLease → `claimed`。
3. 无活会话 → `claimable`。
4. 活会话 `LOST` → `session_lost`。
5. 活会话 `CREATING` / `CLOSING` → `session_not_ready`。
6. 活会话 `OPEN` 且 owner 的 `ACTIVE` 租约数 ≥ `capacity` → `owner_at_capacity`。
7. 活会话 `OPEN` → `owner_required`。

详情页：`session_lost` 橙色说明「会话失联，处置并确认旧浏览器停止后才会继续」；`owner_required` / `owner_at_capacity` / `session_not_ready` 灰色说明等待。不给处置按钮（P7），展示 `sessionId` 与 `ownerWorkerId` 即可。手动刷新 GET，不加定时器。

### D9. 不新增 Run 状态，不新增 Step Type

`QUEUED` / `RECOVERING` 已经表达「无人持有、可再领」。再加 `WAITING_FOR_CAPACITY` 只会和 Affinity、失联抢词，观察面用 `placement` 区分即可。

Engine 正式路径不 `acquire`，RF04 继续：无浏览器步骤的 Run 零 `browser_sessions` 行（没有账号，或有账号但没有任何 Worker 去 `acquire`）。本方案的浏览器测试走 `BrowserSessionManager.acquire` 夹具，不注册新 Step。

### D10. S02 是证据包，不是平台承诺

路线图：同账号连续两个 Run 登录一次；`NEW_PAGE` 与 `REUSE_PAGE`；补测过期 / MFA / 崩溃。不可复用就写 Target 限制，不扩大成平台承诺。

本期最低交付：

1. 受控夹具（`tests/target-login-hmi` 或与之同级的会话夹具）可复跑：连续两次 `acquire` 自动登录一次；另一账号 Cookie 不串；`NEW_PAGE` 关 Run 页、`REUSE_PAGE` 沿用基准页；杀掉浏览器后按 D6 隔离。
2. 采用 / 限制采用 / 拒绝写回本文落地结论，不另开与方案平级的实验记录。可重跑证据在测试里。
3. 真实企业系统：有就记一页限制；没有则内部 Foundation 可过，**不得**在文档或 UI 写该系统已兼容。

storageState 仍然不等于活会话备份。S02 若观察到 sessionStorage / SPA 内存导致 `NEW_PAGE` 不等价于原页，记进限制，不改 D8 三档枚举。

### D11. 三层验收一起交付

| 层 | 必须证明 |
| --- | --- |
| L1 | 领取谓词、容量事务（含过期租约不占槽）、腾位与回交退避、回交不计恢复、失败码分流、`PROFILE_LOCKED` 不放键、重启不关 `LOST`、自愈先停浏览器 |
| L2 | `runDetail.placement` 与库一致；信封不出现新的容量失败码 |
| L3 | 详情页能看出失联 / 等待 owner；手动刷新；没有定时器、没有会话菜单 |

缺一层不得标 P4 Gate。页面证明不了两个 Worker 抢同一账号。

## 4. 形状

### `@cairn/shared`

`session.ts` / `run-api.ts` 增 `RUN_PLACEMENT_STATES`、`runPlacementSchema`；`runDetailSchema` 增 `placement`。列表可不带（避免每次 JOIN 会话），详情必带。

`SESSION_ERROR_CODES` 新增 `SESSION_TARGET_MISSING`、`SESSION_POLICY_INVALID`（D5 拆码），`SESSION_CAPACITY_EXCEEDED` 保留、语义按 D3 改成回交信号。不新增 HTTP 错误码，信封不变。

`AUDIT_ACTIONS` 不新增。处置与 `resume-auth` 沿用现有。

`registerWorker` 入参加 `maxSessions`，来自 `CAIRN_BROWSER_MAX_SESSIONS`。不新开 env。

### 表（`0012_session_affinity.sql`）

```text
workers
  max_sessions INT NOT NULL DEFAULT 2
```

| 名称 | 定义 |
| --- | --- |
| `workers_max_sessions_check` | `max_sessions >= 1` |

`registerWorker` / 心跳后的登记写这个列，与 `capacity` 一起更新。已有行靠 DEFAULT 升级。parity 与 `skipped` 含 `0012_session_affinity.sql`。

不改 `browser_sessions` / `session_leases` / `runs` 的约束。领取谓词是查询，不是新 CHECK。

### `@cairn/db`

```ts
// leases.ts
claimRun(...)          // D2 + 事务内容量
registerWorker(...)    // 写入 maxSessions

// recover.ts
yieldClaimedRun(db, grant, reason)
yieldUnfinishedRun(...) // 改为调用 yieldClaimedRun(..., 'worker_shutdown')

// runs.ts
loadRunDetail(...)     // 附派生 placement
computeRunPlacement(db, run): RunPlacement

// sessions.ts
findEvictableSession(db, workerId)  // D3b：OPEN + 无 ACTIVE 租约 + 无认证占用 + last_used_at 最旧
createSession(...)                  // TTL 非法改为返回 SESSION_POLICY_INVALID，不再抛异常
// launch 失败分流见 worker；Repository 已有 setSessionStatus
// closeWorkerSessions 保持不碰 LOST（测试钉死）
```

### `@cairn/worker`

```ts
// placement-backoff.ts
yieldPlacement(db, grant) // yieldClaimedRun(..., 'placement_yield')；yielded 才记冷却
pump: excludeRunIds: placementYieldExcludes()

// lifecycle.service.ts
register({ maxSessions: config.CAIRN_BROWSER_MAX_SESSIONS })
healIdentity: fenceSelf → stopAllLocalBrowsers → 确认则关会话 → register → startClaiming
pump: 冷却窗口内的 runId 直接跳过（PLACEMENT_YIELD_BACKOFF_MS，进程内，非事实源）

// session-manager.ts
launchAndOpen: PROFILE_LOCKED → LOST + profile_locked，其它失败仍可 CLOSED + launch_failed
acquire: 会话位满先 findEvictableSession + close() 腾位，腾不出才回交（D3b）
          目标缺失 / 策略非法返回新码，不再复用 SESSION_NOT_CLAIMABLE（D5）
browserUnavailable: BROWSER_UNAVAILABLE / BROWSER_LAUNCH_FAILED 置位，reaper 每轮清一次
stopAllLocal(): 给自愈用，返回每会话 stopped | unconfirmed
```

Engine、`BrowserPort` 形状、Step 枚举不动。

### `@cairn/api` / `@cairn/web`

详情 DTO 多一个 `placement`。运行详情在非终态展示 D8 的一句说明。源码断言继续禁止 `features/runs` 出现 `refetchInterval` / `setInterval` / `EventSource`。

## 5. 文件

| 区域 | 动作 |
| --- | --- |
| `packages/shared/src/session.ts`、`run-api.ts`、`index.ts` | `placement` 词表与详情字段；`SESSION_ERROR_CODES` 加两个永久错误码 |
| `packages/db/migrations/0012_session_affinity.sql` | `workers.max_sessions` |
| `packages/db/src/schema/worker.ts`、`leases/leases.ts`、`runs/recover.ts`、`runs/runs.ts`、`sessions/sessions.ts` | 领取谓词与未过期容量口径、回交、派生 placement、登记 maxSessions、`findEvictableSession` |
| `packages/db/src/__tests__/run-lease-fencing.test.ts`、新 `session-affinity.test.ts` | L1：两 Worker、失联、容量、回交、重启不关 LOST |
| `packages/worker/src/browser/session-manager.ts`、`runtime/lifecycle.service.ts`、`runtime/placement-backoff.ts` | `PROFILE_LOCKED`、腾位、失败码分流、浏览器不可用自禁、自愈先停浏览器、`yieldPlacement` 回交并记冷却 |
| `packages/worker/src/browser/session-manager.integration.spec.ts` | RF10 夹具在 Affinity 下仍成立；`PROFILE_LOCKED` 不放键 |
| `packages/api/src/runs/`、`packages/web/src/features/runs/` | 详情 placement；文案；无定时器 |
| 本文落地结论 | S02 限制采用；无真实企业系统承诺 |
| `docs/arch/03` §8 / §13 | 落地后改成「MVP = Affinity 优先 + 容量阈值 + DB Claim」，与本方案对齐 |
| `docs/spec/README.md`、两份前序方案的「留给后续」 | 指向本稿；`CHANGELOG` 落地时再写 |

## 6. 实施顺序

1. **shared + 0012**：`placement` schema、`max_sessions`、parity。
2. **claimRun**：谓词 + 事务内容量（只数未过期 `ACTIVE` 租约）；先写会失败的负向测试（Worker-2 领走他人会话绑定的 Run、过期租约把 owner 卡死），再改 SQL。
3. **yieldClaimedRun**：扩停机回交；`placement_yield` 不计恢复；Attempt 已存在时拒绝或走恢复（测试钉死）。
4. **acquire 分流**：拆 `SESSION_TARGET_MISSING` / `SESSION_POLICY_INVALID`；`PROFILE_LOCKED` → `LOST`；容量 / busy / 不可领 / 浏览器不可用在夹具里走回交，Run 不是 `FAILED`。
4b. **不空转**：会话位满先腾位；腾不出回交带退避；浏览器不可用自禁到下一轮 reaper。这一步的用例必须先红（去掉任一道闸即失败）。
5. **自愈**：`healIdentity` 停浏览器；新进程 `reconcileOwn` 不关 `LOST`。
6. **GET + 页面**：`placement`；失联橙色、等待灰色；无定时器、无会话菜单。
7. **S02 结论**：受控夹具写回本文；真实系统有则附录，不另开文档。
8. 回写本稿状态、README、CHANGELOG、`docs/arch/03` §8 / §13。

## 7. 验收

### L1 库与 Worker

1. 空库与上一版本升级通过；parity 含 `workers.max_sessions` 与 CHECK；`skipped` 含 `0012_session_affinity.sql`。
2. Worker-1 持有账号 A 的 `OPEN` 会话，Worker-2 `claimRun` 领不到绑定 A 的 Run，能领无账号或账号 B 且无活会话的 Run。
3. Worker-1 `capacity = 1` 且已有 `ACTIVE` 租约时，两个 Worker 都领不到绑定 A 的第二份 Run；该 Run 保持 `QUEUED` 或 `RECOVERING`。把容量检查从 SQL 拿掉，本条必须失败。
3.1. 过期未回收的 `ACTIVE` 租约不占容量：owner `capacity = 1`，伪造一条 `expires_at` 已过且尚未被 reaper 处理的 `ACTIVE` 租约，owner 仍能领到该账号的 Run。把 `expires_at > now()` 从容量子句里拿掉，本条必须失败。
4. 无活会话时，Worker-1 与 Worker-2 都能领绑定 A 的 Run（与现网兼容）。随后并发 `createSession` 仍只有一份活会话。
5. 账号 A 会话为 `LOST` / `CLOSING` / `CREATING` 时，任何 Worker 领不到绑定 A 的 Run；`dispose` 使 `LOST`→`CLOSED` 后可领。
6. `resume-auth` 之后只有会话 owner 能领；owner 已 `LOST` 则谁都不领。
7. `claimRun` 在同一事务里看到未过期 `ACTIVE` 租约数 ≥ `capacity` 返回 `null`；Lifecycle 的 `inFlight` 挡板保留，但不得作为本条的唯一牙齿。
8. `yieldClaimedRun(..., 'placement_yield')`：租约 `RELEASED`，Run `RECOVERING`，`countFailedRecoveries` 不变。连续回交三次不得进 `NEEDS_REVIEW`。
9. 已有 `RUNNING` Attempt 时不得用 `placement_yield` 把现场洗成「没开始过」（0 行或走现有恢复）。
10. `acquire` 得到 `SESSION_CAPACITY_EXCEEDED` / `SESSION_BUSY` 后回交，Run 不是 `FAILED`，无成功 Attempt。
10.1. 会话位满先腾位（D3b）：`maxSessions = 2`，本 Worker 一份会话在 `ACTIVE` 租约里、一份空闲无租约，账号 C 的 Run 到达 → 空闲那份按确认路径 `CLOSED`，C 的会话建出来，**不**回交。带 `ACTIVE` 租约或持有认证占用的会话不得被腾。
10.2. 腾不出才回交，且回交带退避：会话位全部在 `ACTIVE` 租约里 → `yieldPlacement` 回交一次后，冷却窗口内本进程不得再领同一 Run（`claimRun` 必须吃 `placementYieldExcludes()`，钉住窗口内 `run_leases` 只多一行）。把 `rememberPlacementYield` 从 `yieldPlacement` 拿掉，或改回手工传入 `excludeRunIds`，本条必须失败。
10.3. `BROWSER_UNAVAILABLE` / `BROWSER_LAUNCH_FAILED`：Run 回交 `RECOVERING`、不是 `FAILED`、`countFailedRecoveries` 不变；本进程置自禁后同一 tick 不再尝试 launch；跑一轮 reaper 后允许重试。把「直接 FAILED」加回去，本条必须失败。
10.4. 拆码（D5）：Target 行缺失 → `SESSION_TARGET_MISSING` 且 Run 真失败；`maxLifetimeSeconds <= idleTtlSeconds` → `SESSION_POLICY_INVALID` 且 Run 真失败（不是抛异常穿透 `acquire`）；这两种现场不得再产生 `SESSION_NOT_CLAIMABLE`，也不得走回交。
11. 插入 `CREATING` 后模拟 `PROFILE_LOCKED`：行变为 `LOST` + `profile_locked`，同键不能再建；不得出现 `CLOSED` + `launch_failed`。把「锁定当启动失败关会话」加回去，本条必须失败。
12. 新 `instance_id` 重启：`reconcileOwn` 关掉名下 `OPEN`，**不**关 `LOST`；键仍阻塞。
13. `healIdentity`：本进程句柄被停；能确认退出的会话 `CLOSED`；确认不了的 `LOST`。自愈后不得在 `LOST` 仍占键时 `createSession` 成功。
14. RF10 夹具：同账号连续两次 `acquire`，自动登录一次；另一账号独立 profile，Cookie 不串。两次领取的 `holderWorkerId` 是同一 owner。
15. RF12 夹具：浏览器进程被杀且无法确认退出 → `LOST`，他 Worker 不能建同键会话；处置后可重建。
16. 无账号 Echo → Delay → Echo：零 `browser_sessions` 行，任意 Worker 可领（RF04）。
17. 现有 RunLease 用例（过期接管、fencing、优雅停机回 `RECOVERING`）全绿。

### L2 HTTP

18. `GET /runs/:id` 的 `placement` 与上表计算一致；刷新后不倒退。
19. 创建 / 取消 / 核查 / `resume-auth` 的领域码不出现容量类新码。
20. viewer 能看 `placement`，不能处置会话、不能 `resume-auth`。

### L3 控制台

21. 绑定失联会话的 Run：详情橙色说明须处置；绑定他人健康会话：灰色等待 owner。
22. 页面无 `refetchInterval` / `setInterval` / `EventSource`（沿用 P3 源码断言）。
23. 侧栏仍无「会话」菜单。

### 统一

24. `pnpm test`、`pnpm lint`、`pnpm typecheck`、`pnpm check:deps` 通过。
25. S02 有采用 / 限制 / 拒绝结论（见落地结论）。无真实系统不得写「已兼容」。
26. 不得宣称 RF11 / RF12 在真进程 kill / 暂停 / 断网上通过——那是 P3 债务，本方案只证明库谓词与本进程句柄。

## 8. 刻意留给后续

| 阶段 | 本方案结束后仍缺的 |
| --- | --- |
| P5 | Engine 消费 `BrowserPort`；按 D4/D5 先 `acquire` 再创建 Attempt；双 Lease 真实 `acquire` 集成测试；孤儿恢复增加「页面不可重建」 |
| P6 | 截图、Trace、授权下载 |
| P7 | SSE、`run_events`、会话只读页与处置按钮 |
| 认证通道 | headful / 远程可视化 / 扩展桥 |
| Placement | zone、标签、跨 Worker 容量调度、活会话迁移 |
| 运维 | 真进程故障注入；`CAIRN_SESSION_REAPER_INTERVAL_MS` 改名 |

## 9. 债务

1. 领取不锁会话行。会话在 `claimRun` 提交后被标 `LOST`，Run 会短时间 `RUNNING` 再回交。接受；闪一下比双开诚实。
2. 无活会话时两个 Worker 可同时领同一账号的两份 Run。浏览器路径靠 `createSession` 唯一索引 + 回交收敛。Echo 路径会并行——本期没有浏览器 Step，接受。P5 不得把「先执行再 acquire」当成优化。
3. `placement` 是当前值。历史 Run 当时为什么排队，事后看不出来。要留痕得进 `run_events`（P7）。
4. `resume-auth` 仍不打开浏览器核对。错按之后 owner 领到未登录会话，探针再失败。
5. 浏览器不可用只回交不失败（D5）。全集群都没浏览器时，Run 永久排队而不是失败，`placement` 还会显示 `claimable`——键上确实没有活会话，页面看不出「没有一台机器能开浏览器」。本期只靠 Worker 的 error 日志暴露，指标与列表提示留给 P7。宁可排队也不批量误失败，但这个缺口必须写在明处。
5.1. 腾位会打断一份健康且已登录的会话（D3b）。被腾掉的账号下次运行要重新登录一次。会话位紧张时这是必要代价；真要少登录，得先做跨 Worker 调度而不是放宽腾位条件。
5.2. 回交退避是进程内记忆，不是库事实。进程重启即失效，也不跨 Worker；最坏情况退回未退避的频率，不会卡住 Run。要让退避可观察、可跨进程，得等 `run_events`（P7）。
6. Affinity 不看 `workers.status = LOST` 本身：只看会话。Worker 已 `LOST` 但会话尚未被标上的窗口，靠心跳阈值大于租约 TTL（P3 D3）缩小，不在本期再做一层。
7. `workers.max_sessions` 与进程 env 可能短暂不一致（改 env 未重启）。领取不读它；只影响展示。

## 10. 更新历史

- 2026-09-11：初稿。以路线图 P4 / RF10–RF12 / F14、会话方案「留给后续」、RunLease 方案 §8「P4 后半」、`claimRun` 与 `launchAndOpen` 现网行为为事实源。不把 P5 页面能力写进来，也不把「Engine 空转」当成可以跳过本截的理由。
- 2026-09-11：评审后修订五处，都带负向验证（把修补撤掉，对应用例必须失败）。
  - **D4 判据**：「先 `acquire` 再创建 StepRun」与代码不符——`step_runs` 在 `createRun` 里随 Run 整批插入，Worker 侧没有这个时机。改为「第一个 `startAttempt` 之前」，并同步修 [Browser Surface 方案](2026-09-11-browser-surface.md) 的三处引用。
  - **D5 `BROWSER_UNAVAILABLE`**：初稿判「真正失败」的理由与 `runtime.ts` 的分类相反（那恰恰是本机缺浏览器）。改为回交 + 本进程自禁重试，避免一台漏装 Playwright 的 Worker 把整条队列烧成业务失败。
  - **D5 拆码**：`SESSION_NOT_CLAIMABLE` 现网一码多义（暂态 + 永久配置错误，后者甚至是抛异常穿透 `acquire`），按码分流会把配置错误判成永久排队。拆出 `SESSION_TARGET_MISSING` / `SESSION_POLICY_INVALID`。
  - **D2 容量口径**：只数未过期的 `ACTIVE` 租约，避免一条死票长期吃掉 owner 的执行槽、再被 Affinity 锁死成无人可领。
  - **新增 D3b**：默认 `capacity = 1` / `maxSessions = 2` / idle TTL 600 s 下，回交会变成 1 s 一轮的空转。改为会话位满先腾位，腾不出才回交且带进程内退避。
- 2026-09-11：落地。`0012` 登记 `max_sessions`；`claimRun` 按活会话 Affinity 且容量只数未过期租约；`yieldClaimedRun(..., 'placement_yield')` 不计恢复；`acquire` 拆配置错误码、腾位、浏览器不可用自禁、`PROFILE_LOCKED`→`LOST`；自愈先 `stopAllLocal`；详情 GET `placement`。S02 受控夹具限制采用，无真实企业系统承诺（见落地结论）。
- 2026-09-13：S02 结论并回本文，删除与方案平级的实验记录。
- 2026-09-12：回交与进程内冷却收成 `yieldPlacement`。夹具与验收 10.2 走这条入口；只调库回交不再算接上退避。

- 2026-09-12：跟随 [Browser Surface 方案](2026-09-11-browser-surface.md)的评审修订一处。**D4 判据**从「该 Run 名下没有任何 Attempt」改为「不存在 `RUNNING` Attempt」：初稿口径只覆盖首次领取，恢复重领的 Run 因为身上有终态 Attempt，D5 的回交会被 `yieldClaimedRun` 整条挡掉，Run 卡在 `RUNNING` 直到租约 `EXPIRED` 并计进 `countFailedRecoveries`，三轮后 `NEEDS_REVIEW`——与本方案「占不到会话不计恢复、不标失败」的承诺正好相反。修订后的谓词与 §7 L1 第 9 条本来的措辞一致，落地测试（`startAttempt` 造的是 `RUNNING` Attempt）不受影响；代码改动随 P5 PR 1 一起落地。

## 11. S02 落地结论

**限制采用。** 受控账密 Cookie 夹具，不是对某家企业系统的兼容承诺。

- 采用：`NEW_PAGE`（默认）、`REUSE_PAGE`；同账号活会话复用；账号键隔离 profile。
- 限制：只证明受控夹具。未测真实 MFA / 过期会话 / 真进程 kill。腾位会关掉一份已登录空闲会话（债务 5.1）。
- 拒绝：不把 `storageState` 当活会话备份；不做 `NEW_CONTEXT`；不把一次成功轨迹写成平台通用复用承诺。sessionStorage / SPA 内存若使 `NEW_PAGE` 不等价于原页，记 Target 限制，不改三档枚举。

基线约 `7c54f3b` 之后的 P4 后半工作树。可复跑：`pnpm --filter @cairn/worker exec vitest run src/browser/session-manager.integration.spec.ts src/browser/runtime.hmi.spec.ts src/browser/reuse.spec.ts`。2026-09-11 本机：有 Chromium 时同账号二次 acquire 走 `session.reused`、凭据解析一次；`PROFILE_LOCKED` / 无句柄 `stopAllLocal` → `LOST`。无浏览器归 `BROWSER_UNAVAILABLE` 回交，不记复用失败。
