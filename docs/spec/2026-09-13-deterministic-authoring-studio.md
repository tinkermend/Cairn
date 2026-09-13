# 确定性场景编写：草稿、编译与顺序编辑

日期：2026-09-13。状态：**已落地**。  
对应工程计划 P10 最小 Compiler、P11 确定性 Sequence Editor、P13 最小断言表单；落在 D1 的确定性闭环，**不开放 AI 混编**。  
与 [D0 Midscene 探针](2026-09-13-d0-hybrid-probes.md) 并行：两边不得抢 Step 注册表、Engine 分发和 Worker 正式路径。

前置：[执行内核](2026-09-10-execution-kernel.md)（场景 / 版本 / Run 账本）、[Browser Surface](2026-09-11-browser-surface.md)（五个 Web Step 与 `assert` 执行器）、[UI 底座正式接入](2026-09-13-ui-foundation-review.md)（Target / Scenario 样板页）。录制 IR 草稿已存在，但**不**在本期回填。

范围：用户能在控制台创建、保存、编译、发布并从头试跑一条「打开 → 输入 → 查询 → 提取 → 断言」的确定性场景。  
不是 SSE、不是 Live View、不是 AI Step、不是录制回填 Studio。

## 1. 为什么现在写

S06 在回答「AI 能不能接上受管 Page」。D1 混编编辑器还缺一层它不必等待的底座：

1. 每次改步骤都直接追加不可变 Version，没有草稿、没有冲突控制、没有发布。
2. 保存期只有 Zod + 禁止前向 `from`；创建 Run 才检查引用是否落在 input 或更早 `outputKey`。没有 Compiler，也没有按步骤定位的诊断。
3. 创建框只能组 `echo` / `delay` / `fail`；详情是只读工作区。五个已能执行的浏览器 Step 没有表单。
4. `assert` 执行器与 `assertExpect` 五种 kind 已落地，编辑器没有对应表单。
5. 录制草稿是另一张表，不能当作可执行 Scenario。本期不接这条入口，但 Compiler 必须成为以后唯一的发布门槛。

执行内核当时写明：P10 给 `definition` 补显式 `inputs`，保存期校验从「非前向引用」收紧为「非前向引用 ∪ 已声明输入」。本期把这件事做完。

```text
手工表单 ──┐
           ├──→ Draft Document ─ compile() ─→ 发布 Version 或试跑 Snapshot
录制 IR   ──┘     （本期只接手工；录制回填属 D2）
```

## 2. 目标与非目标

### 目标

1. 每个 Scenario 有一份带 `revision` 的草稿；保存走乐观并发，两个编辑会话不得静默覆盖。
2. 纯逻辑 Compiler：Schema → 顺序与 ID → 参数 / 输出引用 → Target 与能力 → 策略合并 → 诊断。不启动浏览器，不调用模型。
3. 发布产生新的不可变 `scenario_versions`。已发布 Version 与已开始的 Run 不因草稿继续修改而改变。
4. 试跑冻结**当前编译后的草稿**为 Run Snapshot，走现有 Worker / Engine / 五个浏览器 Step；之后改草稿不影响这次试跑。
5. 控制台顺序编辑：增删、上移下移、键盘重排、参数绑定、八种已注册 Step 的类型化表单；诊断挂到对应 Step。
6. 最小断言表单覆盖已有 kind：`exists` / `visible` / `text_equals` / `text_contains` / `number_compare`。期望与实际在编辑器里分开：编辑器只写期望。
7. 用户能独立完成「打开 → 输入 → 查询 → 提取 → 断言」的保存、刷新、发布、试跑；重排弄断引用时阻止发布。

### 非目标

- 不把 `ai_action` / `ai_extract` / `ai_assert` 写入 `EXECUTABLE_STEP_TYPES` 或 `stepSchema`。
- 不改 Engine 分发，不解除 Worker 对 Playwright / Midscene 的边界检查。
- 不做 Model Gateway、Provider SPI、AI 步骤控件、AI 建议。
- 不做 SSE、`run_event`、Live View、受控认证画面。试跑仍进入现有运行详情，状态靠刷新 GET。
- 不把 `recording_drafts` 导入 Scenario 草稿，不提供可用的「录制到此场景」。
- 不做拖拽排序、协同 OT、自由画布、`@xyflow`。
- 不做 Excel 导入、Business Action、术语库、从页面点选元素的本地 Bridge。
- 不把当前页上读到的文本自动当成断言期望。
- 不重跑 RF01–RF18 联合 Gate；只保证触及的创建 Run、快照不可变和已有浏览器 Step 回归为绿。

