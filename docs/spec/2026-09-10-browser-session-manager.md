# 识途 BrowserSession / SessionLease：会话复用、独占租约与回收

日期：2026-09-10。状态：**已落地**。  
对应路线图 P4（Browser Runtime 与 Session 所有权）的第一截：会话纳管、健康与认证、独占租约、回收。  
前置：执行内核（P1 / P2，已落地）、目标系统目录与凭据引用（已落地）、对象存储内核（已落地，本方案不碰对象）。  
范围：让需要浏览器的 Run 拿到平台纳管的认证会话；健康会话跨 Run 复用；同一 Target + TargetAccount 同一时刻只有一个持有者；租约过期、会话回收、丢租即停。  
不是页面定位（P5）、不是截图与 Trace（P6）、不是 SSE 与观察面（P7）、不是新 Step Type。

RunLease 与 Fencing（P3）**尚未落地**。本方案与它的绑定按「可空列 + 形状 CHECK」预留，P3 落地后回填收紧，不假装它已存在；跨 Worker 失联判定也依赖 P3 的 Worker 注册与心跳，本方案只冻结状态与列。

## 1. 为什么现在写

执行内核能跑 Echo → Delay → Fail，Run / StepRun / Attempt / Evidence 账本已经在库。缺的是**被平台纳管的浏览器会话**：没有它，后面的页面定位、截图、Trace 只能各自 `chromium.launch()`——同账号并发开两份登录、登录态无处复用、崩溃后无人回收、租约没有任何事实源，正是宪法 §19 点名的硬禁区。

宪法 §7 把这件事钉成两条：可复用 Browser Session 与单次 Lease 分离；同一 Target + TargetAccount 不得同时授予冲突 Lease。前者是能力，后者**必须由数据库约束卡住**，不能靠代码自觉（§18.18）。现在仓里一条都没有：`browser_sessions` / `session_leases` 表不存在，`packages/**` 里 `SessionReusePolicy`、`fencingToken` 零命中，`runs` 拿不到「谁在执行」。

本方案从 P4 拆出「会话与租约」这一截。不宣称 RF10 至 RF12 全通过：RF11 的 Affinity 与容量排队属 P3 / P4 后半，RF12 里「owner 失联不冒险双开」的跨 Worker 判定依赖 P3 心跳，本方案只落 LOST 状态与 SQL 形状。

## 2. 目标与非目标

### 目标

1. 冻结 Session 键：Target + TargetAccount。唯一性由部分唯一索引卡住，不由代码保证。
2. 冻结 `browser_sessions` / `session_leases` 两张表；生命周期、健康、认证三件事分开存，互不冒充（D2、D4）。
3. 冻结租约的获取 / 续租 / 释放 / 过期四条原子操作；同一 Session 同时只有一个 `ACTIVE` 租约（D5）。
4. 丢租即停：续租失败后本进程立即拒绝任何浏览器命令；浏览器步骤提交结果前在事务内校验租约（D6）。
5. Profile 目录由 Worker 本地派生，**键入库、绝对路径不入库**；同键目录稳定、跨代复用（「登录一次」的前提，D9）。
6. 认证：能用账密自动登录的自动登录；验证码、手工、MFA 转 `WAITING_FOR_AUTH`，等待期由独立认证占用保住会话（D7）。
7. 回收：租约过期、空闲 TTL、最大生命周期、Worker 重启自愈四条路径都能把资源收干净；非 owner 不得碰别人的浏览器（D10）。
8. 惰性启动：浏览器不可用不影响 Echo / Delay / Fail；RF04 不退化（D11）。
9. Playwright 只进 worker 依赖；`src/engine/` 继续不出现 playwright，现有 `engine.boundary.spec.ts` 是牙齿（D1）。
10. 运行时可观测：`sessionId` / `leaseId` / `generation` 进结构化日志（D12）。

### 非目标

- 不做 Affinity / Placement / 容量排队。本方案只到「本 Worker 内的会话与租约」；容量超限立即失败，不排队（P3 之后接通）。
- 不做活会话跨 Worker 迁移，不做浏览器集群控制器。
- 不自动解决验证码与 MFA，不自动探测登录框（`loginFields` 由目标系统目录给出，探测属后续）。
- 不导出、不上传、不入库 `storageState` 或 Cookie。profile 目录留在 Worker 本地盘。
- 不实现 `NEW_CONTEXT` 复用档位（D8：持久化 Context 是单 Context 模型）。
- 不新增 Step Type，不做页面定位（P5），不采集截图 / Trace（P6），不发 SSE。
- 不扩 `RUN_EVENT_TYPES`：会话状态由表承载，事件与观察面在 P7 一起定（D12）。
- 不改 API 业务路由；P7 之前 Web 不展示会话。
- 不在启动期校验浏览器是否安装（D11）。

## 3. 决策

### D1. 归属 worker 进程内 `packages/worker/src/browser/`，不新建包

浏览器运行时绑定本机进程、持有 `userDataDir` 与子进程句柄，不是可复用库；唯一消费者是 Worker。执行内核就住在 `packages/worker/src/engine/`，同一节奏，不提前建包。

```text
@cairn/shared     Session 键、状态词表、策略 schema、错误码、env 片段
@cairn/db         browser_sessions / session_leases 两张表与 Repository；不依赖 playwright
@cairn/worker     src/browser/：适配器 + 会话与租约管理 + 回收 tick；src/engine/ 只认 BrowserPort
@cairn/api        本期零改动（没有会话路由）
@cairn/web        本期零改动
```

依赖方向无需改 `tools/check-deps.mjs` 的允许边（`@cairn/api` 本来就不允许依赖 worker）。边界由测试卡住：

- `engine.boundary.spec.ts` 的禁止 import 正则已含 `playwright`；扩一条禁止 `src/engine/**` 出现 `../browser`（Engine 只能通过注入的 `BrowserPort`）。
- `packages/db` 不得依赖 playwright：新 Repository 的测试不需要浏览器，能跑在无浏览器环境。

`playwright` 只加进 `packages/worker/package.json`。浏览器二进制不进 CI 默认安装路径——见 D11 惰性启动。

