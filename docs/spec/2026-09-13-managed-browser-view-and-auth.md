# P7 / P5：受管浏览器查看、认证续跑与页面交接

> 编号：B。日期：2026-09-13。状态：**审查后修订并实施**。
> 对应 P7 Live View / 受控认证、P5 页面交接、D1；S-LIVE 是本线实现选择的先行探针。
> 关联：[A 运行实时状态](2026-09-13-run-realtime-observation.md)、[C 录制回填 Studio](2026-09-13-recording-studio-integration.md)；唯一交付顺序见[工程计划第 5 节](../plan/识途开发路线与工程实施计划.md#5-当前交付顺序与验收样例)。

## 0. 审查结论（相对待审稿）

对照 2026-09-13 工作区后，待审稿的方向成立，但有若干会直接做歪的缺口。本节是修订依据，不是另开方案。

| 问题 | 修订 |
| --- | --- |
| 对外路由写成 `:id`，现网与 A 线均用 `:runId` | 统一 `GET/POST /api/runs/:runId/...` |
| A 线仍写成待审；`observation` / SSE 已落地 | 本线消费既有观察通道；页面/认证变化必须登记新事件类型，不得使用未登记字符串 |
| Worker 生产代码禁含 `/api/runs`（INV002） | 内部入口冻结为 `/internal/managed-browser/*`，禁止把控制面路径抄进 Worker |
| `enterWaitingForAuth` 实际是三次独立写入，`claimAuthHold` 返回值被忽略 | 进入等待必须单事务：绑定 hold + `authState=EXPIRED` + `WAITING_FOR_AUTH` + 释放 RunLease |
| `resumeRunAfterAuth` 只检查 `run.status`，API 直接改库 | 公开 `POST .../resume-auth` 必须转发到 owner Worker；库操作要求 hold/control epoch 匹配 |
| `authHold` 只有 workerId + 到期时间；超时 reap 按 TargetAccount 误杀全部等待 Run | hold 绑定 `runId` + `sessionGeneration` + `workerInstanceId`；reap 只处置绑定 Run；未绑定存量 hold 不授输入权 |
| 无 Worker HTTP、无地址映射、无内部密钥 | 冻结环境变量与 HMAC 签名；本机 loopback 可用 HTTP+HMAC，跨主机必须 TLS |
| `pageAfter` 若升 click executor 版本会卡死历史快照 | 可选字段，缺省=旧行为，click 仍为 version `1` |
| PageRef 不落库，但 GET 元数据写得像总能拿到当前页 | Worker 不可达时降级：DB 所有权/控制态仍返回，`framesAvailable=false`，页面列表为空 |
| `waitForPopup` 现为 context 任意新页 | `pageAfter=popup` 只接受 opener 为当前页、且落在 Target 允许来源内的唯一新页 |
| 服务凭据未写明 | 画面与认证控制不进开放服务 API |
| 迁移编号未冻结 | PostgreSQL `0024`，MySQL / SQLite `0008` |
| 画面流只在开流时看一次控制者 | Worker 每帧周期与 API 15s 复核：进入等待后非控制者立即停流 |
| 「处理登录」藏在展开后 | 等待认证时折叠态即可看到该主操作；展开才订阅画面 |
| `rel=noopener` 弹出窗口 `opener` 为空 | 记为 `PAGE_HANDOFF_NO_POPUP`，禁止改用 `context.pages()` 猜测收养 |
| 认证输入未校验当前页来源 | 有 `allowedOrigins` 时，命令执行前拒绝越权页面 |

## 1. 要交付什么

用户在 Studio 或运行详情看到 Worker 正在使用的浏览器；需要登录或验证码时，运行进入等待认证，获授权的用户取得短时独占输入权，完成目标系统登录，再将控制权交回执行器。确定性点击明确打开 popup 时，后续步骤、AI 所获受管 Page 和观察画面使用同一当前页。

三个能力放在一份方案，是因为它们共同依赖 Session 所有者、Page 身份与自动/人工控制交接。如果分别实现，容易出现“画面是一页、输入是一页、下一步又回到旧页”。

本线包括只读实时画面、最小鼠标/键盘/文本输入、认证控制权、单个 popup 交接、撤权与故障恢复。它不提供任意暂停点接管、云端录制、远程桌面、任意 CDP 调用、系统文件选择器操作或绕过业务权限的浏览器入口。

## 2. 已有基础与需要补的边界

| 已有实现 | 缺口与复用方式 |
| --- | --- |
| Worker BrowserSessionManager 管理 handle、runPages、SessionLease 与复用 | 继续是唯一 Page 所有者；补 PageRef 映射和观察/认证入口，API 不取得 Playwright Page |
| `withManagedPage` 与 BrowserPort 已被确定性及 AI Executor 使用 | 页面交接必须在此收口，不能让各 Executor 保存另一份当前页 |
| WAITING_FOR_AUTH、authHold、`resumeRunAfterAuth` 已存在 | hold 补 Run/代次/instance 绑定；AuthControl 独占输入；进入等待与恢复均改为带 fencing 的单事务；公开 resume 改走 Worker |
| `surface.ts` 点击可等 popup，但保留原页 | 增加显式 `pageAfter`；未提供时保留旧语义。popup 必须校验 opener，禁止 `context.pages().at(-1)` |
| Worker 以 Nest application context 启动，没有 HTTP | 同进程增加受限内部 HTTP；不另起执行平台 |
| A 线 `GET .../observation` 与 `GET .../events` 已落地 | 本线帧流独立；控制/交接事实落库后发登记事件，UI 仍只信观察 GET |
| Studio、Run Detail、Evidence Viewer 已有 | 嵌入共同 Browser View 面板；画面与证据用途分开 |

[配置中心方案第 11 节](2026-09-13-platform-configuration-center-assessment.md)已落地 Target 认证配置冻结与会话策略。本线消费冻结快照，不重复编写配置解析器；历史快照继续按显式兼容规则解释。

## 3. S-LIVE 先行探针

先在现有受控靶场、同一个 BrowserSessionManager 所有的 Chromium Page 上验证：

1. 使用 Page 所属 context 创建 CDP session，订阅 `Page.startScreencast` 的推送帧，及时确认帧并只保留最新待发帧。
2. 通过受控接口验证点击、滚动、快捷键和中文文本输入；测页面导航、iframe、popup、视口变化及断开后的资源回收。
3. 记录 Playwright/Chromium 精确版本、操作系统、网络条件、样本量、首帧及画面延迟、CPU/内存/带宽。
4. 分别给出画面、认证输入和 popup 的通过/限制/拒绝结论；未通过类别在能力响应里关闭。

Screencast 由 Chromium DevTools 协议提供，属于实验性能力，本线锁定实际浏览器版本验证，不能仅凭接口存在声明可靠。[CDP 官方协议定义](https://github.com/ChromeDevTools/devtools-protocol/blob/master/json/browser_protocol.json)

首选链路为 **Worker 推送最新帧 → API 鉴权转发 → Web**。MVP 采用独立 SSE 图像流，帧使用 base64 JPEG。初值限制最长边 1280、质量 60、转发不超过 2 fps，丢弃过时帧而不形成视频队列。测量不合格时先调整采样/编码；需要改传输时更新本节结论后再做，不在旁边预建 WebRTC、VNC 或截图轮询备胎。

探针实现为 Worker lab spec：`CAIRN_S_LIVE=1` 且能启动 Chromium 时，用同一个 `BrowserSessionManager` 测 CDP 首帧、中文 `insert_text`、`pageAfter=popup` 后 `pageForGrant` 与 Midscene 适配层是否同一页。无该环境变量时跳过，**跳过不等于通过，也不得把默认 `open` 写成 BV08**。能力字段先反映“实现已接通”；lab 通过只证明受控靶场接通，不自动改写 BV08 的展示路径 p95 与 20 次循环。前端仅对 `closed` 隐藏入口。

2026-09-14 本机 `CAIRN_S_LIVE=1`（Playwright 1.63 / headless Chromium / darwin）探针通过：首帧 ≤ 3s、中文 `insert_text`、popup 后 `pageForGrant` 与假模型 Midscene 适配层同一页。这不是 BV08（未测 Web 展示路径 p95，也未做 20 次连接/切页循环），也不是 BV09。

能力响应字段：

```text
capabilities = {
  screencast: 'open' | 'limited' | 'closed',
  authInput: 'open' | 'limited' | 'closed',
  popupHandoff: 'open' | 'limited' | 'closed',
  chineseInsertText: 'open' | 'closed',
}
```

未通过类别必须为 `closed`，前端不得展示对应入口。

## 4. 页面身份与 popup 的统一语义

### 4.1 PageRef

由 shared 定义可运行时校验的 `PageRef = { sessionId, sessionGeneration, pageId, documentEpoch }`。`pageId` 是平台分配的 opaque UUID，不能向 Web 暴露原始 CDP target ID 或调试地址。Session 重建使 `sessionGeneration` 失效；主文档导航递增 `documentEpoch`。

Worker 在现有 SessionManager 内维护 PageRef → Page 的有界映射。浏览器对象不持久化；数据库只保存 Session 所有权、控制代次，以及需要复盘的页面交接事实（事件 + Attempt 级 `log` 证据）。新 Run 的初始页按冻结的 Target 入口与现有会话策略初始化，不能从上一 Run 的临时 pageId 推断执行位置。

执行器调用时取当前受管页；观察者默认跟随该页。浏览器面板可临时查看其他仍存活、属于该 Run 且在 Target 允许范围内的受管页，但必须标明“查看其他页面”，**查看选择不修改执行当前页**。认证持有人切换输入页还要通过控制范围检查，不能把只读切页自动变成控制转移；前次 Run 留下的其他业务页不能自动暴露给新观察者。

GET 元数据在 Worker 可达时带上当前执行页与存活页列表；Worker 不可达或进程代次不匹配时返回 DB 中的 Session 所有权与脱敏控制态，`framesAvailable=false`，`pages=[]`。

### 4.2 显式 popup 交接

本次最小增量是确定性 click 的可选输入 `pageAfter: 'same' | 'popup'`：

- 未提供时保留旧执行语义（可等待 popup 但不收养），不静默升级现有草稿、已发布版本和 RunSnapshot。
- `same` 保持当前页。
- `popup` 在触发点击前建立监听，只接受该动作原页打开（`Page.opener()` 为当前页）、符合 Target 允许范围的一个新页。`rel=noopener` / `noreferrer` 使 opener 为空，记为 `PAGE_HANDOFF_NO_POPUP`，不得改用 `context.pages()` 的最后一个猜测成功。
- 单个有效 popup 就绪后，SessionManager 更新该 Run 的当前页，并记录带 Run/StepRun/Attempt 的 `log` 证据与 `run.page_handoff` 事件；后续确定性与 AI 调用统一取此页。
- 无 popup、多个歧义候选、跨越禁止的目标范围或 popup 立即关闭，返回明确错误（`PAGE_HANDOFF_NO_POPUP` / `PAGE_HANDOFF_AMBIGUOUS` / `PAGE_HANDOFF_OUT_OF_SCOPE` / `PAGE_HANDOFF_CLOSED`）；不能取 `context.pages()` 的最后一个猜测成功。
- 点击已经发出而交接结果未知时，按现有副作用策略收口：交接失败一律 `UNKNOWN`，进 `NEEDS_REVIEW`，不因等待新页超时或零/多 popup 自动重放点击。

输入 Schema、Compiler、Step Editor、`browserCommandSchema` 与 Executor 同步支持新字段；保持“旧字段缺省 = 旧行为”。**不提升 click executor 版本**。Worker 重启后不得凭过期 PageRef 自动继续有副作用步骤，仍服从已有恢复/核查规则。

首期不承诺任意窗口跳转/返回父页、多 popup 选择语言或完整标签页管理。C 只能把已验证的单 popup 信号转成此字段；其余录制事件显示诊断。

Midscene 当前在线验收范围是普通 DOM。页面交接通过不等于 AI 的 iframe、popup 导航、canvas 或原生 select 等类别自动通过；新增类别继续受[Midscene 接入方案](2026-09-13-midscene-runtime-integration.md)的能力闸门约束。可以单独验确定性 popup，也必须另外验 AI 消费交接后页面的具体样例（本线至少用同一 `pageForGrant` 断言，不宣称 Midscene 已覆盖 popup）。

## 5. API 转发与 Worker 内部入口

API 通过数据库查询 Session 的 `ownerWorkerId`、`generation` 和当前 Worker `instance_id`，再从部署维护的受信地址映射选择内部端点。客户端不能传入任意 URL、Worker 地址、CDP 命令或浏览器连接串。

Worker 增加一个受限内部 HTTP 服务，复用现有进程，不另起执行平台；只实现本线需要的观察订阅、认证控制和白名单输入。API 是鉴权/转发控制面，Worker 检查自身所有权并操作受管 Page，执行和认证事实由 Worker 直接写数据库。该通道不承担 Worker → API 的执行状态回调。

### 5.1 环境与网络

| 变量 | 进程 | 含义 |
| --- | --- | --- |
| `CAIRN_INTERNAL_AUTH_SECRET` | API 与 Worker | HMAC-SHA256 密钥，base64 编码恰好 32 字节。开发默认值仅 development 可用 |
| `CAIRN_WORKER_INTERNAL_HOST` | Worker | 默认 `127.0.0.1` |
| `CAIRN_WORKER_INTERNAL_PORT` | Worker | 默认 `8091`；`0` 表示不监听（测试） |
| `CAIRN_WORKER_ENDPOINTS` | API | `workerId=baseUrl` 逗号分隔，例如 `local-worker=http://127.0.0.1:8091` |

跨主机 `https://` 必须 TLS。`http://` 仅允许 loopback（`127.0.0.1` / `localhost` / `::1`）；非 development 环境对非 loopback HTTP 拒绝启动。身份凭据只在服务间使用，不传给 Web；禁止把控制台 JWT 直接当作 Worker 管理密钥，禁止将完整请求体写日志。

### 5.2 内部签名

请求签名绑定 `method`、`path`（不含 query）、body digest（SHA-256 hex，GET 用空 body）、到期时间、actor、runId、sessionGeneration、workerInstanceId。

```text
canonical = method \n path \n bodyDigest \n expiresUnix \n actorId \n runId \n sessionGeneration \n workerInstanceId
signature = hex(HMAC-SHA256(secret, canonical))
```

头：`x-cairn-internal-expires`、`x-cairn-internal-signature`、`x-cairn-internal-actor`、`x-cairn-internal-run`、`x-cairn-internal-session-generation`、`x-cairn-internal-worker-instance`。过期窗口 ±30 秒。Worker 校验自身 `instance_id` 与签名中的代次，失配即拒绝。

### 5.3 路径

对外（控制面，仍只 GET/POST，参数名 `:runId`）：

| 接口 | 权限 | 用途 |
| --- | --- | --- |
| `GET /api/runs/:runId/browser` | `run:read` + `session:view` | 受管页元数据、当前执行页、画面可用性和脱敏后的控制状态 |
| `GET /api/runs/:runId/browser/frames` | 同上；认证阶段仅当前控制者 | 鉴权后的独立画面流；断线只取最新画面，不重播旧帧 |
| `POST /api/runs/:runId/browser/auth-control/acquire` | `session:control` + `run:execute` | 检查等待认证与自动执行已停，授予独占控制权 |
| `POST .../auth-control/heartbeat` | 同上 | 校验并短期续期，不延长既定的认证等待总上限 |
| `POST .../auth-control/input` | 同上 | 白名单输入；必须绑定有效控制 token、PageRef 和命令序号 |
| `POST .../auth-control/release` | 同上 | 撤回输入权并回到等待认证，可安全重试 |
| `POST /api/runs/:runId/resume-auth` | `session:control` + `run:execute` | 既有业务入口；内部统一走停止输入、认证检查和恢复协调 |

Worker 内部（不得出现 `/api/runs`）：

| 接口 | 用途 |
| --- | --- |
| `GET /internal/managed-browser/meta` | 当前页与能力 |
| `GET /internal/managed-browser/frames` | 最新帧 SSE |
| `POST /internal/managed-browser/auth-control/acquire` | 原子授权 |
| `POST /internal/managed-browser/auth-control/heartbeat` | 续期 |
| `POST /internal/managed-browser/auth-control/input` | 白名单输入 |
| `POST /internal/managed-browser/auth-control/release` | 撤权 |
| `POST /internal/managed-browser/resume-auth` | 停输入、验登录、匹配 epoch 后恢复 |

观察使用现有 Run/Target 权限再加 `session:view`；认证控制再要求 `session:control` 和 `run:execute`。画面流沿用 A 的 JWT 到期关闭、存活期间复核权限和旧连接隔离规则，不能仅在开流时授权。权限目录新增两项明确权限，不能把 `session:read` 的元数据权限默认为画面及输入权限。系统角色：admin / author / operator 授予 `session:view` 与 `session:control`；viewer 保留原运行/证据查询，不授予画面或输入。自定义角色不自动增权。开放服务 API 本期不开放上述接口。

解析前 body 上限沿用 64 KiB。API 与 Worker 都使用 Zod 校验和固定路由。

宪法检查修订：

- 保留 INV002：Worker 生产代码不得引入控制面 HTTP 客户端，不得出现 `/api/runs` 或 `/api/v1/`。
- 新增 INV007：`packages/web` 生产代码不得出现 `/internal/managed-browser`、Worker 地址映射或 CDP 调试串。
- 新增 INV008：`packages/api` 生产代码不得导入 `playwright`，不得持有 Page。

允许 API 使用平台 HTTP（`fetch` / undici）访问受信 Worker 内部端点。

## 6. 人工认证的状态与独占保证

### 6.1 三种占用不能混用

| 对象 | 职责 |
| --- | --- |
| RunLease / 执行 SessionLease | 自动执行所有权，沿用原 fencing 与调度规则 |
| authHold | 某个等待认证 Run 对受管 Session 的短时保留，绑定 Run、`sessionGeneration` 与 Worker `instance_id`；此时不占 RunLease |
| AuthControl | 某个控制台 actor 的短时独占输入权，绑定 authHold、Run/Session/Page 范围、control epoch、到期时间和 token 摘要 |

AuthControl 最小持久结构按 Session 唯一约束有效控制者，通过 Session 行增加控制字段实现，不先造通用租约框架。token 仅发一次给该控制者，数据库只保存 SHA-256 摘要；任何会话重建、hold 更换、控制转移都递增代次，旧 token 永不恢复有效。

存量 hold（有 worker/到期、无 Run 绑定）不授予 AuthControl，按超时清理 hold 自身；不按 TargetAccount 批量失败其他等待 Run。绑定后的超时只失败 `authHoldRunId` 这一条。

首期续期周期 5 秒、单次 AuthControl TTL 30 秒，并受冻结的认证等待总期限（`sessionPolicy.authWaitSeconds`）限制；数据库时间判断过期。具体值随 S-LIVE 测量调整，不读取热配置去延长一份已授出的控制权或执行租约。

### 6.2 等待、接管、交回

1. **自动执行停止。** Worker 先关闭该 Run 的自动输入入口，等在途操作结束或按既有迟到隔离关闭浏览器。未知副作用保留 NEEDS_REVIEW，不能借“重新登录”绕过核查。
2. **原子进入等待。** 同一 DB 事务：锁 Session 再锁 Run；校验 Run 仍 `RUNNING` 且 RunGrant 有效、Session `OPEN` 且 owner 匹配；写入绑定 hold、`authState=EXPIRED`、Run → `WAITING_FOR_AUTH`、释放 RunLease、追加 `run.auth_wait`。`claimAuthHold` 不得再作为可忽略的前置步骤，也不得写入缺少 Run / `sessionGeneration` / `workerInstanceId` 的占用。`markRunWaitingForAuth` 只改 Run 状态，生产进入等待不得使用。
3. **申请人工控制。** API 授权后转到 owner Worker；Worker 确认自动输入已静止、hold 有效且绑定该 Run、代次匹配、Run 仍等待，再以数据库原子条件授予 AuthControl。竞争者得到“由其他用户处理”，不共享输入权。缺少绑定的存量 hold 直接拒绝。
4. **受控输入。** Worker 每次接受命令都验证控制者、代次、租约期限、PageRef、当前页 origin（相对冻结 `allowedOrigins`）、视口以及运行仍等待认证；执行时再次在该 Session 的串行入口核对，拒绝排队期间已经过期的命令。自动 `withManagedPage` 在等待认证期间拒绝。
5. **完成认证并继续。** 先关闭输入入口、等待已受理输入收口，再在 Worker 用该 Run 冻结的 `targetAuth` 检查登录。验证成功后，以匹配的 hold/control epoch 原子撤销 AuthControl/释放 hold、记录审计与认证状态并将 Run 转为 `RECOVERING`（`run.auth_resumed`）。之后重新领取 RunLease、递增 fencing，再按执行入口检查 Session/认证状态。
6. **验证未通过。** 明确显示仍未登录（`AUTH_NOT_VERIFIED`）；Run 继续 `WAITING_FOR_AUTH`。若用户继续处理，重新取得有效控制权，不默默恢复旧 token。

直接 POST `resume-auth` 也不能绕过 Worker：无控制者时，只要 hold 有效且登录检查通过即可恢复；若他人仍持有未过期 AuthControl，拒绝。数据库恢复禁止只看 `run.status === WAITING_FOR_AUTH`。

### 6.3 断线、取消和迟到操作

关闭认证画面、主动放弃、JWT 到期、权限撤销、心跳过期、Run 取消、Worker 失联、Session generation 或 Worker instance 变化均关闭输入入口。连接断开时立即尝试撤权，失联由短 TTL 和数据库 fencing 兜底；没有浏览器静止确认时不能授予新的执行者或控制者。

同一个 `commandId` 重传只返回已知回执，不再次输入；序号乱序拒绝，已跨 Worker/Session 代次的命令拒绝。输入已发出而回执丢失，报告结果未知，客户端先查看页面，不自动重放点击/回车。只在当前控制代次保存有界回执，不持久化按键和文字内容。

命令携带所见帧、文档与视口标识；导航、页关闭、缩放/尺寸不匹配或画面超过允许时限时拒绝坐标输入并刷新画面。点击、滚轮、键盘、文本是固定白名单，不提供 evaluate、任意 URL 导航或脚本执行。中文输入使用原生文本框收集 composition 完成后的文本（`insert_text`），不能把拼音组合过程逐键重放。

## 7. 画面、证据与敏感信息

画面帧只包含 PageRef、帧标识、尺寸/缩放、捕获时间和图像，默认不入事件账本或 ObjectStore；刷新恢复状态读 A，重新打开画面只看最新帧。Step 截图、Trace 和失败证据继续遵循既有 Evidence Policy。页面交接使用 `log` 证据（payload `kind=page_handoff`）加 `run.page_handoff` 事件，不新增 Evidence 类型。

普通观察者只能看授权范围内的执行画面。进入认证阶段，非控制者停止接收画面并清空旧帧；只有获授权的当前认证控制者可看，避免验证码、账号提示等认证内容向其他观察者广播。开流后仍须持续复核：Worker 按推送周期查 Run/控制者，API 每 15 秒复核 JWT、权限与控制者，失配即关流。获取控制权之前展示元数据和申请入口，不以一张未经授权的登录截图代替门禁。

本线禁止持久化认证输入明文、剪贴板、按键流、控制 token 或原始认证帧，API 日志、Worker 日志、错误、Trace、截图和遥测都要逐项检查。进入等待时停止该 Run 已开启的 Playwright Trace；自动 `withManagedPage` 在等待期间不会再开 chunk 或截图。认证画面只走内存帧且仅发给控制者。仅依赖 `input[type=password]` 的遮罩不能声称已消除 OTP/账号信息泄露。

保留可审计事实：谁在何时对哪个 Run/Session 取得/释放控制权（`session.auth_control_acquire` / `session.auth_control_release`）、登录检查成败、撤权原因和关联 ID。必要事件关联 Run，执行期间的页面交接进一步关联 StepRun/Attempt；绝不为认证输入伪造一个业务 Step。

A 线事件枚举本线扩展：

| type | 何时写入 |
| --- | --- |
| `run.auth_control_changed` | 取得 / 释放 / 过期控制权（payload：`phase`、`epoch`，可含脱敏 `actorId`） |
| `run.page_handoff` | 执行当前页因显式 popup 切换（payload：`fromPageId`、`toPageId`、`reason`） |

受管浏览器自身允许访问的业务 URL 继续受 Target 策略约束；没有独立来源清单时，首期仅接受冻结的入口/登录来源及已明确允许的来源，跨域 SSO 未通过样例前关闭。API 转发错误不能泄露内网地址、调试端口或目标系统凭证。

## 8. 页面交互

按[前端工作流](../design/front/ai-workflow.md)复用现有 TrialPanel、Run Detail、Card、Sheet/Dialog、Button、Alert 和状态色。实时浏览器是现有运行工作区的一块面板，不再增加独立管理系统。

- **任务**：看见 Worker 当前页；等待认证时完成目标系统登录并交回。
- **主操作**：运行中无面板级主操作（只读展开）；等待认证且未持权时唯一主操作是“处理登录”，折叠态也必须可见；持权后唯一主操作是“登录完成，继续运行”，“放弃控制”为次要。离开页面尝试撤权。
- **布局**：Studio 试跑结果下方与 Run Detail 状态卡之后共用 `BrowserView`；窄屏与详情页一样改为上下堆叠，不另做标签切换。
- **状态**：折叠默认不抓帧；展开才订阅画面。等待认证时即使折叠也拉取元数据，以便显示“由其他用户处理”。断线禁用输入，不用最后一帧假装在线。

其余约定：

- 正常运行：步骤/尝试/证据保持可见，浏览器只读并跟随当前执行页，明确当前页与所看页。
- 等待认证：业务状态显示“需要登录”；有权用户的唯一主操作变为“处理登录”。页头“取消”改为次要描边，不能比处理登录更醒目。取得控制后明确提示当前输入将作用于目标系统。观察账本有新事件时 BrowserView 重拉元数据，以便别人持权后立刻显示“由其他用户处理”。
- 控制中：主要操作为“登录完成，继续运行”，次要操作为“放弃控制”；清楚显示剩余时间和控制者，其他人没有输入入口。
- 断线/撤权/画面过期：立即禁用输入，显示原因和恢复动作。
- 运行结束：关闭动态画面，保留正式截图/Trace 入口；关闭查看不会无条件销毁健康且可复用的 Session。

键盘焦点只能在显式取得控制后进入远端输入面，退出方式可见可键盘操作。运行错误、证据缺失或待核查不得藏进画面菜单。

Step Editor 为 click 增加“点击后页面”：未指定 / 保持当前页 / 切换到弹出窗口。未指定写出时不带 `pageAfter`。

## 9. 实施归属与迁移

| 位置 | 本线职责 |
| --- | --- |
| shared 的浏览器契约、Step 输入与权限目录 | PageRef、AuthControl、白名单命令、pageAfter、内部签名、能力响应；`session:view` / `session:control` |
| Worker `browser/` 与 `internal/` | 捕获、页面交接、所有权验证、串行输入/撤权、认证检查、内部 HTTP |
| DB `sessions/`、`runs/recover` 与三库 migration | authHold 绑定、原子控制/等待/恢复、fencing 与审计；不保存输入明文 |
| API `runs/`、Web 共同 Browser View | 鉴权、内部转发、现有 resume-auth 接线、Studio/详情挂载 |
| deploy 与受控靶场 | Worker 地址映射/凭据/网络边界、S-LIVE 与故障样例 |

迁移编号：PostgreSQL `0024_managed_browser_auth.sql`，MySQL / SQLite `0008_managed_browser_auth.sql`。缺少 Run/代次绑定的存量 hold 不授人工输入权，只清理 hold 自身，不猜测归属、不按账号误杀其他 Run。

`resumeRunAfterAuth` 的库签名改为要求 `sessionId` + `workerId` + `workerInstanceId` + `controlEpoch`；原“只改状态”的测试改为走完整绑定或直接准备 `RECOVERING`（若测的是领取而非认证）。

## 10. 验收与完成标准

复用现有浏览器靶场、真实 DB 与 Worker 故障测试；每条开放能力保存版本、样本、结果及关键证据，不能只录一段成功演示。

| 编号 | 必须证明 |
| --- | --- |
| BV01 同一浏览器 | 自动步骤、画面和输入对应同一 Session/Page；API 无正式浏览器，断开 Viewer 不破坏 Session 复用 |
| BV02 页面交接 | 明确 popup 后确定性步骤使用新页；查看其他页不改变执行页；零/多 popup、页关闭、禁止目标与未知副作用不误续跑 |
| BV03 认证独占 | 等待释放 RunLease；两个用户/两个 Run 竞争同账号不获冲突控制；自动输入和人工输入不能重叠 |
| BV04 交回闭环 | 直接调旧 resume-auth 路径也须先停输入、验认证、撤权，再重新领取增代；未登录不假恢复 |
| BV05 故障撤权 | 断网、关闭面板、取消、权限撤销、心跳超时、旧 Worker/旧 token、迟到命令全部拒绝；未知输入不自动重试 |
| BV06 输入与安全 | 中文、滚动、视口变化、跨页坐标检查；Web 不能直连 Worker/CDP，服务签名/重放/body 限制有效 |
| BV07 隐私 | 认证画面只发给控制者；日志、Trace、对象、错误及事件里没有输入秘密/token；有脱敏控制审计 |
| BV08 性能与限制 | 受控局域网目标首帧 p95 ≤ 3 秒、帧捕获到展示 p95 ≤ 2 秒；至少 20 次连接/切页/关闭循环无持续资源增长，记录并发与硬件 |
| BV09 用户闭环 | 用户从 Studio 发现等待认证、完成登录、看见续跑与证据；A 断线不会开放输入，B 断线不会伪造 Run 状态 |

BV01–BV09 对应工程计划 LV01–LV06 的展开，不能降低 RF 的所有权与未知副作用要求。PG/MySQL/SQLite 的控制原子性分别验收；浏览器/网络支持按探针实际通过范围公开。操作系统弹窗、证书选择、复杂 SSO 和新 AI 页面类别未经专项验证不宣称支持。

无 Chromium 的 CI 跑契约、三库原子性、签名/权限/转发与 UI 状态测试；S-LIVE / popup lab / 性能数字在有浏览器的环境记录，不能把跳过写成通过。BV08 的展示路径 p95 与 20 次连接循环、BV09 的 Studio 真机登录闭环仍要在控制台对受控目标实测，lab 通过不能替代。

## 11. 与另外两线的依赖

**B 可以与 A/C 并行开发，但独占认证有明确前置：配置语义收口和本线控制契约必须先完成。** S-LIVE 与确定性 popup 探针不需要等待 A 的事件账本。A 的最小契约（观察 GET、事件枚举、SSE）已经可消费。

B 的页面/认证变化通过 A 事件入口通知页面；UI 状态只来自观察 GET。本线局部验证可以先从 GET 查询状态，完整 D1 再做实时联合验收。

C 可独立开发单页录制转换；录制 popup 的可执行回填依赖本线 `pageAfter` 契约和实际能力通过。C 不负责复制浏览器控制权，也不能用 Extension 代替正式 Run 的 Browser Runtime。