## 3. 复用与增量

| 范围 | 选择 | 上游 / 现有位置 | 本期差异 | 验证 |
| --- | --- | --- | --- | --- |
| Step 契约 | 直接使用 | [`step.ts`](../../packages/shared/src/step.ts) 八种 type | 不加 AI type | 现有 `step.test.ts` 保持绿 |
| 保存期校验 | 最小适配 | [`validateScenarioDefinition`](../../packages/shared/src/scenario.ts) | 升为 `compileScenarioDocument`；`inputs` 进入定义 | 正反例单测 |
| 版本账本 | 最小适配 | `scenarios` / `scenario_versions` | 版本只在发布时新增；草稿另表 | 迁移回填 + 仓库测 |
| 正式 Run | 直接使用 | `POST /runs` + `createRunWithSnapshot` | 仍只跑**已发布** Version；快照与摘要契约不改 | 现有创建 / 幂等测 |
| 试跑 | 最小适配 | 同一 Engine 与队列 | 新入口编译草稿为 `kind='trial'` 版本，Run 照旧绑定确定版本 | HTTP + 集成 |
| 浏览器 Step / 断言执行 | 直接使用 | Surface 五步与 `assert` Executor | 只补表单，不改 Resolver / 执行器 | 现有 L2 回归 |
| 控制台壳 | 最小适配 | `features/scenarios`、`Main` / `PageHeader`、Foundation 工作区 | 详情改为可编辑 Studio | 前端验收 skill |
| 录制草稿 | 仅参考 | [`recording.ts`](../../packages/shared/src/recording.ts) | 不回填；Compiler 预留以后收 IR | — |
| Midscene / Page Agent | 不涉及 | S06 探针 | 零消费、零改动 | 与 S06 分文件 |

## 4. 决策

本节 D1–D14 是方案内部编号，不是工程计划 D0–D4。

### D1. 草稿与发布分轨，创建仍立刻可跑

现网 `POST /scenarios` 写入 Version 1，测试和「创建后运行」都依赖它。本期保留：

- 创建在同事务写入 Scenario、草稿（`revision = 1`）和 Version 1。
- 创建用的步骤必须通过 Compiler 且无 error，否则 400。这样现有 `create → POST /runs` 不断。

之后的编辑只写草稿。`POST /scenarios/:id` **不再接受 `steps`**，避免「每次保存都发布」。改名、停用仍走该接口。步骤写入改走草稿接口。

仓库内 `appendScenarioVersion` 收成发布实现，测试夹具若要「改步骤再跑正式 Run」，改为 publish 或继续用仓库函数，不从 HTTP 偷发布。

### D2. 每个 Scenario 恰好一份草稿

新建表 `scenario_drafts`，主键即 `scenario_id`。不按用户拆多份草稿，不做分支。

```text
scenarios 1 ─── 1 scenario_drafts
    │
    └─── 0..n scenario_versions   （仅 publish 产生）
```

文档形状：

```ts
type ScenarioInputDecl = {
  key: string          // contextKeySchema，且不在 FORBIDDEN_CONTEXT_KEYS
  label: string        // 1–128
}

type ScenarioDocument = {
  schemaVersion: 1
  inputs: ScenarioInputDecl[]
  steps: Step[]        // 仍是现有 stepSchema
}
```

**不设 `required` 标记。** 现网 [`assertRunFromResolved`](../../packages/shared/src/scenario.ts) 的可用键集合来自创建 Run 时**实际传入的 `input`**，不是声明。声明成「可选」又被某步 `from` 引用，建 Run 时必然 `SCENARIO_UNRESOLVED_REF`——那是个陷阱而不是能力。本期语义：被 `from` 引用的声明输入在创建 Run / 试跑时必须提供值；`defaultValue` 留给后续方案。

存量 `definition` 只有 `schemaVersion` + `steps`。解析时 `inputs` 缺省 `[]`。**不**提高 `RUNTIME_SCHEMA_VERSION`。

草稿保存要求每步仍过 `stepSchema`（表单不产生半截 Step）。未声明的 `from` 在保存期只记 warning，与今天「保存放过、Run 再收紧」兼容；**发布和试跑**按 Compiler error 拦截。