**版本必须与 `packages/web` 一致**：playwright 每个版本钉死自己的 chromium revision（1.55 → 1187、1.63 → 1243），两个包各写一个版本就是各下一份浏览器，且 worker 的浏览器测试在没装对应 revision 的机器上静默 skip（CI 只装 web 那份，于是它从来没在 CI 上跑过）。约束由 `tools/check-deps.mjs` 卡住（`SHARED_VERSION_DEPS`），版本分叉直接让 `pnpm check` 失败。

### D2. 三件事分开存：生命周期 / 健康 / 认证

`READY` 与 `AUTH_REQUIRED` 是两种观测的合取，不是第三种观测。把「进程在不在」「健康不健康」「登录态还有效吗」压成一个 status 列，等于每次认证过期都要靠人记得同步改 status，而崩溃或探针失败又必须回写——双事实源，且崩在中间态就永久撒谎。

因此：

| 列 | 表达 | 取值 |
| --- | --- | --- |
| `status` | 生命周期与所有权 | `CREATING` / `OPEN` / `CLOSING` / `CLOSED` / `LOST` |
| `health` | 进程与页面可交互 | `UNKNOWN` / `HEALTHY` / `UNHEALTHY` |
| `auth_state` | 目标系统登录态 | `UNKNOWN` / `AUTHENTICATED` / `EXPIRED` |

派生谓词（写进 Repository，不落库）：

```text
reusable  = status = 'OPEN' AND health = 'HEALTHY' AND auth_state = 'AUTHENTICATED'
claimable = status = 'OPEN' AND health <> 'UNHEALTHY' AND 无 ACTIVE 租约
busy      = 存在 ACTIVE 租约          // 不落 status
```

与 `docs/arch/03` §6 的词表对应：`READY` = `reusable`；`BUSY` = `busy`（派生）；`AUTH_REQUIRED` = `claimable ∧ auth_state <> 'AUTHENTICATED'`；`BROKEN` = `status='OPEN' ∧ health='UNHEALTHY'`；`EXPIRED` 归 `CLOSED` 加 `close_reason`。**落地时同步修订 arch/03 §6**，避免两份词表并存。

### D3. 唯一性由部分唯一索引卡住，键覆盖所有「进程可能还活着」的状态

```sql
CREATE UNIQUE INDEX browser_sessions_key_live_idx
  ON <schema>.browser_sessions (target_id, target_account_id)
  WHERE status IN ('CREATING','OPEN','CLOSING','LOST');
```

`CLOSED` 是唯一释放键的终态——`LOST` 必须留在索引里：owner 失联时旧浏览器**可能仍在运行**，此时放行新会话就是同账号双开（宪法 §19）。只有确认进程已停或完成隔离，才允许 `LOST` → `CLOSED` 并重建。

隔离范围进入唯一约束（路线图 P4）：不同 TargetAccount 天然不同键；同账号挂在不同 Target 下也是不同键与不同 profile 目录。

### D4. 状态迁移与唯一驱动者

```text
                    ┌──────────────► CLOSED  (终态，释放键；closed_at / close_reason 必填)
                    │ 确认进程已退出
CREATING ──► OPEN ──┼──────────────► CLOSING ──► LOST (进程是否仍在无法确认 → 阻塞键，等人工)
   │           │    │
   │           └────┴──────────────► LOST   (owner 失联，P3 心跳判定)
   └───────────────────────────────► CLOSED (启动自愈：进程随上次 Worker 退出)
```

- 只有 **owner 自己** 能把 `OPEN` → `CLOSING` → `CLOSED`：只有它持有子进程句柄。
- `CLOSING` 在宽限期内确认退出则 `CLOSED`；确认不了则 `LOST`，**不假装关掉了**。
- `LOST` 只由 P3 的 Worker 心跳判定或人工处置推进，本期不实现自动推进。
- `health` / `auth_state` 由 owner 的探针写；非 owner 永远不写这两列。

### D5. 租约四条原子 SQL，全部用库钟

**获取**（幂等 + 冲突兜底）：

```sql
-- 1. 幂等：同 (session, run, holder) 已有 ACTIVE 租约，直接返回
SELECT * FROM session_leases
 WHERE session_id = $1 AND run_id = $2 AND holder_worker_id = $3 AND status = 'ACTIVE';

-- 2. 否则在同一事务内：锁会话行 → 递增 fencing → 插入租约
WITH bumped AS (
  UPDATE browser_sessions
     SET fencing_token = fencing_token + 1, last_used_at = now(), updated_at = now()
   WHERE id = $1 AND status = 'OPEN' AND health <> 'UNHEALTHY'
  RETURNING id, generation, fencing_token
)
INSERT INTO session_leases
  (id, session_id, session_generation, session_fencing_token, run_id, run_fencing_token,
   holder_worker_id, status, expires_at)
SELECT $2, b.id, b.generation, b.fencing_token, $3, $4, $5, 'ACTIVE',
       now() + make_interval(secs => $6)
  FROM bumped b
ON CONFLICT DO NOTHING
RETURNING id, session_fencing_token, expires_at;
```

返回 0 行时补一条 SELECT 区分 `SESSION_BUSY`（有 ACTIVE 租约，附 holder 与 expiresAt）与 `SESSION_NOT_CLAIMABLE`（status 或 health 不允许）。`ON CONFLICT` 不带目标，让部分唯一索引自己兜底；`bumped` 的 `UPDATE` 同时持有行锁，同一会话的并发获取在此串行。

**续租**：

```sql
UPDATE session_leases l
   SET expires_at = now() + make_interval(secs => $3), heartbeat_at = now()
 WHERE l.id = $1 AND l.holder_worker_id = $2 AND l.status = 'ACTIVE' AND l.expires_at > now()
   AND EXISTS (SELECT 1 FROM browser_sessions s
                WHERE s.id = l.session_id AND s.status = 'OPEN'
                  AND s.generation = l.session_generation)
RETURNING l.expires_at;
```

0 行 = `SESSION_LEASE_LOST`（含「会话被回收或已换代」）。调用方**立即**撤销 guard 并停止浏览器动作，不重试获取同一租约。

**释放**（幂等）：

```sql
UPDATE session_leases
   SET status = 'RELEASED', released_at = now(), release_reason = $3
 WHERE id = $1 AND holder_worker_id = $2 AND status = 'ACTIVE'
RETURNING session_id;
```

0 行且该行已非 `ACTIVE` 视为成功（重复释放不是错误）；行不存在报 `SESSION_LEASE_UNKNOWN`。

