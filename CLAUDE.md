# 识途宪法

> 本文件只定义不可轻易破坏的产品原则、领域语义、运行时不变量与技术边界。可替换的实现不得伪装成产品不变量；选型理由、历史方案和否决清单不进入本文件。

## 1. 产品核

识途是面向真实Web系统的智能仿真平台。

平台同时支持**确定性自动化**与 **AI 智能自动化**。二者地位平等，共享 Scenario、Run、Execution Context、Browser Session、调度与 Evidence 体系。

识途不是“RPA 加 AI”，而是统一执行运行时：**确定性 Step 与 AI Step 可以在同一 Scenario 中逐步骤自由组合，并共享同一运行生命周期。**

用户先选择 Target，再通过录制、手工编排或 AI Authoring 构建 Scenario。固化后的 Scenario 可用于手工运行、调试、巡检、测试和调度执行。

平台不是无边界的通用 RPA，也不是裸 Browser Agent。没有绑定 Target 的 Scenario 不得执行；没有持久化运行事实和必要证据的 Run 不算完成。

## 2. 统一领域模型

```text
Target → TargetAccount → Scenario → Step[]
                               ↓
                              Run
                               ↓
                           StepRun
                               ↓
                            Attempt
                               ↓
                    Output / Evidence / Trace
```

- **Target**：被仿真的真实业务系统，是系统身份、入口、策略与账号资源的逻辑边界，不等同于 URL。
- **TargetAccount**：登录 Target 的目标系统账号，与识途控制台用户完全分离。
- **Scenario**：可版本化的执行定义。MVP 采用 Sequence First，由有序 Step 链组成。
- **Step**：统一最小执行单元，具有 Step Type、输入/输出契约、执行策略和 Executor。
- **Run**：一次 Scenario 执行。手工、调试、AI 试跑和调度执行都进入统一 Run 模型。
- **StepRun**：Run 中某个 Step 的一次逻辑执行。
- **Attempt**：StepRun 的一次实际尝试。Attempt 失败不等于 StepRun 失败；策略耗尽后才判定 StepRun 失败。

MVP 不提供自由分支、并行、状态机和任意跳转，但数据模型不得永久堵死未来的结构化控制流能力。

Run 启动时冻结 Scenario Definition 及影响执行解释的配置。之后修改 Scenario 只影响新 Run；历史 Run 必须依赖自身 Snapshot 解释。

## 3. Authoring 与 Runtime 分离

场景“如何创建”与“如何执行”必须分离：

```text
Recorder ──────┐
Manual Editor ─┼──→ Structured Step → Scenario
AI Authoring ──┘
```

录制只是生成确定性 Step 的一种 Authoring Method，不是独立执行模式。Extension Recorder 捕获真实浏览器操作，经规范化生成 Structured Step；录制结果必须可在 Web 中继续编辑和验证。

手工创建与录制生成的同类型 Step 在 Runtime 中没有等级差异。

AI Authoring 可以创建/配置 AI Step，也可辅助生成确定性 Step，但不得形成不可检查、不可修改、不可版本化的黑盒场景。

## 4. Structured Step，而非自造 DSL

MVP 不把自研文本 DSL 作为 Scenario 的底层事实源。

Scenario 的事实源是**版本化 Structured Step Definition**。它必须机器可验证、可迁移、可编辑。

未来可以提供 Code View、脚本导入或高级 DSL，但它们属于 Authoring / Presentation 能力，不得反向成为唯一事实源。

跨模块、跨进程和持久化的核心结构必须具有 Runtime Schema，不能只依赖 TypeScript 编译期类型。

## 5. Step 类型

MVP 遵循“语义明确、契约明确、能力最小化”。

确定性 Step 围绕真实 Web UI 自动化提供必要能力，例如 Navigate、Click、Input/Fill、Select、Keyboard、Wait、Extract、Screenshot、Assert。不得因为 Playwright API 很多就无限膨胀 Step Type。