### D3. `revision` 是唯一并发闸

草稿行有单调递增 `revision`。保存必须带客户端读到的 `revision`；匹配则写入并 +1，否则 `409 SCENARIO_DRAFT_CONFLICT`，正文带当前 `revision` 与文档。禁止 last-write-wins。

前端冲突时展示「他人已更新」，提供重新加载，不自动合并。

### D4. Compiler 是纯函数，服务端再跑一遍

`compileScenarioDocument(document, ctx)` 放在 `@cairn/shared`。Web 用来画诊断；**发布、试跑、创建**以服务端结果为准。Compiler 不读库之外的东西；`ctx` 只传入调用方已经查到的 Target 状态和「当前可执行 type 集合」。

```text
parse document
 → 步数 1–32、step.id / outputKey 不重复
 → 禁止前向 from
 → from ∈ 已声明 inputs ∪ 更早 outputKey（error，发布/试跑）
 → 声明了但未被任何 from 使用的 input（warning）
 → type ∈ EXECUTABLE_STEP_TYPES（未知 type 为 error，给未来 AI 预留拒绝口）
 → Target 存在且 active（否则 error）
 → 合并缺省 policy（见 D6）
 → Analyzer 警告（见 §6）
```

相同文档 + 相同 `COMPILER_VERSION` + 相同 ctx 必须得到相同 `definition` 与诊断码。Compiler 不启动浏览器，不调用模型。

`COMPILER_VERSION = 1`。发布与试跑的版本行都记下 `compilerVersion` 与源文档规范摘要（`canonicalJson` + sha256）。摘要不能代替存下来的 `definition`。

### D5. 试跑也绑定确定版本，只是这个版本不对外发布

[`docs/arch/02`](../arch/02_识途核心领域模型与数据架构设计_v1.0.md) 冻的是「编辑产生 Draft，发布形成新 Version，**Run 引用确定版本并生成 Snapshot**」。所以试跑不能是「没有版本的 Run」。

`scenario_versions` 增 `kind`：`published` | `trial`。试跑在同一事务里落一个 `kind='trial'` 的不可变版本行，Run 照旧绑定它。

| 入口 | 权限 | 解释源 | Run 绑定 |
| --- | --- | --- | --- |
| `POST /runs` | `run:execute` | 最新 `published` Version，或显式 `scenarioVersionId`（必须是 published） | 该 Version |
| `POST /scenarios/:id/trial` | `workflow:write` **且** `run:execute` | 当前草稿经 Compiler 的产物 | 新建或复用的 `trial` Version |

这样换来的是：`runs.scenario_version_id` 保持 `NOT NULL` 与外键，`reject_run_snapshot_mutation` 触发器不动，`runSnapshotSchema`、`snapshotDigestPayload`、`idempotencyDigestPayload`、`runSummarySchema` **全都不改**。本期对跨进程契约的改动收敛为「新增 `ScenarioDocument` 与 Compiler」，不引入可空的快照字段，也没有 API / Worker 版本偏斜风险。

trial 版本按 `(scenario_id, kind='trial', source_digest)` 去重：同一份内容反复试跑复用同一行，不产生行爆炸，幂等键行为与正式 Run 完全一致（同键同摘要返回原 Run，同键不同摘要冲突）。

`GET /scenarios/:id/versions`、`latestVersionId` / `latestVersionNo` / `stepCount` 只看 `published`。控制台运行详情区分试跑与正式，用 GET 派生的 `scenarioVersionKind`（读版本行，不进快照、不参与摘要），与现有 `scenarioName` / `targetName` 的派生展示同类。

停用的 Scenario 或 Target：正式 Run 与试跑都拒绝。

### D6. 缺省策略仍由 Engine 解释，Compiler 不物化

用户文档可以省略逐步 `policy`。**编译产物不写入平台缺省**：`resolveStepPolicy` 与 `DEFAULT_STEP_TIMEOUT_MS` / `DEFAULT_RETRY_LIMIT` 已经在运行期兜底（[`policy.ts`](../../packages/shared/src/policy.ts)），编译期再物化一遍只会让「编译定义」与「源文档」形状分叉，连 `draftDirty` 都没法直接比。