**过期**（任何 Worker 可跑，幂等）：

```sql
UPDATE session_leases
   SET status = 'EXPIRED', released_at = now(), release_reason = 'lease_expired'
 WHERE status = 'ACTIVE' AND expires_at <= now()
RETURNING session_id;
```

### D6. fencing 与 generation，以及「提交边界必须回库」

- `generation`：**键**的会话实例计数。新会话插入时取同键历史最大值 + 1（在唯一索引保护下串行），复制进租约。
- `session_fencing_token`：会话行内单调递增的租约序号，每次成功获取 +1。
- `run_fencing_token`：P3 的 RunLease token。本期为 `NULL`（P3 未落地），CHECK 只约束取值形状；P3 落地后回填并收紧为 `NOT NULL`——可空期间的语义缺口写进债务 3。

命令面校验用进程内 guard：`SessionGrant = { sessionId, generation, sessionFencingToken, leaseId, expiresAt }`，四元组 + 到期时间任一不符即拒绝命令。**不做每条命令回库校验**——一次浏览器动作可能产生上百条协议消息，那会把延迟和连接数都烧在无收益的往返上。事实源仍然是库：授予、回收、续租判定都在库上，guard 是租约在本进程的有效副本，续租失败即撤销。

提交边界必须回库：浏览器步骤的 Attempt 在写结果前要求租约仍 `ACTIVE`、holder 与 token 匹配、会话 `OPEN` 且未换代；不符则该 Attempt 不写成功结果——`effectType = SIDE_EFFECT` 时转 `NEEDS_REVIEW`，其余转失败。理由与 P3 对 RunLease 的要求一致：丢租后的结果不可信，不能让它落成事实。

### D7. 认证：平台侧登录绑定，不能自动的转人工等待

用库里已有的事实做判定，不新增探测：

| `authMethod` | `captchaMode` | `loginFields` | 行为 |
| --- | --- | --- | --- |
| `password` | `none` | username + password + submit 齐全 | 自动登录：`secretRef` 取密文 → 填表提交 → 探针确认 `AUTHENTICATED` |
| `password` | 非 `none` | 任意 | 自动登录降级：置认证占用，Run → `WAITING_FOR_AUTH` |
| `password` | `none` | 缺字段 | 同上，记 `SESSION_AUTH_UNSUPPORTED` |
| `manual` | 任意 | 任意 | 直接置认证占用，Run → `WAITING_FOR_AUTH`（SSO / 扫码等首次必须人登） |

- 登录态判定：`probeAuth()` 导航到 `entryUrl`，若落在 `loginUrl`（或出现 `loginFields.password` 定位）判 `EXPIRED`，否则 `AUTHENTICATED`。探针只在空闲期与租约获取前跑，**不刷新 `last_used_at`**（否则空闲 TTL 永不生效）。
- 认证占用（`auth_hold_worker_id` / `auth_hold_expires_at`）是与租约分开的独占：等待人工认证时释放执行租约、保留会话与占用，避免会话被别人抢走或按空闲 TTL 回收。有占用时 D10 的三条回收路径都跳过。
- 等待超时 `CAIRN_SESSION_AUTH_WAIT_SECONDS`：租约释放、Run 以 `SESSION_AUTH_TIMEOUT` 失败，会话保留（`auth_state = 'EXPIRED'`，profile 目录留着），不关浏览器。
- 人工认证的通道（headful 本机 / 远程可视化 / 扩展桥）不在本期。本期只把会话置为等待认证、暴露状态，并允许 `CAIRN_BROWSER_HEADLESS=false` 便于本机人工登录。
- 凭证边界：密文只在登录流程内解密一次，不进日志、不进 Evidence、不进快照；`runSnapshotSchema.secretRef` 只存引用（已有约束）。

### D8. 复用档位三值，进 RunSnapshot 顶层而不塞 `executionPolicySchema`

`SESSION_REUSE_POLICIES = REUSE_PAGE | NEW_PAGE | RECREATE_SESSION`

- `REUSE_PAGE`：直接用会话的基准页，沿用页面内存状态。
- `NEW_PAGE`（默认）：复用 Context（Cookie、sessionStorage 存续），新开页面。
- `RECREATE_SESSION`：关闭会话、增代重建，重新走认证。

不做 `NEW_CONTEXT`：会话由 `launchPersistentContext(profileDir)` 承载，持久化 Context 是单 Context 模型，再开一个只能是无状态 Context（等于丢掉登录态）。真要独立 Context 得先改成「browser + storageState 播种」，那是架构变更，不在本期；枚举里不出现它——声明了却没人能实现的取值只会误导调用方。

策略解析优先级沿用宪法 §5 的 Platform Default < Target Policy < Scenario Policy < Step Override：本期只实现 **env 默认 + `POST /runs` 显式覆盖**（`createRunBodySchema` 已有 `policy`，并列加 `sessionPolicy`），不做 Target 策略列与 UI。**解析结果写进快照**，历史 Run 因此可解释（宪法 §2）。

放在快照顶层而不进 `executionPolicySchema`：后者同时被 `Step.policy` 使用，塞进去等于允许每个 Step 声明会话策略，破坏「Step 不决定会话所有权」的分层。

### D9. Profile 目录规则：键入库，绝对路径不入库

```text
profile_key = `<targetId>/<targetAccountId>`
目录        = `${CAIRN_BROWSER_PROFILE_DIR}/<targetId>/<targetAccountId>`   // 0700
```

- 同键目录**跨代稳定**：Cookie 与 localStorage 留在 profile 里，重建会话通常无需重新登录——这正是 RF10 的「连续两个 Run 登录一次」。
- 目录由 owner Worker 本地派生，`profile_key` 入库用于排障，绝对路径不入库：绝对路径只在 owner 上有效，入库等于把 Worker 文件系统拓扑写进共享事实源。
- Chromium 对同一 `userDataDir` 的单实例锁是第二道防线：即使索引被误删，同键双开也会在 OS 层失败，映射为 `PROFILE_LOCKED`。
- 登录态即凭证：目录不上传对象存储、不进日志、不打包；保留策略与清理属后续（见债务）。

### D10. 回收：owner 自查，非 owner 只改状态