AI 产品层至少区分：

- **AI Action**：理解页面并执行操作；
- **AI Extract**：从页面提取结构化信息，原则上只读；
- **AI Assert**：判断业务条件是否成立，至少输出判断结果与解释，原则上只读。

三类 AI Step 可以共享 AI Executor，但产品语义与输入输出契约不得混成一个万能节点。

## 6. Execution Engine

Execution Engine 是识途核心自研运行时，负责：

- 加载 Run Snapshot；
- 顺序调度 Step；
- 创建 StepRun / Attempt；
- 通过 Executor Registry 解析执行器；
- 维护 Execution Context；
- 管理 Timeout、Retry、Cancel、失败传播；
- 持久化状态与结果；
- 驱动 Evidence；
- 与 Browser Runtime 协作。

Execution Engine 不直接实现浏览器动作或 AI 推理。

```text
Execution Engine
       ↓
Executor Registry
   ┌───┼──────────┐
   ↓   ↓          ↓
 RPA   AI       Assert
Executor Executor Executor
```

未来新增 HTTP、SQL、Shell、Human 等 Executor 时，不应要求重写 Scenario、Run 或 Evidence 的核心生命周期。

## 7. Browser Runtime

Browser Runtime 是识途核心自研基础设施。

Playwright 是浏览器自动化核心能力；CDP 等连接方式只是 Browser Runtime 的实现策略，不属于产品不变量。

Browser Runtime 统一管理 Browser Process、Browser Context、Page、Browser Session、TargetAccount 关联、Lease、健康状态、生命周期、失效恢复与清理。Executor 不得绕过 Browser Runtime 私自创建无法纳管的正式执行浏览器。

**Browser Session** 表示可复用的浏览器运行与认证状态。同一次 Run 默认共享同一 Session。Session 与 Run 生命周期解耦，Run 结束不意味着 Session 必须销毁。

**Lease** 表示某次执行对 Session 的临时独占使用权。同一 Target + TargetAccount 在要求单会话一致性的策略下，同一时刻只能有一个有效 Lease。异常退出、Worker 失联和超时不得造成永久死租约。

Session 生命周期由健康状态、认证状态、Idle TTL、最大生命周期和 Target 策略共同决定。健康且可复用的认证会话优先复用；失效时允许重建。

## 8. Execution Context

同一个 Run 必须具有显式 Execution Context。Step 输出可以按名称供后续 Step 引用。

页面状态通过共享 Browser Session 延续；数据状态通过 Execution Context 显式传递。不得依赖不可见的进程内全局变量作为 Run 事实源。

## 9. AI 执行原则

AI 是 Executor 能力，不是独立场景系统。

AI Step 保存**业务意图、契约和执行策略**，而不是某一次成功运行产生的 selector、坐标或点击轨迹。每次运行时 AI Executor 基于当前页面重新理解并完成意图。

如果未来提供“AI 成功后转确定性步骤”，必须是显式用户操作并产生新的 Scenario 版本。

Run 必须冻结足以解释当时 AI 行为的配置，包括 instruction、Step 类型、Executor 类型/版本、Model Route、实际模型、Prompt/Policy Version、关键参数和 Output Schema。

> Scenario 保存“要做什么”；Run Snapshot 保存“当时以什么配置执行”；Evidence 保存“实际上发生了什么”。

Midscene 可以作为第一阶段默认 AI Executor 实现，但识途核心模型不得依赖 Midscene 专有语义。模型访问经过 Model Router，不允许业务 Step 与具体模型供应商形成不可替换的直接绑定。

## 10. Evidence 与可复盘性

Evidence 是产品能力，不是附属日志。

证据必须关联到 Run、StepRun、Attempt。Platform Evidence 至少能表达 Step 输入/输出、Attempt、时间、Screenshot、Error、Executor 信息、AI 必要审计信息、AI Decision/Reason 和关键运行事件。