所以本期 `definition` 等于校验通过的 `ScenarioDocument`。用户填写的 `timeoutMs` / `retryLimit` 照旧覆盖；没填就是没填。

不为「失败截图 / 证据 / 重试」插入隐藏 Step。副作用分类仍由作者声明；表单给新步的**初始值**（不是推断规则）：

| 新步 type | 初始 `effectType` |
| --- | --- |
| `extract` / `assert` / `echo` / `delay` | `READ_ONLY` |
| `navigate` / `click` / `fill` / `fail` | `SIDE_EFFECT` |

作者可改。不得按步骤名称自动改写已保存的 `effectType`。

### D7. 顺序编辑只覆盖已注册的八种 Step

可添加：`navigate` / `click` / `fill` / `extract` / `assert` / `echo` / `delay` / `fail`。  
夹具三种留在编辑器里，方便无浏览器验收，不作为业务默认推荐。

创建对话框收成：名称 + Target + **必填首步**（默认 `navigate` + URL）。契约上 `createScenarioBodySchema.steps` 是 `min(1)`、`scenarioSchema.stepCount` 也是 `min(1)`，没有零步场景，首步不是可选项。提交后进入 Studio，不再在弹窗里堆完整步骤编辑。

### D8. 断言表单只包已有 kind，期望与实际分开

P13 本期只做构建，不改 Executor。五种 kind 与 [`assertExpectSchema`](../../packages/shared/src/browser-command.ts) 对齐。

- 编辑器只收集目标与期望。
- 实际值、类型错误、元素缺失出现在 Run / Attempt Evidence，沿用现有复盘页。
- 不提供「把当前页文本填进期望」。没有本地 Bridge，也不把一次试跑输出静默写回草稿。
- 本期表单**要求**选择目标。`assert` 的 `target` 在契约上仍可选，但不在 UI 暴露「无目标断言」。

### D9. 诊断挂 Step，错误挡发布和试跑

诊断：`code`、`severity`（`error` | `warning`）、`message`、可选 `stepId` / `inputKey`。  
有 error 时 `compile.ok = false`，发布与试跑 400 `SCENARIO_COMPILE_BLOCKED`，正文带回全部诊断。  
warning 不阻断；「场景没有断言」只是 warning，不强制每条业务场景都有断言。

保存草稿不要求 `ok`。结构非法（过不了 `stepSchema`）仍 400。

### D10. 试跑从当前草稿从头跑，观察复用现页

试跑打开现有 `/runs/:runId`。不在 Studio 里做第二套时间线，不接画面。已知限制写在页面上：进度需刷新。SSE / Live View 另案。

需要账号的浏览器场景：试跑请求带与 `POST /runs` 相同的 `targetAccountId` / `input` / 可选策略覆盖。被 `from` 引用的声明输入若没给值，创建期 `assertRunFromResolved` 失败，不产生 trial 版本行。

### D11. 与 S06 / 录制 / P7 的文件边界

| 允许改 | 禁止改 |
| --- | --- |
| `packages/shared/src/scenario.ts`、新 `compiler.ts` | `EXECUTABLE_STEP_TYPES`、`stepSchema` 增 type |
| `packages/db` 场景草稿迁移与仓库 | `packages/worker/src/engine` 分发 |
| `packages/api/src/scenarios` | Worker 正式路径接 Midscene / 模型 |
| `packages/web/src/features/scenarios` | `packages/web/src/features/recordings` 回填 |
| `scenario_versions.kind` 与发布 / 试跑仓库 | `runSnapshotSchema`、两个摘要 payload、`runs` 表结构 |
| — | `run_event`、SSE、CDP screencast |

S06 夹具若继续 `createScenarioWithVersion` + `createRunWithSnapshot`，不受草稿 UI 影响。共享迁移仍由一人合入。

### D12. 主操作随状态变，一张页仍只有一个主按钮

| 状态 | 主操作 | 次要 |
| --- | --- | --- |
| 草稿未保存（dirty） | 保存草稿 | 发布 / 试跑禁用 |
| 已保存，有 error | 无主操作（先修诊断） | 保存仍可用 |
| 已保存，无 error，与已发布不一致 | 试跑 | 发布 |
| 已保存，无 error，与已发布一致 | 试跑 | 用已发布版本运行（现有对话框） |

「运行已发布版本」不是编辑主路径，放在菜单或次要按钮，避免和试跑抢蓝色主按钮。

