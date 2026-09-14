# 识途底座通用性演进设计方案：面向持续功能迭代的架构抽象与自测试增强

日期：2026-09-13。状态：**方案待审，拟进入实施**。

前置方案：[面向 AI 敏捷自测与验证的底座增强方案](2026-09-13-ai-testing-foundation.md)、[Midscene 正式接入方案（待审）](2026-09-13-midscene-runtime-integration.md)、[两类 AI 配置边界](2026-09-13-ai-model-configuration-boundaries.md)。

---

## 1. 背景与核心问题分析

### 1.1 演进背景
在上一阶段的底座建设中，识途（Cairn）成功完成了“AI 敏捷自测试底座”（Phase 1~3）：
1. **PostgreSQL 模板克隆加速**（20~50ms 秒级自愈数据库）；
2. **确定性 MockModelClient**（队列响应、429 退避、损坏 JSON、Abort 取消）；
3. **受控靶场业务扩展**（Chromium 真机下的登录、表单、动态表格三项 E2E）；
4. **全链路脚手架 `CairnTestHarness`**（声明式 10 行跑通 Target -> Scenario -> Run -> Attempt -> Evidence）；
5. **宪法看门狗 `check-invariants.mjs`**（静态防腐与架构不变量门禁）。

这些基础能力让当前阶段的开发和测试实现了质的飞跃。然而，从**“持续演进、面向后续功能开发”**的视角审视，当前底座中存在诸多**“当前适用、但后续不再适用/扩展性不足”**的临时性实现。

### 1.2 现状瓶颈与未来痛点（为什么必须提升通用性）

| 维度 | 当前现状（当前适用） | 后续迭代痛点（后面不适用） | 违反/受限的架构目标 |
| --- | --- | --- | --- |
| **执行器体系** | `ExecutionEngine.runExecutor` 内部用硬编码 `if-else` 分发 `echo`, `delay`, `fail` 和浏览器步骤 | 当引入 `ai_action`, `ai_extract`, `ai_assert`（D1 阶段）以及未来的 `http`, `sql`, `shell` 等步骤时，Engine 将沦为巨石代码（God Method），任何新增步骤都必须侵入修改 Engine 内部，且开发者无法对新步骤进行隔离单测 | 《识途宪法》第 6 条明确规定：“Execution Engine 通过 Executor Registry 解析执行器；未来新增 Executor 时，不应要求重写 Scenario/Run 核心生命周期” |
| **AI 模型通信与路由** | 仅有针对单客户端的 `MockModelClient` 和硬编码的 OpenAI ChatCompletion 桩 | 宪法与规划中，AI 会迅速分化出视觉 VLM（Qwen-VL）、推理 LLM（DeepSeek-R1）、轻量结构化抽取、以及多模型路由（Model Route）、Fallback 降级、Token 计量与多租户审计；单体 Mock 无法模拟多路由故障与降级 | 《识途宪法》第 9 条：“业务 Step 不得与具体模型供应商形成不可替换的直接绑定；Run 必须冻结 Model Route、实际模型与参数” |
| **受控仿真靶场** | 手写的 3 个原生静态 HTML 文件（`auth-flow.html`, `order-flow.html`, `dynamic-table.html`） | 后续测试复杂交互（反爬滑块、跨域 iframe、Shadow DOM、长轮询、WebSocket 实时推送、网络慢速与 5xx 故障）时，每加一个特性都必须手写原生 DOM 代码，成本极高，且缺乏后端状态反向检验端点 | 无法高效支撑 AI Agent 视觉自愈、复杂异常重试与网络容灾的自动化测试 |
| **自动化测试 Harness** | `CairnTestHarness` 硬编码了完整的“DB 事务/克隆 + Target + Run + Engine”全量链路 | 测试颗粒度单一：无法做“单步骤内存微测试”（微秒级单步逻辑验证），也无法便捷模拟“多 Worker 分布式抢占与孤儿收敛”、“对象存储上传失败重试”等系统级故障 | 复杂场景测试编写繁琐，单测成本偏高 |
| **架构看门狗** | `tools/check-invariants.mjs` 采用单文件硬编码正则扫描特定关键词 | 规则缺乏声明式元数据，难以扩展新规则；正则匹配缺乏上下文，容易对注释或局部变量产生误报或漏报 | 无法适应随着功能迭代不断扩充的架构防御规则 |