| 路径 | 谁跑 | SQL 形状 | 结果 |
| --- | --- | --- | --- |
| 租约过期 | 任何 Worker | D5 过期语句 | 租约 `EXPIRED` |
| 空闲 TTL / 最大生命周期 | **只有 owner** | 见下 | `OPEN` → `CLOSING` → `CLOSED` |
| Worker 重启自愈 | 该 Worker 启动时 | 见下 | 自己名下会话 `CLOSED`、租约 `REVOKED` |
| owner 失联 | P3 心跳（本期不做） | — | `OPEN`/`CLOSING` → `LOST` |

```sql
-- owner 收自己名下到期会话（有租约或有认证占用则跳过）
UPDATE browser_sessions
   SET status = 'CLOSING', version = version + 1, updated_at = now()
 WHERE owner_worker_id = $1 AND status = 'OPEN'
   AND auth_hold_worker_id IS NULL
   AND NOT EXISTS (SELECT 1 FROM session_leases l
                    WHERE l.session_id = browser_sessions.id AND l.status = 'ACTIVE')
   AND (last_used_at + make_interval(secs => idle_ttl_seconds) <= now() OR expires_at <= now())
RETURNING id;

-- 重启自愈：进程随上次 Worker 退出，名下的活会话必然已不在
UPDATE session_leases SET status = 'REVOKED', released_at = now(),
       release_reason = 'worker_restart'
 WHERE status = 'ACTIVE' AND holder_worker_id = $1;

UPDATE browser_sessions SET status = 'CLOSED', closed_at = now(),
       close_reason = 'worker_restart', version = version + 1
 WHERE owner_worker_id = $1 AND status IN ('CREATING','OPEN','CLOSING');
```

回收 tick 与清理 tick 同节奏，挂在 `LifecycleService` 既有的定时器体例上（`cleanupTick` 已有先例），停机时先停定时器再等收尾。

页面不累积：会话持有 `basePage`（创建时打开）。`REUSE_PAGE` 直接用基准页；`NEW_PAGE` 打开的页面在释放租约时关闭。RF17 的「无遗留 Run Page」口径因此可判定：50 次运行后页面数 ≤ 会话数 × 1。

关机即关会话：`onApplicationShutdown` 释放本进程名下租约、把名下 `OPEN` 会话走 `CLOSING` → `CLOSED`（进程随 Worker 退出）。这不违反「Run 结束不销毁会话」——Run 结束不关，进程退出才关。

### D11. 配置进 `workerEnvSchema`，惰性启动

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `CAIRN_BROWSER_HEADLESS` | `true` | 关掉便于本机人工认证 |
| `CAIRN_BROWSER_PROFILE_DIR` | `.data/browser-profiles` | 相对值按仓根解析（与对象存储同一约定） |
| `CAIRN_BROWSER_MAX_SESSIONS` | `2` | 超限 `SESSION_CAPACITY_EXCEEDED`，不排队 |
| `CAIRN_BROWSER_EXECUTABLE_PATH` | 空 | 空则用 Playwright 自带 chromium |
| `CAIRN_SESSION_IDLE_TTL_SECONDS` | `600` | |
| `CAIRN_SESSION_MAX_LIFETIME_SECONDS` | `14400` | 必须大于空闲 TTL |
| `CAIRN_SESSION_LEASE_TTL_SECONDS` | `30` | 与路线图租约参数一致 |
| `CAIRN_SESSION_HEARTBEAT_MS` | `5000` | 续租走独立定时器，不依赖步骤循环 |
| `CAIRN_SESSION_REAPER_INTERVAL_MS` | `15000` | |
| `CAIRN_SESSION_AUTH_WAIT_SECONDS` | `300` | |

`superRefine`：`LEASE_TTL ≥ 3 × HEARTBEAT`（连续两次丢心跳才判丢租）、`MAX_LIFETIME > IDLE_TTL`、`MAX_SESSIONS ≥ 1`。到期判定一律用库钟（宪法与 `runtime-contracts` §D4 已冻：`leaseExpiresAt` 不得用进程 `Date.now()` 当租约真相）。

惰性启动：浏览器在第一个需要会话的 Run 才启动，启动期不校验浏览器是否安装。缺浏览器时该 Run 以 `BROWSER_UNAVAILABLE` 失败，Echo / Delay / Fail 与 CI 不装浏览器的环境不受影响（RF04 不退化）。相对 `PROFILE_DIR` 在非 development 下启动失败，与对象存储同规则。

### D12. 可观测：结构化日志，不扩事件枚举

`pino` 行带 `sessionId` / `leaseId` / `sessionGeneration` / `fencingToken` / `workerId` / `runId`，事件覆盖：`session.created`、`session.reused`、`session.auth_changed`、`session.closing`、`session.closed`、`session.lost`、`session.disposed_externally`、`lease.acquired`、`lease.renew_failed`、`lease.released`、`lease.expired`、`reap.cycle`。

不扩 `RUN_EVENT_TYPES`：事件信封是 Run 作用域的，会话生命周期不是 Run 的子事件；SSE 与观察面是 P7 的事，那时再决定会话事件的形状。指标（活跃会话数、租约等待时长、重建认证次数）留给 P7 的 OTel 接入。

### D13. 卡死会话的人工处置出口：控制面只改状态，不碰浏览器

`LOST` 占键是对的（D3），但它必须有出口——否则一个 owner 失联的会话会把该 Target + TargetAccount **永久**锁死，只能手写 SQL 救。本期补最小出口：

```text
GET  /browser-sessions                  session:read      列出占键的会话（元数据 + 当前 ACTIVE 租约 + disposable）
POST /browser-sessions/:id/dispose      session:dispose   确认旧浏览器已停/已隔离后释放键
```