### D13. 列表区分「已发布」和「有未发布草稿」

列表继续用已发布 Version 的 `latestVersionNo` / `stepCount` 作为可调度事实。增加 `draftDirty: boolean`：**比较草稿的源文档摘要与最新 `published` 版本行上的 `source_digest`**（§5.2），两边都是源文档口径。不要拿草稿文档去比编译定义——那是 D6 之前会恒为 true 的错误口径。停用态不变。

详情 GET 同时返回已发布摘要与完整草稿，供 Studio 使用。只读消费者若只要发布定义，读 `published`。

### D14. 前端按已认可工作区扩，不新开框架

布局对齐 [AI 前端工作流](../design/front/ai-workflow.md)「创建、编辑、验证一组步骤」：步骤序列 + 当前属性 + 诊断；宽屏两栏，窄屏先列表后表单。复用 Token、`Button` / `Input` / `Select` / `Alert`、已迁的 Scenario 页层次。实现后按 [前端验收 skill](../../.agents/skills/shitu-frontend-acceptance/SKILL.md) 做页面级验收。不引入新 UI 库，不把 Foundation HTML 原型的模拟试跑当成真接口。

## 5. 数据与兼容

### 5.1 新表 `scenario_drafts`

建议迁移号 `0015_scenario_drafts.sql`（以合入时下一个序号为准）。

| 列 | 说明 |
| --- | --- |
| `scenario_id` | PK，FK `scenarios.id` |
| `revision` | `int ≥ 1` |
| `document` | `ScenarioDocument` JSONB |
| `updated_by_console_account_id` | FK 控制台账号 |
| `updated_at` | timestamptz |

回填：每个已有 Scenario 取最新 Version 的 `definition`，补 `inputs: []`，插入 `revision = 1`。

### 5.2 `scenario_versions` 增量列

| 列 | 说明 |
| --- | --- |
| `kind` | `published` \| `trial`；回填 `published`，带 CHECK |
| `version_no` | 改为**可空**：`published` 从 1 递增，`trial` 为 NULL |
| `compiler_version` | 发布 / 试跑时的 `COMPILER_VERSION`；回填 `1` |
| `source_digest` | 源文档规范摘要（`canonicalJson` + sha256）；回填由存量 definition 重算 |

现有唯一索引 `scenario_versions_scenario_no_idx (scenario_id, version_no)` 保留即可：Postgres 唯一索引允许多行 NULL，多个 trial 不互斥。`CHECK (version_no >= 1)` 遇 NULL 判 unknown 同样放过，不必改写。

新增部分唯一索引用于 trial 去重：`(scenario_id, source_digest) WHERE kind = 'trial'`。

**必须同时修的排序陷阱**：[`latestVersion()`](../../packages/db/src/runs/scenarios.ts) 现在是 `ORDER BY version_no DESC LIMIT 1`。Postgres 的 `DESC` 默认 `NULLS FIRST`，trial 行一进来它就会返回 trial 版本，`appendScenarioVersion` 的 `latest.versionNo + 1` 随之算出 NaN。该函数与所有 `latestVersionNo` / `stepCount` 派生都要加 `kind = 'published'` 过滤。

`definition` 按 D6 等于校验通过的源文档（`schemaVersion` + `inputs` + `steps`），因此同一行的 `source_digest` 与 `definition` 摘要同口径。旧行无 `inputs` 也可读。

### 5.3 `runs` 表不动

`scenario_version_id` 保持 `NOT NULL` 与外键，快照不可变触发器不动。试跑绑定的是 `kind='trial'` 的版本行，不是空值。

仓库写入处断言：`POST /runs` 显式传入的 `scenarioVersionId` 必须是 `published`；试跑入口只允许绑定本次编译出的 trial 行。

### 5.4 现有 HTTP 行为变化

| 现网 | 本期 |
| --- | --- |
| `POST /scenarios` 创建 + Version 1 | 保持，并写草稿 r1，dirty=false |
| `POST /scenarios/:id` `{ steps }` 追加 Version | **删除**；改走草稿 + 发布 |
| `GET /scenarios/:id` 只回最新 Version 步骤 | 回 `published` + `draft` + 即时 `compile` |
| `POST /runs` | 不变；`scenarioVersionId` 只接受 published |

