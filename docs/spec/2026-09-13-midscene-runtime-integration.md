# Midscene 正式接入：统一 Run 中的 AI 混编

日期：2026-09-13。状态：**已落地（2026-09-13）**，在线真模型验收已完成：受控靶场普通 DOM 类别 5 个代表任务 × 3 次共 15 次尝试全部成功，详见第 8 节末的实测记录。不对 `docs/targets/` 企业页默认发 AI。

对应工程计划 D1 的 P8 / P9，以及 AI 接入直接需要的 Compiler、专用步骤表单与 Evidence 增量。公共编辑、参数选择、草稿保护与工作区试跑展示由并行的[顺序编排与 AI 步骤编辑增强方案](2026-09-13-sequence-studio-foundation.md)负责，两边共用同一套 Step 与运行契约。交付优先级只维护在[工程计划第 5 节](../plan/识途开发路线与工程实施计划.md#5-当前交付顺序与验收样例)。本次开始正式 AI 接入；SSE、Live View、完整 Foundation 联合验收不作为开发前置。完整 D1 的画面、认证与实时观察验收仍按原计划完成，不能用本方案通过代替。

前置依据：[D0 受管 Page 探针](2026-09-13-d0-hybrid-probes.md)、[确定性场景编写](2026-09-13-deterministic-authoring-studio.md)、[两类 AI 配置边界](2026-09-13-ai-model-configuration-boundaries.md)。按 [宪法「开发与交付」](../../CLAUDE.md#开发与交付)，审查通过后进入实现。

## 1. 本轮交付

用户在现有 Scenario Studio 插入 AI Action、AI Extract、AI Assert，与确定性 Step 混编，保存、试跑、发布后由同一 Worker / Engine 执行；运行详情能看到 AI 输出、判断依据、调用用量及失败证据。

首个浏览器 AI 实现采用仓库已经安装的 Midscene `1.12.6`。它负责页面理解与动作规划；识途继续负责 Scenario、Run、Context、Browser Session、所有权及 Evidence。平台通用生成与分析仍使用独立模型配置，不经 Midscene，本方案不把它算作已交付。

本轮范围包括三类 AI Step、单条真实视觉模型路由、正式执行接线、输出字段引用及现有页面的最小编辑与复盘支持。完整 `aiAct` 的取消 / 丢租验证属于这次接入任务，不另开一个无限延长的基础建设阶段；未通过时 AI Action 不开放。

## 2. 已有能力与实际缺口

| 位置 | 已有能力 | 本轮增量 |
| --- | --- | --- |
| `worker/src/ai/midscene/` | 已安装 SDK、受管 Page 构造、动作与模型调用 gate | 暴露并执行完整 `aiAct` / 查询 / 断言路径；接真实租约、配置、预算与证据 |
| `worker/src/engine/` | 顺序、Attempt、超时、重试、取消、恢复和原子收尾 | 按类型解析正式 AI Executor；三类 AI 同样获得 Session、双租约提交保护 |
| `shared/src/step.ts`、`compiler.ts` | 五种 Web Step、草稿编译、输入引用校验 | 三种 AI 契约及最小结构化输出字段引用 |
| `db/src/runs/runs.ts` | 正式与 trial 共用创建 Run / 冻结 Snapshot | 两个入口共同冻结 AI 执行配置，保留历史快照和幂等语义 |
| `browser/session-manager.ts`、`browser/port.ts` | Page、SessionGuard、截图、Trace、对象证据 | AI 与确定性执行共用受管调用及证据采集范围 |
| `web/features/scenarios`、`web/features/runs` | 顺序编辑、试跑入口、Attempt 与证据 Viewer | 本线提供三类 AI 专用表单及 AI 结果组件；Studio 线负责注册、公共绑定选择和页面接入 |

现有探针不能直接注册为生产 Executor：`ManagedAgentHandle` 未暴露正式 AI 方法；构造函数会读取探针环境并回退假模型；调用记录保留原始请求；`pageForGrant` 自身不校验租约；每次构造 / 销毁还会修改 SDK 全局运行目录。以上均在本轮接线时处理。

另有六处既有实现会直接决定 AI 步骤的正确性，本轮必须一并改，不能只加新代码：

1. `isBrowserStepType` 有四个调用点，其中 `db/src/objects/evidence.ts` 用它决定截图 / Trace 是否算「应有而缺」。AI 步骤不进这个判断，第 7 节的证据缺失登记对 AI 就是空的。
2. `engine.ts` 的 `shouldRetry` 明确不看 `ExecutionError.retryable`，`EXECUTOR` 类失败在 `retryLimit > 0` 时一律重试。断言不成立正是 `EXECUTOR`，照搬会把 AI Assert 变成「反复问模型直到它同意」。
3. `session-manager.ts` 的 `release` 只关 `runPages` 里那一页；base 页策略下 `pageForGrant` 返回的是共享 `basePage`，释放后仍留给下一个租约复用。迟到的 SDK 调用因此能碰到下一个 Run 的页面。
4. `EXECUTABLE_STEP_TYPES` 被 `web` 的步骤类型下拉直接遍历，而 `CompileContext.executableTypes` 目前没有任何生产调用方传值。AI 类型一进枚举就是全局开放，没有能力闸门。
5. `PERMISSION_RESOURCES` 没有 `ai` 资源，`OPERATOR_PERMISSIONS` 是显式清单且系统角色权限集不可改，`ai:execute` 的归属是一个必须先定的产品决策。
6. Engine 只认识 `BrowserPort.execute(grant, BrowserCommand, ...)`，而 guard 校验、Trace chunk 与失败截图这套受管范围是按 `BrowserCommand` 写死在 `SessionManager.execute` 里的。复用它必须先把受管范围与命令解耦。

两条既有实现反过来已经保证了本方案的兼容承诺，实现时只需补回归断言，不需要新机制：`canonicalJson` 会丢掉 `undefined` 键，所以给 Snapshot 加可选字段不改旧摘要；`secrets` 表独立于 `target_accounts`，模型密钥登记为独立 Secret 不需要动表结构。

本方案依据当前工作区代码静态核对，未重跑此前模块的全部验收。已有类型检查或测试脚手架失败先复核，影响本轮实现和回归的部分随任务修复；不把它们扩大为新的通用测试平台工程。

## 3. Step 与输出契约

| Step Type | 输入 | 输出与执行语义 |
| --- | --- | --- |
| `ai_action` | 业务 instruction、步骤超时 | 受控动作执行结果及简短摘要；首版固定 `SIDE_EFFECT`，`retryLimit` 只允许 `0`，业务成功由后续独立断言确认 |
| `ai_extract` | 提取 instruction、Output Schema | 经运行时 Schema 校验的结构化数据；固定 `READ_ONLY`，整条动作通道拒绝 |
| `ai_assert` | 业务条件 instruction | `{ passed: boolean, reason: string }`；固定 `READ_ONLY`；`false` 是断言失败，解析失败、超时和模型异常是执行失败 |

三类均使用现有 Step ID、名称、`outputKey` 和 policy；Step 不保存 selector / 坐标轨迹作为下次 AI 执行指令，不允许用户把 AI Action 改成只读以获得自动重试。SDK 类型与 `MIDSCENE_*` 字段不进入业务 Step。

Output Schema 首版支持标量及扁平对象的 string / number / boolean 字段，明确必填字段并拒绝未声明字段；不支持远程 `$ref`、任意表达式或任意 schema 插件。契约使用 Zod 校验，模型结果在进入 Context 前再校验一次。不得用 TypeScript 泛型或 JSON 可解析代替输出契约校验，也不得将“字段形状正确”等同于“提取内容真实”。

### 重试语义必须由代码卡住

现有 `shouldRetry` 不读 `retryable`，只按 `category` 判断，`EXECUTOR` 与 `INFRASTRUCTURE` 在额度内一律重试。三类 AI 因此需要两条硬约束，都落在契约与执行策略上，不写成提示文案：

- `ai_action` 的 `policy.retryLimit` 只允许 `0`。Step Schema 与 Compiler 直接拒绝更大的值，`SIDE_EFFECT` 的 AI 动作可能已经做了一半，`EXECUTOR` 类失败重放等于让平台自己重做未确认的副作用。基础设施类失败也不例外：无法确认副作用结果时走 `NEEDS_REVIEW`，由人决定。
- `ai_assert` 的 `passed: false` 使用一个 `shouldRetry` 明确拒绝的失败分类，与「模型异常 / 解析失败」区分开。断言不成立是业务结论，不是可重试故障；允许重试等于用额度换一个模型点头，也和「业务成功以独立断言判定」直接冲突。

`ai_extract` 的模型异常、超时和 Schema 校验失败可以按现有分类重试，因为它是只读且无副作用；`passed` / 输出内容本身不构成重试理由。

### 结构化输出接续

保留现有 `from` 的根键语义，为 `fill` / `echo` 增加可选 `fromField`，仅在提供 `from` 时合法。例：`from: "order"`、`fromField: "orderNo"` 表示读取前面 AI Extract 的 `order.orderNo`。首版只取一个对象自有字段，不引入 JSONPath 或表达式引擎。

`fromField` 用独立的字段名 schema，不复用 `contextKeySchema`：后者是 context 写入名的标识符规则，而 Output Schema 的字段名由作者按业务命名，两者约束不同。字段名仍限定为非空、有界长度、非保留属性名。

Compiler 校验来源已声明、来自更早 Step、字段存在于已知输出 Schema；运行时仍拒绝缺字段、保留属性名、类型不匹配。新的 `fill` 字段绑定接受标量，数值 / 布尔值按明确的文本转换规则处理。

公共契约负责人同时提供供 Studio 消费的输出形状描述，以及 `CompileDiagnostic` 可选的字段定位 `fieldPath`；具体响应约定见[编排方案第 3 节](2026-09-13-sequence-studio-foundation.md#3-与-midscene-的契约和修改归属)。共享层只描述可验证的数据与规则，UI 不另写字段解析、类型推断或转换语义。

「对象不能被隐式序列化」与「旧解释不变」是两条会互相打脸的要求，分界必须写死在实现里：现有 `resolveStepInput` 对非字符串 context 值执行 `JSON.stringify` 后灌入输入框，这条路径对**已存在的 Snapshot 原样保留**，历史 Run 的解释不动；对**新草稿**，Compiler 在 `from` 指向已知对象输出而未给 `fromField` 时报错，要求作者显式选字段。两条规则共用一份判定来源，不允许运行时按当前配置重新解释旧快照。

AI Assert 必须保存成功和失败的 `passed` / `reason`，不能仅捕获 SDK 抛错。若 SDK 路径不能稳定返回该契约，复用 Midscene 查询能力执行固定版本的断言提示并校验同一输出，仍是独立的 AI Assert Step。

## 4. 正式执行接线

```text
Scenario Draft → Compiler → Published / Trial Version → Run Snapshot
                                                        ↓
                                              Execution Engine
                                                        ↓
                                    静态 Executor Registry（按类型）
                                       ↓                         ↓
                               确定性 Executor           AI Executor / Midscene
                                       └──────────┬──────────────┘
                                          Browser Runtime
                                      同一 Session / 当前 Page
```

Registry 是按 Step Type 映射执行函数的一份静态注册表，复用现有结果与错误形状，不建插件加载器或多框架路由平台。Engine 只消费平台契约，AI 模块负责 SDK 导入与组装；SDK 依赖仍限制在 Worker 的 `src/ai/`。现有确定性 Executor 随调用入口接入该表，不借机重写调度、恢复或持久化。

### Engine 与 AI 之间的端口契约

Engine 现在只认识 `BrowserPort.execute(grant, BrowserCommand, ...)`，而受管调用范围（guard 校验、Page 解析、Trace chunk、失败截图）是按 `BrowserCommand` 写死在 `SessionManager.execute` 里的。AI 既不能塞进那个命令枚举，又必须复用同一个范围，因此本轮明确三件事：

1. `shared` 增加平台级 `AiCommand` / `AiResult` 契约：步骤类型、instruction、Output Schema、预算与截止时间、Evidence 标识；只用通用可验证 JSON，Midscene 类型不进 `shared`。
2. `SessionManager` 把受管范围从 `execute` 里提出来成为一个接受回调的方法，`execute` 自身改为它的第一个调用方。guard 校验、Page 解析、Trace chunk 与截图逻辑只有一份实现，AI 与确定性执行共用，不复制一遍。
3. `src/ai/` 实现一个独立端口（与 `BROWSER_PORT` 同级的注入符号），内部持有 SessionManager 与模型 client；Engine 只注入符号与平台契约。`WorkerModule` 的装配把 SDK 收在这一层。

「SDK 只在 `src/ai/`」目前只是 `src/ai/README.md` 的一句注释。按宪法第 18.18 条，本轮在 `tools/check-invariants.mjs` 增加一条规则：`packages/worker/src/engine/`、`src/runtime/` 与 `worker.module.ts` 不得出现 `@midscene/` 或 `ai/midscene` 的导入，违反即 `pnpm check` 失败。

### 受管执行与所有权

- 「是否需要浏览器」不再等于「是五种确定性 BrowserCommand 之一」。引入单一谓词（如 `stepUsesBrowser`）替换 `isBrowserStepType` 的判定职责，四个调用点全部改到新谓词：`engine.ts` 的 `needsBrowser`、`engine.ts` 的 `sessionLeaseFor`、`db/src/objects/evidence.ts` 的截图 / Trace 应有判定、`compiler.ts` 的「含浏览器步骤却没有断言」告警。`isBrowserStepType` 只保留给确实要区分确定性命令的地方。三类 AI 因此同样获得 Run 级 acquire / release、SessionLease 提交保护与双租约 fencing。
- `pageForGrant` 只能在验证 grant 后使用，SDK 不得 launch、创建独立 Context 或销毁共享 Session。
- 每个 Attempt 创建独立 Agent，结束时清理；同一 Run 的 Page 与 Context 继续共享。保持 `forceSameTabNavigation: false`、`forceChromeSelectRendering: false`、`generateReport: false`。正式路径移除探针配置与假模型兜底。
- 每次模型请求、动作以及异步等待返回后，检查 Attempt AbortSignal、有效 SessionGrant 和执行所有权失效信号。真实 SessionGuard 的撤销 / 到期不能只在 Attempt 开始时检查；Run 丢租由现有生命周期信号及时传递。
- AI Extract / Assert 的只读强制采用**整条动作通道拒绝**，而不是维护一份「哪些动作是写操作」的名单。名单在 SDK 升级新增动作时会静默放行，拒绝整条通道则默认失败关闭；只读步骤本来不该走动作边。
- AI Action 的超时、断线或取消若无法确认副作用结果，沿用 `NEEDS_REVIEW`，不因 SDK 异常、模型切换或 Worker 恢复自动重做。

### 迟到调用不能碰到下一个 Run

超时或取消后先关闭 gate，阻止后续模型请求和动作；迟到结果不能写 Context 或成功终态。不能只用 `Promise.race` 返回而让 Agent 在后台继续操作。

gate 只在动作边与模型边生效，卡在底层网络调用里的 SDK 不受它约束，而这条通路目前是真实存在的：base 页策略下 `pageForGrant` 返回共享 `basePage`，`release` 并不关它，Session 仍然健康并留给下一个租约。因此本轮定死顺序：

```text
超时 / 取消 → 关闭 gate → 有界等待底层调用落定
   ├── 已落定 → 正常 release，Session 可复用
   └── 未落定 → 标记 Session 不可复用并关闭 → 再 release
```

判定必须排在 Engine `finally` 的 `release` 之前，不能先把租约还回池子再补救。等待窗口是配置项而不是魔法数。验收补一条：同一 Session 键的下一个 Run 在页面上看不到任何上一个 Run 的残留动作。

### 页面范围与副作用

首批开放已登记 Target 中的同一受管页面及其受支持交互，不承诺任意 iframe / 多窗口兼容。适配层以平台 Target 策略检查页面范围；导航动作前和重定向 / 页面变化后均校验，越界时停止，不允许把凭据或截图继续发往未授权范围。

本轮同页样本可先验收正式 AI 子项。popup 与当前页交接仍是完整 D1 的验收要求；未完成显式交接前，AI 产生新窗口必须以可诊断错误停止，不静默留在旧页继续执行。可能已经发生副作用时进入核查。操作系统弹窗、任意人工接管与跨系统跳转不作为本轮支持声明。

SDK 的全局运行目录不能按并发 Attempt 反复设置 / 清空。正式路径避免每 Attempt 修改全局配置；先确认关闭报告后仍有哪些落盘，必要临时目录由 Worker 初始化一次并受控清理。文件与监听器残留用并发 Attempt 和 Session 复用用例验证，不用全局锁掩盖所有权问题。

## 5. 模型配置、权限与预算

首期只配一条浏览器视觉模型路由，沿用现有环境配置及 SecretProvider。新增 `CAIRN_BROWSER_AI_*` 正式配置域；默认关闭时不阻断确定性功能；启用但配置非法时明确报错，不回落探针或进程 `MIDSCENE_*` 配置。

| 变量 | 作用 | 校验 |
| --- | --- | --- |
| `CAIRN_BROWSER_AI_ENABLED` | 浏览器 AI 总开关 | 布尔，默认 `false`；为 `false` 时其余项不必填 |
| `CAIRN_BROWSER_AI_BASE_URL` | OpenAI 兼容服务地址 | 启用时必填，须为合法 URL |
| `CAIRN_BROWSER_AI_MODEL` | 实际模型名 | 启用时必填；取值由服务商决定，平台不翻译 |
| `CAIRN_BROWSER_AI_MODEL_FAMILY` | 适配层所需的模型能力族 | 启用时必填；取值须属 SDK 封闭枚举，由适配层校验 |
| `CAIRN_BROWSER_AI_API_KEY_SECRET_ID` | 模型密钥的 Secret 引用 | 启用时必填其一；非 development 只接受这一项 |
| `CAIRN_BROWSER_AI_API_KEY` | 开发期直填密钥，也是登记命令的输入 | 仅 development 可用作运行凭据，取值一律不入日志与 Snapshot |
| `CAIRN_BROWSER_AI_REQUEST_TIMEOUT_MS` | 单次模型请求超时 | 正整数；须小于步骤超时 |
| `CAIRN_BROWSER_AI_HANG_WAIT_MS` | 取消 / 超时后等底层调用落定的窗口 | 正整数；超出即判为未落定，按迟到隔离处理 |
| `CAIRN_BROWSER_AI_STEP_MAX_CALLS` | 单个 StepRun 的模型调用上限 | 正整数，预算的硬上限 |
| `CAIRN_BROWSER_AI_MAX_OUTPUT_TOKENS` | 单次响应 token 上限 | 正整数 |

**平台变量名与 SDK 键名是两层，不是同一层。** `CAIRN_BROWSER_AI_*` 是平台自己的配置名，永远不出现在 SDK 面前；适配层把它们映射成 Midscene 的 `modelConfig` 对象，对象的**键**才是 `MIDSCENE_MODEL_NAME` / `_BASE_URL` / `_API_KEY` / `_FAMILY`。这是 SDK 的官方隔离扩展点（`Agent` 构造函数要求 `modelConfig` 是 plain object，且显式传入时与全局配置完全隔离），探针已经按这条路跑通，因此**不需要改 Midscene 源码，也不需要往进程环境写 `MIDSCENE_*`**；`vendor/midscene` 只是只读参考快照，不在 workspace 内，fork SDK 不在本方案范围。

不自由的是**取值**，有两项受外部约束，必须在实现里当作硬约束对待：

- `CAIRN_BROWSER_AI_MODEL_FAMILY` 的合法值是 SDK 的封闭枚举（1.12.6 由 `TModelFamily` / `MODEL_FAMILY_VALUES` 定义，`validateModelFamily` 对非法值抛错）。枚举知识留在 `src/ai/`，**不写进 `shared` 的 env schema**——把第三方枚举复制进平台契约会在 SDK 升级时变成两处事实源。为了不让拼写错误拖到第一次 AI 调用才暴露，启用状态为真时 Worker 启动期调用一次适配层的校验入口，失败按现有配置错误路径拒绝启动。
- `CAIRN_BROWSER_AI_MODEL` 透传给模型服务，必须与服务商控制台的模型 ID 或接入点 ID 一致，平台不做名称翻译或猜测。

`_MODEL_FAMILY` 是适配层参数而非平台概念，但**不为此改名**：名字与 Midscene 文档对得上更利于排查，抽象命名只增加理解成本。将来接入第二个浏览器 AI 实现时，它只消费自己需要的配置键，用不到的键保持惰性即可，不要求每个适配器都接受全部键，也不要求为此重命名既有键。真正保证可替换的是 Step 契约、`AiCommand` 端口与 Snapshot 冻结的适配器标识，不是配置命名。

变量随读取方及 Schema 一同落地，进 `workerEnvSchema`，API 只解析其中的非秘密项。`.env.example` 是键集事实源且 `pnpm env:use` 会按键集对齐，加键时同步更新开发画像文件。`CAIRN_S06_*` 保留为离线 / 在线探针专用，不作为正式运行配置；正式路径同时保留「进程里不得存在 `MIDSCENE_*` / `OPENAI_*`」这条断言，从探针测试升级为启动期检查。

模型密钥复用现有加密 Secret 存储，补最小管理命令把 `CAIRN_BROWSER_AI_API_KEY` 登记为独立 Secret 并打印引用，密钥不作为命令行参数、日志或 Snapshot 明文。该 Secret 不绑定为 TargetAccount，也不借目标账号密码字段保存模型密钥。Worker 经引用读取，API 仅解析非秘密执行配置和引用。

解出的模型密钥必须并入 Attempt 的脱敏集合。现有 `resolveRedactionSecrets` 只解目标账号口令，本轮让模型密钥走同一条路进 `startAttempt` / `finishAttempt` 的 `secrets`，否则 SDK 或 HTTP 客户端把 Key 带进错误文本时，证据里就是明文。

### 权限与能力闸门

复用 RBAC，新增 `ai` 资源与 `ai:execute` 权限，同时补 `PERMISSION_RESOURCES`、`PERMISSIONS` 与两张 label 表。`admin` 通过 `permissions: PERMISSIONS` 自动获得；**`operator` 默认不含 `ai:execute`**——系统角色权限集由代码拥有且不可改，AI 调用属于会产生外发和成本的能力，默认由管理员通过自定义角色显式授予。系统角色权限对账随同一次变更落地，不留下「代码有、库里没有」的角色行。

API 创建正式 Run 与 Trial Run 时校验 AI 执行权限和启用能力；草稿编辑 / 发布仍沿用 workflow 权限，实际调用需同时具备 run 与 AI 执行权限。Worker 不重做身份判定，只按冻结的 Snapshot 执行。

能力闸门要真的存在，不能只写在文案里。AI 类型进入 `EXECUTABLE_STEP_TYPES` 之后：API 按启用配置向 Compiler 传 `executableTypes`，未开放时 AI 步骤得到 `SCENARIO_UNKNOWN_STEP_TYPE`；前端步骤类型清单改为读能力查询结果，不再直接遍历枚举常量。能力未开放时，已有符合 Schema 的草稿仍可编辑和保存；步骤库与类型切换不提供可选的新建入口，发布 / 试跑给出明确诊断。

本线提供新增的 `GET /scenarios/capabilities`，沿用 `workflow:read`，静态路径在 `:scenarioId` 前注册。响应的 Runtime Schema 包含 `executableStepTypes` 与 `unavailableReasons[{type, code, message}]`，不含凭据、模型地址或 SDK 参数；表示部署配置与已开放类型，不代表 Worker 健康。Studio 另外按 RBAC 判断用户动作，服务端发布 / 创建 Run 重新校验。接口与字段定位由同一公共契约负责人提交，详细分工见编排方案第 3 节。

### 预算

调用预算由平台包装 client 执行：限制单次响应 token 上限、StepRun 累计模型调用次数和 Attempt 截止时间。SDK 自带网络重试关闭；语义重试必须经过同一个 client 并计数。模型请求前，在有效双租约事务内登记一条最小调用证据并预占调用额度；失败未发出也保守计入。重试和恢复读取 StepRun 已使用额度，不将预算归零。进程崩溃时，未拿到响应的调用保留为结果 / 用量未知。

累计计数复用现有 Evidence `log` 行及 Run 锁，新增操作封装在 `@cairn/db`，业务层不引入 SQL 方言。计数**不得依赖 JSON 谓词下推**：按 `stepRunId` 与 `type` 取行、在代码里分类，或使用独立计数存储；PG / MySQL / SQLite 三库共用同一业务断言，沿用现有适配测试。预扣记录走独立事务，Attempt 失败或回滚不得把已发出的调用额度退回；Attempt 主结果仍由 Engine 原子收尾。不额外建设计费或队列系统。

平台通用 AI 的配置、启用状态与凭据保持独立；本轮不新增没有调用方的通用 AI 变量，也不自动回退到其模型。

## 6. Snapshot 与历史兼容

为 Run Snapshot 增加可选的 AI 执行配置。含 AI Step 时必须存在且通过 Runtime Schema 校验；确定性历史快照缺省仍按原逻辑解释。冻结内容包括：适配器 / Executor 类型与版本、SDK 版本、路由标识和配置版本、模型服务与模型名、凭据引用、提示 / Policy 版本及关键参数和预算。instruction、Step 类型及 Output Schema 已包含在冻结的 steps 中。

API 的正式与 trial 路径共享同一份配置解析结果并传入公共创建函数；Worker 只使用 Snapshot 的非秘密配置，不以当前 `.env` 覆盖。轮换密钥可以更新引用的秘密材料，但不得借此改变历史模型或策略。

Run 同时冻结执行所允许的 Target 页面范围与 AI 采集 / 外发策略，供确定性和 AI 步骤共同使用。当前 Engine 的 `loadAllowedOrigins` 读取实时 Target 配置，本轮改为**所有新 Run 都用冻结值**，而不是只对含 AI 的 Run 生效：同一个平台里 `navigate` 的范围判定不能有两套解释，字段可选加旧快照回落实时查询已经足够兼容，也更贴近「历史 Run 不依赖当前配置」。旧快照走这条明确的兼容路径，不能以当前 Target 配置补写历史快照。

AI 配置与冻结页面范围进入 `snapshotDigestPayload`；旧快照缺字段时规范化摘要必须保持不变。`canonicalJson` 已经会丢掉 `undefined` 键，这条承诺是结构性成立的，实现只需补一条对既有快照夹具的摘要逐字节回归断言，防止后续有人改动摘要负载时把它破坏。幂等键仍代表同一次创建请求：同键重传返回原 Run 和原配置，即使部署配置发生变化也不重新执行；新增 Run / 新幂等键采用新配置。若将来允许请求显式选路由，届时再把该请求选择纳入幂等摘要。本期不提供用户任意填写模型地址的 Run 接口。

更新 `executorVersions` 的冻结与匹配、Compiler 版本及新增输入形状的兼容检查；不改写已存历史 Snapshot 或旧版本行。第一版按停止领取、统一升级 API / Worker、恢复领取部署，不声称旧 Worker 能执行新增 AI Step。只把通用、可验证 JSON 契约跨过包边界，不让 Midscene 类型进入 shared / db。

## 7. Evidence 与现有页面

主 input / output / error、Context、Attempt 和 StepRun 仍沿用同一原子提交。AI 调用与动作摘要复用现有 `log` Evidence，payload 使用版本化 AI 审计 Schema；记录关联 ID、调用编号、开始 / 结束、实际模型、耗时、tokens / 成本（可获得时）、错误分类，以及业务结果的简短依据。未知用量显示未知，不记成零。

模型 API Key、目标密码及其他 Secret 明文在日志与 Evidence 写入前脱敏；探针中的原始 `params` 收集不进入生产。只把执行任务所需的页面和显式绑定数据提供给模型，不把整个 Run Context、凭据对象或完整 SDK 原始请求当作默认输入。认证页面不执行 AI；页面采集与模型外发需符合 Target 策略，敏感输入区域在采集侧遮罩或拒绝采集，不能指望文本脱敏清除截图内容。

复用 Screenshot / Trace 策略和 ObjectStore；失败也必须保存可获得的 AI 判断与调用错误，证据缺失明确登记。业务成功以独立断言判定，不能只相信 Agent 自报任务已完成。

本线提供三类 AI 专用字段组件：业务指令、提取输出字段、断言条件及固定执行策略；同时提供判断结果、原因和调用摘要的 AI 证据组件。分别在独立的 `ai-step-fields.tsx` 与 `ai-evidence.tsx` 中实现，Props 在公共契约评审时与 Studio 线约定。Studio 线负责步骤注册、公共输入绑定、`step-editor.tsx` 与 `evidence-viewer.tsx` 的挂载接线，避免两边同时修改同一交互入口。沿用设计 Token、AI 紫色语义及前端验收工作流，联合验收三类表单和结果展示；AI Executor 开发无需等待 Studio 全部增强完成。

本轮试跑仍可通过现有 GET 刷新查看结果；不新增高频轮询，也不让 SSE 或浏览器视频流成为 AI Executor 的依赖。画面与受控认证按 P7 / S-LIVE 完成后接回同一 Run。

## 8. 可交付验收

主样本复用 Surface Lab 的订单 / 混编页面，使用可重置测试数据与真实视觉模型：确定性打开与输入 → AI Action 完成指定查询 → AI Extract 读订单字段 → 确定性填入另一个控件 → 确定性断言核对业务值 → AI Assert 判断结果。由业务步骤组成约 10 步流程，具体页面与期望固定在样本中，不用模型自己的结果生成期望。

| 检查 | 必须证明的行为 |
| --- | --- |
| 正式闭环 | 在 Studio 保存、修改、从头试跑、发布、再建正式 Run；三类 AI 和确定性 Step 同一会话、同一账本，后续步骤消费真实 AI 字段 |
| 完整停止 | 用假模型响应回放完整 `aiAct` 循环，在规划返回至动作开始的窗口注入取消、超时和真实 lease revoke；零新动作、零续呼、迟到结果不能提交 |
| 迟到不串 Run | 底层调用在取消后不落定时，Session 被标记不可复用并在 `release` 前关闭；同一 Session 键的下一个 Run 页面上零残留动作 |
| 只读与输出 | Extract / Assert 拒绝整条动作通道（含 SDK 新增的未知动作名）；缺字段、类型错、非法 JSON、false 断言均有正确失败分类；失败输出不能写成成功 Context |
| 重试边界 | `ai_action` 拒绝 `retryLimit > 0`；`passed: false` 不触发任何重试；`EXECUTOR` 类失败不重放已开始的 AI 动作 |
| 预算与故障 | 429、超时、SDK 语义重试、Attempt 重试及恢复共享预算；调用前持久登记失败则不外呼；Attempt 回滚不退还已发出额度；副作用未知不自动重做 |
| 配置与权限 | 无 AI 配置的确定性 Run 正常；缺 `ai:execute` 不能运行 AI；能力关闭时阻断发布 / 试跑和新建该类型，已有合法草稿可编辑保存；密钥不出现在快照 / 证据 / 错误文本；改配置不影响旧 Run，同键重传返回原 Run |
| 浏览器与证据 | 无私自 launch；销毁 Agent 后 Session 可继续复用；并发任务不串配置 / Trace；AI 步骤与确定性步骤一样进入截图 / Trace 应有判定；越界或未支持 popup 可诊断停止，失败有证据 |
| 真模型支持范围 | 本轮只按普通 DOM 类别开放，`小图标`、`嵌套 iframe`、`popup / 导航`、`Canvas` 显式登记为未开放；按 P9 要求对开放类别跑至少 5 个代表任务 × 3 次（共 ≥15 次尝试），成功率 ≥90%、安全误操作为零，记录用量与限制，离线通过不能代替在线验收 |
| 边界检查 | `pnpm check` 新增规则：`engine/`、`runtime/` 与 `worker.module.ts` 不得导入 `@midscene/` 或 `ai/midscene` |
| 兼容与页面 | 既有快照夹具摘要逐字节不变；确定性执行、草稿 OCC 与发布 / trial 幂等回归；前端按影响面检查三类表单、键盘操作与结果展示 |

优先扩展已有 Vitest、Engine × 真浏览器用例与受控靶场。离线检查不要求真实模型 Key；在线验收使用明确配置的路由与受控数据，不默认对 `docs/targets/` 中的真实企业页面发起 AI 请求。三库新增持久化操作共用业务断言，沿用现有数据库适配测试。

本轮通过表示“首个 Midscene 正式 AI 混编子项可用”；完整 D1 的 SSE、Live View、受控认证及页面交接另按工程计划验收。实现完成后写实际测试结果、支持范围及 CHANGELOG，不以方案文字代替完成记录。

### 在线真模型实测记录（2026-09-13）

模型 `doubao-seed-2-1-turbo-260628`（`doubao-seed` 族，Ark OpenAI 兼容端点），Target 为受控靶场 `surface-lab-ai`（密码登录，会话复用）。5 个代表任务各跑 3 次，全部走正式 Run 而非探针路径：

| 任务 | 页面与交互 | 步骤 | 结果 |
| --- | --- | --- | --- |
| T1 混编主样本 | 动态异步表格：AI Extract 读首行 → 确定性 `fill` 消费 `fromField` → AI Action 查询 → AI Assert → AI Action 删除并确认 | 10 | 3/3，每次 8 次模型调用 |
| T2 分页只读动作 | AI Action 翻页，确定性核对页码与「数据未被改动」 | 7 | 3/3，每次 4 次调用 |
| T3 表单填写与校验 | AI Action 填数字框与文本域、AI 提交，确定性核对校验拦截与金额未变 | 8 | 3/3，10–13 次调用 |
| T4 普通 DOM 查询 | Surface Lab 首页单号查询 | 6 | 3/3，每次 6 次调用 |
| T5 指定行删除 | 三行中删指定行，确定性核对只少一条且首行未被误删 | 7 | 3/3，5 次调用 |

合计 15 次尝试全部 `SUCCEEDED`，成功率 100%，`evidenceStatus` 全为 `COMPLETE`、零缺失证据条目；模型调用 105 次，tokens 790563 / 12149。期望值全部写死在样本里由确定性 `assert` 核对，误操作检查也编码成确定性断言（总计记录数、页码、首行订单号），因此「安全误操作为零」由这些断言而不是人工观察保证。单次 Run 15–60 秒；AI 步骤超时设为 180s（Action）/ 120s（读），因为一个 AI 步骤会发多次模型请求，默认 30s 步骤超时不够。

负向样本单独跑过：故意不成立的 AI Assert 得到 `passed:false` + `ASSERT_FAILED / VALIDATION`、不重试，并按 `on_failure` 留下失败截图，`evidenceStatus` 为 `COMPLETE`。

未开放类别照原样登记：`小图标`、`嵌套 iframe`、`popup / 导航`、`Canvas` 本轮不验收。另有一项实测限制：原生 `<select>` 下拉框视觉模型无法操作，当前 Step 集也没有 Select 类型，因此 `order-flow` 的类目 / 商品选择不在开放交互内，T3 以「校验拦截」为期望结果。

实现过程中由实测暴露并修掉的四处偏差：AI 步骤超时被 SDK 包成普通失败后没能进 `NEEDS_REVIEW`；`aiQuery` 的输出 Schema 没有真正传给模型，导致模型自造中文字段名；必填字符串字段接受了空值，让未渲染完的表格被当成有效提取；`ai_assert` 的 `passed:false` 没有触发失败抓图。另外确认 SDK 在关闭报告后仍会把模型响应与页面描述写进 `<cwd>/midscene_run/log/`，已改为进程启动时一次性指向 Worker 自己的临时目录并在退出时清理；`uploadTestInfoToServer` 未配置服务端地址，不产生外发。

### 离线完整停止验证（2026-09-14）

对应上表「完整停止」。`packages/worker/src/ai/midscene/managed-page.lab.spec.ts` 在受管 Page（真实 PG + SessionLease）上跑真 Midscene 规划循环，模型响应按序号回放；在第 1 次规划已返回、动作尚未开始时注入取消、超时和 `SessionGuard.revoke`。对照组真实点中画布；三种注入均零新动作、出站模型调用保持 1 次；只读 Agent 在同一循环里零动作。

复查发现并修复：续租失败只 revoke 进程内 guard、不 abort 步骤信号，而 gate 原先只看信号，真实丢租后 Agent 仍会点击。现由 `createStepGate` 让动作边与模型边同时校验 `SessionGuard.assertHeld`。反向验证：去掉该校验后「真实丢租」用例点击 1 次而失败。

「迟到不串 Run」：同一文件扣住规划响应，模拟卡在底层调用里的 SDK（gate 故意不接信号）。先 invalidate 再 release 时，下一 Run 换了新页、旧页已关、零迟到点击；对照组不作废会话时，迟到点击落到下一 Run 复用的页面。复查同时修正两处：`settleAiCommand` 让未落定结果原样返回，页面检查不再抛错盖掉 hung（`withManagedPage` 范围检查失败的分支同样保留）；AI 新开的窗口先关闭再报 `AI_POPUP_UNSUPPORTED`，不再留在 Session 里带进后续 Run。

丢租的分类此前落到了 `AI_EXECUTION_FAILED / EXECUTOR`：gate 拦下动作后 SDK 抛的是被它包过一层的报错，AiResult 也没有错误码字段，于是副作用 AI 步骤被记成普通失败，绕过了提交边界对「成功但会话租约已失效」的处置。现在 `ActionGate` 记放行过的动作数，`leaseLostError` 据此分类：已放行过记 UNKNOWN（副作用步骤进 NEEDS_REVIEW），没放行过记 INFRASTRUCTURE；`AiResult` 增加可选结构化 `error`，执行器原样使用；`shouldRetry` 对 `SESSION_LEASE_LOST` 不再重试。真实 SDK 的 lab 用例验证零动作与已动作两种分类，Engine 用例验证副作用进 NEEDS_REVIEW、只读不重试。

SDK 调试日志（含模型响应与页面描述）改为按 Agent 存活期轮换：全部销毁后切到新一代目录并删除旧代，仍有 Agent 在途但单代超过 64 MiB 也轮换（`run-dir.ts`）。gate 拦下模型请求后 SDK 自带一次约 2s 的重试，同样被拦、不出站。

## 9. 修订记录

- 2026-09-14：补迟到调用跨 Run 用例；AI 新开窗口收尾关闭、hung 不被页面检查盖掉；SDK 调试日志轮换。
- 2026-09-14：补离线完整停止验证记录；AI 步骤 gate 接入 SessionGuard，修复真实丢租后仍可动作。
- 2026-09-13：补记在线真模型实测结果与两项实测限制（原生 `<select>` 不在开放交互内、SDK 关闭报告后仍落盘日志）；`CAIRN_BROWSER_AI_HANG_WAIT_MS` 补进配置表。
- 2026-09-13：与 D1 编排增强方案对齐分工：本线提供 AI 契约、能力查询、专用表单和 AI 证据组件，Studio 线负责公共编辑与页面接入；补字段定位及输出描述交接，明确能力未开放时既有草稿的编辑边界。运行时与模型验收要求保持不变。
- 2026-09-13：补记平台变量名与 SDK `modelConfig` 键名的两层关系——不改 Midscene 源码、不写进程 `MIDSCENE_*`；`MODEL_FAMILY` 枚举知识留在 `src/ai/` 并在启用时做启动期校验，`MODEL` 取值由服务商决定。
- 2026-09-13：对照工作区代码复审后补齐。新增 Engine 与 AI 的端口契约与跨包边界检查；把「迟到调用不能碰下一个 Run」从原则写成执行顺序；用单一 `stepUsesBrowser` 谓词收拢 `isBrowserStepType` 的四个调用点（含证据完备性判定）；明确 `ai_action` 禁重试与 `ai_assert` `passed:false` 不重试；给出 `CAIRN_BROWSER_AI_*` 变量表、模型密钥进脱敏集合、`ai:execute` 归属与能力闸门的具体落点；预算计数禁止 JSON 谓词下推；冻结页面范围改为对所有新 Run 生效；`fill` 对象序列化的新旧分界写死；验收补迟到隔离、重试边界、边界检查三行并固定本轮开放的 P9 类别与样本量。