- **只允许 `CREATING` / `CLOSING` / `LOST`**。`OPEN` 一律拒绝（`SESSION_NOT_DISPOSABLE`）：那是活会话，控制面放行等于同账号双开，必须由持有它的 Worker 按 D10 自己回收。
- **API 不持有、不关闭浏览器**（宪法 §12）。控制面没有句柄，也无从验证旧进程是否真的退出——「已停或已隔离」由操作者声明，写进审计摘要，可追溯到人和时间。
- 处置事务内：撤该会话的 `ACTIVE` 租约（`REVOKED` / `operator_disposed`）、置 `CLOSED` / `operator_disposed`、清认证占用、写 `session.dispose` 审计。对已 `CLOSED` 幂等返回，不覆盖既有 `close_reason`。
- **worker 侧必须收尾**：处置改不了另一个进程里的浏览器。`reap()` 先做一次对账，凡是「行已 `CLOSED` / 行已消失 / owner 换了人」的本地句柄，停掉浏览器、丢句柄、清 guard 与租约映射，记 `session.disposed_externally`。没有这一步，处置只是在库里放行，盘上仍留着一个带同一 profile 的旧进程——正是 D3 要防的双开。
- 权限码 `session:read` / `session:dispose` 进 `PERMISSIONS` 目录：admin 全部、operator 两项、viewer 只读。系统角色的权限集由 `0009_session_dispose.sql` 补种——目录是代码拥有的，库里只存绑定，新增码不补种就是「shared 的单测说 admin 全覆盖、实际库 403」。

Web 界面不在本期（非目标：P7 前不展示会话）；出口先给运维与脚本。

## 4. 形状

### `@cairn/shared`（`src/session.ts`，从 `index.ts` 导出）

```ts
export const SESSION_STATUSES = ['CREATING', 'OPEN', 'CLOSING', 'CLOSED', 'LOST'] as const
export const SESSION_HEALTH = ['UNKNOWN', 'HEALTHY', 'UNHEALTHY'] as const
export const SESSION_AUTH_STATES = ['UNKNOWN', 'AUTHENTICATED', 'EXPIRED'] as const
export const SESSION_LEASE_STATUSES = ['ACTIVE', 'RELEASED', 'EXPIRED', 'REVOKED'] as const
export const SESSION_REUSE_POLICIES = ['REUSE_PAGE', 'NEW_PAGE', 'RECREATE_SESSION'] as const

export const SESSION_ERROR_CODES = [
  'SESSION_ACCOUNT_REQUIRED',   // 浏览器步骤没有 targetAccountId
  'SESSION_NOT_CLAIMABLE',      // status / health 不允许
  'SESSION_BUSY',               // 已有 ACTIVE 租约
  'SESSION_CAPACITY_EXCEEDED',
  'SESSION_LEASE_LOST',
  'SESSION_LEASE_UNKNOWN',
  'SESSION_AUTH_UNSUPPORTED',
  'SESSION_AUTH_TIMEOUT',
  'BROWSER_UNAVAILABLE',
  'BROWSER_LAUNCH_FAILED',
  'PROFILE_LOCKED',
] as const

/** 落进快照的是解析后的值，不是「未填」——历史 Run 必须能解释当时怎么执行。 */
export const sessionPolicySchema = z.strictObject({
  reuse: sessionReusePolicySchema,
  idleTtlSeconds: z.number().int().positive(),
  maxLifetimeSeconds: z.number().int().positive(),
  leaseTtlSeconds: z.number().int().positive(),
  authWaitSeconds: z.number().int().positive(),
})
```

`runSnapshotSchema` 顶层加可选 `sessionPolicy`（`strictObject` 加可选字段对既有快照非破坏）；`createRunBodySchema` 并列加 `sessionPolicy`。会话时间戳复用 `wire.ts` 的 `leaseExpiresAtSchema`。

### 表（`0008_browser_session.sql`）

```sql
-- browser_sessions
id, target_id, target_account_id           -- 复合外键 → target_accounts (id, target_id)
status, health, auth_state                 -- D2，CHECK 闭枚举
owner_worker_id                            -- 与 CAIRN_WORKER_ID 同形（TEXT，不是 UUID）
generation, fencing_token, version         -- D6；version 供 CAS
profile_key, reuse_policy                  -- D9 / D8，绝对路径不入库
idle_ttl_seconds, max_lifetime_seconds, expires_at, last_used_at
auth_hold_worker_id, auth_hold_expires_at  -- 成对 CHECK
close_reason, closed_at, created_at, updated_at

-- session_leases
id, session_id → browser_sessions(id), session_generation, session_fencing_token
run_id → runs(id), run_fencing_token       -- P3 未落地前 NULL
holder_worker_id, status                   -- CHECK 闭枚举
acquired_at, heartbeat_at, expires_at, released_at, release_reason
```

约束与索引：

| 名称 | 定义 |
| --- | --- |
| `browser_sessions_key_live_idx` | UNIQUE (target_id, target_account_id) WHERE status IN ('CREATING','OPEN','CLOSING','LOST') |
| `browser_sessions_owner_idx` | (owner_worker_id, status) |
| `browser_sessions_reap_idx` | (status, last_used_at) WHERE status = 'OPEN' |
| `browser_sessions_auth_hold_check` | `(auth_hold_worker_id IS NULL) = (auth_hold_expires_at IS NULL)` |
| `browser_sessions_closed_check` | `status <> 'CLOSED' OR (closed_at IS NOT NULL AND close_reason IS NOT NULL)` |
| `browser_sessions_ttl_check` | `idle_ttl_seconds > 0 AND max_lifetime_seconds > idle_ttl_seconds` |
| `session_leases_active_idx` | UNIQUE (session_id) WHERE status = 'ACTIVE' |
| `session_leases_reap_idx` | (status, expires_at) WHERE status = 'ACTIVE' |
| `session_leases_released_check` | `(status = 'ACTIVE') = (released_at IS NULL)` |

迁移体例沿用现有文件：`"__SCHEMA__".` 前缀、`CREATE TABLE IF NOT EXISTS`、`DO $$ … pg_constraint …` 加约束、全文幂等。复合外键需要被引用侧的唯一索引，`0008` 里同时给 `target_accounts (id, target_id)` 补一个 UNIQUE。

### `@cairn/db`（`src/sessions/`）

```ts
findLiveSession(db, key): Promise<SessionRow | null>
createSession(db, input): Promise<SessionRow>              // 撞唯一索引 → SESSION_BUSY
acquireSessionLease(db, input): Promise<LeaseOutcome>       // D5，含幂等与区分失败原因
renewSessionLease(db, input): Promise<LeaseRow | null>
releaseSessionLease(db, input): Promise<'released' | 'unknown'>
expireStaleLeases(db, limit): Promise<number>
listReapableSessions(db, workerId, limit): Promise<SessionRow[]>
setSessionStatus(db, input): Promise<boolean>               // CAS：version 匹配才写
setSessionProbe(db, input): Promise<boolean>                // health / auth_state，仅 owner
claimAuthHold(db, input) / releaseAuthHold(db, input): Promise<boolean>
revokeWorkerLeases(db, workerId) / closeWorkerSessions(db, workerId)
```