这是对 `updateScenarioBodySchema.steps` 的破坏性收缩。实际消费方是 [`scenarios.service.ts`](../../packages/api/src/scenarios/scenarios.service.ts) 里转调 `appendScenarioVersion` 的分支、`shared/__tests__/scenario.test.ts` 的契约测试和 db 仓库测试；Web 端没有 update 调用，创建弹窗走的是 `POST /scenarios`。随本期一起改。

## 6. Compiler 诊断码

`COMPILER_VERSION = 1`。码稳定，文案可中文。

| 码 | 级别 | 何时 |
| --- | --- | --- |
| `SCENARIO_EMPTY` | error | 无步骤 |
| `SCENARIO_STEP_ID_DUPLICATE` | error | `step.id` 重复 |
| `SCENARIO_OUTPUT_KEY_DUPLICATE` | error | `outputKey` 重复 |
| `SCENARIO_FORWARD_REF` | error | `from` 指向本步或更晚 |
| `SCENARIO_UNRESOLVED_REF` | error | 发布/试跑时 `from` 不是声明 input 或更早 `outputKey` |
| `SCENARIO_INPUT_KEY_DUPLICATE` | error | `inputs.key` 重复 |
| `SCENARIO_INPUT_KEY_FORBIDDEN` | error | `inputs.key` 撞 `FORBIDDEN_CONTEXT_KEYS` |
| `SCENARIO_UNKNOWN_STEP_TYPE` | error | type 不在当前可执行集合 |
| `SCENARIO_TARGET_MISSING` | error | 绑定 Target 不存在 |
| `SCENARIO_TARGET_DISABLED` | error | Target 停用仍要发布/试跑 |
| `SCENARIO_WEAK_LOCATOR` | warning | 定位候选仅有最后一档 `css`，无 role/label/text/title/testId |
| `SCENARIO_EXTRACT_NO_OUTPUT_KEY` | warning | `extract` 未写 `outputKey` |
| `SCENARIO_INPUT_UNUSED` | warning | 声明的 input 没有任何 `from` 使用 |
| `SCENARIO_NO_ASSERT` | warning | 含浏览器 Step 但没有任何 `assert` |

保存草稿对 `SCENARIO_UNRESOLVED_REF` 降为 warning，便于先写 `from` 再补 `inputs`。发布与试跑升为 error。

`SCENARIO_DRAFT_CONFLICT` / `SCENARIO_COMPILE_BLOCKED` 是 API 错误码，不是逐步诊断。

## 7. API

只使用 GET / POST。路径挂在现有 `/scenarios`。

| 方法 | 路径 | 权限 | 作用 |
| --- | --- | --- | --- |
| `GET` | `/scenarios/:id` | `workflow:read` | 发布摘要 + 草稿 + compile |
| `POST` | `/scenarios/:id/draft` | `workflow:write` | 保存草稿（带 `revision`） |
| `POST` | `/scenarios/:id/publish` | `workflow:write` | 编译当前草稿，追加 Version |
| `POST` | `/scenarios/:id/trial` | `workflow:write` + `run:execute` | 编译并创建试跑 Run |
| `GET` | `/scenarios/:id/versions` | `workflow:read` | 仍只列已发布 Version |
| `POST` | `/runs` | `run:execute` | 不变，只跑已发布 Version |

### 7.1 `GET /scenarios/:id`（扩展，兼容字段见下）

```ts
{
  id, targetId, name, status, createdAt, updatedAt,
  latestVersionId, latestVersionNo, stepCount,  // 已发布；无发布时不应出现（创建必有 v1）
  draftDirty: boolean,
  published: {
    versionId, versionNo, definition, compilerVersion, createdAt
  },
  draft: {
    revision, document, updatedAt, updatedBy: { id, displayName }
  },
  compile: {
    ok: boolean,
    compilerVersion: 1,
    diagnostics: { code, severity, message, stepId?: string, inputKey?: string }[]
  }
}
```

现网详情把 `steps` 放在顶层。为减少一次把所有只读页打爆：顶层 `steps` **继续等于已发布 Version 的 steps**（列表/旧客户端语义）。Studio 必须读 `draft.document`，不得把顶层 `steps` 当编辑缓冲。

### 7.2 `POST /scenarios/:id/draft`

```ts
{ revision: number, document: ScenarioDocument }
```

成功：`200`，同 GET 的 draft + compile，新 `revision`。  
冲突：`409 SCENARIO_DRAFT_CONFLICT`。  
文档结构非法：`400`。