---

## 2. 通用性演进的 5 大支柱设计

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        Cairn 通用化底层架构蓝图                         │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  [1. 执行层 SPI]          [2. AI 路由 SPI]        [3. 靶场引擎 Engine] │
│  StepExecutorRegistry      ModelRouter             Configurable Lab    │
│  ├── FixtureExecutor       ├── Route: vision       ├── Dynamic DOM     │
│  ├── BrowserExecutor       ├── Route: reasoning    ├── Network Chaos   │
│  ├── AIExecutor (Midscene) └── MockModelRouter     └── Inspect API     │
│  └── Custom/TestExecutor        (Fallback/Chaos)                       │
│                                                                        │
│  [4. 分层组装 Harness]     [5. 声明式看门狗]                           │
│  CairnTestHarness          Rule-based Invariant Watchdog               │
│  ├── MicroStepHarness      ├── Rule: NoWorkerApiCallback               │
│  ├── FullWorkflowHarness   ├── Rule: OnlyGetPost                       │
│  └── ClusterHarness        └── Rule: SnapshotImmutability              │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

---

### 支柱 1：统一步骤执行契约与动态注册表 (`StepExecutorRegistry`)

#### 契约设计
执行器不再散落在 Engine 内部，而是抽离为标准 SPI 接口：

```typescript
export interface StepExecutionContext {
  readonly runId: string
  readonly stepRunId: string
  readonly attemptId: string
  readonly targetId: string
  readonly step: Step
  readonly input: JsonValue
  readonly context: Readonly<Record<string, JsonValue>>
  readonly signal: AbortSignal
  readonly clock: EngineClock
  readonly sessionGrant?: SessionGrant
  readonly evidencePolicy: EvidencePolicy
}

export type StepExecutionOutcome =
  | {
      kind: 'success'
      output: JsonValue
      screenshot?: ScreenshotPointer
      trace?: ScreenshotPointer
    }
  | {
      kind: 'failed' | 'cancelled' | 'needs_review'
      error: ExecutionError
      output?: JsonValue
      diagnostics?: ResolverDiagnostics
      screenshot?: ScreenshotPointer
      trace?: ScreenshotPointer
      timedOut?: boolean
      aborted?: boolean
    }

export interface StepExecutor<TStep extends Step = Step> {
  readonly supportedTypes: readonly string[]
  execute(ctx: StepExecutionContext): Promise<StepExecutionOutcome>
}
```

#### 注册表设计 (`StepExecutorRegistry`)
```typescript
@Injectable()
export class StepExecutorRegistry {
  private readonly executors = new Map<string, StepExecutor>()

  register(executor: StepExecutor): this {
    for (const type of executor.supportedTypes) {
      if (this.executors.has(type)) {
        throw new Error(`Duplicate StepExecutor for type: ${type}`)
      }
      this.executors.set(type, executor)
    }
    return this
  }

  get(type: string): StepExecutor {
    const executor = this.executors.get(type)
    if (!executor) {
      throw new Error(`No StepExecutor registered for type: ${type}`)
    }
    return executor
  }
}
```

#### 收益：
1. **彻底解耦 Engine**：`ExecutionEngine` 退化为标准的状态机编排器（加载快照、分发租约、推进 Attempt、管理取消与超时），不再关心步骤内部细节。
2. **零侵入扩展**：后续 D1 引入 `AIExecutor`，或者未来引入 `HttpExecutor`、`SqlExecutor`，只需实现接口并在模块中注册，核心引擎代码 0 改动。
3. **极速单步自测**：在自测试时，开发者可直接调用 `executor.execute(...)` 单独测试新步骤的输入校验、错误包装与异常捕获，无需起库起容器。

---

### 支柱 2：通用 AI 模型 SPI 与多策略路由 (`IModelClient` & `ModelRouter`)