### `@cairn/worker`

```ts
// src/browser/runtime.ts —— 唯一碰 playwright 的地方
launchSession(profileDir, opts): Promise<BrowserHandle>      // launchPersistentContext
probeHealth(handle): Promise<'HEALTHY' | 'UNHEALTHY'>
probeAuth(handle, target): Promise<'AUTHENTICATED' | 'EXPIRED'>
loginWithCredentials(handle, target, credential): Promise<boolean>
stopSession(handle, graceMs): Promise<'stopped' | 'unconfirmed'>

// src/browser/session-manager.ts
class BrowserSessionManager {
  acquire(run: RunSnapshot, signal: AbortSignal): Promise<SessionGrant | BrowserFailure>
  renew(leaseId: string): Promise<'ok' | 'lost'>
  release(leaseId: string, reason: string): Promise<void>
  close(sessionId: string, reason: string): Promise<void>
  reap(): Promise<{ leasesExpired: number; sessionsClosed: number }>
  reconcileOwn(): Promise<{ leasesRevoked: number; sessionsClosed: number }>  // 启动自愈
}

// src/engine/ports.ts —— Engine 只认这个，不认识 playwright
export type BrowserPort = {
  acquire(run: RunSnapshot, signal: AbortSignal): Promise<SessionGrant>
  release(grant: SessionGrant, reason: string): Promise<void>
}
```

`SessionGrant` 是 Engine 与 Executor 能看到的全部：没有 Context、Page、Cookie，也没有路径。页面能力在 P5 通过 `BrowserPort` 扩展，本方案不开这个口子。

### 处置接口（`@cairn/api`，D13）

```ts
// src/browser-sessions/browser-sessions.controller.ts
GET  /browser-sessions                 @RequirePermissions('session:read')
POST /browser-sessions/:id/dispose     @RequirePermissions('session:dispose')

// 请求体（disposeSessionBodySchema，strictObject）
{ note?: string }   // 512 字内，操作者确认「旧浏览器已停或已隔离」的说明，进审计
```

`sessionDtoSchema` 只给元数据：状态三列、`ownerWorkerId`、`generation`、`profileKey`（键而非绝对路径）、TTL 与时间戳、当前 `ACTIVE` 租约、`disposable`。没有 Cookie、没有页面句柄，也没有可用于驱动浏览器的东西。

### `@cairn/db` 处置与列表

```ts
listSessions(db): Promise<SessionDto[]>                       // 只列占键的会话
toSessionDto(row, lease): SessionDto
disposeStuckSession(db, { sessionId, actor, note? }): Promise<SessionDto>
DISPOSABLE_SESSION_STATUSES                                    // CREATING / CLOSING / LOST
```

`disposeStuckSession` 行锁 → 校验可处置 → 撤租约 → 关会话 → 写审计，同一事务；对已 `CLOSED` 幂等。`OPEN` 抛 `SESSION_NOT_DISPOSABLE`，不存在抛 `SESSION_NOT_FOUND`，两者都经 `mapPgRestriction` / `DomainError` 走既有 HTTP 映射。

## 5. 文件

| 区域 | 动作 |
| --- | --- |
| `packages/shared/src/session.ts`、`run.ts`、`run-api.ts`、`env.ts`、`index.ts` | 状态词表、错误码、`sessionPolicySchema`、快照与创建入参的可选字段、`browserEnvShape` 并入 `workerEnvSchema`（含 `superRefine`） |
| `packages/db/migrations/0008_browser_session.sql` | 两张表、约束、索引、`target_accounts (id, target_id)` 唯一索引 |
| `packages/db/src/schema/session.ts`、`src/sessions/`、`src/audit/record.ts`、`index.ts` | Drizzle 表、Repository、`recordAudit` 公共写入（原来在 runs / scenarios 各一份） |
| `packages/db/migrations/0009_session_dispose.sql` | 系统角色补种 `session:read` / `session:dispose` |
| `packages/api/src/browser-sessions/` | 控制面：列表与处置（controller / service / module / http spec） |
| `packages/db/src/__tests__/schema-parity.test.ts` | 表清单、列与约束断言、`0008` / `0009` 的 `skipped` |
| `packages/secret/` | 新库包 `@cairn/secret`：`LocalSecretProvider` 从 api 抽出。worker 也要解密，但它不能进 `shared`——web 依赖 shared，`node:crypto` 不该出现在浏览器构建路径上 |
| `packages/worker/package.json` | 加 `playwright` 与 `@cairn/secret` 依赖、二进制安装脚本 |
| `packages/worker/src/browser/` | `runtime.ts`（唯一 playwright 边界）、`session-manager.ts`、`profiles.ts`（目录规则与 0700）、`guard.ts`（命令面校验）、`browser.module.ts` |
| `packages/worker/src/engine/ports.ts`、`engine.ts` | `BrowserPort` 与消费点（本期只接线，不加 Step 类型） |
| `packages/worker/src/runtime/lifecycle.service.ts` | 回收 tick、启动 `reconcileOwn`、停机关会话与租约 |
| `packages/worker/src/engine/engine.boundary.spec.ts` | 扩一条：引擎目录不得引用 `../browser` |
| `.env.example` | D11 的全部变量 |
| `docs/spec/README.md`、`CHANGELOG` | 方案登记与落地记录（§22） |

## 6. 实施顺序

1. **shared**：状态词表、错误码、`sessionPolicySchema`、快照与创建入参字段、env 片段与 `superRefine`；正反例（非法状态、TTL 关系倒置、`LEASE_TTL < 3×HEARTBEAT`、快照缺字段仍可解析）。
2. **db**：`0008` + parity + Repository；SQL 级并发测试（同会话并发获取只有一个成功、唯一索引兜底、过期扫描幂等、CAS 写入）。
3. **worker / runtime**：`launchSession` / `probeHealth` / `probeAuth` / `loginWithCredentials` / `stopSession`，用 `tests/target-login-hmi` 做夹具。
4. **worker / manager**：`acquire → renew → release → reap → reconcileOwn` 与 guard；单测覆盖丢租即停、认证占用、D8 三档复用、profile 目录规则。
5. **接线**：`BrowserPort` 注入、`LifecycleService` 的回收 tick 与停机收口、启动 `reconcileOwn`。
6. **回写**：本方案状态改已落地、`docs/spec/README.md` 登记、`CHANGELOG` 一行、同步修订 `docs/arch/03` §6 词表。

