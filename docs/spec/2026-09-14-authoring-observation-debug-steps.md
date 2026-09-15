# 编写观察面：指认、调试会话与步骤词表

日期：2026-09-14。状态：**已实施 I1–I5**（同日二次收口：指认只出 Observation，「本次验证」写覆盖，「写回草稿」OCC 保存；pick 走 Resolver；检查点写入 pageRef/url，页变需确认；observeGrant 过期后 pick 拒绝；插件补采集字段并沿用 isSensitiveFill）。I6 编写辅助保持 closed。正式开放前验收见[实施报告](../reviews/2026-09-14-authoring-observation-debug-steps-implementation.md)。

三块能力按同一套编写观察契约交付，而不是分别补「选择器探查」「断点调试器」「动作目录」。立足当前时间点设计：可维护、可开关、AI 可融合；不移植商业 RPA 的对象库、属性树、F9 断点和静默自愈。

关联：[受管浏览器查看](2026-09-13-managed-browser-view-and-auth.md)、[录制回填 Studio](2026-09-13-recording-studio-integration.md)、[顺序编排](2026-09-13-sequence-studio-foundation.md)、[两类 AI 配置边界](2026-09-13-ai-model-configuration-boundaries.md)、[平台助手一期](2026-09-14-platform-assistant-phase-one.md)。交付顺序只维护在[工程计划第 5 节](../plan/识途开发路线与工程实施计划.md#5-当前交付顺序与验收样例)。**本文不新增 D 阶段，不改变 D0–D4。** 作为 D2 之后的编写面增量；正式开放前通过本节 Gate。

对照商业产品的差距只作背景；验收以本文契约为准。

## 1. 要交付的用户结果

用户在同一 Studio 里完成三条连续动作，中间不换心智模型：

1. **指认**：对着真实页面点一下，步骤拿到可执行的 `TargetDescriptor`；再点「校验」，页面上高亮唯一匹配，或清楚说明找不到 / 找到多个。
2. **调试**：试跑停在当前步，画面、步骤、期望与实际并排。失败后可以「再试这一步」或结束会话；成功后可以「继续下一步」。不能靠截掉步骤数组假装从中间开跑。
3. **词表**：下拉、按键、等待成为一等步骤；录制不再把右键、双击、修饰键收成普通左键，也不再把密码框当明文 fill。

确定性路径在关闭全部 AI 后仍然完整可用。AI 打开时，只解释和排序已有观察结果，不把推测写成定位事实，不静默改已发布定义。

本期不交付对象库、自由表达式、从任意冷启动步续跑、文件上传 / 对话框 / 下载步骤、云端第二套录制器、正式 Run 的人工暂停，以及助手里的整段生成或运行诊断 Agent。

## 2. 建设原则

商业产品常见的延伸方式是：先有脆弱选择器，再叠 Explorer、对象库、Healing、Locals。识途不走这条链。

| 原则 | 落地约束 |
| --- | --- |
| 一种目标事实 | 指认、录制、手工填写、调试探针、正式执行都读写 `TargetDescriptor`。禁止并行再造 Selector 字符串、XPath 主字段或坐标步骤 |
| 观察先于动作 | 指认和校验只产生观察结果，不触发业务 click / fill / select。业务动作只走 Step / Attempt |
| 快照不可偷改 | 调试中验证新目标，是本次 Run 的临时覆盖，必须写入 Attempt 证据。写回草稿是另一次 OCC 保存；新草稿只影响下一次 Run |
| 续跑靠检查点 | 从失败步再试，依赖同一 Session、同一 PageRef、已持久化 Context。禁止把 Snapshot.steps 截断后当作新定义执行 |
| AI 可关 | 关闭平台编写辅助与浏览器仿真 AI 后，指认、校验、调试、新步骤类型仍可用。AI 不得成为定位或调试的唯一路径 |
| 开关是产品能力 | 启用状态来自平台配置与场景开关，运行时再校验。前端隐藏不是安全边界 |

## 3. 已有基础与必须收口的缺口

| 已有实现 | 本期如何用 | 若不收口会做成什么 |
| --- | --- | --- |
| `TargetDescriptor`、Resolver 四种结果、`resolverDiagnostics` | 升为编写观察的唯一解析器 | 再写一套前端选择器语言 |
| Live View、PageRef、`pageAfter`、认证输入通道 | 调试会话复用同一受管 Page；指认另开观察授权，不复用 AuthControl | 登录输入和点选元素抢同一控制权 |
| Trial Run、SSE、Attempt 证据 | 调试仍是正式 Trial Run，只增加 `HOLDING` 与检查点 | 内存里的「调试模式」在刷新后消失 |
| 录制 `recording-normalizer@2`、敏感字段契约 | 升到 `@3`；采集端补 `inputType` / `autocomplete` | 继续静默丢语义，API 清洗救不回明文 |
| `GET /scenarios/capabilities`、浏览器 AI 闸门 | 扩展编写观察与新 Step Type 能力位 | 未开放类型出现在步骤库里 |
| 平台助手一期（待审） | 本期只生产观察与 Hold 事实，不实现诊断 Agent | 助手与编写面各猜一套定位 |

[A/B/C 复查](../reviews/2026-09-14-abc-integration-review.md)里与本线直接相关的 P1 / P2（认证输入代次、密码框采集、右键静默降级）视为前置缺陷，不在本方案里重开设计；本线验收默认它们已按原报告修好，或在本线增量里一并关掉并写进报告。

## 4. 融合架构

```text
AuthoringPage（受管 Page 或已挂接的录制页）
        │
        ▼
TargetObservation（解析 + 高亮 + 可选 AI 解释）
        │
        ├─ 写回 Step.target          → 草稿 / 下一次 Run
        ├─ 临时覆盖                   → 本次 Attempt 证据
        └─ 执行 BrowserCommand        → StepRun / Attempt
                │
                ▼
Debug Session = Trial Run + HOLDING + Checkpoint
```

三块能力共享三份契约，禁止各写各的：

1. **`TargetObservation`**：一次解析的结构化结果。
2. **`AuthoringPageRef`**：当前可观察的页面身份（复用已有 `PageRef` + URL / title）。
3. **`DebugCheckpoint`**：调试会话停住时的页、上下文与步骤游标。

Worker 仍是 Page 的唯一所有者。API 只转发观察命令。Web 与 Extension 只提交点选坐标或已提取的描述符，不私自连 CDP。

## 5. 目标观察：指认与校验

### 5.1 用户怎么用

有目标的步骤（click / fill / extract / assert / select / keyboard 可选目标 / wait 的元素条件）在属性区提供两个蓝色平台动作：**在页面上指认**、**校验高亮**。它们不是 AI 能力，不用紫色。

| 前置 | 指认 | 校验 |
| --- | --- | --- |
| 调试会话 `HOLDING`，Live View 可用 | 在画面上点元素，Worker 提取描述符 | 用当前步骤（或临时覆盖）的描述符解析并画框 |
| 录制插件已挂接目标页 | 在页面上点元素，插件提取同一描述符 | 插件按同一描述符高亮 |
| 两者都没有 | 按钮说明原因，不假装成功 | 同左 |

本期**不**为了指认单独拉起一条没有 Scenario 的受管浏览器。没有会话时走插件；没有插件时先开调试试跑。单独的「只打开目标页」编写会话不在本期。

### 5.2 提取规则（确定性，AI 关闭也必须成立）

点选命中元素后，按固定顺序生成最多 5 个候选，css 只能落在最后一档，与现有 Schema 一致：

1. `testId`（`data-testid` / `data-test-id`）
2. `role` + 无障碍名称
3. `label`（label 文本或 `aria-label`）
4. `text` / `title`（可见文本或 title，取较短且稳定的一档）
5. `css`（稳定属性优先：id、name、不含 nth-child 的短选择器；没有稳定属性则记诊断，仍给最后一档以便用户改）

同时提取：

- `framePath`（urlPattern / name / selector，深度 ≤ 4）
- 可选 `anchor`：同一行或最近的可见文本，长度 2–40，排除纯数字和当前元素自身文本
- 预览：bounding box、标签名、可见文本截断、可选元素裁剪（不默认存直播帧）

禁止把点击坐标写成步骤目标。坐标只用于当次命中元素。
高亮由 Worker 解析得出 `bounding box` 等预览属性，Web Live View 视窗通过前端叠加层（Canvas/SVG）渲染高亮框，**严禁向受管页 DOM 注入带样式的遮罩节点**，确保后续 Attempt 零污染。

多个匹配时观察结果为 `AMBIGUOUS`，列出可区分的邻近文本，让用户再点一次或改候选；不得默认取第一个。

### 5.3 `TargetObservation` 契约

```text
TargetObservation = {
  outcome: FOUND | NOT_FOUND | AMBIGUOUS | SURFACE_LOST | CAPABILITY_MISSING
  target?: TargetDescriptor          # FOUND 时必填
  page: { pageRef?, url, title }
  preview?: { box, tag, text, cropObjectKey? }
  diagnostics: ResolverDiagnostics   # 复用已有 candidatesTried
  source: 'managed' | 'extension'
  alternatives?: { index, reason }[] # AMBIGUOUS 时的可区分说明
  assist?: TargetAssist              # 仅 AI 开启时出现；缺省等于未使用
}
```

`TargetAssist` 只允许：

- 用一句话解释为何是 FOUND / AMBIGUOUS / NOT_FOUND
- 给已有候选排序建议（不新增 css）
- 建议步骤名称

禁止：编造不在页面上的定位值、把 AI 文本写进 `target.candidates`、把一次成功轨迹固化成确定性步骤。

### 5.4 观察授权，与认证输入分开

`WAITING_FOR_AUTH` 的 AuthControl 继续只服务于登录。`HOLDING` 期间的指认 / 校验使用短时 **`observeGrant`**：

- 绑定 `runId` + `sessionGeneration` + `pageRef` + epoch
- 只允许 `highlight` 与 `pick`（elementFromPoint → 提取描述符）
- 超时、取消、恢复执行、换页后旧 grant 失效
- 不得执行业务 click / fill / select / keyboard / navigate
- **并发互斥闸门**：签发 `observeGrant` 前必须硬性确认 `run.status === 'HOLDING'` 且当前不存在 `RUNNING` Attempt（在途业务动作必须完全停稳排空，未停稳前返回 `WAITING_FOR_STABLE_HOLD`）

插件路径不发 `observeGrant`。插件用控制台登录 + Target 权限提取描述符，经 `POST /api/authoring/observations` 校验后回填到当前草稿步骤；服务端必须做敏感字段清洗（复用 `isSensitiveFill` 规则）与同源校验，再跑一遍候选规则，不信任插件自报的 css，禁止使用客户端传来的 url 发起未经验证的外部请求。

### 5.5 写回与临时覆盖

| 动作 | 写到哪里 | 对当前 Run 的影响 |
| --- | --- | --- |
| 写回草稿 | 当前选中 Step 的 `target`，OCC 保存 | 无。已冻结 Snapshot 不变 |
| 本次验证 | `run.debugOverlay.stepOverrides[stepId].target` | 仅下一次 `retry_current` 使用，Attempt 证据标记 `targetOverride: true` |
| 校验高亮 | 不写定义 | 只返回 Observation |

「写回草稿」成功后，覆盖层丢弃该步覆盖，避免草稿与覆盖长期分叉。无论当次重试成功与否，一旦用户「继续下一步」或「结束会话」，临时覆盖自动丢弃；Studio 属性区明确展示「正在使用临时覆盖目标」及「恢复原始快照」操作。用户改了草稿但未保存，指认结果进入本地字段草稿，沿用现有三层编辑保护。

## 6. 调试会话

### 6.1 它是什么

调试会话是 **`kind='trial'` 的 Run**，外加作者控制点。它不是第二套执行器，也不是前端逐步假装执行。

创建试跑时增加 `debugMode`：

| 模式 | 谁用 | 失败或停步 |
| --- | --- | --- |
| `holdOnFailure` | Studio 试跑**默认** | 步骤最终失败后进入 `HOLDING`，不把后续步标 SKIPPED |
| `holdAfterEach` | 显式逐步确认 | 每步成功或失败后都进入 `HOLDING` |
| `runThrough` | 正式 Run、服务 API、用户关掉调试 | 保持现有失败即停 |

正式发布版本的 Run、服务凭据创建的 Run 只允许 `runThrough`。请求其它模式返回 `DEBUG_MODE_NOT_ALLOWED`。

### 6.2 新主状态 `HOLDING`

在现有 Run 词表增加 `HOLDING`。含义：作者正在看当前步，自动调度暂停，**RunLease 与 SessionLease 都还在**。

| | `WAITING_FOR_AUTH` | `HOLDING` | `NEEDS_REVIEW` |
| --- | --- | --- | --- |
| 原因 | 目标系统要登录 | 作者要看 / 改 / 再试 | 未知副作用，不能自动续 |
| RunLease | 释放 | **保持** | 释放 |
| 浏览器 | authHold 保住 | SessionLease 保住 | 按现有回收 |
| 下一步 | 受控登录后 resume-auth | retry / continue / stop | 人工判定失败或取消 |
| 输入 | 登录键鼠 | 观察 grant（点选 / 高亮） | 无页面输入 |

**Worker 生命周期与 Wait-on-Hold 挂起机制**：
引擎检测到需要进入 `HOLDING` 时，`engine.execute()` **不退出调用栈**，而是在步骤循环边界挂起等待（`await this.waitDebugHold(runId, holdTimeoutMs)`，默认 15 分钟）。
- 在挂起期间，Run 依然保留在 Worker 的 `inFlight` 任务表中，Worker 心跳周期（`beat()`）照常进行 RunLease 续租与 SessionLease 维持，避免租约被 Reaper 判定为失联。
- 收到 `/internal/runs/debug-resume` 时，唤醒挂起的引擎循环，根据指令（retry / continue / stop）决定是新开 Attempt、进入下一步还是退出。
- 若达到 Hold TTL（默认 15 分钟）仍未收到操作，挂起超时，引擎主动将 Run 终结为 `FAILED`（错误码 `DEBUG_SESSION_TIMEOUT`），并释放租约。

**异常恢复收敛（`settleLeaselessRun`）**：
若持有 `HOLDING` 的 Worker 进程意外崩溃或失联超过 `CAIRN_WORKER_LOST_AFTER_SECONDS`，租约过期后 `expireStaleRunLeases` -> `settleLeaselessRun` 必须将 `HOLDING` 的 Run 同事务终结为 `FAILED`（错误码 `DEBUG_WORKER_LOST`），释放 Session 租约并记录审计证据，严禁在库中留下永久无租约的 `HOLDING` 僵尸。不得用过期 fencing 复活已失联的 Hold。

**StepRun 状态与重试事务**：
StepRun 词表不新增状态。失败再试时：DB 原子事务（`startAttempt` 扩展支持 `HOLDING` 下重置 `FAILED` 状态）将当前 StepRun 从 `FAILED` 置回 `RUNNING`，新增 Attempt；历史失败 Attempt 保持完整。成功后的 `holdAfterEach`：当前 StepRun 保持 `SUCCEEDED`，Run 为 `HOLDING`，`continue` 从下一 `PENDING` 步开始。

取消请求仍按现有规则：确认后 `CANCELLED`，后续未跑步 `CANCELLED`，不标 SKIPPED。作者选「结束会话」且最后一步已成功，则 Run `SUCCEEDED`；停在失败步则 `FAILED`，后续保持 `PENDING`（未跑），不补 SKIPPED。证据必须能区分「没跑」和「失败后跳过」。

### 6.3 检查点

```text
DebugCheckpoint = {
  mode: holdOnFailure | holdAfterEach
  reason: step_failed | step_succeeded | author_pause
  stepId
  stepOrdinal
  pageRef?
  url?
  contextKeys: string[]          # 已有键名，不含秘密值
  sessionGeneration
  fencingToken
  overlayRevision
}
```

检查点与 Run 行一起持久化，观察 GET 返回。Context 值仍只活在 Run Context 里，不复制一份到检查点。

`retry_current` 允许的条件（全部满足）：

1. Run 为 `HOLDING`，请求带当前 fencing token
2. Session 健康，`sessionGeneration` 一致
3. 当前 `pageRef` 仍在，或用户确认「页面已变，仍要再试」（写入审计；解析失败则新 Attempt 失败，不装成功）
4. 该步所需 Context 键仍在
5. 副作用：`READ_ONLY` / `IDEMPOTENT` 可直接再试；`SIDE_EFFECT` 必须用户再次确认。`ai_action` 视为 `SIDE_EFFECT` 且 `retryLimit=0`，再试也要确认，不得改成可重试确定性步
6. 覆盖层若存在，只作用于这一次 Attempt

`continue` 只在当前 StepRun 已 `SUCCEEDED` 时允许。禁止在失败步上 continue。

禁止：把 Snapshot 改成从第 N 步开始、冷启动无 Session 的「从这步运行」、在 Hold 期间改草稿并让当前 Run 改用新定义。

### 6.4 作者动作

`POST /api/runs/:runId/debug`，body 判别：

| `action` | 效果 |
| --- | --- |
| `retry_current` | 新 Attempt，可用覆盖目标 |
| `continue` | 进入下一步 |
| `stop` | 按 §6.2 终结 |
| `pause` | 仅 `RUNNING` 的调试会话可请求；当前 Attempt 结束后进入 `HOLDING`（`author_pause`）。在途业务动作仍跑完，不能中途掐断 click |

`pause` 对已发出的副作用没有撤回能力，文案必须写明。

### 6.5 Studio 布局

沿用 Sequence First，试跑从「跑完再看摘要」改成工作区一部分：

```text
Target / 草稿 / 调试会话状态                         保存 / 试跑 / 发布
┌──────────┬────────────────┬─────────────────────┐
│ 步骤序列  │ 当前步骤属性     │ 页面（Live View）    │
│ 当前步高亮 │ 指认 / 校验     │ 高亮框 / 多匹配提示   │
└──────────┴────────────────┴─────────────────────┘
期望 vs 实际 · 解析诊断 · Attempt · 再试 / 继续 / 结束
```

主操作：

| 状态 | 最醒目动作 | 其它 |
| --- | --- | --- |
| 有未保存修改 | 保存草稿 | 试跑说明先保存 |
| 已保存可执行 | 试跑（默认失败即停住） | 发布次要 |
| `HOLDING` 且当前步失败 | 再试这一步 | 指认、校验、写回草稿、结束 |
| `HOLDING` 且当前步成功 | 继续下一步 | 结束会话 |
| 正式 Run 详情 | 不出现调试动作 | 现有取消 / 核查 |

窄屏：步骤 / 属性 / 页面三个分区切换，Hold 动作条始终可见。AI 解释若出现，放在诊断区，紫色只标「AI 说明」，主按钮保持蓝色。

副作用安全提示：当当前步骤为 `SIDE_EFFECT` 或 `ai_action` 时，点击「再试这一步」弹出二次确认模态框（AlertDialog），明确提示可能造成目标系统重复操作或数据变更风险，经确认后才提交 retry；只读与幂等步骤一键直达。

运行详情页对 `kind='trial'` 且 `debugMode !== 'runThrough'` 的 Run 复用同一 Hold 条，避免 Studio 与详情两套逻辑。

## 7. 步骤词表与录制保真

### 7.1 新增 Step Type

加入 `select`、`keyboard`、`wait`。与现有浏览器步一样走 Browser Runtime，不新建执行器品牌。

`screenshot` 本期不升为用户步骤。截图继续按 Evidence Policy 采集。

#### select

```text
input = {
  target: TargetDescriptor
  by: 'label' | 'value' | 'index'
  value?: string            # 与 from 互斥
  from?: contextKey
  fromField?: field
  index?: number            # by=index 时必填，从 0
}
```

首版：原生 `<select>`，以及 `role=listbox` / `role=combobox` 且选项为 `role=option` 的可达列表。自定义 div 下拉若无这些角色，解析为 `CAPABILITY_MISSING`，引导改用 click 选选项或 AI Action，不猜测坐标。

`effectType` 默认 `SIDE_EFFECT`。

#### keyboard

```text
input = {
  target?: TargetDescriptor   # 有则先聚焦；无则对当前页
  keys: KeyCombo[]            # 1–4 个组合，顺序按下
}

KeyCombo = 封闭枚举：
  Enter | Tab | Escape | Backspace | Space | ArrowUp | ArrowDown
  | ArrowLeft | ArrowRight | Home | End | PageUp | PageDown
  | 可加单一修饰：Control / Meta / Alt / Shift + 上述键或单字母 a–z、数字 0–9
```

文本输入继续用 fill。连续字符录入不得拆成一串 keyboard。`Control+s` 这类快捷键允许，但不得用于上传文件或唤起系统对话框；触发系统文件框记为 `CAPABILITY_MISSING`。

`effectType` 默认 `SIDE_EFFECT`。仅 `Tab` / 方向键且作者标 `READ_ONLY` 时允许只读；默认不自动推断。

#### wait

```text
input = {
  kind: 'time' | 'visible' | 'hidden' | 'url' | 'text'
  target?: TargetDescriptor   # visible / hidden / text 必填
  urlPattern?: string         # kind=url
  text?: string               # kind=text，可见文本包含
  durationMs?: number         # kind=time，上限 60s
  timeoutMs?: number          # 其余 kind，默认走步骤策略
}
```

`effectType` 固定 `READ_ONLY`，`retryLimit` 默认 0。禁止 `networkidle`、禁止「等接口」。时间等待只是明确的停顿，不能替代元素条件。

录制**不**自动插入 wait。导航已有 navigate；需要等待时由用户加步。AI 开启时可建议「这里像是在等结果出现」，建议必须经用户确认才写入草稿。

### 7.2 click 补语义，不新增步骤类型

`click.input` 增加可选字段，缺省等于今天的左键单击：

```text
button?: 'left' | 'right' | 'middle'     # 默认 left
clickCount?: 1 | 2                       # 默认 1
modifiers?: ('Alt'|'Control'|'Meta'|'Shift')[]
```

历史 Snapshot 无这些字段时行为不变，click executor 版本保持 `1`。右键若只打开目标页菜单且平台不能操作菜单项，步骤仍执行右键，后续菜单项由用户用 click / AI Action 补；不得把右键改写成左键。

check / uncheck 继续映射为 click，但预览必须写「勾选 / 取消勾选」，不得显示成普通「点击」。

### 7.3 录制 `recording-normalizer@3`

预览与回填必须带 `@3` 重跑，不信任库存 `items`。

| 源事件 | `@2` | `@3` |
| --- | --- | --- |
| 左键单击 | mapped click | 不变 |
| 右键 / 中键 / 双击 / 带修饰键 | 静默左键 | mapped，写入 button / clickCount / modifiers |
| press（封闭枚举内） | unresolved | mapped keyboard |
| press（未开放键） | unresolved | unresolved，诊断写明键名 |
| select | unresolved | mapped select（label 优先，否则 value） |
| fill 且 password / one-time-code / markedSensitive | 依赖 selector 词 | parameterized，源事件无明文 |
| setInputFiles / dialog / download / closePage | unresolved | 仍 unresolved，**必须**出现在预览里，禁止丢掉后显示成功 |

采集端（插件）必须在 JSONL 写出 `inputType`、`autocomplete`、`button`、`clickCount`、`modifiers`、`key`。缺这些字段时，归一化不得猜测为普通左键或普通 fill；标 `unresolved` 或 `parameterized`。

`RECORDING_CANDIDATE_STEP_TYPES` 扩为 `navigate | click | fill | assert | select | keyboard`。

## 8. AI 融合与开关

AI 是观察和调试上的可选层，不是第三条编写产品。

### 8.1 两层开关

| 开关 | 控制什么 | 关闭后 |
| --- | --- | --- |
| 平台「浏览器仿真 AI」 | 已有 `ai_*` 步骤能否执行 | 步骤库禁用 AI 类型，与现网一致 |
| 平台「编写辅助 AI」 | 指认解释、多匹配排序、Hold 失败说明、wait 建议 | 指认 / 校验 / 调试 / 新词表仍可用 |
| 场景「允许编写辅助」 | 本场景是否调用编写辅助；默认跟随平台，可关 | 仅本场景不调用；不影响他人 |

场景开关存在草稿文档，发布进版本。Run Snapshot 冻结当时的场景开关与平台配置修订。历史 Run 的辅助说明按当时冻结结果展示，不按当前开关重算。

编写辅助走**平台通用 AI**，不走 Midscene，不创建额外 Browser Session。浏览器里的 `ai_*` 仍走冻结的浏览器 AI 配置。两类配置继续独立，见[配置边界](2026-09-13-ai-model-configuration-boundaries.md)。

权限：编写辅助需要 `ai:assist`（与助手一期同一码；若该方案未先落地，本线实现时一并加入，默认不授予 viewer）。没有 `ai:assist` 的编写者仍能指认和调试。

### 8.2 允许的辅助，全部只读建议

| 时机 | 输入 | 输出 |
| --- | --- | --- |
| 校验后 AMBIGUOUS / NOT_FOUND | Observation（无截图进模型，除非后续另审视觉） | 解释 + 已有候选排序 |
| 指认 FOUND | Observation | 建议步骤名 |
| `HOLDING` 且步骤失败 | 该 Attempt 的错误、diagnostics、期望与实际 | 事实摘要 + 推断（标推断） |
| 用户问「要不要加等待」 | 当前步类型与失败码 | wait 种类建议，不直接插入 |

助手一期的 `scenario.propose-step` 仍不得改 target。本线落地后，若要「采纳指认结果」，走本节写回草稿，不经助手 Patch。运行诊断 Agent 可以以后消费 `HOLDING` 与 Observation，本期不实现。

模型不得输出任意 JSON Patch，不得降低断言让失败变成功，不得建议无条件重放 `SIDE_EFFECT`。

## 9. 接口与数据

对外仍只使用 GET / POST。画面流沿用现有独立通道，不把帧塞进业务 JSON。

### 9.1 能力

`GET /scenarios/capabilities` 增加：

```text
authoring = {
  indicate: 'open' | 'closed'
  highlight: 'open' | 'closed'
  debugHold: 'open' | 'closed'
  assist: 'open' | 'closed'          # 编写辅助
  stepTypesExtra: ('select'|'keyboard'|'wait')[]
}
```

`executableStepTypes` 在对应类型开放时纳入 `select` / `keyboard` / `wait`。未开放则步骤库禁用并给原因，与 AI 闸门同一模式。

### 9.2 路由

| 方法 | 路径 | 权限 | 作用 |
| --- | --- | --- | --- |
| POST | `/api/runs/:runId/observe` | `run:read` + `session:view` + `workflow:write` | `op=highlight\|pick`；Hold 中转发 Worker |
| POST | `/api/runs/:runId/debug` | `run:execute` + `workflow:write` | retry / continue / stop / pause |
| GET | `/api/runs/:runId/observation` | 现有 | 增加 checkpoint、overlay、debugMode |
| POST | `/api/authoring/observations` | `workflow:write` + `target:read` | 插件提交提取结果，服务端规范化 |
| POST | `/api/scenarios/:id/draft` | 现有 | 写回 target，不新增专用保存口 |

创建试跑的现有 POST 增加可选 `debugMode`，缺省 `holdOnFailure`。服务 API 创建 Run 忽略该字段并固定 `runThrough`。

Worker 内部入口：`/internal/managed-browser/observe`、`/internal/runs/debug-resume`。禁止把 `/api/runs` 抄进 Worker。HMAC、fencing、PageRef 校验与 B 线相同。

### 9.3 事件

观察账本登记：`run.holding`、`run.debug_resumed`、`run.debug_stopped`、`observation.highlighted`、`observation.picked`。SSE 只提示变化；UI 以 GET observation 为准。

### 9.4 存储

不新增业务表也可以先做：checkpoint 与 overlay 放在 Run 行的 JSON 列（需迁移：PostgreSQL 下一号，MySQL / SQLite 同步）。禁止把覆盖目标写进 Snapshot。对象存储只放可选元素裁剪，保留期跟失败截图，不存指认过程的连续帧。

## 10. 实现增量

审查通过后按增量合入，每段可独立验收；未完成段不得宣称编写观察面已交付。

| 增量 | 内容 | 依赖 |
| --- | --- | --- |
| I1 | `TargetObservation`、受管页 highlight、能力位 | Live View 可用；Resolver 复用 |
| I2 | Hold 中 pick、写回草稿、临时覆盖 | I1；observeGrant |
| I3 | `select` / `keyboard` / `wait` + click 语义 + normalizer@3 + 采集敏感字段 | I1 的描述符；C 线敏感 P1 |
| I4 | `HOLDING`、checkpoint、retry / continue / stop、Studio 并排 | I2；引擎循环收口 |
| I5 | 插件同一观察契约（无会话时的指认 / 校验） | I1、I3 |
| I6 | 编写辅助开关与只读建议 | I1、I4；平台通用 AI 配置。可与助手一期共用客户端，不阻塞 I1–I5 |

I4 未完成时，Studio 不得出现「再试这一步」。I3 未完成时，录制预览不得显示 select / keyboard 为可接受成功项。

## 11. 明确不做

- UI Explorer 属性树、对象库、跨场景 UI 库
- 条件断点、Watch、Immediate、改 Context 再继续
- Healing / 运行中静默换定位
- 截断步骤数组的「从第 N 步运行」
- 任意时刻接管正在跑的 AI Action
- 文件上传、系统对话框、下载、原生 `<select>` 以外的自绘下拉（除 listbox/combobox）
- `networkidle`、Excel 行循环、表达式语言
- 把本线做成助手 Agent 或反向让助手改 target

## 12. 验收

安全与正确性零失败；涉及画面的指标在固定 Chromium 版本下测。

| 编号 | 场景 | 通过条件 |
| --- | --- | --- |
| AO01 | 关闭全部 AI，在 Hold 画面指认按钮 | 步骤得到合法 TargetDescriptor；css 若存在则在最后一档；坐标不进定义 |
| AO02 | 校验唯一匹配 | 画面画框；diagnostics.outcome=FOUND |
| AO03 | 校验多个匹配 | AMBIGUOUS，不执行 click；用户能看到可区分说明 |
| AO04 | 写回草稿后再开新试跑 | 新 Run 使用新 target；旧 Run Snapshot 不变 |
| AO05 | 本次验证覆盖后 retry | 新 Attempt 用覆盖目标，证据有 targetOverride；草稿未改 |
| AO06 | 失败 Hold 后 retry 只读步 | 同一 Session，不重新登录；旧 Attempt 仍在 |
| AO07 | 失败 Hold 后对 SIDE_EFFECT retry | 无确认则拒绝；确认后新 Attempt，不删失败证据 |
| AO08 | continue 在失败步 | 拒绝；成功 Hold 后 continue 进入下一步 |
| AO09 | 截断 steps 的请求 | 不存在该 API；现有创建 Run 仍要完整 Snapshot |
| AO10 | 正式 Run 请求 holdOnFailure | `DEBUG_MODE_NOT_ALLOWED`，失败即停行为不变 |
| AO11 | 原生 select 按 label | 选中正确选项；自定义无角色下拉 CAPABILITY_MISSING |
| AO12 | keyboard Enter | 触发页面提交或约定夹具事件；任意字符串键拒绝 |
| AO13 | wait visible 超时 | StepRun 失败，Run HOLDING（试跑）或 FAILED（runThrough）；不是误成功 |
| AO14 | 录制右键 / 双击 / Ctrl+Click | @3 分别 mapped，字段不丢；预览文案不是「点击」 |
| AO15 | `input[type=password]` 无 password 字样 | 采集、预览、持久化均无明文；fill 为 parameterized |
| AO16 | 关闭编写辅助 | 指认 / 校验 / 调试 / 三词表可用；无 assist 字段，无模型调用 |
| AO17 | 打开编写辅助但无 `ai:assist` | 同 AO16，说明缺权限，不挡编写 |
| AO18 | Hold 中 observeGrant 过期后再 pick | 拒绝，不产生业务 click |
| AO19 | AuthControl 与 observeGrant | 登录等待时不能指认；Hold 时不能当登录键盘用 |
| AO20 | 刷新 Studio | 从 GET 恢复 HOLDING、检查点、当前步；不丢会话 |

夹具：现有 surface lab 增加 select / keyboard / wait / 多匹配页。L3 真实系统只在对应类型对用户开放后按支持矩阵登记，单次成功不宣称普遍兼容。

前端按[编写工作流](../design/front/ai-workflow.md)验收 1366 / 1440 / 1920 与一个窄视口：Hold 条不丢，页面区与步骤属性可切换，无横向溢出。

## 13. 风险

| 风险 | 处理 |
| --- | --- |
| Hold 长期占 Session | Hold TTL 可配置，默认 15 分钟，心跳续期；到期取消 Run 并回收，文案说明「调试超时」 |
| 再试造成重复提交 | SIDE_EFFECT / ai_action 强制确认；未知副作用仍进 NEEDS_REVIEW，不走 Hold 再试 |
| 指认生成劣质 css | 稳定属性优先；只有 css 时校验区警告「脆弱定位」 |
| 插件与受管页 DOM 不一致 | Observation 带 source 与 url；写回后必须在调试会话里再校验一次才能宣称可执行 |
| 引擎恢复与 Hold 竞态 | 停步与恢复同一事务更新状态、fencing、checkpoint；过期 token 不能 resume |
| 与助手方案抢模型配置 | 编写辅助复用平台通用 AI 配置域；不在 Midscene 下藏开关 |

## 14. 审查结论与确认

2026-09-14 评审确认：
1. **Studio 试跑默认 `holdOnFailure`**，正式 / API 固定 `runThrough`。确认。
2. **无调试会话时指认只走插件**，不另开裸浏览器会话。确认。
3. **`HOLDING` 作为 Run 主状态**，引擎采用 Wait-on-Hold 挂起并维持 Worker 心跳续租；DB `recover` 与 `startAttempt` 收口超时与重试原子事务。确认。
4. **编写辅助与助手一期共用 `ai:assist`**；I1–I5 不阻塞于助手 UI。确认。
5. **check / uncheck 继续映射 click**，不新增 toggle 类型，预览显示勾选文案。确认。

审查发现的 4 项阻断级细节（Worker Wait-on-Hold 保活、`settleLeaselessRun` 针对 HOLDING 的收敛、`startAttempt` 重试支持、`observeGrant` 在途排空）均已融入本文相应章节。按本案修正案组织开发与分段验收。
