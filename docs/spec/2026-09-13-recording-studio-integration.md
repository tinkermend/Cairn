# D2：从平台发起录制并回填同一 Scenario Studio

> 编号：C。日期：2026-09-13。修订：2026-09-14（落地后按实现收口偏差）。状态：**已落地**。
> 对应 P12 与 D2；复用现有 Extension、IR 草稿、Compiler 和 Sequence Studio。
> 关联：[A 运行实时状态](2026-09-13-run-realtime-observation.md)（已落地）、[B 受管浏览器查看与认证](2026-09-13-managed-browser-view-and-auth.md)（已落地，`pageAfter` 可消费）；唯一交付顺序见[工程计划第 5 节](../plan/识途开发路线与工程实施计划.md#5-当前交付顺序与验收样例)。

## 0. 审查结论（相对 2026-09-13 待审稿）

对照现码与已落地的 A/B 后，原稿可以实施，但有这些必须写死的缺口；本节是修订理由，后面各节已按此改过。

| 问题 | 修订 |
| --- | --- |
| A/B 已落地，§5 / §11 仍把 popup 写成“等 B” | 单个可归属的 `popup` 信号生成 `pageAfter: 'popup'`；多窗口歧义仍待处理 |
| `workflow:read/write` 语义含糊 | 每个接口写清权限；服务凭据走独立入口，本线路由不声明服务 API |
| 插入锚点、disposition、错误码、绑定状态未冻结 | 见 §4、§6、§7 |
| Web 如何找到 extensionId、无手势如何继续未写清 | 工具栏点击是一等路径；`GET /api/recording-bindings/open` 让已登录插件领同一绑定；`VITE_CAIRN_EXTENSION_ID` 仅加速握手 |
| 领取“环境不一致”没有可执行定义 | 绑定记录签发时的 API origin；插件配置的 API origin 必须相同 |
| 独立录制列表任何 `workflow:write` 都能看见全部草稿 | 列表与详情改为仅当前 actor；响应形状不变 |
| 上传摘要用未清洗事件；超限误报 `RECORDING_EMPTY`；体积按 JS 字符串长度 | 摘要在清洗后计算；条数用 `RECORDING_TOO_MANY_EVENTS`；体积用 UTF-8 字节 |
| `mapped` 被当成可执行；旧 `items` 含错误降级 | 预览/回填用 `normalizerVersion` **重跑** 清洗后的源事件，不信任库存 `items` |
| 现有 `sidePanel.open()` 从网页消息里调用会丢手势 | 不把自动打开侧栏写成成功条件；**插件**未 attach 不得显示录制中 |
| GET 导入列表“复用既有分页”但录制列表实际没有游标 | 导入列表首屏一次返回，`nextCursor` 预留为省略 |

### 0.1 落地后冻结的实现边界

对照 2026-09-14 代码与真实 Chrome `pnpm probe:import` 后，下列与待审稿不同的写法按实现冻结，验收不得再按旧句理解。

| 偏差 | 冻结写法 |
| --- | --- |
| 网页无法可靠知道插件是否 attach | 网页 **不** 显示「录制中」。Alert 只表达服务端绑定：`issued` / 已领取未上传 / 已上传待回填。未挂接不算录制成功，这句话只约束插件面板 |
| 预览 Sheet 没有完整 Step Editor | `replace` 契约仍接受完整合法 `Step`。本期 UI 只提供：可接受则 accept；敏感/参数化 fill 绑到已有场景输入（replace）；其余待处理项 discard，或关掉 Sheet 在步骤编辑器手建 |
| `RECORDING_BINDING_EXPIRED` 被两处共用 | 领取窗过期、上传窗过期、以及 **issued 尚未领取就带 `bindingId` 上传**（文案「尚未领取」）都用此码，不另增 UNCLAIMED |
| 绑定与批次的 Target 不一致 | 使用 `RECORDING_BINDING_FORBIDDEN`，预览/上传/回填均适用 |
| 签发 origin 与回 Studio 地址 | 本期签发 `apiOrigin = http://localhost:${CAIRN_API_PORT}`。插件回链：API origin 含 `:3030` 时控制台为 `http://localhost:5173`，否则复用 API origin。换端口或 HTTPS 部署须另改，不假装已通用 |
| `externally_connectable` | 本期只开放本地 `5173` / `4173` 的 localhost 与 127.0.0.1。同源 HTTPS 部署项是后续加白名单，不是已交付 |
| `GET /recording-bindings/open` | **当前 actor 全局**最近一条未关闭且仍在领取/上传窗内的绑定，不是「当前 Scenario 的绑定」。A 未关闭时打开面板会领 A |
| Studio 绑定 Alert | 取该 Scenario 导入列表里最新一条未关闭绑定；**不过滤**已过领取窗的 `issued`，用户仍可关闭。与 `GET /open` 的过期过滤不是同一条规则 |
| OCC 409 | Sheet 与内存中的逐项选择保留，不自动保存。用户按提示重载草稿后再预览；重载后选择回到服务端预览默认值，不把未提交修正写 localStorage |
| 插件「已回填」 | 上传后写「已上传，尚未回填」并给 Studio 链接。插件不轮询 apply；Studio 回填后本地面板不会自己变成「已回填」 |
| 回填高亮 | 「刚导入」依赖 Query 缓存中的插入 Step ID；清掉 `?import=` 导致页面重挂时必须还能亮，不能只靠组件内存 |

## 1. 要交付什么

用户在一个已绑定 Target 的 Scenario 草稿中点击“开始录制”，插件打开对应目标并捕获操作。结束后，平台显示可回填步骤和待处理诊断；用户确认插入草稿，继续改步骤、插入 AI、试跑和发布。

录制是生成 Structured Step 的入口，回填结果使用当前草稿、Compiler、版本与统一 Run；不增加录制专用执行器。插件卸载后，已发布场景仍能由 Worker 正常执行。

本次包括：平台发起与插件握手、Scenario/Target 绑定、导入预览、有限动作的精确转换、敏感值处理、OCC 和幂等回填、来源追踪及回到 Studio。已有独立上传入口保留。重建录制内核、完整云端录制、任意 Playwright 脚本导入、自然语言生成、Excel 导入和自由分支不在范围内。

## 2. 已有基础与实际缺口

| 已有实现 | 本线复用与收口 |
| --- | --- |
| Extension 登录、Target 选择、JSONL 整批上传、误录步排除及真实 Chrome 探针 | 保留采集内核和工作台，新增受控绑定及平台发起入口 |
| `shared/src/recording.ts` 限制事件数、转换 IR 并记录诊断 | 现有 `mapped` 只表示有候选。可执行回填前必须用 `recording-normalizer@2` 重跑；check/uncheck、locator 链、placeholder/alt、过深 iframe 不得错误降级 |
| `db/src/recordings/` 以 actor/idempotencyKey 去重上传 | 继续用现有批次存储，摘要改为清洗后事件；增加导入到具体 Scenario 的幂等账本 |
| API 已保存录制草稿，但未绑定 Scenario 或写入 Scenario 草稿 | 新增预览与原子回填，不能直接把上传当发布 |
| Studio 有三层草稿保护、revision/OCC、Compiler、参数绑定和试跑 | 复用合法草稿保存与编译；导入诊断留在预览区，不污染运行定义 |
| 当前 manifest 尚无平台到插件的外部消息握手 | 受限 origin 白名单 + 一次性绑定票据；浏览器全局 `postMessage` 不是授权 |
| B 已提供 `pageAfter: 'same' \| 'popup'` 与 Worker 交接 | 本线只消费该字段，不自造页面切换语义 |

前序实现和边界见[插件登录与上传](2026-09-13-extension-login-and-recording-upload.md)、[顺序编排增强](2026-09-13-sequence-studio-foundation.md)。本线不重做登录、通用 Step Editor 或 AI 表单。

## 3. 用户闭环与失败出口

1. **从已保存草稿开始。** 用户选择 Scenario 与插入位置（当前选中步骤之后，或列表起点），平台显示 Target；有未保存修改时先保存，OCC 冲突先处理。开始录制不自动覆盖草稿。
2. **绑定插件。** 平台创建短期绑定；插件用自己的控制台登录领取，显示目标系统、Scenario 名称与插入位置。身份或 API origin 不一致时说明原因，不拿平台 JWT 代登录。
3. **实际开始采集。** 插件 attach 成功才在**面板**显示“录制中”；网页不进入该文案。用户操作真实目标页面，敏感字段在上传前被移除或转成待绑定项。
4. **结束并上传。** 插件整批上传并带上 `bindingId`；上传失败可重试，平台/插件失联可从原录制批次继续，不新造 Run。
5. **在 Studio 预览。** 逐项展示源动作、拟生成步骤、插入位置、敏感项与不支持项。用户接受、把参数化 fill 绑到场景输入，或明确舍弃后回填；其它待处理项不在 Sheet 里改成任意 Step。
6. **继续统一编辑。** 回填只改草稿并更新 revision，不自动试跑或发布。用户用已有步骤编辑器、AI 插入、试跑和发布操作继续。

平台发起成功、插件已领取、已上传待回填是网页能看见的三档，均不是“录制中”。尚未 attach、上传中只在插件面板区分。关闭页面后可从服务器录制批次重新打开预览；未提交的本地修正按现有脏草稿保护提示，不假装已经保存。

## 4. 平台与插件的最小协作协议

### 4.1 绑定对象与一次性票据

新增绑定记录，字段为：

| 字段 | 含义 |
| --- | --- |
| `id` | `bindingId` |
| `createdByConsoleAccountId` | 发起人，领取必须同一 actor |
| `targetId` / `scenarioId` | 绑定当时的 Target 与 Scenario |
| `draftRevision` | 发起时的草稿 revision，仅作提示，回填仍以 apply 的 `baseRevision` 为准 |
| `insertAnchor` | `{ kind: 'start' }` 或 `{ kind: 'after', stepId }`，禁止数组下标 |
| `ticketHash` | 票据 SHA-256，明文只在创建响应返回一次 |
| `status` | `issued` \| `claimed` \| `closed`；过期由时间派生，不另存状态 |
| `apiOrigin` | 签发该绑定的 API origin（无尾斜杠），领取时与插件配置的 API origin 比。本期实现固定为 `http://localhost:${CAIRN_API_PORT}` |
| `expiresAt` | 票据领取截止，创建后 5 分钟 |
| `uploadExpiresAt` | 领取后允许绑定上传的截止，创建后 2 小时；关闭或过期后不能开始新的绑定上传 |
| `recordingDraftId` | 成功上传后关联的批次；已保存批次仍按原资源权限访问 |
| 时间戳 | `createdAt` / `claimedAt` / `closedAt` / `updatedAt` |

票据为服务端 32 字节高熵随机值的 hex，不包含控制台 JWT、目标密码或长期权限。领取后继续用插件原有授权上传。

领取条件（满足其一即可，且必须同一 actor、未关闭、未过领取期、API origin 一致）：

1. `POST /api/recording-bindings/claim` 提交创建时的 `ticket`（一次有效）；
2. 或提交 `bindingId`（工具栏打开后面板用 JWT 认领，避免网页消息失败时无法继续）。

`GET /api/recording-bindings/open` 返回**该 actor 全局**最近一条未关闭、且 `issued` 仍在领取窗或 `claimed` 仍在上传窗内的绑定，不含票据。不是“当前 Scenario 的绑定”。若场景 A 的绑定未关闭，在场景 B 点「录制步骤」后打开插件，仍会领到 A；要改绑须先关闭 A。已过期的 `issued` 对 `GET /open` 不可见，但 Studio 该场景的导入列表 Alert 仍可能列出它，供用户关闭。

每次领取、上传、预览和回填都检查真实 Scenario 的 Target、当前用户权限及绑定归属，不能只信消息中的字段。Scenario 被删除、改 Target、权限被撤销或插件登录了另一账号时明确拒绝。既有无绑定上传仍可保留为独立录制草稿，后续由同一用户显式选择相同 Target 的 Scenario 导入，不默默附到最近一次编辑的场景。

无绑定上传保持现有 `workflow:write`，仍校验 Target 存在且未停用。绑定创建、领取后的绑定上传、预览和回填额外要求 `target:read`。

### 4.2 Chrome 消息通道

使用 Chrome 原生 external messaging：manifest `externally_connectable.matches` 本期只开放 `http://localhost:5173`、`http://127.0.0.1:5173`、`http://localhost:4173`、`http://127.0.0.1:4173`；插件再校验 sender 的 scheme/host/port。同源 HTTPS 控制台要另加白名单，本线未交付。所有外部消息经 Zod 校验。Web 在配置了 `VITE_CAIRN_EXTENSION_ID` 时向该 ID `sendMessage`；未配置或发送失败不算绑定失败，用户改走工具栏。[Chrome 官方消息机制](https://developer.chrome.com/docs/extensions/develop/concepts/messaging)

消息只传协议版本、绑定 ID 和票据，不传 JWT、密码或任意 API URL。API 地址继续从插件现有环境名单选取（本期名单只有 `http://localhost:3030`）。回到 Studio 的地址：若插件看到的 API origin 含 `:3030`，控制台 origin 取 `http://localhost:5173`，否则复用 API origin；路径为服务器确认的 Scenario ID，上传成功后带 `import=<recordingDraftId>`。

握手信封：

```text
{ version: 1, type: 'cairn.recording.start', bindingId, ticket }
{ version: 1, type: 'cairn.recording.ack', bindingId, opened: boolean, attached: boolean, reason? }
```

`sidePanel.open()` 有用户手势限制，从网页 `sendMessage` 转入的调用通常没有手势。因此：

- 网页创建绑定后，主文案是“点击浏览器工具栏中的识途录制器图标，继续同一绑定”；
- 插件在工具栏/命令/右键打开时读取 `GET /api/recording-bindings/open` 或消息里的票据并领取；
- 只有实际 attach 成功，**插件面板**才标为“录制中”。网页没有 attach 事实源（未配扩展 ID 时也收不到 ack），只显示绑定的 issued / 已领取 / 已上传，不写“录制中”；
- 打不开侧栏不是错误终态，是本期支持路径。[Chrome sidePanel 官方说明](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)

完成上传后，Web 收到的提示只触发一次 API 查询；事实来自服务端录制批次。通道丢失时，插件提供返回该 Scenario 的链接，平台也可主动刷新导入列表，不建设录制高频轮询或把录制事件混入 Run SSE。

录制页只打开当前 Target 的 `entryUrl`（若绑定要求登录页且已配置 `loginUrl`，允许打开 `loginUrl`）。来源必须属于入口/登录 origin。不从任意 `message.url` 打开页面。跨域 SSO 等未验证类别显示限制，不自动跟随。

## 5. 从录制 IR 到 Structured Step

### 5.1 转换是可验证编译，不是猜测执行

复用已有录制批次。预览和回填以显式 `normalizerVersion = recording-normalizer@2` 对**已落库、再清洗一次**的源事件重跑，忽略库存 `items`。未知或与 `playwright-crx@0.15.0` 不符的 `sourceVersion` 可以保留诊断供查看，但全部项不得进入 `accept`。上传路径对未知来源版本仍只记诊断，以保持独立上传兼容；导入路径更严。

| 来源动作/结构 | 本期处理 |
| --- | --- |
| 普通单页 navigate、click、fill | 在目标、定位及动作参数能精确表达时生成对应 Structured Step |
| 可对应现有 Assert 契约的文本/值/可见性断言 | `assertVisible` → `visible`；`assertText` → `text_equals` / `text_contains`。`assertValue` / `assertChecked` / `assertSnapshot` 待处理 |
| 已支持深度与语义的 iframe 定位 | 保留完整 `framePath`（`selector` 步）和相对作用域；超过 `MAX_FRAME_DEPTH`（4）整项待处理，禁止静默截断 |
| 单个、可确定归属的 click → popup 信号 | 生成 `pageAfter: 'popup'`。多个 popup 或无法归属则待处理 |
| check/uncheck、select、press、文件上传、关页 | 待处理；不因录制器会捕获就临时膨胀 Step Type |
| 复杂 locator 链（存在 `locator.next`）、未知 options、placeholder/alt 唯一策略 | 阻断本项自动转换；禁止 `placeholder→label`、`alt→text`、把链摊成 OR `candidates` |

`mapped` 仅表示有候选。预览项另给 `ready`：候选能通过对应 Step Schema 时为真。`parameterized` 的 fill 缺 `value`/`from`，`ready` 为假，必须替换为合法参数绑定或舍弃。

转换只解析受支持的结构化字段，绝不执行录制中的 JS、selector 表达式或任意代码。输出用正式 Step Schema、ScenarioDocument Schema 和 Compiler 验证，手工与录制生成的同类 Step 在运行时没有区别。

### 5.2 待处理项不进入 Runtime IR

预览项包含 `sourceIndexes`、候选步骤、诊断及用户处理结果。每项只能进入一种最终处理：

| `disposition` | 要求 |
| --- | --- |
| `accept` | 该项 `ready === true`；服务端重跑转换后必须仍 `ready` |
| `replace` | API 提交完整合法 `Step`（含新 id），走 Step Schema / Compiler，检查 Target、参数、输出名冲突与前序引用。本期 Studio 只对「参数化 fill 且能解析 target」生成 replace：把 `from` 绑到当前草稿已声明的场景输入。其它未 ready 项不在 Sheet 里提供通用改 Step |
| `discard` | 必填 `reason`（1–200 字） |

处理结果必须覆盖预览中的每一项，`sourceIndexes` 集合必须与预览一致。未处理或有错误的项不能通过一键回填悄悄丢掉。Sheet 对不能自动接受、也不能绑参数的项只给舍弃；要改成别的合法 Step，关掉预览后用已有步骤编辑器手建，或走 API `replace`。

敏感 fill 保留“此处需要凭据/参数”的意图，不留下真实值或可当作真实值执行的假密码。复用现有 TargetAccount/SecretProvider 和受控参数契约；当前 Step Schema 无法安全表达时，保持待处理并提示配置认证或人工编辑，不能新增明文密码默认值来凑闭环。

ScenarioDocument 保持现有合法性要求；预览中间态单独表达，不往 steps 塞 unresolved 节点，也不放宽严格 Schema。已有草稿可以独立发布，但未回填批次明确显示不在该版本中，不能在 UI 上混为已纳入。

当前限制保持明确：单批最多 200 个源事件、上传 JSON 最多 256,000 UTF-8 字节，合法 Scenario 目前最多 32 个 Step。超过可容纳步骤数时显示剩余容量，用户明确选择/舍弃或先整理草稿，不截断后声称全部导入。全部舍弃走“放弃导入”，不调用 apply、不写回执、不占同批唯一约束。

### 5.3 上传前脱敏与服务端复核

采集/上传边界结合 DOM `input[type=password]`、敏感 `autocomplete`（`current-password` / `new-password` / `one-time-code` / `cc-number`）、手动标记（`markedSensitive`）和已知凭据字段删除真实输入；本地面板与临时缓存也不能再显示这些值。API 对事件及 locator 再做白名单：只保留契约字段；`locator.options` 只留 `name`；`signals` 只留已知 `name`。未知键、嵌套 `storageState`/`cookies`/`localStorage`/`sessionStorage` 整单拒绝。

不上传 cookie、storage、控制台/目标凭据、文件内容或任意页面快照。导航 URL 查询中的 `password` / `passwd` / `secret` / `token` / `access_token` / `refresh_token` / `otp` / `pin` 删除。先移除敏感值，再生成保存内容的摘要；请求体和校验失败日志不得记录完整录制文本。

体积限制按 `TextEncoder` UTF-8 字节计算，覆盖中文和嵌套字段；条数超限使用 `RECORDING_TOO_MANY_EVENTS`，不得再报 `RECORDING_EMPTY`。无法判断的一般业务数据不承诺自动完全脱敏，预览提供标记/舍弃入口，测试用明确的密码、token、OTP 和嵌套泄露样本卡住已定义边界。

## 6. 预览、OCC 与原子回填

### 6.1 预览契约

```text
POST body: { recordingDraftId, baseRevision, insertAnchor }
响应: {
  normalizerVersion, sourceVersion, sourceDigest,
  recordingDraftId, recordingName, eventCount,
  remainingStepCapacity, currentRevision, insertAnchor,
  items: [{
    sourceIndexes, sourceAction, name, status, ready,
    candidateStep?, diagnostics, sensitive?
  }],
  diagnostics
}
```

预览不改 Scenario，也不自动生成已发布版本。服务端重跑转换，不信任客户端已编译标志。

### 6.2 一次提交完成

```text
POST body: {
  idempotencyKey, baseRevision, recordingDraftId,
  normalizerVersion, sourceDigest, insertAnchor,
  dispositions: [{ sourceIndexes, disposition, step?, reason? }]
}
```

在数据库同一事务中：

1. 核对 actor 权限、Scenario/Target、批次归属（创建者 = 当前 actor，Target 与 Scenario 一致）及可选绑定条件，查找已有幂等结果。
2. 锁定 Scenario 草稿并比较 revision；锚点步骤已删除、草稿并发修改或 `normalizerVersion`/`sourceDigest` 与重跑结果不符均返回明确冲突，不默认覆盖。
3. 重新转换/校验，为 accept/replace 分配新 Step ID，在所选位置插入，检查完整 Scenario 的步骤数、输入输出引用；Compiler 按 **release** 检查，出现 error 则整单失败（比普通保存更严，与“一键回填须通过 Compiler”一致）。
4. 更新合法草稿、递增 revision，并写入导入回执与来源映射；任意一步失败全部回滚。

回执保存 `recordingDraftId`、ScenarioId、sourceDigest、normalizerVersion、旧/新 revision、sourceIndexes → 新 Step ID、用户处理说明、actor 与时间。来源信息放 Authoring 导入记录，不把录制器专有字段塞进执行核心 IR。

通过 `(scenarioId, recordingDraftId)` 唯一约束阻止同批重复回填，另以 `(actorId, idempotencyKey)` 和请求摘要处理网络重试。同 key 同请求返回原回执；同 key 不同请求报冲突；新 key 也不能绕过同批唯一约束。若用户确需复制步骤，使用 Studio 明确复制操作，不重放导入。

拿到重试返回的旧回执后，前端另读当前草稿再做版本判断，不能用旧 revision 覆盖后来编辑。OCC 409（`SCENARIO_DRAFT_CONFLICT`）保留当前 Sheet 与内存中的逐项选择，提示基线已变，不自动强制保存。用户确认重载草稿后必须重新请求预览；重载后选择回到服务端默认（ready 则 accept，否则空 reason 的 discard），不把预览修正写入 localStorage。多个导入批次、普通保存、发布和 Target 变更必须共用原有草稿并发边界。

## 7. API 与权限

路径只使用 GET/POST。现有 `POST /api/recordings` 增加可选 `bindingId`，无该字段时行为与现在兼容（独立草稿）。独立 `GET /api/recordings` 与详情改为只返回当前 actor 的草稿，权限字仍为 `workflow:write`。

本线路由使用控制台 JWT + RBAC，不声明服务 API（无 `IS_SERVICE_API`）。服务凭据当作 Bearer 过不了 JWT，因此不能领取、预览、回填或上传录制；隔离靠认证边界，本线没有单独的服务 Key 用例。

| 接口 | 权限 | 用途 |
| --- | --- | --- |
| `POST /api/scenarios/:id/recording-bindings` | `workflow:write` + `target:read` | 创建绑定，响应含一次性 `ticket` |
| `GET /api/recording-bindings/open` | `workflow:write` + `target:read` | 当前 actor **全局**最近一条未关闭且仍在领取/上传窗内的绑定（不含票据），不按 Scenario 过滤 |
| `POST /api/recording-bindings/claim` | `workflow:write` + `target:read` | 插件以自身登录领取 |
| `POST /api/recording-bindings/:id/close` | `workflow:write` | 关闭绑定、阻止新上传，可安全重试 |
| `POST /api/recordings` | `workflow:write`；带 `bindingId` 时另需 `target:read` | 可选绑定；整批重传复用上传幂等语义 |
| `GET /api/scenarios/:id/recording-imports` | `workflow:read` + `target:read` | 该场景可导入批次（同 actor、同 Target、尚未回填）与已导入回执 |
| `POST /api/scenarios/:id/recording-imports/preview` | `workflow:read` + `target:read` | 生成预览，不写草稿 |
| `POST /api/scenarios/:id/recording-imports/apply` | `workflow:write` + `target:read` | 原子回填并返回回执 + 最新场景 |

上传权限不等于编辑 Scenario 的权限；预览、回填和重传均重新授权，不能凭旧 `bindingId` 延续已撤销权限。录制和回填本身不要求 `ai:execute`；只有试跑含 AI 的版本时才走既有 AI 权限与能力闸门。

领域码（在现有 `RECORDING_*` / `SCENARIO_*` 上增加）：

| 码 | 何时 |
| --- | --- |
| `RECORDING_TOO_MANY_EVENTS` | 超过 200 条 |
| `RECORDING_BINDING_NOT_FOUND` | 绑定不存在或不属于当前 actor |
| `RECORDING_BINDING_EXPIRED` | 领取窗已过、上传窗已过，或绑定仍为 `issued` 就带 `bindingId` 上传（文案「尚未领取」） |
| `RECORDING_BINDING_CLOSED` | 已关闭 |
| `RECORDING_BINDING_CLAIMED` | 票据或 bindingId 重复领取 |
| `RECORDING_BINDING_ORIGIN_MISMATCH` | 插件 API origin 与签发 origin 不同 |
| `RECORDING_BINDING_FORBIDDEN` | 上传/预览/回填的 Target 与绑定或场景不一致 |
| `RECORDING_IMPORT_INCOMPLETE` | 处理结果未覆盖全部预览项 |
| `RECORDING_IMPORT_CAPACITY` | 插入后将超过 32 步 |
| `RECORDING_IMPORT_STALE` | normalizer / sourceDigest / 锚点与当前不符 |
| `RECORDING_IMPORT_CONFLICT` | 同批已回填，或幂等键对应不同请求 |
| `RECORDING_SOURCE_UNSUPPORTED` | 来源版本不能进入可执行转换 |
| `SCENARIO_DRAFT_CONFLICT` | 草稿 revision 已变（细节含当前 revision/document） |
| `SCENARIO_COMPILE_BLOCKED` | 回填后 Compiler 有 error |

## 8. Studio 与插件交互

按[前端工作流](../design/front/ai-workflow.md)复用现有步骤列表、Step Editor、诊断区域、Sheet、Alert、Toast 和草稿状态，不新增与 Studio 并列的“录制场景编辑器”。

- Scenario Studio 在步骤列表工具条增加次级“录制步骤”入口（outline，不压过保存/试跑）。Alert 只反映该场景导入列表里最新一条未关闭绑定：`issued` 提示点工具栏且写明未挂上页面不算录制中；已领取未上传提示去插件完成上传；已挂批次则提示待预览回填。Alert **不**写「录制中」，也 **不**按领取窗过期隐藏 `issued`（仍提供关闭绑定）。
- 预览用 Sheet（窄屏同样），展示源动作与拟插入步骤的对应关系，诊断定位到具体项。UI 支持接受、参数化 fill 绑定到已有场景输入、以及带原因的舍弃；不要求用户理解 JSONL。不能自动接受的其它项不在 Sheet 内改 Step。
- 一键回填只在全部项已处理、将插入步数大于 0、且完整草稿可通过 Compiler 时启用；显示将插入多少步、插入在哪里及保留多少原步骤。全部舍弃走「放弃导入」，不调用 apply。
- 回填后高亮新步骤（插入 ID 写入 Query 缓存，清 `?import=` 重挂后仍亮），保留当前编辑上下文；用户可继续插入已有 AI Step。试跑面和证据继续使用 A/B 与现有组件。
- 查询参数 `import=<recordingDraftId>` 可重新打开预览。草稿未保存时先挡住、不打开 Sheet。离开时复用已有草稿保护，不能把预览结果/密码写 localStorage。
- 插件展示“录入哪个系统、哪个场景”；上传成功写「已上传，尚未回填」并给出 Studio 链接。插件不查询回执，因此 Studio 回填后本地面板不会自己改成「已回填」。普通用户无需到独立管理页复制粘贴。
- 覆盖插件未安装/未登录、环境或账号不符、被禁止来源、录制已断开、上传失败、绑定过期、转换有诊断、草稿冲突和导入成功；错误中不带票据或原始敏感数据。

## 9. 实施归属与迁移

| 位置 | 本线职责 |
| --- | --- |
| shared `recording.ts` 与 `recording-import.ts` | 安全归一化、精确映射、绑定/预览/回执 Schema；消费 B 的 `pageAfter` |
| DB `recordings/`、Scenario 草稿操作、三库 migration | PG `0025`、MySQL/SQLite `0009`：绑定表、回执表、唯一约束、OCC 事务与来源映射 |
| API `recordings/` 与 `scenarios/` | 授权、领取、预览、回填；复用上传与 HTTP 信封 |
| Extension manifest/bridge/panel | origin 限制、握手、敏感值处理、已有 attach/upload 与返回 Studio |
| Web Studio 导入面板 | 预览、修正和导入反馈；入口接在现有步骤工具条 |

存量录制草稿没有 Scenario 绑定，迁移不猜测归属；只有用户显式选择后才可预览和导入。旧批次先按 `@2` 再清洗；不能证明已脱敏（仍含禁止键）的不得进入 `accept`。新转换规则不改已发布 ScenarioVersion 与历史 Run。

跨库逻辑传输版本升到 `0026`，导出集合包含绑定与回执。与配置中心重合的 Scenario 创建/试跑配置逻辑只消费新契约，本线不修改 Snapshot 的 AI 默认值或认证策略。

## 10. 验收与完成标准

复用现有 shared 测试、三库适配测试、Scenario OCC 测试和 `pnpm probe:panel`。平台发起闭环另有 `pnpm probe:import`（真实 Chrome + 扩展页顶替侧栏：领取、打开入口、录制、绑定上传、Studio 预览回填）。新增用例围绕有风险的转换、事务和真实插件闭环，不重建录制测试框架。自动化打不开工具栏/真 Side Panel，这两处仍要人点。

| 编号 | 必须证明 |
| --- | --- |
| RC01 发起与绑定 | 从指定 Scenario 成功开始录制；未安装/用户手势限制有可达入口。插件未 attach 不得显示录制中；网页不得把 issued/claimed 写成录制成功或录制中 |
| RC02 授权 | 错 origin/extensionId、重放票据、跨账号/Target/API origin、撤权或过期绑定均拒绝；服务 Key 因走不通控制台 JWT 而不能导入 |
| RC03 转换语义 | 支持动作精确转换并通过 Compiler；check/uncheck、locator 链、深 iframe、未知来源等不被错误降级 |
| RC04 安全与容量 | 密码/token/OTP/嵌套秘密不进入上传、日志或草稿；中文 UTF-8 超限和 32 Step 超限明确拒绝，无静默截断 |
| RC05 并发与重试 | 上传重试、apply 响应丢失、两次 apply、导入与手工保存/发布并发只产生一个完整结果；失败无半批步骤 |
| RC06 编辑保护 | 409 保留当前 Sheet 选择且不自动保存；用户重载后须重新预览（选择回到默认）。旧回执不覆盖新草稿；逐项来源可追踪，未处理项阻止回填，历史 Run 不受后续编辑影响 |
| RC07 平台闭环 | 录制 → 预览回填 → 改确定性步骤 → 插入已支持 AI → 试跑 → 发布，可由用户独立完成 |
| RC08 Runtime 独立 | 关闭/卸载插件后正式 Run 继续由 Worker 执行；录制和手工的同类 Step 共用 Executor/Snapshot/Evidence |
| RC09 跨线页面 | 普通单页可独立验；带 popup 的录制在回填后带 `pageAfter`，观察面复用 A/B 已有组件 |

RC01–RC06 与单页确定性 RC08 可独立开发和验收。RC07 的完整可观察混编闭环与 D2 Gate 需要既有 AI 能力和 Studio 一起验；上传成功或单测通过不能据此宣称 D2 完成。

## 11. 与另外两线的依赖

A/B 已落地。普通单页转换、绑定、导入事务和草稿 OCC 不依赖新的 A/B 工作。popup 回填消费已落地的 `pageAfter`，不再等待 B，也不自造页面切换字段。C 不修改 A 的事件序号，也不把录制进度伪装成 Run 状态。

联合验收仍保持 D1 能力与可观察面在前、D2 证明录制入口接入同一用户流程。这是联合验收依赖，不是开发串行门闩。