## 7. 验收

1. 空库迁移与上一版本升级通过；parity 含两张表、列、唯一索引与 CHECK；重复迁移的 `skipped` 含 `0008_browser_session.sql`；`pnpm check:migrations` 通过。
2. 同键并发创建：两个事务同时插入同 `(target_id, target_account_id)`，只有一个成功，另一个拿到 `SESSION_BUSY`；`CLOSED` 后可以再建。
3. `LOST` 会话**阻塞**同键新建：`LOST` 行存在时插入失败；转 `CLOSED` 后才放行。
4. 同会话并发获取租约：两个 Run 同时 `acquire`，只有一个拿到 `ACTIVE`；另一个得到 `SESSION_BUSY` 且带当前 holder 与 `expiresAt`；DB 里 `session_leases` 的 `ACTIVE` 行恒为 1。
5. 幂等：同一 `(session, run, holder)` 重复 `acquire` 返回同一条租约，不新增行、不递增 `fencing_token`。
6. 续租：租约未过期且 holder 匹配则延长；holder 不匹配、已过期或会话已换代（`generation` 变化）时 0 行，调用方判 `SESSION_LEASE_LOST`。
7. 丢租即停：把租约 `expires_at` 写成过去后调用浏览器命令 → 被 guard 拒绝；续租失败后同一 grant 的任何命令都失败，恢复需要重新 `acquire` 并换新 token。
8. 提交边界：租约在 Attempt 提交前被过期，`SIDE_EFFECT` 步骤不写成功结果而转 `NEEDS_REVIEW`；`READ_ONLY` 步骤转失败。两种情况下都不出现「租约已失效但结果记为 SUCCEEDED」。
9. 过期扫描幂等：连续跑两轮，第二轮不再改任何行；`RELEASED` / `REVOKED` 的旧租约不被改成 `EXPIRED`。
10. 空闲 TTL：`last_used_at` 拨到阈值前，owner 的回收把会话推进 `CLOSING`；关掉浏览器后 `CLOSED`，键释放。
11. 探针不延寿：反复 `probeHealth` / `probeAuth` 不改变 `last_used_at`；空闲会话仍按 TTL 被回收。
12. 有租约或有认证占用时不回收：分别构造两种情况，回收 tick 不把会话推进 `CLOSING`。
13. 重启自愈：伪造 `owner_worker_id = 本进程` 的 `OPEN` 会话与 `ACTIVE` 租约，Worker 启动后租约 `REVOKED`、会话 `CLOSED`、键可再建；profile 目录仍在。
14. 停机：`onApplicationShutdown` 后回收定时器已停、本进程名下无 `ACTIVE` 租约、无遗留浏览器进程；Nest 测试上下文能正常关闭。
15. 复用与隔离（RF10）：同一账号连续两个 Run 复用同一 Context，自动登录只发生一次；另一账号使用独立 profile 目录与独立会话，Cookie 不串。
16. 崩溃（RF12）：杀掉浏览器进程后探针判 `UNHEALTHY`，owner 走 `CLOSING` → `CLOSED` 后同键可重建；进程是否退出无法确认时进 `LOST` 并阻塞新会话，等人工处置。
17. 认证等待：`captchaMode != 'none'` 或 `authMethod = 'manual'` 时 Run 置 `WAITING_FOR_AUTH` 且租约已释放、认证占用存在；等待超时后 Run `SESSION_AUTH_TIMEOUT`，会话仍 `OPEN`。
18. `SESSION_ACCOUNT_REQUIRED`：没有 `targetAccountId` 的 Run 请求会话时失败，不产生 `browser_sessions` 行（宪法：未绑定 Target 的 Scenario 不得执行）。
19. 惰性启动（RF04）：无浏览器二进制的环境里 Echo → Delay → Fail 全部通过，不出现 `browser_sessions` 行、不 import playwright；`pnpm check:deps` 与扩展后的 `engine.boundary.spec.ts` 通过。
20. 容量：`CAIRN_BROWSER_MAX_SESSIONS = 1` 时第二个键的获取返回 `SESSION_CAPACITY_EXCEEDED`，不排队、不开第二份。
21. 页面不累积（RF17）：同一会话连跑 50 次 `acquire → release`，页面数不超过 1，无遗留业务页。
22. 配置：`LEASE_TTL < 3×HEARTBEAT`、`MAX_LIFETIME <= IDLE_TTL`、非 development 配相对 `PROFILE_DIR` 时启动失败，输出只有变量名与规则；`.env.example` 与 schema 键名逐一对应。
23. `pnpm test`、`pnpm lint`、`pnpm typecheck` 通过。
24. 处置出口（D13）：`LOST` 会话经 `POST /browser-sessions/:id/dispose` 转 `CLOSED`（`close_reason = operator_disposed`），其 `ACTIVE` 租约转 `REVOKED`，同键可立即再建且 `generation` 前进；`OPEN` 会话处置返回 409 `SESSION_NOT_DISPOSABLE`，状态不变；重复处置幂等且不改写 `close_reason`；不存在返回 404 `SESSION_NOT_FOUND`；审计含操作者、目标会话与 `note`。
25. 处置的权限与授权：`GET /browser-sessions` 需 `session:read`，处置需 `session:dispose`；只有 `session:read` 的账号处置得 403；未认证得 401；`0009` 迁移后 admin 的权限集仍与 `PERMISSIONS` 逐项相等（否则按钮可见但接口 403）。
26. 处置后 worker 收尾（D13）：本进程仍持有句柄的已处置会话，下一次 `reap()` 停掉浏览器、丢弃句柄、清 guard 与租约映射（`session.disposed_externally`），浏览器进程数归零；页数归零。
27. 列表只给元数据：`GET /browser-sessions` 的项不含 Cookie / storageState / profile 绝对路径；只列占键的会话（`CLOSED` 不出现）；`disposable` 仅在 `CREATING` / `CLOSING` / `LOST` 为真。

## 8. 刻意留给后续