Playwright Trace 用于浏览器级调试，但不得取代平台自己的 Step Evidence。完整 Trace 按 Evidence Policy 保留，例如 Debug Run、Failure、Retry/异常 Attempt 或显式要求时保留，而不是所有成功 Run 永久保存。

结构化状态、索引和对象指针存 PostgreSQL；截图、Trace、报告等大对象存 S3 兼容对象存储。对象存储不得作为队列、锁服务或事务事实源。

## 11. Run 状态是真相

Run、StepRun、Attempt 的持久化状态以 PostgreSQL 为事实源。

Worker 必须持续持久化关键状态。WebSocket、SSE、PG NOTIFY、API 内存和 Worker 内存都不是运行状态事实源。

实时通知只提示“状态发生变化”。页面刷新、API 重启或实时连接丢失后，系统必须能从持久化状态恢复真实 Run 状态。

## 12. API、Worker 与调度

**API** 是无状态控制面：负责鉴权授权、Target/Account/Scenario 管理、Run 创建、调度、查询、Evidence 索引访问和 Web 实时出口。API 不持有正式 Browser Session，不执行 Scenario。

**Worker** 是执行面：负责领取 Run、Execution Engine、Executor、Browser Runtime、Session/Lease、Evidence 生产和状态持久化。Worker 不通过调用 API 写回执行事实。

Worker 与 API 通过持久化数据和通知机制协作，不通过双向业务回调耦合。

MVP 使用 PostgreSQL 持久化 Run 队列并通过原子领取机制支持多 Worker。具体队列实现是阶段性技术选择；长期不变量是：**调度必须持久化、可恢复、支持原子领取，并避免同一任务被多个 Worker 同时成功持有。**

## 13. 实时通信

Web 获取 Run 实时进度采用 SSE。PostgreSQL 状态表是事实源，PG NOTIFY 只作为变化提示：

```text
Worker → Persist State → NOTIFY → API → SSE → Web
```

丢失 NOTIFY 或 SSE 不得造成状态丢失。客户端重新连接后必须能通过 API 恢复完整状态。

禁止用高频轮询作为正常 Run 实时进度机制；断线恢复查询不属于轮询。

## 14. Extension 边界

Extension 是 Authoring 与本地浏览器协作组件，不是正式 Runtime 的必要依赖。

MVP 主要承担 Recorder 和必要的 Local Browser Bridge。正式调度 Run 不依赖 Extension。

AI Trial、Debug Run 和手工 Run 原则上进入统一 Run / Execution Engine。只有需要接管用户当前本地浏览器上下文时才使用 Local Browser Bridge；特殊通道仍不得绕过 Run、Snapshot、Evidence 和持久化状态体系。

## 15. Secret 与身份

识途控制台身份与 TargetAccount 必须彻底分离。

目标系统凭证通过 SecretProvider 抽象访问。MVP 可采用安全的本地/数据库加密实现，未来可接 Vault、KMS 或企业秘密管理系统；业务代码不得依赖具体 Secret Backend。

平台授权以 RBAC 为基础，并为企业身份协议扩展保留边界。日志、Evidence、异常和 AI 请求不得无控制泄露凭证明文。

## 16. 可观测性

结构化日志至少以 requestId、runId、stepRunId、attemptId 串联。Tracing 与 Metrics 使用 OpenTelemetry 体系。

平台必须能够回答：Run 为什么失败、为什么慢、资源和 AI 成本发生在哪里。AI 调用必须可观测耗时、模型、Token/成本（可获得时）、错误与路由。

## 17. 前端原则

Web 是主要控制台。shadcn-admin 是管理端 Shell 和工程起点，不是产品架构或不可替换依赖。设计系统采用 shadcn/ui + Radix + Tailwind。

MVP Scenario Studio 采用 **Sequence First**，不以自由 Flowchart 为主要交互。`@xyflow/react` 作为未来复杂流程视图的技术预选，不是 MVP 必需依赖。

