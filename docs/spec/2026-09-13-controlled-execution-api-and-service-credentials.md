# 受控执行 API 与服务凭据基础方案

日期：2026-09-13。状态：**基础功能已实施，二次复查的 3 项复现缺陷已修复并通过回归；其他验收缺口仍保留**。最新修复与验证见第 14 节；第 12、13 节保留历史实施与复查记录，不代表全部验收项已满足。

目标：外部应用持有服务凭据，在被授权的 Target 与 TargetAccount 范围内提交执行任务、获取结果与证据，并受用量限制；所有任务复用现有 Run、Execution Engine、Browser Runtime 与 Evidence。

用户已确认先建设基础能力，不等待整个平台或所有模块完善。用户已授权自审通过后直接开发；按本方案建议先开放已发布版本调用。交付安排只维护在[工程实施计划第 5 节](../plan/识途开发路线与工程实施计划.md#5-当前交付顺序与验收样例)，本文的任务编号用于拆分与验收，不构成另一套排期。

## 1. 已确认的需求与本方案建议

### 1.1 用户已确认

- 外部调用方通过 API 调用识途执行框架完成任务。
- API Key 必须限制可调度的目标系统范围。
- 服务凭据不用于管理平台，不开放用户、RBAC、系统设置等管理能力。
- 现在先做必要底座，不以整个 MVP、完整开放平台或全部功能模块完成为前置。

### 1.2 自审后的实施决定

- 首批服务端集成由控制台管理员登记与授权；使用稳定的服务调用方身份和可轮换的 API Key。
- 授权以 Target 为主，并显式限定可使用的 TargetAccount；默认无授权，不自动授予账号全集。
- **先以“调用已发布 Scenario 版本并传入参数”验证基础闭环。** 用户授权按方案开发后，首版采用此入口；直接提交 Structured Step 留待明确需求追加，凭据和授权底座不依赖任务只能来自发布场景。
- 基础版本提供异步提交、按需查询、取消和经过授权的证据访问；SSE 接入 P7 时复用同一授权逻辑，不以 SSE、Live View、完整录制、动作库或所有 AI 类型完成作为开始开发的条件。

## 2. 交付范围

| 本次基础能力 | 交付行为 |
| --- | --- |
| 服务调用方 | 管理名称、负责人、启停状态及执行限额；作为 Run、幂等和用量的稳定归属 |
| 服务凭据 | 签发、仅展示一次的 Secret、到期、轮换、吊销、最近使用信息 |
| 执行授权 | 封闭的执行操作集合、Target 白名单、目标账号白名单、显式无账号执行许可 |
| 执行 API | 已授权资源说明、提交已发布版本、查询本调用方 Run、取消、结果与证据读取 |
| 受理保护 | 输入校验、请求限速、未终结 Run 上限、执行到期、重复提交去重 |
| 归属与审计 | 区分控制台用户与服务调用方，关联凭据 ID、requestId、runId，保留事实与审计原子性 |
| 最小管理页面 | 复用控制台列表、详情与表单；管理员配置调用方、凭据、目标范围和限额 |

本次不开放管理接口给服务凭据，不建设外部用户注册、OAuth 授权服务器、开发者门户、计费、Webhook、SDK 产品线或多租户 SaaS。不接受任意 JS、CDP 命令或浏览器连接租借。外部“任务调度”在此指提交持久化 Run，周期计划管理不在本次范围。

平台 RBAC 仅用于内部人员管理服务调用方和凭据；外部凭据使用独立的执行范围，不绑定控制台角色。外部任务需要人工认证或副作用核查时，返回现有状态，由有权限的控制台人员处理，不向服务凭据开放 `resume-auth`、`review` 或 Session 处置接口。

## 3. 当前实现与需要补齐的位置

以下记录自审时的既有能力与本次增量；实际验证见第 12 节。

| 位置 | 已有能力 | 本次增量 |
| --- | --- | --- |
| [AuthGuard](../../packages/api/src/common/auth.guard.ts)、[RequestAccount](../../packages/api/src/common/request-account.ts) | Bearer JWT 解析到控制台账号 | 按路由声明选择认证入口，增加独立的服务凭据主体；不伪造控制台用户 |
| [PermissionsGuard](../../packages/api/src/rbac/permissions.guard.ts) | 控制台动作权限；未声明权限的已认证路由放行 | 服务入口另行默认拒绝，不让这种默认规则接受服务凭据 |
| [RunsService](../../packages/api/src/runs/runs.service.ts)、[RunsController](../../packages/api/src/runs/runs.controller.ts) | 创建、查询、取消、证据访问 | 查询目前不携带资源范围；增加外部受理和按调用方、Target、账号过滤的读取操作 |
| [Run Repository](../../packages/db/src/runs/runs.ts) | 已发布版本校验、Target/账号关系、Snapshot、幂等创建 | 服务主体归属、原子授权与限额、外部请求摘要；复用创建 Run 的共同事务逻辑 |
| [Run 表](../../packages/db/src/schema/execution.ts)、[审计](../../packages/db/src/audit/record.ts) | 创建者/actor 关联控制台账号；幂等按控制台账号划分 | 增加服务调用方关联与数据库约束，保留现有外键和历史数据 |
| [Run DTO](../../packages/shared/src/run-api.ts)、[Evidence 映射](../../packages/db/src/objects/evidence-map.ts) | 内部详情含 Snapshot、Context、Lease；证据含对象键和原始 payload | 定义外部白名单 DTO，不整份透传内部对象 |
| [Browser Runtime](../../packages/worker/src/browser/runtime.ts)、[AI Port](../../packages/worker/src/ai/port.ts) | 显式 Navigate 校验源；AI 有当前页源检查 | 补齐拟开放 Target 的重定向、popup、Frame 及跨源动作边界验收，不能据此前置检查宣称全部导航已受控 |
| [Engine](../../packages/worker/src/engine/engine.ts)、[AI 预算](../../packages/db/src/runs/ai-budget.ts) | Step 超时/取消、按 StepRun 持久化预扣 AI 调用次数 | 补 Run 级到期边界；应用总请求/任务上限不能被当作已实现 |
| [数据库适配](2026-09-13-database-portability.md) | `@cairn/db` 公共业务边界、三库适配与迁移 | 新模型、外键、唯一性、受理事务、迁移传输纳入三库等价验收 |

## 4. 接入结构与身份

```text
控制台用户 JWT → 现有 RBAC → 服务调用方/凭据管理

外部应用 API Key → 服务认证 → 执行操作 + Target/账号范围
                            → 原子受理：授权、幂等、限额、Snapshot、Run、审计
                            → 现有持久化队列 → Worker → Engine → 受管浏览器
                            → 按归属和当前授权读取结果/Evidence
```

API 仍为无状态控制面，外部路由直接调用应用服务与 `@cairn/db` 业务操作，不通过 HTTP 再调用自己的控制台 API。Worker 不接收外部 API Key，不新增执行队列、浏览器池或第二套 Run 状态机。

### 4.1 最小逻辑模型

| 对象 | 必要信息与约束 |
| --- | --- |
| `ServiceCaller` 服务调用方 | `id`、名称、负责人、启停状态、请求速率/未终结任务/运行时长限制、创建与更新时间；不具有控制台登录身份或角色 |
| `ServiceCredential` 服务凭据 | `id`、`callerId`、名称、Secret 校验值、到期/吊销时间、执行 scopes、最近认证时间、授权 revision、签发人；`callerId` 有外键 |
| `CredentialTargetGrant` | 凭据与 Target 的唯一关联、`allowAnonymous`；Target 与凭据均有外键 |
| `CredentialTargetAccountGrant` | 引用一个 Target 授权项及允许的 TargetAccount；同一账号只登记一次，数据库约束保证账号属于该授权项的 Target |

一个应用就是一个 ServiceCaller，不再并列建设 Application、ServiceAccount、Client 三套一对一模型。Key 的 Secret 仅负责认证；同一调用方的不同 Key 可以具有不同 Target/账号范围和执行 scopes，但共享调用方限额。

目标账号表可补 `(target_id, id)` 唯一约束，账号授权表通过复合外键保证归属；具体物理字段由 `@cairn/db` 的三库迁移维护，不把账号 ID 数组当作唯一的完整性保障。服务调用方和凭据采用停用/吊销保留记录，存在 Run/审计引用时不物理删除。

### 4.2 Run 与审计迁移

- 保留 `createdByConsoleAccountId` 的含义，新增 `serviceCallerId` 和 `serviceCredentialId`；Run 的两类创建主体必须且只能存在一个。服务创建时必须有关联凭据，并以复合外键保证该凭据属于该调用方。
- 已有控制台创建记录不改归属，既有 Scenario / ScenarioVersion / Draft 作者字段不在本次泛化。只扩展实际有服务调用者的 Run、受理和审计链。
- Run 上新增不可变、经过 Runtime Schema 校验的 `serviceAdmission`：保存协议版本、请求关联 ID、凭据授权 revision、实际 Target/账号、使用的执行 scopes 和生效限额，不保存 Secret 或整份账号配置。与 Run 和审计同事务写入。
- 审计增加服务 actor、凭据 ID、requestId 与来源信息；操作事件只能归属一种主体，原有未知账号登录/系统事件的合法空 actor 仍可保留。扩展现有审计模型，不新建第二套业务审计流水。
- 内部 actor 契约使用可运行时验证的 `console | service` 判别结构；各持久化列仍由真实外键和 CHECK 约束保护，不能退化成无外键的任意 `actorType + actorId`。
- 外部 Run 的幂等唯一性按 `(serviceCallerId, idempotencyKey)` 建立；保留控制台现有唯一约束。三库对 NULL、大小写和并发冲突的行为须一致。

## 5. 凭据与授权契约

### 5.1 签发、认证和轮换

建议使用 `Authorization: Bearer cairn_sk_<credentialId>.<secret>`。`credentialId` 用于定位记录，不具备独立认证能力；Secret 用 Node 标准库 `randomBytes(32)` 生成并编码，数据库保存域分隔后的 SHA-256 校验值，比较固定长度摘要使用 `timingSafeEqual`。这是针对系统生成的高熵随机凭据的方案，不替换现有用户密码哈希。[Node 24 Crypto](https://nodejs.org/docs/latest-v24.x/api/crypto.html)

- Secret 仅在签发响应中返回一次；响应 `Cache-Control: no-store`。页面关闭后不保留在 localStorage、URL、审计、日志或错误中；遗失后重新签发。
- 首版所有凭据必须有到期时间，建议默认 90 天，由管理员在平台允许上限内配置。有效状态依据数据库时间、调用方启停与凭据吊销/到期共同计算。
- 每次认证读取持久化状态，首版不缓存授权、不再交换长生命周期 JWT。失效、格式错误与不存在统一返回 401；数据库故障按服务故障返回，不能误报凭据失效，更不能放行。
- 轮换复用“签发新 Key → 调用方切换 → 吊销旧 Key”。新 Key 可由管理员显式复制旧授权，但不扩大范围；两把 Key 共用调用方配额与幂等命名空间。
- Key 只面向服务端保存与调用，不作为浏览器前端配置。正式外部入口通过 HTTPS；可用现有入口设施限制未认证流量，不为本次新增 API 网关产品。[OWASP REST Security](https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html#api-keys)

### 5.2 操作范围与资源范围

服务 scope 为封闭集合：`run:execute`、`run:read`、`run:cancel`、`evidence:read`、`ai:execute`。这些名称用于服务执行授权，不把全部控制台权限目录作为可选项，不允许通配符、角色名或管理员继承。`evidence:read` 必须同时具备 `run:read`；含 AI 的新任务同时需要 `run:execute` 与 `ai:execute`，且平台实际支持该 AI 能力。

Target 授权的首版语义是：允许调用该 Target 下平台已发布的场景，新增已发布场景会进入该范围。控制台必须明确展示这一含义；Scenario 级例外清单按首个实际需要追加，不默认预建另一套授权层。请求必须显式指定已发布版本，不能以 `latest` 或省略版本静默改变执行定义。

服务端按以下规则判断，不信任调用方声明的归属：

1. 从已持久化的 Scenario 和版本解析实际 Target，校验版本确属该 Scenario 且为 published。
2. 当前 Key 必须获得该 Target 的授权；账号既属于 Target，也必须出现在 Key 的账号授权中。省略账号只有 `allowAnonymous=true` 才合法，不自动挑选一个账号。当前 Browser Runtime 要求 TargetAccount，因此无账号许可仅适用于不使用浏览器的步骤；浏览器任务缺少账号在受理时返回 `SESSION_ACCOUNT_REQUIRED`。
3. 读取/取消 Run 时，必须属于同一 ServiceCaller，且该 Run 冻结的 Target/账号仍在当前 Key 授权中；用当前 Scenario 的 Target 判断历史访问不合法。
4. Evidence 元数据和内容下载必须检查 Run 归属、当前资源授权、读取 scope，以及 Evidence 与 Run 的关联。随机 UUID 不替代授权。
5. 对查询/取消的不可见资源统一返回 404；有身份但缺少操作 scope 返回 403。列表先在持久化查询中施加范围和分页，不先查全库再在前端过滤。

这些检查共同防止持有合法 Key 的应用通过更换对象 ID 访问别人的任务。[OWASP 对象级授权](https://api-security.owasp.org/editions/2023/en/0xa1-broken-object-level-authorization/)

### 5.3 路由与执行范围

外部执行路由显式声明服务认证和所需 scopes；其余路由不接受服务凭据。现有全局 AuthGuard 需要按显式路由元数据分派，不能给外部 Controller 标记 `@Public()` 后寄希望于每个方法自觉补验证。控制台 JWT 也不被隐式当作服务凭据。

浏览器访问范围继续来自 Target 的平台配置及冻结 Snapshot，外部请求不能覆盖 `allowedOrigins`、模型地址、凭据引用、Session 策略或 Evidence 保留策略。明确 URL、自动跳转、popup 和可操作 Frame 的目标范围必须统一纳管；页面内容与 AI 输出不能扩大授权。

现有 Navigate 的请求前源检查和 AI 当前页检查不能证明重定向请求在发出前被阻断。对外开放前，应在共享 Browser Runtime/受管动作边界验证并补齐拒绝；不能仅在动作之后发现越界并将 Run 标失败。依赖跨源认证的 Target 要记录经过批准的源范围；无法满足范围限制的 Target 暂不签发外部执行授权。这里的业务目标授权也不等价于已经实现任意互联网浏览器的完整网络沙箱。

### 5.4 吊销与在途运行

吊销 Key、缩小授权或停用调用方，对之后的受理和查询生效；与受理并发时，以共享事务锁/条件更新确定合法先后。已经受理的 Run 按冻结定义、限额与原有所有权执行，不因普通轮换改写 Snapshot。

停用调用方不伪装成已经停止浏览器。紧急停止需由内部有权限的人员对该调用方任务发出持久化取消请求，仍经过既有取消、丢租和副作用未知处理；不能直接把运行状态改成 CANCELLED。首版可通过现有 Run 处置完成，不要求先做批量管理框架。

## 6. 外部 API 契约

以下为已实现路径，不是宪法不变量。沿用全局 `/api` 前缀，仅 GET / POST；JSON 错误复用现有 `code/message/requestId` 契约。

| 方法与路径 | scope | 首版返回/动作 |
| --- | --- | --- |
| `GET /api/open/v1/targets` | `run:execute` | 授权 Target 的最小目录、允许的账号引用和是否可无账号执行；无口令/Secret 引用 |
| `GET /api/open/v1/targets/:targetId/scenarios` | `run:execute` | 范围内可调用场景、所有已发布版本 ID、已声明参数、是否含 AI；不返回草稿与内部配置 |
| `POST /api/open/v1/runs` | `run:execute`；含 AI 另需 `ai:execute` | 持久化受理后返回 Run ID 与状态；首次 201，幂等复用 200 |
| `GET /api/open/v1/runs` | `run:read` | 只列本调用方且当前 Key 可见的 Run；稳定游标与分页上限 |
| `GET /api/open/v1/runs/:runId` | `run:read` | 状态、时间、步骤/Attempt 状态、已发布业务输出与错误码 |
| `POST /api/open/v1/runs/:runId/cancel` | `run:cancel` | 请求取消；返回实际状态，不承诺请求返回时浏览器已经停止 |
| `GET /api/open/v1/runs/:runId/evidence` | `run:read` + `evidence:read` | 已批准外发类型的索引、关联、类型和大小；业务输出含 payload，截图按 ID 拼接内容路由 |
| `GET /api/open/v1/runs/:runId/evidence/:evidenceId/content` | `run:read` + `evidence:read` | 鉴权后读取对象内容；不接受调用方传 objectKey |

所有列表使用服务端游标、默认 20/最多 100 条；目录中账号信息也须有有界返回契约，不能因嵌套数组绕过上限。现有 Scenario 参数声明仅有 key/label，首版文档不能伪称已有完整 JSON Schema 类型系统；提交复用现有结构校验与参数引用校验。

提交示例（ID 为占位，不含真实凭据）：

```http
POST /api/open/v1/runs
Authorization: Bearer cairn_sk_<credentialId>.<secret>
Content-Type: application/json
```

```json
{
  "scenarioId": "<scenario-id>",
  "scenarioVersionId": "<published-version-id>",
  "targetAccountId": "<authorized-account-id>",
  "input": { "orderId": "DEMO-001" },
  "idempotencyKey": "order-check-20260913-001"
}
```

外部提交 Schema 使用严格字段白名单，版本 ID 和幂等键必填，不透传当前内部 `CreateRunBody` 的 policy、sessionPolicy、evidencePolicy 等覆盖能力。Body 有字节上限，input 的键数、嵌套 JSON 大小及声明参数均需校验。业务参数可以包含场景明确定义的数据，但不得用于覆盖模型配置、追加步骤或扩大浏览器访问范围。

### 6.1 结果与证据的对外投影

外部 DTO 复用状态词表和必要子 Schema，单独选择字段；不复用完整 `RunDetailDto` 或 `EvidenceMetadata`。保留步骤顺序、名称/类型、Attempt、状态、错误码及已人工发布的业务输出；Expected/Actual 只有进入已发布业务输出时才返回；不暴露完整 Snapshot/Context、原始模型请求、系统提示、模型服务地址、Secret 引用、对象键、Worker 地址、Lease 或 fencing token。

首版新增持久化 `externalAccess` 标记，默认关闭；控制台已有运行证据项提供“发布给外部调用方 / 取消对外发布”操作和审核确认。运行查询中的 Attempt.output 默认 null，仅填入已发布的业务 output Evidence；提交/幂等重放响应不附带业务输出。外发证据限于人工检查后的结构化业务输出和 PNG/JPEG/WebP 截图；Trace、原始日志与 AI 审计原文默认只供控制台使用。`evidence:read` 是读取允许外发证据的权限，不表示读取全部存储对象。截图不能靠文本字段脱敏获得安全保证；包含认证页或敏感区域、无法完成遮罩/确认外发的证据必须拒绝对外下载，并返回明确的不可外发状态。原始证据仍按平台策略保留，不能为了隐藏内容删除历史事实。

GET 从持久化事实读取，API 重启后仍可恢复。P7 尚未完成时，本版只承诺按需查询，不附带高频轮询客户端；后续 SSE 以相同主体、资源和证据权限输出变化提示，重连重新鉴权并补读。SSE 未验收不能被列为本版已交付能力。

## 7. 原子受理、幂等与资源上限

### 7.1 受理操作

在 `@cairn/db` 增加一个完整的外部受理业务操作，复用 `createRunWithSnapshot` 的校验、快照生成和 Run/StepRun 插入逻辑。必要时将现有函数中的事务内部分提取为共同实现，不复制一份 Run 创建流程，也不让 API 拼接多个独立提交的 Repository 调用。

事务内按约定顺序锁定调用方、凭据/授权及相关资源，重新确认身份有效期、授权 revision、Target/账号状态与归属；授权调整使用兼容的锁定顺序。校验、限额、Snapshot、Run、StepRun、幂等约束和操作审计一起提交。鉴权 Guard 的一次成功不能替代此处的并发一致性校验。

重试请求先在当前授权允许的范围内寻找已受理的 Run，再处理新任务的容量与运行配置；有效重试不因当前配额已满、平台默认值变化、Scenario 后来停用或模型暂不可用而新建任务/改写原结果。资源授权已被收回时仍拒绝访问旧结果。

### 7.2 幂等语义

外部请求摘要使用现有 canonical JSON / SHA-256 能力，输入为协议标识、显式 Scenario/版本 ID、账号（规范化省略值）和业务 input；不加入 Secret、credentialId 或之后可变的平台默认配置。同一调用方相同键同请求返回原 Run，不同请求返回 409 `RUN_IDEMPOTENCY_CONFLICT`。

外部协议与控制台现有摘要语义分别标识，保留既有控制台行为。API 超时或提交结果不明时，调用方以原 Key/轮换后同调用方的有效 Key 和原幂等键查证，不产生第二个 Run。去重只保证受理去重，不承诺目标网站的外部副作用 exactly-once；未知结果仍进入原有核查流程。

### 7.3 基础限制

| 限制 | 首版建议 | 执行位置 |
| --- | --- | --- |
| 请求体与列表 | 请求体建议 64 KiB；列表默认 20、最大 100；现有 Step/输入上限继续执行 | 解析前字节限制 + Zod/分页校验 |
| 请求速率 | 每 ServiceCaller 固定时间窗计数，建议起始 60 次/分钟；所有 Key 共享 | 持久化原子计数，超限 429 与 `Retry-After` |
| 未终结 Run | 建议起始最多 2 个；包含 QUEUED、RUNNING、RECOVERING、WAITING_FOR_AUTH、NEEDS_REVIEW | 受理事务按调用方锁定并从 Run 状态计数 |
| Run 到期 | 建议自受理起最多 10 分钟，含排队与认证等待；可由管理员在平台上限内调整 | 持久化 deadline + Worker/恢复扫描 + 执行取消 |
| AI | 默认无 `ai:execute`；启用后使用平台受控模型、StepRun 调用次数预扣及输入/输出规模上限 | 冻结 AI 配置，Worker 在实际调用前执行预算保护 |

以上数值为试点默认建议，不是硬编码的产品不变量；生效限额取平台上限与调用方设置的较小值，外部请求不能调大。未终结任务上限同时封住积压和执行并发，不再先建设分开的应用调度器；只有出现“允许大量排队但限制运行数”的实际需求时才拆分。此限制可能保守拒绝新任务，不能超额放行。

请求速率的窗口状态可放在 ServiceCaller 行上，以数据库时间和原子更新维护，首版不引入 Redis 或通用配额服务。固定窗口在边界附近允许短时突发，属于已知上限；需要平滑流量时再替换算法。其限速计数独立于业务事务提交，失败请求和幂等重试也计入速率；幂等复用不占新 Run 名额。无效凭据流量由入口设施的全局保护承担，不能依靠不存在的 caller 计数。

Run 到期是本次实际需要新增的执行边界，现有 Step 超时不能冒充总时限。将可选 `deadlineAt` 纳入新 Run Snapshot 与摘要；历史缺字段的 Snapshot 按既有行为解释，canonical 序列化应保持历史摘要逐字不变。首次领取、后续步骤、重试和恢复均检查冻结到期时间，已过期的排队 Run 不获得执行权；Worker 到期发送原有 abort/取消，故障时由既有持久化恢复扫描收口，不只依赖一个 API 进程定时器。

到期按系统取消处理，持久化取消来源与 `RUN_DEADLINE_EXCEEDED` 原因；未开始执行的过期任务进入 CANCELLED，已执行任务沿既有取消/核查规则收口，不新增一套 Run 状态。到期发出停止请求不等于物理动作已立即停止；迟到结果、挂起 AI、浏览器隔离继续服从既有 fencing 与未知副作用规则，不强制改写成功/取消结论。NEEDS_REVIEW 继续占用未终结名额，需人工处理，不能以超时或释放名额掩盖未知事实。

AI 首版按有限任务数、步骤数、每 StepRun 调用数、请求大小和模型输出上限限制消耗；不宣称已实现按人民币/美元的精确额度或 Token 总账。费用/Token 可取得时记录，无法取得时保留 unknown；若需要日/月硬预算，再单独补预扣与结算。执行时间与第三方成本必须作为资源限制考虑，而不能只计算 HTTP QPS。[OWASP 资源消耗](https://api-security.owasp.org/editions/2023/en/0xa4-unrestricted-resource-consumption/)

## 8. 管理面、审计与运行维护

### 8.1 控制台最小页面

管理员的任务是登记调用方、签发凭据和限定执行范围。沿用[前端工作流](../design/front/ai-workflow.md)及现有 Target 管理页组合方式：列表管理、详情查看、弹窗表单，不制作独立开放平台首页。

- 主入口为“开放服务”；调用方列表展示状态、凭据数量、未终结 Run 与上限，详情内查看凭据和授权。列表主操作为“新增调用方”，详情主操作为“签发凭据”，避免同时出现多个强主按钮。
- Target/账号授权选择复用现有目录数据；默认未选、无全选默认值，显式展示“允许该目标下已发布场景”和无账号执行设置。
- Secret 仅在签发成功视图可复制；没有再次查看按钮。过期/吊销/停用状态清楚区分，轮换说明指向新旧 Key 切换流程。
- 复用 Main、PageHeader、Table、Dialog、AlertDialog、Input 和 Token；实现时覆盖空、加载、保存失败、无权限、中文长名称、键盘焦点与窄屏，执行前端验收 skill。

内部管理路由使用 GET / POST 与控制台 JWT，建议增加 `service:read` / `service:write` 权限，默认仅管理员；这是内部管理授权，不是开放 RBAC API。服务 scopes 的 Schema 永远不接受这两个权限。与[控制台产品角色方案](2026-09-13-console-product-roles-and-capability-map.md)共享权限目录/种子迁移时，按其实际合入状态同步，不以该方案尚未实施阻塞本模块，也不顺带调整其他角色。

### 8.2 审计和调用记录

调用方/Key 的创建、授权调整、轮换、吊销、停用，以及 Run 创建和取消写入现有持久化操作审计，包含内部操作人或服务 actor；服务事实与相应业务审计同事务。请求关联 ID、凭据 ID、Run ID 和结果码进入结构化日志，认证失败只记录不可重放的标识与原因分类。

不默认把每次 GET 都写成一条业务审计；最近使用和请求计数用于最小调用信息。证据下载另记安全访问日志，不写内容。复用现有 pino 脱敏基线，并覆盖签发响应、Authorization、错误对象、请求体和 AI Evidence；IP 仅来自既有可信代理解析，不信任任意转发头。

调用方停用、凭据吊销和到期由数据库状态判定，不依赖 API 重启。取消、人工认证、核查和对象缺失继续按现有状态展示。服务调用方与用户创建的 Run 可由获授权的内部人员在现有运行页面辨认和处置。

Session 继续按现有 Target + TargetAccount 策略复用；给多个调用方授权同一目标账号，意味着允许它们使用同一业务账号的认证状态，任务结果隔离不等价于独立浏览器身份。需要不同业务身份时分配不同 TargetAccount，本次不改变单账号 Session/Lease 一致性规则。

## 9. 代码改动边界与可独立验收的工作项

| 工作项 | 修改范围与复用点 | 独立验收结果 |
| --- | --- | --- |
| EX01 身份与持久化 | shared 服务契约；db 新模型/三库迁移；Run、审计 actor 与传输适配 | 有外键的服务归属、控制台存量不变、跨库迁移不丢主体与授权 |
| EX02 凭据与管理 | API 服务认证、显式路由标记、内部管理权限；最小管理页面 | 可签发、授权、轮换、吊销；服务 Key 访问平台管理接口始终失败 |
| EX03 受理与查询 | API 外部 DTO/路由；db 共享受理事务、范围查询、请求限速与幂等 | 一个已发布确定性场景完成提交—结果—取消闭环，越权与重复受理被阻断 |
| EX04 运行范围与限额 | 共享 Browser Runtime 范围检查；Snapshot deadline；Engine/领取/恢复增量 | 重定向/popup/Frame 范围、排队超期、执行中到期与迟到结果行为可证明 |
| EX05 证据与交付 | 外部 Evidence 投影/下载、现有审计、接口说明与集成样例 | 结果可复盘、证据不越权/泄密、API 重启可恢复、试点接入可复现 |

这些是同一基础交付的工作拆分，不能只完成 EX02 就宣称外部执行能力可用。EX01 可先用持久化夹具验证，EX03 可先用既有确定性执行器，无需真实模型；对外开放具体能力前须通过相应 EX04/EX05 Gate。AI 仅在平台已启用且该类别的真实执行验收满足后开放，确定性接口不被模型缺失阻断。

生产 API/Worker 只调用 `@cairn/db` 公开业务操作，不引入 Drizzle/驱动/物理表依赖；适配层同步更新 migration、records、native indexed text 配置、约束错误映射及 transfer。对 Run 创建者变更须搜索并检查全部调用方、审计 join、查询 DTO、夹具和迁移工具，不能只让新外部路由跑通。

## 10. 验收矩阵

| 编号 | 必须验证的行为 |
| --- | --- |
| EX-A01 | 有效 Key 能使用授权 Target/账号；缺失、伪造、到期、吊销和调用方停用均拒绝；数据库故障不放行 |
| EX-A02 | 枚举所有平台管理路由：服务 Key 无法读取/修改用户、RBAC、配置、Target/账号定义、Scenario 草稿，也无法签发新 Key；新增未标注路由默认拒绝 |
| EX-A03 | 伪造 Target、错配 Scenario/版本、换用同 Target 的未授权账号、省略未许可账号均失败；两个调用方共享 Target 也不能互读/取消 Run |
| EX-A04 | Evidence ID 串 Run、直接请求内容、遍历列表及换用权限较小 Key 均不能绕过归属和当前授权；不外发对象键、Secret 引用或未批准的原始证据 |
| EX-A05 | 两个 API 实例并发同键提交只产生一个 Run/StepRun/审计；同键异输入 409；轮换 Key 后同请求仍复用原 Run |
| EX-A06 | 达到容量上限后，新任务 429，合法幂等重试仍复用；凭据轮换不重置限额；请求失败仍计速率；终态释放名额，NEEDS_REVIEW 不被自动抹掉 |
| EX-A07 | 受理与授权缩小/吊销/账号停用并发，只能落入一个合法先后结果；事务回滚没有半个 Run、孤立主审计或虚假受理 |
| EX-A08 | 目标范围覆盖显式导航、服务器重定向、点击跳转、popup 与可操作 Frame；越界动作在发生前被拒绝；未验证 Target 不开放 |
| EX-A09 | 排队到期不执行；执行、认证等待、重试和恢复不延长 deadline；API/Worker 重启不丢到期边界；迟到结果不能覆盖取消/未知结论 |
| EX-A10 | 外部请求不能覆盖运行/会话/模型/证据策略；发布/编辑新版本不改变已有 Run；无 AI 配置时确定性调用正常 |
| EX-A11 | 签发后无法再次获取 Secret；真实日志/异常/审计/Evidence 样例中没有测试用 Key 或目标口令；认证截图不外发 |
| EX-A12 | PostgreSQL、MySQL、SQLite 对外键、主体互斥、大小写、幂等、并发受理、限速、迁移与旧 Snapshot 摘要给出等价结果；按既有部署支持范围验收 |
| EX-A13 | 真实浏览器执行正常/失败/取消三条样例；API 重启后 GET 还原状态与证据；执行页面显示服务调用方来源 |
| EX-A14 | 管理页无权限、空态、保存失败、一次性 Secret、轮换/吊销、键盘及窄屏通过对应前端验收；仅通过 HTTP 测试不算页面交付 |

实施时沿用现有 Vitest、真实数据库与受控靶场，补针对授权、并发和状态边界的必要案例，不新建测试框架。检查命令按影响面使用 `pnpm check`、`pnpm typecheck`、对应 API/DB/Worker 测试以及 `pnpm check:design`；只改方案时检查文档差异、链接和边界一致性，不宣称实现测试通过。

## 11. 审查点与后续扩展条件

1. **任务输入方式**：本次按已发布版本调用落地，直接提交 Structured Step 不在首版。若需要，增加受控任务定义受理：绑定 Target、Runtime Schema/Compiler 校验、持久化不可变 ScenarioVersion、再创建 Snapshot/Run；不得把 inline 请求直接交给浏览器或自造第二套任务状态。此决定影响输入/版本持久化，不推翻凭据和授权底座。
2. **授权粒度**：首版 Target 下已发布场景整体可调用，账号必须逐项授权；若实际需要只开放某几个场景，再增加 Scenario/版本清单。
3. **实时、回调与周期计划**：SSE 随 P7 复用；Webhook、周期任务和外部提交任务定义各按明确需求扩展，不能用它们未完成否定当前基础闭环。
4. **部署边界**：首批为管理员维护资源的受控集成。若升级为多个外部客户自主管理资源的共享 SaaS，租户数据/执行隔离必须单独设计并验收，不能拿 Key 的 Target 白名单替代完整租户能力。

本次完成代码、三库迁移、管理页面与集成测试；测试凭据只在隔离数据库创建。实际环境升级应先迁移再启动新版本，外部 HTTPS 入口与真实业务 Target 的授权按试点配置。


## 12. 自审修订与实施记录

自审确认沿用统一 Run/Engine，不需要等待其他模块完成。补齐以下不可省略的执行边界后实施：

- 原方案只描述了证据审核，现落实为数据库持久化外发标记和控制台人工发布；按 Run/当前授权二次检查内容读取，禁止原始 Trace、日志与 AI 调用审计外发。输出白名单不等于自动识别所有敏感业务数据。
- deadline 从受理开始，纳入 Snapshot 和不可变摘要；数据库领取、Attempt 开始/完成、恢复扫描与 Engine 取消协同。认证阶段也监听取消并关闭本次获取的会话；NEEDS_REVIEW 保留原语义。
- Chromium 原生导航拦截补齐重定向各跳，Playwright Context 拦截初始 popup。**首版保守拒绝初始 popup 的所有 HTTP 3xx 响应**，包括同源跳转；普通页面同源重定向与无重定向 popup 可用。需要跳转式 popup 登录的目标暂不接入。
- 导航和可操作 Frame 按冻结的入口源/登录源约束。跨源子资源和页面发出的普通 fetch/XHR 不构成完整网络沙箱；本版面向平台管理员维护并验证的 Target 与发布场景。
- 每个调用方一把数据库事务锁，保证限额、幂等、授权变更有明确先后顺序；固定一分钟窗口允许边界突发，需要平滑流量时才替换限速算法。每调用方最多保留 200 条凭据。
- 调用方默认 60 次/分钟、2 个未结束 Run、600 秒总时限；配置上限分别为 600 次、20 个、3600 秒。Key 默认 90 天，最大 365 天。Secret 不进入查询缓存、浏览器存储或数据库明文列。

### 12.1 迁移与启用

新增 PostgreSQL `0019_service_access.sql`、MySQL/SQLite `0005_service_access.sql`。保留现有 Run 创建者、外键和历史 Snapshot；SQLite 重建 Run 表后恢复外键并检查存量引用。跨数据库传输版本提升至 `0019`，传输包包含调用方、凭据摘要、授权、服务运行归属与审计。

升级命令沿用 `pnpm db:migrate`，随后重启新构建的 API/Worker/Web。控制台管理员从“治理 → 开放服务”登记应用、选择 Target/账号并签发 Key。仅管理员默认获得内部 `service:read/write`；自定义管理角色如需操作授权选择，还应具备已有的 `target:read`。

### 12.2 最小接入样例

只在调用方后端保存 Secret；示例环境变量由调用方配置，不能将真实 Key 写进源码。

```sh
# CAIRN_ORIGIN=https://your-platform.example
# CAIRN_SERVICE_KEY 由调用方的服务端秘密配置注入
curl -H "Authorization: Bearer $CAIRN_SERVICE_KEY"   "$CAIRN_ORIGIN/api/open/v1/targets"
curl -H "Authorization: Bearer $CAIRN_SERVICE_KEY"   "$CAIRN_ORIGIN/api/open/v1/targets/$TARGET_ID/scenarios"
curl -X POST -H "Authorization: Bearer $CAIRN_SERVICE_KEY"   -H 'Content-Type: application/json'   --data @run-request.json "$CAIRN_ORIGIN/api/open/v1/runs"
```

`run-request.json` 使用第 6 节结构。首次受理 201，原请求重放 200，同键不同输入 409；429 按 `Retry-After` 退避。随后 GET `/api/open/v1/runs/:id` 按需恢复状态，POST `/api/open/v1/runs/:id/cancel` 请求取消。该基础接口未交付 SSE，不应以高频轮询模拟常态实时进度。

业务输出由控制台检查并发布后出现在运行详情的 Attempt.output；截图索引走 GET `/api/open/v1/runs/:id/evidence`，下载走 `.../evidence/:evidenceId/content`。未发布证据、其他应用的 Run，以及当前 Key 已失去 Target/账号授权的资源均不可见。

### 12.3 验证记录

本次使用隔离的真实 PostgreSQL/MySQL/SQLite、真实 Nest HTTP 服务和 Chromium；所有服务 Key 均为测试夹具。已完成以下检查：

| 检查 | 结果 / 证据 |
| --- | --- |
| Shared 契约与历史摘要 | 25 个文件、254 项通过，包含旧 Snapshot canonical 序列化逐字断言 |
| DB 权限、迁移、执行与租约回归 | 6 个文件、153 项通过；服务专项 19 项覆盖三库幂等、容量、当前权限、吊销竞态、过期、跨库传输和 SQLite 存量升级 |
| API 基础和 HTTP 集成 | 服务专项 4 项与鉴权/GET-POST/证据回归 10 项通过；两个 Nest 实例并发同幂等键只创建一个 Run，另一个实例可读持久化状态 |
| Engine / Browser 回归 | 8 个文件、81 项通过；真实浏览器验证外部任务成功、失败、取消、发布输出，以及登录中总时限取消；执行、Session 和 AI 边界回归通过 |
| 导航边界 | 真实 Chromium 验证直接越界、连续重定向、popup、iframe，以及已授权跨站 iframe 的后续重定向；未授权服务端接收请求数为 0 |
| 控制台验收 | 真实 API 验证新建、授权修改、一次性 Secret、轮换、吊销、停用和只读角色拒绝；1440×1000 与 390×844 实测无整页横向溢出，键盘 Enter 打开弹窗可用；额外注入空列表与 503 验证展示和保留表单后重试 |
| Web 权限导航回归 | 2 个文件、13 项通过 |
| 工程检查 | shared/db/api/worker/web 构建、API/DB/Worker 类型检查、`pnpm check`、`pnpm check:design` 和 `git diff --check` 通过 |
| 日志脱敏 | 检查实际 HTTP/Worker 测试日志，未发现完整可重放服务 Key 或夹具目标口令 |
| 运行环境检查 | 只读核对当前本机 PostgreSQL 已匹配最新迁移；未重启其他任务正在使用的 API/Worker，未配置生产外部入口 |

关键可复跑用例：[服务 DB 合约](../../packages/db/src/__tests__/service-access.test.ts)、[真实 HTTP 与控制台](../../packages/api/src/services/services.http.spec.ts)、[浏览器范围](../../packages/worker/src/browser/target-scope.spec.ts)、[Engine 浏览器闭环](../../packages/worker/src/browser/engine.lab.spec.ts)。截图保存在本机 `.run/service-access/ui/`，均不含完整 Secret。

验收修正了：多库约束与 SQLite 重建位置、过期结果提交、认证中的取消传递、旧测试夹具与真实运行契约漂移、跨站 iframe 测试必须实际执行页面回调。相关修正均已重跑对应检查。

本次证明受控确定性执行基础闭环；没有用真实业务目标和真实模型完成外部客户试点。首次授权前仍需验证具体 Target 的认证、导航与所选 AI 类别。初始 popup 跳转限制、人工证据发布、有限的无账号任务、固定窗突发和单账号 Session 复用语义仍按本文执行。

## 13. 二次对照复查（2026-09-13）

结论：主体与执行架构没有走偏，仍是独立服务身份、Target/账号授权、已发布版本调用和统一 Run/Engine；没有给服务 Key 开放 RBAC 或平台管理。当前不能将“主线功能已实施、既有测试通过”视为全部 Gate 已完成。本轮确认以下 3 项实现缺陷，并发现验收覆盖不足。

本轮只复查、复现并修正文档状态，没有修改业务代码、发布迁移或重启共享开发服务。复现使用独立 PostgreSQL 数据库和临时 Nest 服务，结束后关闭服务并删除隔离库。

### 13.1 已复现的实现缺陷

**R1 / P1：超时会把未确认的副作用结果变成已取消，违背第 7.3 节与 EX-A09。**

- 位置：[deadline.ts](../../packages/db/src/runs/deadline.ts) 第 28–38 行；关联 [recover.ts](../../packages/db/src/runs/recover.ts) 的 `yieldUnfinishedRun`、`reconcileOrphanAttempts` 与 `settleLeaselessRun`。
- 复现：提交含 `SIDE_EFFECT` Click 的服务 Run，领取并开始 Attempt，按 Worker 停机路径释放租约进入 RECOVERING；超过冻结 deadline 后执行扫描。
- 实际：Run 成为 CANCELLED，原因是 `RUN_DEADLINE_EXCEEDED`，但 StepRun 和 Attempt 仍是 RUNNING；随后调用孤儿 Attempt 恢复仍返回取消，不能再补出未知结论。对照组在超时扫描前走恢复，正确进入 NEEDS_REVIEW。
- 原因：用 `status !== RUNNING` 推断可以直接取消，忽略 RECOVERING 可能有在途副作用；后续恢复看到 Run 已终态直接退出。结果既掩盖目标系统是否已提交的未知事实，也错误释放调用方名额。
- 收口要求：超期与共享取消/故障恢复统一处理在途 Attempt，未知副作用优先进入 NEEDS_REVIEW 并保留名额；同时核对租约过期恢复中的取消优先分支。不能只跳过 RECOVERING 而留下永久无法领取的超期任务。补 Worker 停机/失联 × 到期 × SIDE_EFFECT 的自动化案例。

**R2 / P2：实际启动入口的解析顺序使 64 KiB 请求体限制失效，违背第 7.3 节。**

- 复查时位置：`main.ts` 第 25–28 行、`services/body-limit.ts` 与 [AuthGuard](../../packages/api/src/common/auth.guard.ts)。修复后解析装配已统一至 [body-parsers.ts](../../packages/api/src/config/body-parsers.ts)。
- 复现：按生产 `main.ts` 的顺序先注册全局 1 MiB JSON/urlencoded parser，再注册服务 64 KiB parser，发送带 80 KiB 空白前缀的合法执行请求。
- 实际：原始请求 82,130 字节，解析后重新序列化仅 210 字节，返回 HTTP 201 并创建 QUEUED Run。期望是在解析入口返回 413。
- 原因：第二个 parser 跳过已经解析的 body；Guard 只检查重新序列化后的大小，不能恢复原始请求字节数。现有 HTTP 测试仅注册服务 parser，与真实启动顺序不一致，因此通过了大字符串案例却漏掉此问题。
- 收口要求：让服务限制在通用 parser 前生效，并使 HTTP 验收使用与启动入口一致的装配顺序；补空白填充、压缩展开后的边界和常规合法请求案例。

**R3 / P2：PostgreSQL 授权外键依赖连接 search_path，破坏指定 schema 的迁移完整性。**

- 位置：[0019_service_access.sql](../../packages/db/migrations/0019_service_access.sql) 第 43 行，`REFERENCES targets(id)` 漏掉 `"__SCHEMA__"`；[迁移函数](../../packages/db/src/migrate.ts) 接受显式 schema，但不替调用者改 search_path。
- 复现：在隔离数据库中，以 search_path 为 `cairn,public` 的连接执行 `migrate(pool, 'service_review_custom')`，查询 PostgreSQL 外键实际指向。
- 实际：`service_review_custom.credential_target_grants.target_id` 指向 `cairn.targets`，而不是 `service_review_custom.targets`。迁移表记录成功并不能证明引用正确；如果搜索路径没有同名表，该语句会失败。
- 影响边界：连接 search_path 与迁移 schema 一致的常规启动不一定触发；显式 schema 迁移及当前采用这种方式的 schema 一致性验收会受影响。可造成合法授权插入失败，或引用另一个 schema 的 Target。
- 收口要求：显式限定目标表 schema，验收外键的目标 namespace；已经执行错误迁移的库还需前向修正约束，不能只改已执行的 SQL 文件。

### 13.2 验收项逐项核对

“已有主线证据”只表示实现与已有案例对应，不表示完成任意业务目标或全部边界的验收。本轮未重跑整套历史 515 项。

| 验收项 | 对照结论 |
| --- | --- |
| EX-A01 身份有效性 | 已有有效、伪造、到期、吊销、停用及权限检查；数据库故障按服务错误处理的代码边界存在，仍缺服务入口专项故障注入 |
| EX-A02 管理接口隔离 | 默认 JWT / 显式服务路由分派方向正确；HTTP 案例仅抽查 5 个 GET 管理入口，未完成计划要求的全部管理路由及 POST 写操作枚举 |
| EX-A03 对象范围 | 已有调用方、Target/账号和版本关系校验及部分越权案例；应补齐同 Target 未授权账号、错配版本等 HTTP 负例矩阵 |
| EX-A04 证据访问 | 有人工外发标记、Run/当前授权检查和存储读取后复核；现有服务 HTTP 只查空证据列表，缺服务截图内容下载的正例、串 Run、权限缩小及下载中撤回的完整案例 |
| EX-A05 幂等 | 已有三库及双 Nest 实例并发同键受理、轮换复用证据；两个实例共用测试数据库 handle，不能据此宣称进程重启验收完成 |
| EX-A06 配额 | 已有固定窗、共享调用方名额和幂等案例；R1 会错误释放本应进入 NEEDS_REVIEW 的名额，需与恢复补测一起关闭 |
| EX-A07 原子受理 | 调用方锁覆盖凭据吊销/授权更新，已有吊销竞争案例；Target/账号状态读取没有落实第 7.1 节描述的相关资源锁，授权缩小和账号停用竞争仍需专项验证，不能视为已全部验收 |
| EX-A08 浏览器范围 | 有真实 Chromium 导航、重定向、popup、iframe 阻断案例；实际业务 Target 仍需逐个验证，初始 popup 3xx 与非完整网络沙箱限制保持明确 |
| EX-A09 总时限与恢复 | **复现失败：R1**；已有排队、活跃任务和认证中的到期案例，缺超期与副作用恢复、重试、进程重启组合 |
| EX-A10 不可覆盖策略 | 严格请求 Schema、冻结版本/摘要及 AI scope 检查存在；既有确定性无模型案例可用 |
| EX-A11 Secret / 脱敏 | 已有一次性 Secret 与日志检查；本轮 HTTP 日志 Authorization 已脱敏。认证/敏感页面截图的外发仍依赖人工检查，不应宣传为自动识别敏感图片 |
| EX-A12 三库等价 | 服务三库合约已有 19 项通过；**指定 PG schema 外键复现失败：R3**，既有测试未检查实际引用 namespace |
| EX-A13 浏览器闭环 / 重启 | 已有真实 Engine 成功、失败、取消与服务来源展示；没有实际停止并重新启动 API 后核对服务 Run 和证据的用例，也未覆盖服务任务 Worker 重启期限 |
| EX-A14 管理页面 | 已有真实 API/UI、只读角色、轮换/吊销、窄屏/键盘，以及注入空态/保存失败的验收记录；本轮沿用该记录，没有再次执行页面验收 |

手工发布输出/截图、拒绝初始 popup 3xx、只调已发布版本，以及延期 SSE / Webhook / 周期计划 / 开发者门户，均已写入本版范围或限制，本轮不将其误报为开发遗漏。它们仍是外部接入时必须明确的产品限制。

### 13.3 本轮证据与收口顺序

- 原始复现结果保存在本机 `.run/service-access/review/reproduce.log`。同目录 `reproduce.mjs` 在第 14 节修复时已改为断言正确行为，修复后的结果单独写入 `fixed-reproduction.log`，不覆盖原始缺陷证据。脚本使用构建产物，修改代码后须先构建再复跑。
- 重跑 DB 服务合约：`pnpm --filter @cairn/db exec vitest run src/__tests__/service-access.test.ts`，19 项通过。
- 重跑浏览器范围：`pnpm --filter @cairn/worker exec vitest run src/browser/target-scope.spec.ts`，2 项通过。
- 重跑 API 服务 HTTP 主线：`pnpm --filter @cairn/api exec vitest run src/services/services.http.spec.ts -t 'real global guards|concurrent HTTP retries|rate limits'`，3 项通过；1 项 UI 用例因定向选择未执行。

合计本轮重跑 24 项通过，同时新增复现确认 3 项缺陷。先修复 R1 的运行事实与未知副作用收口，再修复 R2 请求边界、R3 迁移完整性，并将本节列出的缺口补成可失败的验收案例，之后重新评定基础交付 Gate。无需为此引入新队列、网关产品、Redis 或另一套执行框架。

## 14. 缺陷修复与回归（2026-09-13）

用户已授权修复第 13 节复现的缺陷。R1、R2、R3 均已修复；此次没有将第 13.2 节所有尚缺验收一并宣称完成。

| 缺陷 | 修复与验收结果 |
| --- | --- |
| R1 超期掩盖未知副作用 | [共享取消收口](../../packages/db/src/runs/recover.ts) 先确认没有 ACTIVE RunLease，再按冻结 Step 的 effectType 处理孤儿 Attempt；SIDE_EFFECT 进入 NEEDS_REVIEW、关闭 Attempt 为 FAILED 并保留配额，安全步骤的 Attempt/StepRun 一起取消。deadline、手动取消、Worker 回交、Worker 取消结论和丢租恢复共用该处理；有效持有者仍只收到取消请求 |
| R2 请求体限制顺序 | [统一解析装配](../../packages/api/src/config/body-parsers.ts) 供 main 和 HTTP 测试共用，开放服务 64 KiB JSON/urlencoded 限制先于控制台通用 1 MiB parser；验证正好 65,536 字节可受理、超一字节拒绝、gzip 解压超限拒绝、表单编码超限拒绝 |
| R3 PG 外键 schema | 修正新安装使用的 0019 外键限定名，并新增 [0020 前向迁移](../../packages/db/migrations/0020_service_target_foreign_key.sql) 重建已执行过的约束；验证迁移 schema 与 search_path 不同、旧错误约束带存量授权升级、重复迁移幂等。遇到只属于其他 schema 的历史非法授权，迁移整体回滚并保留记录，不删除或默许非法授权 |

R1 的自动化案例在 PostgreSQL、MySQL、SQLite 分别覆盖：Worker 回交后到期、先到期再回交、到期后租约失效、持有者收口取消、恢复中手动取消；每种顺序同时覆盖副作用步骤和只读步骤，并检查未执行后续步骤、名额、重复扫描及迟到成功不可改写结论。最终核对还补上提交时 SessionLease 已失效且取消请求已到达的组合：仍检查会话所有权，副作用未知优先于取消；对应三库断言先验证失败、修复后再回归。

此次 PG 0020 只修正物理约束，不变更逻辑传输结构，因此传输格式仍为逻辑版本 `0019`；MySQL/SQLite 不需要空迁移。已有数据库通过正常迁移命令应用修复，不能仅修改磁盘上的 0019 后宣称旧库已经恢复。

### 14.1 验证记录

| 检查 | 结果 |
| --- | --- |
| DB 全量 `pnpm --filter @cairn/db exec vitest run` | 21 个文件、340 项通过，含服务专项 34 项、PG 新装/存量修复、三库迁移传输与运行/租约回归 |
| Worker 执行与生命周期 | 8 个文件、67 项通过：Engine boundary/AI/browser/integration、真实浏览器 engine.lab、target-scope、lifecycle 单元/集成 |
| 开放 API HTTP | 4 项通过，新增与生产启动共用装配的请求体边界；1 项原有 UI 用例因定向选择未执行，此次无 UI 改动 |
| API 鉴权/登录/GET-POST/证据回归 | 5 个文件、13 项通过 |
| 3 条原始复现路径复跑 | 恢复中的副作用保留 NEEDS_REVIEW，StepRun/Attempt 为 FAILED；82,130 字节请求返回 413；指定 schema 的外键引用自身 Target 表，三条断言通过 |
| 工程检查 | DB/API 生产构建、DB/Worker 全包类型检查、`pnpm check` 与本次差异检查通过 |
| API 全包类型检查 | 未通过：既有 `config/browser-ai.spec.ts:26` 使用 CommonJS 不允许的顶层 await 与无扩展名动态 import，连带第 45 行隐式 any；错误不在本次修改文件，API 生产构建通过，未改动该并行工作的测试 |
| 本机数据库 | `pnpm db:migrate` 新执行 PostgreSQL 0020，随后 `assertReady` 通过；修复前只读查询未发现 CANCELLED Run 仍有 RUNNING Attempt 的历史记录 |

最终本次去重计数为 **424 项自动化测试通过**（340 + 67 + 4 + 13），另有 3 条原始复现断言通过。日志保存在本机 `.run/service-access/review/fix-*.log` 与 `fixed-reproduction.log`，原始失败证据 `reproduce.log` 保留。

关键回归：[三库服务合约](../../packages/db/src/__tests__/service-access.test.ts)、[会话丢租与取消](../../packages/db/src/__tests__/sessions-repository.test.ts)、[PG 修复迁移](../../packages/db/src/__tests__/service-migration.test.ts)、[HTTP 请求体边界](../../packages/api/src/services/services.http.spec.ts)。本次没有增加依赖或新的执行状态，也没有重启共享开发进程。API/Worker 真正重启后的外部服务验收、全管理路由枚举及证据下载竞态等其余缺口，继续以第 13.2 节记录为准。