### 7.3 `POST /scenarios/:id/publish`

```ts
{ revision: number }
```

服务端读取该 revision 的草稿并编译。`revision` 必须仍是当前值，否则 409。成功追加 `kind='published'` 的 `version_no + 1`，`draftDirty` 变 false。不改草稿内容。

**幂等**：发布不改 `revision`，所以同一 revision 连点两次必须不产生两个内容相同的版本。判定用摘要而不是按钮状态——若草稿 `source_digest` 已等于最新 `published` 版本的 `source_digest`，直接返回该版本，不新增行。

### 7.4 `POST /scenarios/:id/trial`

```ts
{
  revision: number,
  targetAccountId?: string,
  input?: Record<string, JsonValue>,
  policy?: ExecutionPolicy,
  sessionPolicy?: SessionPolicyOverride,
  evidencePolicy?: EvidencePolicy,
  idempotencyKey?: string
}
```

`revision` 必须是当前草稿。编译失败 400。成功在同一事务里落 trial 版本（或复用同摘要的已有 trial 行）并创建 Run，返回与 `POST /runs` 相同的 Run 详情信封。

试跑不改草稿 `revision`，也不影响 `draftDirty`。

## 8. 控制台

### 8.1 Studio 信息架构

场景详情升级为 Studio，不新开路由（仍 `/scenarios/:scenarioId`）。

1. 页头：名称、Target、已发布 vN、草稿 rN、dirty / 冲突 / 停用。
2. 主列：有序步骤。选中一步，状态（诊断 error 用红、warning 用橙）可见。
3. 侧栏：该步类型化表单 + 该步诊断。未选中时展示场景级 `inputs` 与全局诊断。
4. 窄屏：步骤与表单纵向堆叠，不出现整页横向溢出。

键盘：`Alt+↑` / `Alt+↓` 重排；删除需确认。不做拖拽。

### 8.2 表单字段（与契约对齐，不另造字段名）

| type | 必填 | 其余 |
| --- | --- | --- |
| `navigate` | `url` | 名称、effect、policy |
| `click` | `target` | 同上 |
| `fill` | `target`，且 `value` / `from` 恰好一个 | `sensitive`、outputKey 不用 |
| `extract` | `target`、`as`；`as=attribute` 时 `attribute` | `outputKey` 建议填写 |
| `assert` | `target`、`expect.kind`；equals/contains 要 `value`；number 要 `op`+`value` | — |
| `echo` | `value` / `from` 恰好一个 | `outputKey` |
| `delay` | `durationMs` | — |
| `fail` | `message` | code / category / retryable |

`target` 表单：1–5 个候选（`by` + `value`，`role` 可填 `name`）、可选 `framePath`、可选 `anchor`。`css` 只能作为最后一档，与现网 Schema 一致。

场景级 `inputs`：增删声明；步骤 `from` 用 Select 选「场景输入 / 更早步骤输出」，避免自由打错 key。仍允许先选尚未声明的 key，保存为 warning。

### 8.3 创建与空态

创建成功跳到 Studio。若用户只给了名称和 Target、URL 留空，创建失败（navigate 过不了 Schema）。空场景不允许。

刷新后草稿仍在；未保存的本地修改按浏览器惯例丢失，不在本期做本地 autosave。

## 9. 验收

统一完成条件见工程计划 §3：可运行代码、检查、迁移、最小说明、已知限制。

### 9.1 Compiler / 账本

1. 同一文档、同一 `COMPILER_VERSION`，两次 compile 产物与诊断码相同；产物等于源文档，不含物化的平台缺省。
2. 前向引用、未知 type、重复 id、未解析 `from`（发布时）阻断。
3. 存量无 `inputs` 的 Version 仍能 `POST /runs`；存量快照摘要与改动前逐字节一致。
4. 发布后改草稿，旧 Version 与已存在 Run 的 Snapshot 步骤不变。
5. 空库迁移与从 `0014` 升级都回填草稿与 `kind='published'`；每个 Scenario 恰有一行草稿。
6. 同一 revision 连续 publish 两次只得到一个版本，第二次返回同一 `versionId`。
7. 库里存在 trial 版本时，`latestVersionNo` / `stepCount` / `GET /versions` 仍只反映 published，`appendScenarioVersion` 的版本号继续正确递增（覆盖 `NULLS FIRST` 陷阱）。
8. `schema-parity.test.ts` 的表清单、逐列断言、迁移文件清单与 `pg-restriction.test.ts` 的约束名映射随迁移同步更新并通过。

