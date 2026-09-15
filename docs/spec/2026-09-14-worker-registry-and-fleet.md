# Worker 登记、内部入口与执行节点治理

日期：2026-09-14。状态：**已落地（2026-09-14）**。[评审与修订对照](../reviews/2026-09-14-worker-registry-review.md)记录设计问题；[实施报告](../reviews/2026-09-14-worker-registry-implementation.md)记录验收。WR03 跨命名空间 HTTPS、WR13 旧/新二进制升级未跑，跳过≠通过。

对应：Browser Runtime 所有权、[受管浏览器查看](2026-09-13-managed-browser-view-and-auth.md)的 API 转发、已有 `registerWorker` / 心跳 / `browser_sessions`。交付顺序只维护在[工程计划第 5 节](../plan/识途开发路线与工程实施计划.md#5-当前交付顺序与验收样例)。**不新增 D 阶段，不改变 D0–D4。**

本机环境变量映射仍够 D1 试跑。第二台 Worker 或跨主机 API 扩容前，须完成本文的登记、失联与代次隔离、内部转发和部署验收。

## 1. 要交付的结果

1. Worker 直接向数据库登记 `workerId`、`instanceId`、生命周期、容量、失联期限与可选内部入口，并持续上报心跳和句柄采样。
2. 任一 API 根据同一份有效登记找到 Session 的 owner；转发同时校验 Worker 存活、实例代次和 Session 归属。两个 API 必须能实际连接同一 owner，不能只比较地址字符串。
3. 治理页「执行节点」展示生命周期、心跳新鲜度、容量和 Session 计数。内部地址仅向运维权限用户显示；卡死会话沿用 dispose，不在本页开画面。

## 2. 非目标

- Worker 不向 API 注册、续心跳或回写执行事实，不配置多组控制面地址。
- 不持久化画面帧、Cookie、`userDataDir` 绝对路径或 CDP 调试串；不把内存 Page 清单作为控制面事实源。
- 不做 Session 跨 Worker 热迁移，不让新进程继承旧进程的浏览器控制权；登记接管不等于浏览器已停止。
- 不新增会话账本、节点级调度操作、远程桌面或自动句柄修复。会话策略继续走[配置中心](2026-09-13-platform-configuration-center-assessment.md)。
- 不向开放服务 API 暴露节点治理。本次升级采用维护窗口，不承诺新旧版本混跑或零停机升级。

## 3. 已有基础与本线改动

| 已有实现 | 本线改动 |
| --- | --- |
| `registerWorker` 通过行锁、主键防止同 ID 并发首注册 | 保留锁与主键；改为按旧登记的持久化期限判定能否接管，不采用申请者的阈值 |
| `heartbeatWorker` 按 `id + instanceId + READY` 更新 | 再要求原登记尚未到期；同事务更新期限、内部入口及遥测 |
| 停机写入与部分收尾只按 Worker ID 查找 | 生命周期写入增加实例条件；收尾只处理本实例的原始 grant 和句柄，不重查并取得新实例的 grant |
| Session 只有 `ownerWorkerId`，认证 hold 另有专用实例字段 | 增加 Session 的 `ownerWorkerInstanceId`；普通观察、认证与会话维护共用明确归属 |
| 环境变量映射与 HMAC 转发 | 登记有效且入口为空时才查旧映射；无效登记不能通过回退绕过 |
| 共享状态含 `READY / DRAINING / STOPPED / LOST` | 完整复用 `workerStatusSchema`，不缩减状态 |
| `session:read`、`session:dispose` 与处置审计 | 沿用权限；列表与详情统一投影内部入口 |
| 数据库启动检查要求迁移版本一致 | 保留门禁，补维护窗口、存量登记失效初始化与回滚边界 |

这些是本线必须实现的契约，不能把现有函数名视为相应保障已经完成。

## 4. 登记、到期与代次隔离

```text
Worker ──写入──► workers / browser_sessions / leases       （事实源）
API    ──读取──► 同一库 ──TLS + HMAC──► owner 内部入口      （跨机）
Web    ──GET/POST──► 任一 API（可经控制面 Nginx / VIP）
```

### 4.1 同一时钟和期限

数据库时间是登记、续期、接管、失联扫描和读取新鲜度的唯一比较时钟。发生锁等待时，判定使用取得锁后的数据库实际时间，不能沿用请求进入或事务开始时的过期时间快照。`lostAfterSeconds` 在新实例登记时冻结；之后心跳使用该行保存的值，不读取调用者的新配置来延长旧实例期限。

- 登记和成功心跳在同一事务写 `heartbeatAt = dbNow`、`heartbeatExpiresAt = dbNow + lostAfterSeconds`。
- `heartbeatFresh = heartbeatExpiresAt != null && heartbeatExpiresAt > asOf`；`asOf` 来自本次数据库读取。相等即过期。生命周期单独展示，不能因心跳新鲜就把 STOPPED 显示为 READY。
- 心跳条件为 `id + instanceId + READY + heartbeatExpiresAt > dbNow`。更新 0 行时沿用 `lost / instance_taken` 分流；到期后不得由迟到心跳复活同一代次。
- `markLostWorkers` 按每行的 `heartbeatExpiresAt <= dbNow` 原子将 READY/DRAINING 改为 LOST，不再接受扫描者的统一失联阈值。扫描与心跳使用相同条件与锁语义。
- 即使没有任何 Worker 执行失联扫描，API 也须即时按期限拒绝转发；只读 GET 不负责把状态改成 LOST。

`heartbeatExpiresAt` 与策略、心跳必须成组写入并由数据库操作及契约测试保证一致；不开放单独改期限的业务接口。

### 4.2 登记与接管

`workers.id` 仍是唯一登记键。并发首注册只允许主键胜出的一个进程成功。

1. 在事务中锁定旧登记。旧行尚未到期且非 STOPPED 时，另一实例收到 `WORKER_ID_CONFLICT`。申请者的阈值不参与旧行判定。
2. 旧行已到期，或当前实例已用受保护的停机流程明确写成 STOPPED，才允许新 `instanceId` 接管。缺少期限且非 STOPPED 的行不允许猜测接管；按第 10 节先完成升级初始化。
3. 接管同事务改写实例、期限、容量、入口并重置遥测连续差异；保留现有撤销旧 RunLease 和后续恢复收敛语义。登记失败不能留下半写入口。
4. 登记不提供可任意重试的同代次 upsert。成功实例后续只走心跳；重复登记同一代次不得再次撤销租约。提交结果未知时，只能核对自身实例是否已经登记成功，不能重放撤租副作用。
5. 新实例不接管旧 Session 的浏览器句柄。旧代次或归属未知的未关闭 Session 进入 LOST 隔离并保留账号键；确认旧浏览器停止或隔离后才能走已有处置/重建路径，不能因新登记成功直接标 CLOSED。

Worker 在绑定内部服务、自身会话检查完成后才开放内部命令和开始领取；启动失败须以本实例条件撤下登记。内部服务尚未就绪期间即使 API 尝试转发，也只允许返回既有降级结果。

### 4.3 所有生命周期写入都要保护实例代次

- `markWorkerDraining`、`markWorkerStopped`、入口更新和遥测写入都要求 `workerId + instanceId`，并校验允许的原状态；0 行即失去登记权，不能再按 Worker ID 无条件补写。STOPPED 只在本实例收尾完成后写入；失联扫描负责 LOST，不伪造正常停机。
- 停机先停止领取和接收输入，收口在途领取，再处理本进程已经持有的原始 RunGrant / SessionGrant。删除停机中仅按 Worker ID 重新加载所有 ACTIVE RunLease 的做法；新实例的 grant 不能进入旧进程的清理集合。
- Session 的创建、续租、关闭、认证 hold 维护和本实例批量清理携带 owner 实例；资源写入还校验 Session generation、lease ID / fencing。迟到收尾失配时只释放本地句柄，不能改新代次行。
- `reconcileOwn` 等批量操作也必须按实例归属处理。跨实例隔离须原子确认当前登记仍是本次观察到的版本，且待隔离 Session 仍属于所见旧实例/generation；登记或 Session 已变化则重读，不把扫描结果中的 Worker ID 当作稍后可无条件批量写入的授权。
- Worker 收到 `instance_taken` 后停止命令、关闭本地流与句柄并退出；自愈使用新实例代次。HMAC 中的 `workerInstanceId` 校验保留，不能代替上述数据库条件。

本节是本线实施范围，WR02/WR11 必须覆盖；不留作未来清理。

## 5. 持久化字段与内部地址

### 5.1 三库增量迁移

实施时为 PostgreSQL、MySQL、SQLite 分别新增迁移，不修改已发布脚本；本次工作区预计编号为 PostgreSQL `0030`、MySQL/SQLite `0014`，落地前核对是否已被其他方案占用。

`workers` 增加：

| 列 | 类型与语义 |
| --- | --- |
| `internal_base_url` | nullable，规范化后的 origin；只描述当前 `instanceId` 的受限内部服务 |
| `lost_after_seconds` | nullable 正整数；新实例必须写入，存量未知值保持 null，不能臆测历史策略 |
| `heartbeat_expires_at` | nullable 时间；新实例与心跳成组写入，存量初始化见第 10 节 |
| `live_handle_count` | nullable 非负整数；当前进程 live map 的采样，null 表示未上报，不能用默认 0 代替 |
| `sampled_slot_count` | nullable 非负整数；接受该次心跳时按第 7 节聚合的占用槽位，用于解释采样差异，不代替实时计数 |
| `handle_mismatch_streak` | 0–2 的整数，默认 0；连续差异样本数，超过 2 仍保存 2，仅作提示 |

成功登记/心跳原子写入遥测组合；采样时刻取同事务 `heartbeatAt`，对外命名为 `handleSampledAt`。没有句柄样本时两个计数均为 null、连续差异为 0。接管必须覆盖或清空所有入口与遥测字段，不能继承旧实例的值。

`browser_sessions` 增加 nullable `owner_worker_instance_id`。新 Session 创建时必须与 owner Worker ID、generation 一起写入，之后不得原地改给新实例。存量 null 是未知归属，禁止复用、观察或输入，按第 4.2 节隔离；认证 hold 的实例还须与该字段一致。旧 Session 的归属不根据当前 `workers.instanceId` 自动回填。

shared Schema、数据库操作输入、三库 CHECK/索引、记录映射和迁移/逻辑导入校验同步覆盖这些约束。Session 控制面 DTO 可增加 nullable `ownerWorkerInstanceId`；字段既可解释旧记录，也不能成为客户端选择执行实例的参数。

### 5.2 监听地址不自动成为广告地址

增加 API 与 Worker 共用的部署配置 `CAIRN_WORKER_NETWORK_MODE = local | distributed`，默认 `local`。local 只适用于所有 API 与 Worker 共享同一网络命名空间的部署；不同机器或容器网络均按 distributed 配置。

1. 显式设置 `CAIRN_WORKER_ADVERTISE_URL` 时，校验并登记该值。未设置时 `internal_base_url = null`，**不从监听 host/port 自动拼接**。
2. local 模式可继续使用 API 的 `CAIRN_WORKER_ENDPOINTS`；保留当前本机默认映射。没有对应映射则降级。
3. distributed 模式每个 Worker 必须有显式、非 loopback 的 HTTPS 广告 URL；缺失即拒绝启动。API 未配置旧映射时使用空映射，不注入本机默认值；显式映射也须符合 distributed 校验。
4. `CAIRN_WORKER_INTERNAL_PORT = 0` 只用于 local 测试；入口明确写 null，且不允许同时配置广告 URL。distributed 模式拒绝不监听。
5. 本期受限内部 HTTP 服务只监听 loopback。`0.0.0.0`、`::` 和其它非 loopback 监听地址均拒启，不能依靠配置广告地址把明文 HTTP 暴露到网络。跨机入口由同机或同一网络命名空间的 TLS 代理提供，见第 10 节。

### 5.3 扩展共享 URL 校验

扩展 `assertWorkerEndpointAllowed`，让登记、配置启动检查、环境变量回退和运行时查表使用同一规则；现有函数只查协议，不能原样使用。

- 仅允许 HTTP/HTTPS；HTTP 只在 local 模式允许 loopback。distributed 模式不接受任何 loopback 入口。
- 禁止 userinfo、非根路径、query、fragment、unix socket、通配/未指定主机。IPv6 先按 URL 标准解析后校验；规范化存储为 `URL.origin`，允许输入根 `/` 后去除。
- 本期将 9222 保留为调试端口，禁止用它登记平台内部服务，且要求入口专门指向受限内部服务。端口检查不能证明服务身份，不能取代 HMAC、实例校验和固定路由。
- API 禁止跟随内部转发的重定向。URL 不合格时拒绝该登记的转发，不降级去猜另一个端点。

## 6. API 查表转发

### 6.1 一份解析结果绑定地址与身份

由 db 层提供带 Runtime Schema 的 `resolveWorkerRoute(runId)` 读取：按原有 Run placement / 绑定 auth hold 找到确切 Session，一致读取 Session 的 owner ID、owner instance、generation，以及对应 Worker 的实例、状态、期限、入口与数据库 `asOf`。普通 Session 和认证 Session 均有明确实例来源。

API 只能消费这份解析结果；内部地址、签名实例和 Session generation 不得来自分开的新旧查询。客户端不能提供 Worker 地址或选择实例。两台 API 只读不会相互争抢登记，但读取可能与 Worker 接管交错，仍要靠如下校验拒绝迟到请求。

1. 执行画面与认证只接受 OPEN 且归属完整的 Session，Worker 为 READY、心跳未到期，Session owner instance 必须等于 Worker instance。其余 Session 状态只提供数据库元数据降级。
2. 普通观察继续校验该 Run 的有效 Session 关联及运行/租约状态；认证操作另校验 hold 绑定的 Run、Session generation、实例与期限，不能只看到 owner 相同就授予控制权。
3. 若 `internalBaseUrl` 非空，校验后使用。只有登记与归属有效、该字段为空时才查 `CAIRN_WORKER_ENDPOINTS[workerId]`。
4. Worker 缺失、非 READY、期限未知/到期、Session 实例未知/失配、库内入口无效时直接降级；不能回退环境变量绕过门禁。库内有效入口拨号失败也不切换到另一地址。
5. Worker 内部入口验证签名与本地实例，并复核数据库中当前登记及 Session 归属。排队的认证命令在既有串行输入闸门执行前再次校验；连接建立后接管也不能继续使用旧代次输入或画面。

### 6.2 有界转发与降级

连接/TLS 建立上限 3 秒；元数据与流响应头上限 10 秒；认证 POST 响应上限 30 秒。请求取消和超时均撤销上游请求；不向客户端透传地址、证书路径或原始网络异常。

普通读失败沿用 `WORKER_UNREACHABLE` 与所有权元数据降级；进程代次失配沿用对应的代次降级。认证 POST 超时/断连若无法证明请求尚未送出，返回 HTTP 503、稳定码 `WORKER_RESULT_UNKNOWN` 和“结果未知，请先查看状态”；加入 shared 的受管浏览器错误词表，仍使用现有错误信封。上游明确返回的 `authControlInputReceipt.status = unknown` 保持原语义，不伪造 accepted 回执。Web 对两种未知结果都禁止自动重试点击、文字输入、回车或认证恢复。

SSE 在响应头建立后不套整流 10 秒超时。沿用 B 线的鉴权与回收机制，API 将当前 Worker 实例/期限、Session 归属纳入每 15 秒复核；Worker 在既有逐帧鉴权中也检查当前登记与归属，发现失配即关流和中止上游。认证串行闸门的命令检查仍逐次执行，不能等下一次复核。本线不修改帧编码或增加图像轮询。

治理 GET 只读数据库与本 API 的部署映射，不主动调用 `/meta` 或订阅画面。其 `routeAvailability = eligible | unavailable` 仅表示登记是否满足转发条件，不声称网络已经探测成功。受限原因词表为 `worker_not_ready`、`registration_incomplete`、`heartbeat_expired`、`endpoint_missing`、`endpoint_invalid`；实际拨号结果仍在发生请求的运行视图表达。

## 7. Session 计数与句柄采样

列表和详情的数据库计数使用同一 `asOf` 与一致读取；按 Session ID 去重，不因历史 Run/Lease join 倍增。

| 口径 | 定义 |
| --- | --- |
| 占用槽位 | owner Worker ID 相同，`status ∈ {CREATING, OPEN, CLOSING}`；不排除旧/未知实例残留，避免隐藏实际占键 |
| 失联占用 | owner Worker ID 相同，`status = LOST`；仍保留账号键 |
| 执行占用 | 占用槽位中，当前实例归属和 generation 匹配，存在未到期 ACTIVE SessionLease 及其匹配的有效 RunLease；按 Run ID/fencing 精确关联 |
| 在跑 | 执行占用中，关联 Run 为 RUNNING |
| 调试暂停 | 执行占用中，关联 Run 为 HOLDING；占容量，但不显示为正在执行动作 |
| 等待认证 | 占用槽位中，存在未到期、Run/Session generation/owner instance 完整绑定的 auth hold，且该 Run 为 WAITING_FOR_AUTH；不按 TargetAccount 找任意等待 Run |
| 遗留认证占用 | 有未过期 hold，但绑定不完整；只展示待清理，不计为可操作的等待认证 |
| 过期租约残留 | 占用槽位中仍有 `ACTIVE` 但已过期的 SessionLease；不计执行占用，展示等待既有回收器收敛 |
| Run 容量占用 | 当前 Worker 名下未到期 ACTIVE RunLease 数，包含 HOLDING；与浏览器 Session 数分开 |

`profileKey` 只展示稳定键，不拼路径；Session 列表仍有 target/account、生命周期、健康、认证和 `disposable`。槽位计数来自实时数据库聚合，不从句柄遥测反推。

每次成功心跳在有效实例的事务中记录 live map 数与当时数据库槽位数，差值为 `liveHandleCount - sampledSlotCount`，不与稍后 GET 的实时计数直接比较。该采样横跨内存与数据库，不能视为原子浏览器快照：

- 未上报、实例更换或样本对应的登记已到期：差异状态为 `unknown`，可展示带时间的历史样本，不报当前句柄异常。
- 差为 0：连续差异计数归 0；第一次非 0：计为 1，只提示“采样差异，待复核”。
- 同实例连续两次成功心跳均有差异：计为 2，提示“持续采样差异”，仍不能直接诊断泄漏或改变 Session 状态。中间缺样本则重置为 0。

## 8. 控制面接口与权限

仍只 GET / POST，开放服务不挂这些路由。

| 接口 | 权限 | 用途 |
| --- | --- | --- |
| `GET /api/workers` | `session:read` | 分页节点摘要、计数与转发条件 |
| `GET /api/workers/:workerId` | `session:read` | 节点摘要 + 分页的未 CLOSED Session 列表 |
| `GET /api/browser-sessions` | `session:read` | 保留既有返回行为，只增加可选 `ownerWorkerId` 筛选 |
| `POST /api/browser-sessions/:sessionId/dispose` | `session:dispose` | 沿用现有处置语义、确认说明与审计 |

### 8.1 Runtime Schema 与查询边界

shared 定义节点摘要、详情、查询和响应 Schema，并直接复用 `workerStatusSchema`、`sessionDtoSchema` 与现有日期/游标约束。

- 摘要至少含 `workerId`、`instanceId`、四值 `status`、`heartbeatAt`、nullable `lostAfterSeconds / heartbeatExpiresAt`、`heartbeatFresh`、`capacity / maxSessions`、第 7 节计数、句柄采样与差异状态、`routeAvailability`、nullable 降级原因、`endpointSource = database | environment | none`。
- 列表响应为 `{ items, nextCursor, asOf }`。按稳定 Worker ID 升序分页，`limit` 默认 20、上限 100；支持 Worker ID 搜索、四值状态和心跳新鲜度筛选。游标与筛选绑定，非法参数返回校验错误。
- 详情响应为 `{ worker, sessions: { items, nextCursor }, asOf }`。Session 仅取非 CLOSED，按 `createdAt DESC, id DESC` 排序；使用独立 Session 游标与相同 limit 上限，可按生命周期筛选。计数统计该 Worker 全部相关 Session，不因详情分页或筛选改变。
- 当前 `/browser-sessions` 客户端不因本线突然收到截断列表或改变信封；新增治理详情通过独立的有界查询读取。节点不存在返回 404。
- 日期比较和派生计数在 db 层用一致读取完成；跨请求翻页不承诺冻结整个运行中的舰队，每页携带自己的 `asOf`。GET 不改登记或 Lease。

### 8.2 内部入口统一投影

具有 `session:read` 的 author 可看节点标识、状态、计数和转发条件，**不返回真实 host、port、协议或 baseUrl**。Worker ID 是可见的运维标识，部署时使用独立节点名，不把内部 URL 编进 ID；这不是对所有基础设施身份信息保密的承诺。

同时具有 `session:read + session:dispose` 的用户可见 `internalEndpoint: { baseUrl, host, port, protocol }`；admin 通过既有权限全集自然获得，不增加角色名硬编码。其他用户返回 `internalEndpoint: null`，不通过“只删 baseUrl”伪装隔离。列表、详情、错误和能力预览共用投影与权限判断；原始 Worker 行不能整包序列化到 Web。

viewer 没有 `session:read`，菜单隐藏、直接 GET 拒绝。dispose 仍以实际权限决定；自定义/叠加角色同样按权限并集判定，不能只测试系统角色名。处置按钮还必须满足 Session 的 `disposable`，确认旧浏览器已停止或隔离的说明继续进入审计。

## 9. 治理页

按[前端工作流](../design/front/ai-workflow.md)复用 Target 列表、审计页和已有 Token/组件：标题 → 筛选与分页表格 → 详情。

- **任务**：判断执行节点生命周期与心跳、浏览器占用和为何转发降级。
- **主操作**：手动刷新，无节点级调度动作；可处置的残留 Session 在详情中提供危险操作，不作为页头主按钮。
- **布局**：治理侧栏「执行节点」，`/workers`，权限 `session:read`；能力预览增加 `menu.workers`。窄屏先表后独立详情，不嵌 BrowserView、不拉帧。
- **生命周期**：READY 且心跳新鲜显示就绪；READY 但过期显示“就绪登记已过期”；DRAINING 显示收尾中；STOPPED 显示已停止；LOST 显示失联。沿用语义 Token，文字与图标共同区分状态。
- **新鲜度与遥测**：生命周期始终保留，旁边独立展示心跳时间；STOPPED 不因历史心跳新鲜变绿，也不被显示成异常失联。句柄第一次差异为待复核，连续差异才有警告；失联/未知样本显示时刻和未知提示。
- **信息层次**：在跑、调试暂停、等待认证与过期残留分开；内部入口仅在有权限的详情区域展示。空列表、加载失败、无权限、节点消失和处置冲突均有明确反馈。

显示“截至 asOf”的读取时间，以手动刷新获取新样本，不新增高频轮询。侧栏标题不用“会话”，不把这一测试约定误解为禁止展示 Session 详情。

## 10. 实施归属、部署与升级

### 10.1 实施归属

| 位置 | 职责 |
| --- | --- |
| shared | 登记/路由/摘要/查询 Schema、四值状态复用、URL 与部署配置校验、结果未知错误语义 |
| db | 三库迁移与约束、期限冻结/到期谓词、实例条件写入、Session 归属、旧登记初始化、批量清理保护、聚合与分页 |
| worker | 显式广告配置、句柄采样、自愈/停机隔离、受限入口的当前实例与归属校验；不引入控制面 HTTP 客户端 |
| api | 一份路由解析结果、严格回退、超时/取消/禁重放、治理读取和权限投影、错误脱敏 |
| web | 治理列表与详情、四值生命周期、采样语义、能力预览和处置确认 |
| 部署 | 唯一 Worker ID、网络模式、TLS 代理/信任、维护窗口、升级与回滚验证 |

INV002 保持 Worker 不回调控制面；INV007 保持 Web 不含 Worker 地址映射或 CDP 串，授权详情只展示元数据；INV008 保持 API 不 import Playwright。业务接口只 GET/POST。

### 10.2 本期支持的网络拓扑

local 模式使用同一网络命名空间内的 loopback HTTP，可不设广告 URL。分布式采用以下固定拓扑：

```text
任一 API ──HTTPS + HMAC──► 每 Worker 专用 TLS 入口
                              └──同机/同命名空间 loopback HTTP──► Worker
```

例如 Worker `worker-a` 监听 `127.0.0.1:8091`，声明 `CAIRN_WORKER_NETWORK_MODE=distributed` 与 `CAIRN_WORKER_ADVERTISE_URL=https://worker-a.internal:8443`；同机 TLS 代理把专用入口转到该 loopback。容器部署要求代理与 Worker 共享网络命名空间，本期不支持 TLS 终止后再跨网络明文转发。

API 也设置 distributed 模式，信任入口证书链并验证主机名。代理只开放必要的内部路径，保留签名头和原始请求体，关闭 SSE 缓冲；其超时不得短于第 6 节限制。不得把多个不同 Worker 随机负载均衡到同一个广告 origin，也不得关闭证书验证。HMAC 密钥仍通过已有部署密钥配置共享，不写广告 URL。

控制面 Nginx/VIP 只承担客户端到 API 的入口；Worker 专用 TLS 代理是独立链路职责，即使部署使用同一软件也不能混为注册服务。维护文档须给出这两条链路的可运行配置和故障排查方式。

跨机数据库使用 PostgreSQL/MySQL。SQLite 只支持本机文件与同机进程，不因本方案而支持共享网络文件；完整范围继续引用[数据库支持说明](../../deploy/database-backends.md)。

### 10.3 维护窗口与存量初始化

1. 预先准备新版本包、TLS 入口和已验证备份；停止新 Run 领取/业务写入，收口执行与必要证据，停止旧 API、Worker、调度和其他写入者，并确认旧执行进程/浏览器已停止或完成隔离。未确认的旧浏览器继续保留 Session 隔离状态，不能以升级释放账号键。
2. 用匹配新版本的迁移工具执行三库对应增量。新增字段后，在迁移中主动使存量登记失效：保留旧心跳及实例信息，`lost_after_seconds = null`，`heartbeat_expires_at = 迁移数据库时间`；旧 READY/DRAINING 转 LOST，旧 STOPPED/LOST 保留。入口和遥测置为未知。这是在已停写前提下注销旧登记，不是推断其历史失联阈值。
3. 存量 Session 的 owner instance 保持 null。新代码的复用/控制谓词拒绝未知归属；启动核对将旧/未知未关闭会话隔离为 LOST，保留账号键和证据，通过已有处置与重建恢复，不从新 Worker 实例反填归属。
4. 启动相同结构版本的新 API/Worker。Worker 新登记写完整策略、未来期限与自己的入口；完成受保护的旧资源收敛后再领取。逐个确认节点、真实转发、认证和证据链后恢复业务入口。
5. 迁移前失败可继续运行旧版；迁移后不得只回滚可执行文件。尚无新业务写入时，可以在全部停止后恢复已验证的升级前备份并恢复整套旧版。已有新业务事实后，优先前向修复；回退须先保存和处理增量，不能恢复旧备份丢掉新事实。MySQL 部分 DDL 失败按数据库说明恢复，不手改完成标记。

迁移操作保留当前严格版本检查。它不能同时承担零停机兼容；如果以后需要混合版本运行，应另行设计受约束的兼容窗口。

| 进程 / 数据库 | 本期支持 |
| --- | --- |
| 旧进程 + 旧库 | 升级前正常使用 |
| 新进程 + 旧库 | 启动检查拒绝，先执行匹配迁移 |
| 旧进程 + 新库 | 重新启动会被版本检查拒绝；已经运行的旧进程也不允许留在维护窗口后 |
| 新进程 + 新库，登记完整但入口为空 | local 模式可用旧环境变量映射，或无映射时降级 |
| 新进程 + 新库，存量登记/Session 未初始化完整 | 显示过期或未知，拒绝转发与复用，按本节完成初始化/隔离 |

这里的“环境变量兼容”只保留配置方式，不表示未升级 Worker 可以继续写新库。

## 11. 验收

所有编号表示必须证明的结果。实施后的执行情况见[实施报告](../reviews/2026-09-14-worker-registry-implementation.md)；跳过不等于通过。

| 编号 | 必须证明 |
| --- | --- |
| WR01 只写库 | Worker 登记/心跳不发起控制面 HTTP，依赖与生产路径检查继续挡住；开放服务无节点治理路由 |
| WR02 去重与迟到停机 | 同 ID 双开只有一方成功；到期后新实例接管入口。旧实例迟到心跳、停机和批量清理均不能改新状态/入口、释放新 grant 或关闭新 Session；新实例仍可正常续租 |
| WR03 横向 API | 两个不同网络命名空间的 API 读取同一库，分别实际访问两个 Worker 的正确 owner；不能用“地址字符串相同”代替可达性 |
| WR04 查表转发 | 无环境变量映射时使用库内广告入口，完成正确 owner 的元数据与受控认证链路；错误实例、证书不可信、TLS 错配、重定向均不能误转发 |
| WR05 严格回退 | 仅有效实例/期限/Session 归属且库内入口为空时允许旧映射；READY 但过期、未知归属、非 READY、库内 URL 无效或拨号失败均不得换用映射 |
| WR06 地址校验 | 无广告 URL 不自动登记 loopback；distributed 缺广告/使用 loopback/非 HTTPS 拒启；通配监听拒启。覆盖 userinfo、path/query/fragment、IPv6、调试端口和 port=0 的配置矩阵 |
| WR07 计数与采样 | 槽位/LOST 与数据库一致；过期 ACTIVE 不算执行中，HOLDING 单列，认证按确切 hold/Run 关联。覆盖未上报、第一次差异、连续差异、样本到期及实例更换；遥测不改 Session 事实 |
| WR08 权限 | viewer 菜单隐藏且直接 GET 拒绝；author 的列表/详情无可重建入口的字段；运维权限可见入口；自定义/叠加角色按权限并集，dispose 保留权限、状态与确认审计 |
| WR09 安全与关流 | 错误/日志不带内部 URL、密钥或调试串；本页不订阅画面。运行流在身份/期限失效后关闭；连接黑洞有界结束，认证结果未知不自动重试 |
| WR10 期限一致性 | 旧实例 120 秒、心跳年龄 90 秒，新申请者/扫描者设 60 秒仍不能提前接管或判 LOST；验证相等边界、迟到心跳、数据库时钟、最后一台 Worker 死亡后 API 的即时过期拒绝 |
| WR11 Session 代次 | 普通 Session、认证 hold、Worker 登记代次一致；接管穿插在解析/发送/排队输入之间时旧请求拒绝。存量 null 不反填、不授予控制权；未知旧浏览器保持隔离和账号键 |
| WR12 状态与有界读取 | 同一响应含 READY/DRAINING/STOPPED/LOST 均通过共享 Schema；STOPPED 显示正确。验证分页、过滤、总计不随页变化、旧 `/browser-sessions` 客户端兼容及页面正常/异常/窄屏状态 |
| WR13 升级 | 用实际旧/新版本及三库验证兼容矩阵、迁移初始化、严格启动门禁、受控恢复；MySQL 中断保持阻断。映射兼容测试不能替代升级测试 |

三库必须运行登记竞争、到期、实例条件更新、Session 归属、计数/分页和迁移契约；跨进程和跨命名空间验证用服务端数据库。缺少第二台物理机时，可用隔离容器网络证明 WR03/04，但须实际走 HTTPS、信任链和 owner 请求；同一命名空间的两个端口只能记录为本机进程验证，不能据此关闭分布式验收。跳过不等于通过。

## 12. 与其它线的关系

D1 本机试跑可继续使用现有配置方式。本方案只处理节点登记、路由与治理及其必要的存活/代次保障；不替代 D1 联合验收，也不重开 B 线的帧协议。HOLDING 按[编写观察与调试方案](2026-09-14-authoring-observation-debug-steps.md)的实际契约统计，不在此引入新的调试语义。

本文已按评审修订并实施。验证写入 `docs/reviews/` 并登记 CHANGELOG；WR03/WR13 仍见实施报告，跳过≠通过。WR09 连接 3s 已由 API 转发的 undici `connectTimeout` 实现，TLS 握手证明仍未跑。