Scenario Studio、Step Editor、Run Detail/Debugger、Evidence Viewer、Browser Session 等核心页面围绕识途领域模型自行设计，不能被通用 Admin 模板反向塑造。

## 18. 架构不变量

1. Scenario 必须绑定 Target 才能执行。
2. Scenario 核心事实源是版本化 Structured Step Definition。
3. 确定性与 AI Step 共享统一 Scenario / Run / Context / Evidence。
4. Authoring Method 与 Runtime 分离。
5. Execution Engine 与具体 Executor 分离。
6. Executor 与 Browser Runtime 分离。
7. 正式执行不依赖 Extension。
8. Run 启动后使用冻结 Snapshot。
9. 历史 Run 不依赖当前 Scenario 解释。
10. Run / StepRun / Attempt 状态必须持久化。
11. 实时通信不是事实源。
12. Evidence 必须与 Run / StepRun / Attempt 可关联。
13. 可复用 Browser Session 与单次 Lease 分离。
14. TargetAccount 与控制台身份分离。
15. Secret Backend 可替换。
16. AI Executor 与具体 AI 框架、模型供应商解耦。
17. 关键跨边界契约必须可运行时验证。
18. 必须遵守的约束最终都应由代码、Schema、数据库约束、状态机或自动化检查卡住，而不是依赖自觉。

## 19. 硬禁区

- 不得执行未绑定 Target 的 Scenario。
- 不得把自然语言伪装成确定性 DSL 后交给脚本引擎猜测执行。
- 不得让 Recorder 内部格式成为 Runtime 唯一事实源。
- 不得让 AI 一次成功轨迹静默取代原 AI Step 的业务意图。
- 不得让 Executor 私自创建无法纳管的正式 Browser Session。
- 不得因每次 Run 开始而无条件重新登录。
- 不得为要求单会话一致性的同一 Target + TargetAccount 同时授予冲突 Lease。
- 不得用当前 Scenario 定义解释已开始或已完成的历史 Run。
- 不得让 Worker 通过 API 回调写回正式执行事实。
- 不得让 Web 直连数据库或正式 Worker。
- 不得把对象存储当队列、锁或事务源。
- 不得让 WS、SSE、NOTIFY 或进程内存成为 Run 状态唯一事实源。
- 不得让具体 AI 框架或模型供应商定义识途核心领域模型。
- 不得默认永久保存所有成功 Run 的重型 Trace。
- 不得把控制台账号与目标系统账号建成同一种账号。

## 20. 当前技术基线

本节记录当前工程基线，不等同于永久架构不变量；版本只锁大版本，精确版本以 lockfile 为准。

| 层 | 当前选择 |
|---|---|
| Runtime | Node 24 LTS |
| Monorepo | pnpm + Turborepo |
| API | NestJS |
| ORM | Drizzle |
| Runtime Schema | Zod |
| Database | PostgreSQL 16+ |
| MVP Queue | PostgreSQL + `FOR UPDATE SKIP LOCKED` |
| Object Storage | S3 Compatible（MinIO / OSS 等） |
| Browser Automation | Playwright |
| Browser Runtime | 自研 Session / Lease Manager |
| Execution Runtime | 自研 Execution Engine + Executor Registry |
| AI Executor | Midscene（第一阶段默认实现） |
| Model Routing | 自研 Model Router |
| Secret | SecretProvider abstraction |
| Frontend | React 19 + Vite |
| Server State | TanStack Query |
| Table | TanStack Table |
| Router | TanStack Router |
| Local UI State | Zustand |
| UI | shadcn/ui + Radix + Tailwind |
| Admin Shell | shadcn-admin（二次开发） |
| Scenario UI | Sequence Editor（MVP） |
| Advanced Flow | `@xyflow/react`（预留） |
| Realtime | SSE |
| Change Hint | PostgreSQL NOTIFY |
| Logging | pino |
| Telemetry | OpenTelemetry |
| Browser Evidence | Playwright Trace（策略化保留） |
| Extension | Chromium Extension |
| Authorization | RBAC；企业身份协议可扩展 |