| 阶段 | 本方案结束后仍缺的 |
| --- | --- |
| Affinity / 容量排队 | P3 心跳与 Worker 注册到位后，把 Run 路由到健康 owner；容量不足改为等待而不是失败 |
| 跨 Worker 失联 | owner 失联判定 → `LOST`（本期只到 SQL 形状与人工处置出口）；确认旧进程停止后的自动隔离与重建流程 |
| 处置面 | Web 界面（P7 的会话只读页里加处置按钮）、批量处置、按 Target 的会话视图；本期只有 API |
| 认证通道 | 人工登录的可达界面（headful 本机 / 远程可视化 / 扩展桥）；`WAITING_FOR_AUTH` 期间释放 RunLease 并由恢复扫描重新领取、增代 |
| 复用档位 | `NEW_CONTEXT`（需要改成 browser + storageState 播种），以及每个 Target 的策略列与 UI |
| 页面能力 | P5 的 `BrowserPort` 扩展、Surface 与 TargetResolver |
| 证据 | 浏览器 Attempt 的证据挂 `sessionId` / `generation` / `leaseId`；截图与 Trace（P6） |
| 观察面 | 会话事件与指标（P7），Web 只读展示 |
| 运维 | profile 目录的保留期与清理、登录态跨机迁移、会话上限的集中配置 |

## 9. 债务

1. `generation` 取同键历史最大值 + 1 依赖唯一索引串行化；键被 `CLOSED` 后立即重建时，旧行仍在表里所以计数连续。若以后物理删除历史行，计数会回退——不许删会话行。
2. 命令面用进程内 guard，不逐条回库。事件循环被同步阻塞超过租约 TTL 时会自证丢租（这是期望行为），但表现为「明明没崩却丢了租约」；排障要靠 `lease.renew_failed` 日志。
3. `run_fencing_token` 在 P3 未落地前为 `NULL`，此时只能证明「我是会话的持有者」，不能证明「我仍是这个 Run 的合法执行者」。单 Worker 阶段可接受；P3 落地必须回填并收紧为 `NOT NULL`。
4. 认证等待期间 Run 仍占住该 Worker 的执行槽（`WAITING_FOR_AUTH` 已经写库，但释放与重新领取要 P3 的恢复扫描）。单 Worker 下表现为「等人登录时不能跑别的 Run」。
5. 非 owner 不碰别人浏览器的规则靠 `owner_worker_id` 过滤，DB 层没有强制「只有 owner 能写 health / auth_state」。多 Worker 落地时应加显式校验或按 owner 分离的写权限。
6. 处置是**声明式**的：操作者说旧浏览器已停，平台无法验证。若实际操作者判断错误，处置会释放键并允许同键重建，而旧进程可能仍在跑同一 profile——此时靠 Chromium 的 `userDataDir` 单实例锁兜底（表现为新会话 `PROFILE_LOCKED`），不是靠平台。要真正消除这一档风险，需要跨 Worker 的进程可见性（P3 心跳 + 隔离流程）。
7. 浏览器崩溃后 profile 目录里可能留下带锁的残留（`SingletonLock`）；`PROFILE_LOCKED` 时本期靠人工清理，没有自动恢复。
8. 相对 `CAIRN_BROWSER_PROFILE_DIR` 在非 development 下启动失败与对象存储同规则，但两者的根目录约定各自维护，没有共用解析函数。
9. profile 目录含登录态，权限靠 0700 与「不上传」两条约定，没有加密；Worker 磁盘被读取即等于账号被接管。合规要求提高时需评估磁盘加密或专门的凭证存储。

## 10. 更新历史

- 2026-09-10：按评审意见重写。原稿以外部项目（PulseAI）为基线、表设计与本仓约定冲突、状态机与 `docs/arch/03` §6 不一致、缺少唯一性约束与验收标准；本稿删除外部基线，改为以宪法、路线图 P4 与仓内既有契约为事实源。
- 2026-09-11：落地。shared 词表与 env、`0008` 迁移与 Repository、worker `src/browser/`、Lifecycle 回收与自愈、`finishAttempt` 提交边界；`docs/arch/03` §6 词表已按 D2 修订。
- 2026-09-11：补齐认证闭环——`WAITING_FOR_AUTH` 写库、认证占用超时 → `SESSION_AUTH_TIMEOUT`、worker 侧 LocalSecretProvider 自动登录、`SESSION_LEASE_UNKNOWN`、换代续租测试、可选 chromium runtime 测、`browser:install` 脚本。
- 2026-09-11：P1 收口——快照平台默认与 env 默认对齐测试、RF04 零 session 行断言、D8 复用档位单测、RF17 50 页、认证文案与 `.env.example` 去重。说明：ExecutionEngine 本期只注入 BrowserPort、不调用（无浏览器 Step）；P5 前正式 Run 不走 acquire。
- 2026-09-11：复查补口——`LOST` 原本是只写状态（占键且无出口，同 Target+TargetAccount 会被永久锁死）。按 D13 补最小人工处置入口：`GET /browser-sessions` + `POST /browser-sessions/:id/dispose`（`session:read` / `session:dispose`，`0009` 补种系统角色）、`disposeStuckSession` 同事务撤租约与写审计、worker `reap` 对账丢弃已处置句柄。同时把 `recordAudit` 从 runs / scenarios 的各一份收敛成 `packages/db/src/audit/record.ts`。
- 2026-09-11：修订——worker 的 playwright 与 web 对齐到 1.63.0（同一 chromium revision 1243，装一次两处共用），分叉由 `tools/check-deps.mjs` 的 `SHARED_VERSION_DEPS` 卡住。对齐后 worker 的浏览器测试首次真正运行，暴露出两处此前被「无 chromium 就 skip」掩盖的问题：`loginWithCredentials` 在登录失败时抛异常而不是返回 false（违反其 `Promise<boolean>` 契约，把可解释的认证失败变成调用方未捕获异常），以及集成用例共用 Target+TargetAccount 键、指向公网 `example.com`。前者改为内部收敛为 false，后者改用内嵌登录夹具并让每个用例各领账号。worker 测试 48 通过 0 跳过（原 47 通过 1 跳过）。
- 待后续：路线图 P4 中 Affinity 与失联处置；P5 页面能力（Engine 消费 BrowserPort）；人工认证可达通道；处置面 Web 界面。