#### 通用模型通信契约 (`IModelClient`)
```typescript
export interface ModelMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>
}

export interface ModelCompletionOptions {
  model?: string
  temperature?: number
  maxTokens?: number
  responseFormat?: { type: 'text' | 'json_object' }
  signal?: AbortSignal
}

export interface ModelCompletionResult {
  content: string
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
  rawResponse?: unknown
}

export interface IModelClient {
  complete(messages: ModelMessage[], options?: ModelCompletionOptions): Promise<ModelCompletionResult>
}
```

#### 模型路由器 (`ModelRouter`)
```typescript
export interface ModelRouter {
  getClient(routeKey: string): IModelClient
  getRouteConfig(routeKey: string): {
    modelName: string
    provider: string
    baseUrl?: string
  }
}
```

#### 自测试通用性扩展：`MockModelRouter`
支持按路由注入独立 Mock 策略：
```typescript
export class MockModelRouter implements ModelRouter {
  private readonly clients = new Map<string, MockModelClient>()

  setRoute(routeKey: string, client: MockModelClient): this {
    this.clients.set(routeKey, client)
    return this
  }

  getClient(routeKey: string): IModelClient {
    const client = this.clients.get(routeKey)
    if (!client) throw new Error(`Unmocked routeKey: ${routeKey}`)
    return client
  }
}
```
**收益**：未来测试 AI 多模型混编（例如视觉用 `qwen-vl` 路由，逻辑断言用 `deepseek-r1` 路由，某一个路由限流 429 触发降级），可以在测试中随意组合不同路由的行为，实现工业级 AI 容灾自测试。

---

### 支柱 3：声明式可配置测试靶场引擎 (Configurable Lab Surface Engine)

将目前的“手写静态 HTML 页面”演进为**“声明式动态靶场引擎”**：

#### 1. 动态页面生成端点：`/lab/dynamic`
支持通过 JSON 声明在浏览器端即时构建复杂 DOM：
```typescript
// GET /lab/dynamic?spec=<encodeURIComponent(JSON.stringify(spec))>
export interface LabDynamicPageSpec {
  title?: string
  delayMs?: number // 页面渲染前的人工延迟
  elements: Array<{
    tag: 'input' | 'button' | 'select' | 'table' | 'div' | 'iframe'
    id?: string
    name?: string
    text?: string
    attributes?: Record<string, string>
    shadowDom?: boolean // 支持 Shadow DOM 穿透测试
    iframeSrc?: string  // 支持多级 iframe 测试
  }>
  submitAction?: {
    apiEndpoint: string
    method: 'POST' | 'GET'
    successResponse: unknown
    failureCode?: number
  }
}
```

#### 2. 网络混沌端点：`/lab/chaos`
支持在测试中精确模拟网络故障：
- `/lab/chaos?status=504&delay=1000`：模拟网关超时；
- `/lab/chaos?status=401`：模拟会话过期，测试自动重新认证逻辑；
- `/lab/chaos?flake=3`：前 2 次返回 500，第 3 次返回 200，测试步骤自动重试。

#### 3. 靶场状态断言端点：`/lab/inspect/:sessionId`
解决自动化测试只在前端 DOM 观察的局限，提供服务端真实验证：
- `GET /lab/inspect/:sessionId`：返回该 Session 实际向靶场提交的所有请求历史、表单参数和时间戳。测试可以在执行完成后直接断言：“后端确实收到了正确的表单值”。

---

### 支柱 4：模块化可组装测试脚手架 (`CairnTestHarness`)

将当前的单体黑盒脚手架升级为**分层组装体系**：

```typescript
export class CairnTestHarness {
  // Level 1: 单步微测试（无需启动真实数据库，纯内存快速自测）
  static createStepHarness(options?: {
    executors?: StepExecutor[]
    mockRouter?: MockModelRouter
  }): MicroStepHarness

  // Level 2: 真实浏览器单测（轻量浏览器交互自测，不建 Run 记录）
  static createBrowserHarness(options?: {
    labServer?: LabServerHandle
  }): BrowserHarness

  // Level 3: 全链路闭环自测（带 PostgreSQL 模板自愈的端到端 Run 闭环）
  static async createWorkflowHarness(options?: {
    mockRouter?: MockModelRouter
    customExecutors?: StepExecutor[]
  }): Promise<WorkflowHarness>

  // Level 4: 多 Worker 并发测试（模拟分布式冲突、抢占、Lease 漂移）
  static async createClusterHarness(options: {
    workerCount: number
  }): Promise<ClusterHarness>
}
```