## 21. 宪法自身的边界

宪法只锁定那些一旦破坏就会改变产品性质、领域语义或系统可信性的原则。

以下内容不应轻易写成宪法不变量：某个第三方库、具体 SQL、表名、API 路径、部署拓扑、某个模型、某个 AI 框架、某个云厂商、具体 TTL 数值和 UI 像素级实现。

当实现需要改变时，优先替换实现；当领域原则需要改变时，才修改宪法。


## 22. 文档编写

- 在进行大的功能模块开发之前先写方案文档放在 docs/spec 目录下, 用户审查通过后再进行开发, 方案文档可以作为 PR 的基础, 也可以作为后续开发的参考,同时在 docs/spec README.md 中记录方案文档的目录和链接, 方便用户查阅。

## 23. 架构文档

`docs/arch/` 展开宪法中的领域与运行时边界，本身不是宪法不变量。当前五份设计如下：

1. [识途智能仿真平台总体架构设计方案 v1.0](docs/arch/识途智能仿真平台总体架构设计方案_v1.0.md)
   给出平台总体逻辑架构与七个一级架构域，并锁定 Authoring、Execution、Intelligence、Perception、Browser Runtime、Knowledge 与 Platform 之间的跨模块原则。
2. [识途核心领域模型与数据架构设计 v1.0](docs/arch/02_识途核心领域模型与数据架构设计_v1.0.md)
   冻结 Target / TargetAccount / ScenarioVersion / Step / Run / StepRun / Attempt / Evidence / BrowserSession / 双 Lease / BusinessAction，以及 Version、Snapshot、Fencing 与一致性原则。
3. [识途 Execution 与 Browser Runtime 详细设计 v1.0](docs/arch/03_识途Execution与Browser_Runtime详细设计_v1.0.md)
   重点解决 Execution Engine、Executor、Session 复用、Worker Affinity、RunLease、SessionLease、Fencing、故障恢复、副作用步骤、Capacity/Placement；复杂 iframe 已纳入 Browser Surface，Playwright FrameLocator 作为这一层的底层能力。
4. [识途 Scenario Authoring 与 IR 详细设计 v1.0](docs/arch/04_识途Scenario_Authoring与IR详细设计_v1.0.md)
   重点解决 Recorder 不等于脚本生成、Scenario IR、Excel/CSV 导入、自然语言、手工编排、术语、Business Action、参数化、断言生成、Scenario Analyzer 与 Trial/Fix Loop。
5. [识途 MVP 范围与开发实施路线图 v1.0](docs/arch/05_识途MVP范围与开发实施路线图_v1.0.md)
   明确 In Scope / Out of Scope、9 个 PoC Gate、6 个 Vertical Slice、里程碑、验收指标和第一批 ADR，防止第一版越做越大。

## 24. UI 的核心原则

1. 蓝色表达操作和平台能力；
2. 绿色表达成功和健康；
3. 红色只表达失败、错误和危险；
4. 橙色表达警告和待处理；
5. 紫色只表达 AI 能力；
6. 灰色表达辅助、禁用、等待和次要信息；
7. 白色卡片承载主要业务内容；
8. 页面背景使用极浅冷灰色；
9. 一张页面最多只有一个最醒目的主操作；
10. 用户首先看到业务状态，其次看到数据趋势，最后看到辅助信息；
11. 测试步骤、断言、执行证据是平台的核心信息，不得为了简洁而隐藏；
12. 所有复杂功能优先采用渐进式展示，而不是一次性全部展开；
13. 表格用于批量管理，卡片用于概览和快捷操作；
14. AI 是辅助能力，不取代用户对测试逻辑的控制。