### 9.2 并发与试跑

1. 两个保存带同一 `revision`：一个 200 且 revision+1，另一个 409，库中文档是胜者那份。
2. 试跑 Run 绑定 `kind='trial'` 版本，步骤等于编译后草稿；再改草稿，该 Run GET 仍是旧步骤。
3. 同一份草稿内容反复试跑复用同一 trial 版本行；带相同幂等键返回同一 Run，内容变化后同键报冲突。
4. `POST /runs` 仍只跑 published；显式传 trial 的 `scenarioVersionId` 被拒绝。
5. 停用 Scenario / Target 时 publish 与 trial 均失败。
6. 被 `from` 引用的声明输入未提供值时试跑失败，且不产生 trial 版本行或半成品 Run。

### 9.3 编辑器

1. 用户可创建并保存「navigate → fill → click → extract → assert」，刷新后顺序和参数一致。
2. 上移下移导致 `from` 变成前向引用：保存可以，发布 / 试跑被阻断，诊断指向该步。
3. 断言：同一场景在夹具符合 / 不符合时期望分别通过和失败（复用 Surface Lab，不新开站）；Evidence 仍有期望、实际、规则。
4. 无权限、Target 停用、409 冲突、编译错误各有可见状态，失败保留输入。
5. 1366 与窄屏无整页横向溢出；键盘能完成添加、重排、保存。
6. 页面级走前端验收 skill；`pnpm check:design` 保持绿。

### 9.4 回归

现有 Echo/Delay/Fail 与五个浏览器 Step 的创建 Run、L2 受控站、权限与快照摘要测试保持绿。不把「未跑 S06 / 未跑 RF 全集」写成通过。

## 10. 明确留给后续的口子

| 后续 | 本期留下的接口 |
| --- | --- |
| S06 通过后的 P8 / P9 | Compiler 已拒绝未知 type；正式 AI Step 另案加枚举后再允许编译 |
| 输入默认值 | `inputs` 已是结构化声明，补 `defaultValue` 时只动 Compiler 与 Run 创建期解析 |
| P7 SSE | 试跑已是普通 Run，观察页只差事件流 |
| S-LIVE | Studio 不嵌画面；试跑页以后可挂只读 Viewer |
| D2 录制回填 | `ScenarioDocument.steps` 已是 Structured Step；另案把 IR item 映射进来并走同一 compile |
| 完整 P13 | kind 与 Evidence 已通；增强「点选元素 / 读页填期望」另案 |

## 11. 建议实现顺序

1. `ScenarioDocument` + `compileScenarioDocument` + 诊断码单测。
2. 迁移：`scenario_drafts`、`scenario_versions.kind` / 可空 `version_no` / `compiler_version` / `source_digest`、trial 部分唯一索引；同步 `schema-parity.test.ts` 与 `pg-restriction.test.ts`。
3. 草稿仓库；`latestVersion` 及所有派生加 `kind='published'`；创建路径双写；回填。
4. HTTP：draft / publish（含幂等）/ trial；收缩 `POST /scenarios/:id` 的 `steps`。
5. Studio 表单与冲突 / 诊断；创建框收口。
6. Surface Lab 上跑一条五步试跑；前端验收。
7. CHANGELOG 记落地（本文通过审查只表示方案可实施，不表示已交付）。

## 12. 方案修订

- 2026-09-13：初稿。确定性草稿 / 编译 / 顺序编辑 / 最小断言；与 S06 并行；不含 AI、SSE、Live View、录制回填。
- 2026-09-13：自审后修订六处。试跑改为绑定 `kind='trial'` 的不可变版本行，不再置空 `runs.scenario_version_id`（原设计与 arch/02「Run 引用确定版本」冲突，且要改快照与两个摘要契约）；D6 不再物化平台缺省策略，编译产物等于源文档；`draftDirty` 统一为源文档摘要对比；去掉 `inputs.required`（`assertRunFromResolved` 只看实际传入键，可选声明是陷阱）；创建首步明确必填；补 publish 幂等、`latestVersion` 的 `NULLS FIRST` 陷阱与两处 schema 检查的同步要求。