**代码编写对比**：
- **微单步测试**：
  ```typescript
  const harness = CairnTestHarness.createStepHarness()
  const result = await harness.executeStep({
    step: { type: 'echo', input: { value: 'hello' } },
  })
  expect(result.output).toBe('hello') // 耗时 1ms！
  ```
- **全链路测试**：
  ```typescript
  const harness = await CairnTestHarness.createWorkflowHarness()
  const run = await harness.runScenario([ ...steps ])
  expect(run.status).toBe('SUCCEEDED')
  ```

---

### 支柱 5：声明式架构不变量看门狗 (Rule-based Invariant Watchdog)

将 `tools/check-invariants.mjs` 重构为基于规则定义的引擎：

```typescript
export interface InvariantRule {
  readonly id: string
  readonly constitutionArticle: number // 关联《识途宪法》条款，如 12, 18, 19
  readonly description: string
  readonly targetGlobs: readonly string[]
  check(file: SourceFile): Violation[]
}
```

预设规则集：
1. `INV001_ONLY_GET_POST`（第 12、18、19 条）：API 严禁使用 PUT/PATCH/DELETE；
2. `INV002_WORKER_NO_API_CALL`（第 12、19 条）：Worker 严禁通过 HTTP 回调 API 写回执行事实；
3. `INV003_SNAPSHOT_IMMUTABLE`（第 2、8、9 条）：执行期间快照禁止就地突变；
4. `INV004_SECRET_NO_LEAK`（第 15 条）：凭据字段必须经由 SecretProvider 或安全打码；
5. `INV005_NO_DB_TESTING_IN_PROD`：生产代码严禁跨越导入 `@cairn/db/testing`。

**收益**：规则结构化、可单独跑测试、报错带精准文件名与违背的宪法条款链接，任何新规范都能一键新增 Rule。

---

## 3. 架构不变量与设计约束

在推进通用化演进时，必须严格恪守以下不可打破的红线：
1. **绝不为了通用性引入外部重型依赖**：不引入复杂反射、重型 IOC/AOP 框架，保持 TypeScript 原生与轻量 NestJS 兼容；
2. **严守《识途宪法》**：
   - API 保持纯 GET/POST，无副作用查询走 GET，一切变更走 POST；
   - Worker 执行事实源唯一属于持久化数据库，不向 API 进行任何双向 RPC；
   - RunSnapshot 冻结语义不可破坏，历史 Run 不受新通用配置影响；
   - 凭据隔离与脱敏机制始终如一；
3. **保持纯本地、离线敏捷自闭环**：通用测试体系不得产生任何外网依赖，所有测试必须在本地隔离运行通过。

---

## 4. 实施阶段规划

| 阶段 | 交付物 | 验收标志 |
| --- | --- | --- |
| **Phase A: 执行器体系抽象** | 抽离 `StepExecutor` SPI 与 `StepExecutorRegistry`，将 `echo`, `delay`, `fail`, `browser` 接入注册表，解耦 `ExecutionEngine` | `packages/worker/src/engine` 单元测试与集成测试全绿；新增自定义测试执行器只需 1 行注入 |
| **Phase B: AI 模型 SPI 与多路由抽象** | 抽离通用 `IModelClient` 与 `ModelRouter`，将 `MockModelClient` 适配升级为通用组件 | 单元测试验证多路由分发、不同路由独立故障注入与降级 |
| **Phase C: 声明式靶场引擎增强** | 靶场增加 `/lab/dynamic`、`/lab/chaos`、`/lab/inspect` 端点 | 编写测试验证通过 URL 参数秒级生成复杂 DOM 结构并验证网络混沌响应 |
| **Phase D: Harness 模块化与看门狗规则化** | 升级 `CairnTestHarness` 支持分层构建，将 `check-invariants.mjs` 重构为模块化规则集 | 覆盖微单步测试与规则集自测试 |

---

## 5. 变更与提交规范
严格执行：开发前方案入库 `docs/spec/`，更新 `README.md`，完成后登记 `CHANGELOG`。
