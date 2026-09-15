# 平台助手一期方案审查

日期：2026-09-14。对应方案：[平台助手一期](../spec/2026-09-14-platform-assistant-phase-one.md)。对照：[架构复用边界](../spec/2026-09-14-platform-assistant-architecture.md)、[两类 AI 配置边界](../spec/2026-09-13-ai-model-configuration-boundaries.md)、[产品角色与能力地图](../spec/2026-09-13-console-product-roles-and-capability-map.md)。P1 已写入方案并按权限先行落地，实施结果见[落地验证](2026-09-14-platform-assistant-phase-one-implementation.md)。

结论：**产品方向和一期取舍可以批准；进入实现前须先补清第 3 节的契约，并确认第 5 节的产品决策。** 方案没有把助手做成第二套 Runtime，也没有提前建设无消费者的 Agent 平台。缺口主要在跨边界契约仍偏口头、以及和现有权限目录、运行状态词、软删除工作区对不上的地方。

## 1. 与宪法和已确认架构的对齐

下列边界已经写清楚，审查通过后应保持，不要在实现时放松：

- 平台通用 AI 与浏览器 AI 分开配置，不经 Midscene，不创建 Browser Session，不为提问伪造 Run。
- 历史 Run 只读自身 Snapshot 与 Evidence；不把当前 Scenario 拿来解释旧运行。
- 候选只进 Studio 本地草稿，采纳不写库、不发布、不试跑；保存 / 试跑走原有 OCC、Compiler 与 Run。
- 模型不输出 JSON Patch 或整份 Scenario；链接、引用和入口由代码校验后生成。
- API 只用 GET / POST；助手轮次不进 Run 队列，也不改 Run SSE。
- 通用层只做路由分槽与分派；Run / Scenario / Evidence 语义由识途 Agent 负责。
- 不新增 D 阶段或排期；不把 ABC 联合验收缺口当成已经修好。

一期不做整场景生成、增删重排、推测定位器、看图、解析 Trace、自动执行，这个取舍与架构文档第 5 节一致，也避免把目标系统知识和浏览器感知做成助手前置。

## 2. 与现有实现的对账

方案第 2.1 节列出的复用点成立，但实现时要按实际契约落地，不能只按表格里的名称理解。

| 方案说法 | 代码现状 | 审查意见 |
| --- | --- | --- |
| 复用一致观察 | `loadRunObservation` 一次锁行返回完整 `run`（含 Snapshot、Execution Context、全部 Attempt 输出）+ Evidence 元数据 + `eventSeq` | 观察查询可复用；送给模型的必须是白名单投影。Context 和 Attempt `output` 默认不能整包进入提示词 |
| 运行耗时来自时间戳 | `run` / `stepRun` / `attempt` 均有 `startedAt` / `finishedAt` | 可算间隔；`finishedAt` 为空只能标未知，不能补零 |
| 「资源等待」与认证等待并列 | Run 主状态没有资源等待词。容量 / 会话占用在 `placement.state`：`owner_at_capacity`、`session_not_ready`、`owner_required` 等；主状态仍可能是 `QUEUED` | 必须按 placement 解释，不能新造 Run 状态 |
| 草稿 revision 与三层编辑 | `use-studio-draft.ts` 已有 baseline / candidate / `stepOverlays`（字段草稿）/ `conflict` / `remoteStale` | 生成入口要求无未保存、无字段草稿、无远端冲突，对齐现有三层，可执行 |
| 文档摘要前后端共用 | Web 侧 `sameDocument` 用 `JSON.stringify`；共享层已有 `canonicalJson` | 摘要必须放 `@cairn/shared`，用规范化 JSON，不能复用 Web 的 stringify |
| 领域读服务带权限 | `RunsService.get/list/evidence` 不接收 actor，只靠 Controller 守卫 | 方案第 5.2 节的提醒成立。当前也没有按用户隔离 Run / Scenario，助手「核对对象关联」应指 step 属于 Snapshot、版本属于场景等完整性，不是资源级 ACL |
| 新增 `ai:assist` | `PERMISSION_ACTIONS` 只有 `read/write/delete/execute/cancel/review`；`RESOURCE_LABELS.ai` 现为「浏览器 AI」；viewer 测试要求全部权限以 `:read` 结尾 | 见 P1-1 |
| 已删除对象不可见 | 工作区已有软删除：`getRun` 等对 `deletedAt IS NOT NULL` 返回不存在 | 助手历史恢复必须走同一可见性，不能凭 conversation 里的旧引用读出已删除 Run 的派生内容 |
| fill 是否敏感 | `fill.input.sensitive` 为作者声明；录制敏感识别仍有缺口（ABC 复查 C 线） | 见 P1-3 |
| 平台配置加分组 | 现行 `schemaVersion = 1`，文档只含 `browserAi` | 「旧修订读成平台 AI 关闭、不改写旧修订」成立。优先给 v1 增加可选分组并默认关闭，避免无必要的全量升 v2 |

## 3. 进入实现前必须补清

这些不是文风问题。不写进方案，AS01–AS12 无法稳定卡住实现。

### P1-1. `ai:assist` 与现有权限目录冲突

方案写「四类内置产品角色可使用助手」，并新增 `ai:assist`。

现有只读角色不变式是：viewer 的权限码全部以 `:read` 结尾（[角色方案](../spec/2026-09-13-console-product-roles-and-capability-map.md) D2，以及 `rbac.test.ts` 第 105 行）。`ai:assist` 会直接打破这条不变式。同时 `PERMISSION_ACTIONS` 没有 `assist`，`ai` 资源的产品名仍是「浏览器 AI」。

实现前必须在方案里选定其一，并同步改能力地图、种子和测试：

1. **viewer 不用助手**，只给 admin / author / operator 加 `ai:assist`，viewer 不变式保留。
2. **权限码改为 `ai:read`**，四类角色都可给；语义弱一点，但符合只读角色和现有 action 词表。
3. **坚持 `ai:assist` 且给 viewer**，则必须显式改写「只读全是 read」这条产品不变式，并把 `ai` 资源改名为覆盖平台助手，而不是继续叫浏览器 AI。

自定义角色不自动补权可以保留。无论选哪条，Studio「修改建议」仍必须另要 `workflow:write`，只读用户不能看见可写入口。

### P1-2. `nextActions` 与引用键没有闭合词表

诊断结果依赖 `facts[]` / `hypotheses[]` / `nextActions[]`，以及「模型只引用本轮事实包中的引用键」。这两项是跨 API / Web / 测试的硬契约，目前只有自然语言。

方案应冻结：

- 引用键格式，例如 `run` / `stepRun` / `attempt` / `evidence` / `step` 加已有实体 ID，禁止模型发明路径。
- `nextActions` 的闭合种类。一期只允许跳到**已经存在**的页面，例如运行详情、证据 Viewer、认证处理、核查、Studio 步骤、目标账号、平台配置。不得出现「重跑」「取消」「代填认证」「通过核查」这类可执行命令，即使只是做成按钮文案。
- 入口参数一律由服务端按引用键生成，前端不得把模型文本当路由。

不先冻结，AS03「不得建议未知副作用的无条件重放」只能靠提示词自觉。

### P1-3. 敏感 fill 的判定和候选范围写反了风险

方案只允许「已有非敏感 fill」做 `fill_binding`。现有敏感标记是可选的作者声明，不是可靠分类；录制侧还可能漏标。

更要紧的是产品方向：敏感 fill 正是应该改成「引用已声明输入 / 前序输出」、而不是继续写死 `value` 的步骤。把它们整类排除，助手帮不到最需要参数化的字段；只按 `sensitive === true` 排除，漏标的口令字段又可能把现值送进模型。

建议改成：

- 模型上下文**永不包含** fill 的 `value`，无论是否标记敏感；只给定位摘要、现有 `from` / `fromField` 和可选绑定列表。
- 构造器允许对 fill 做 `from` / `fromField` 绑定，并继续去掉互斥的 `value`。
- 已声明 `sensitive: true` 的步骤，绑定后必须保持 `sensitive: true`。
- 定位器或字段名命中现有敏感启发式时，按敏感处理，不把现值送模型。

「未知敏感性的原始输出不整包发送」应对齐到 Attempt 输出和 Execution Context：只传结构说明或已声明非敏感字段。

### P1-4. 「资源等待」必须落到现有 placement，不能写成第三种 Run 状态

AS03 把认证等待、资源等待、`NEEDS_REVIEW` 并列。领域词表里只有 `WAITING_FOR_AUTH` 和 `NEEDS_REVIEW` 是主状态；资源不足、会话未就绪、必须回原 Worker，都在详情 DTO 的 `placement`。

方案应写明：

- `focus=waiting` 覆盖 `WAITING_FOR_AUTH` **以及** `placement.state ∈ {owner_at_capacity, session_not_ready, owner_required, session_lost}` 等已有取值。
- 事实包带 `status` 与 `placement`，解释口径与运行详情页一致。
- 不得新增 Run 状态，也不得把 `QUEUED` 一律说成「排队等 Worker」。

### P1-5. 快捷入口固定 capability 与自由问句冲突

第 4.1 节同时写了「页面快捷入口可固定 capability，省去分类」和「页面上下文不得覆盖用户本轮指定对象」。运行详情点「分析本次运行」后，用户仍可能问「目标账号在哪配置」。

若不先规定冲突规则，实现会把导览问题硬分到 `run.diagnose`，或反过来丢掉页面带来的 `runId`。

建议：快捷入口只预填槽位和 `capabilityHint`；问句明显属于另一项已授权能力时，仍走一次分类；分类结果与 hint 不一致则澄清，不静默执行 hint。`capabilityHint` 不能降低权限或放宽槽位校验——这一点方案已有，应保留。

### P1-6. 短任务取消语义和前端请求归属互相打架

方案要求：收起浮层或站内换页不取消；用户点停止或浏览器断开该请求则 Abort 并拒绝迟到结果。SPA 刷新会中断 fetch，按后一条即变成取消。

AS07 / AS10 / AS11 要同时成立，必须写死：

- 在途 POST 挂在 `AuthenticatedLayout`（或同等全局 owner），路由切换不卸载请求。
- 关标签 / 刷新 / 点停止 = 取消，轮次 `CANCELLED`，不接纳结果。
- 进程退出或 deadline = `INTERRUPTED`，恢复不自动再调模型。
- 整轮 60 秒必须小于部署反向代理空闲超时；否则代理先断，客户端会当成取消。建议在方案里写「实现与部署超时必须大于整轮超时」，或把整轮超时降到可部署的值。

## 4. 建议收紧，但不挡批准

### P2-1. 事实包要有数字上限，并点名现成摘要函数

「标注删减和截断」还不够。应给出事实包最大字符 / token、优先保留当前步骤与失败 Attempt、超出必须写入 `missingInformation`。文档摘要用共享 `canonicalJson`（或基于它的 digest），不要再做一份 Web 专用比较。

观察对象含整份 Snapshot 和 Context，投影漏一层就会把执行上下文送出平台。

### P2-2. 平台配置用 v1 可选分组，不要先升 v2

旧修订解释为平台 AI 关闭、更新才生成新修订，这个兼容策略是对的。现行文档是 v1 且测试面已经绑在 `browserAi`。一期给 `platformAi` 做可选分组、缺省关闭，比先 bump `schemaVersion` 更小。若坚持独立版本，须写清 v1 读取器和迁移，不能只说「带版本」。

`platform-default` 只作为配置槽名称，不要暗示已经有通用 Model Router。

### P2-3. 导览目录必须挂现有能力 ID 和真实路由

六类主题里，「浏览器会话」当前不是侧栏菜单，能力预览也不得把它说成独立菜单；实际入口在运行详情的受管画面，门是 `session:view`。平台配置门是 `platform-config:read`。viewer 两者都没有。

目录项应引用 `CONSOLE_CAPABILITIES` 的 id 和已存在路由；缺路由或未实现的能力一律走「未支持」，并加一条能扫到悬空入口的检查。人工短说明可以存在，但不能单独成为入口事实源。

### P2-4. 对话列表分页、幂等键和阶段事件应对齐现有信封

会话列表应复用现有 cursor + `nextCursor`，不要另做页码。创建会话的请求 ID 应对齐已有 `idempotencyKeySchema`。SSE 的 `stage` 应闭合，例如 `accepted / routing / loading_facts / generating / validating / persisting`，避免前端猜字符串。

助手轮次是否写入控制台操作审计，方案没说。一期可以只用 `AssistantTurn` / `PlatformAiCall` 作审计，但要写明「不进操作记录表」，避免实现时各写各的。

### P2-5. 清理作业放哪、模型输出语言、输入长度

正文 30 天、调用元数据 90 天可以保留。清理应指定执行面：助手数据不属于 Worker 执行域，不宜塞进对象 purge；API 侧持久化作业或现有调度入口即可，但必须三库同一套条件更新。

方案未写回答语言。控制台是中文，应要求用户可见结果为中文。问句 2000 字已有；事实包和模型输入上限见 P2-1。

结构化 JSON 是本期接入面。两家模型若只有一家稳定支持 JSON mode，修复循环不能变成无限重试；超过「分类 + 生成 + 一次修复」仍失败，就返回诊断，不能再开一轮。

### P2-6. 与软删除、观察面缺口的衔接

资源生命周期方案与助手同一天待审，工作区读路径已经排除 `deletedAt`。助手应写一句：可见性与对应 GET 相同；已删除或无权对象的历史轮次只保留不可访问提示。不要让 conversation 变成第二条读 Run 的路径。

ABC 复查仍有观察通知可能拖垮进程等问题。诊断读的是观察 GET，不依赖 NOTIFY；但助手若与 API 同进程，通知通道的进程级故障仍会波及。这不是助手方案的阻塞项，发布说明里不要写成「观察链路已全部收口」。

## 5. 需要确认的产品决策

1. **只读角色能不能用助手（连带 P1-1）。** 给 viewer 会把运行定义和错误送出到外部模型，并占用 4 路平台在途额度。不给则只读用户看不到「分析本次运行」。
2. **60 条真模型门槛是发布门还是质量目标。** 两家供应商 × 60 条，再加上路由 95%、诊断 / 单步 90%，任一供应商波动都会挡住发布。用户效果 20% 已允许标「待验证」。建议：安全关键误分派必须为零，作为发布门；90% / 95% 作为发布记录里的质量目标，首次未达到就标缺口，不把整期功能卡死。确定性契约测试仍是硬门。
3. **一期是否一次做满四个能力。** 语义上共一条链是对的；工程上要同时交付平台模型配置、三库会话、额度、SSE、Studio 采纳和 60 条评测。若希望先看到控制台里的助手，可以先开放 `run.diagnose` + 确定性 `platform.guide`，`scenario.explain` / `propose-step` 用同一注册表跟进。这不是架构否决，只是交付切片。

## 6. 验收矩阵

AS01–AS14 覆盖了路由、串任务、三层运行状态、证据两轴、候选过期、两类 AI 隔离、迟到结果、三库和焦点，方向对。补上第 3 节之后，建议再加三条样例，不必扩成新阶段：

- 运行详情快捷入口提出导览问题，必须澄清或改派，不能按 hint 诊断。
- 敏感 fill 的现值不出现在模型输入、会话正文和普通日志；允许的绑定候选保持 `sensitive`。
- 已软删除的 Run / Scenario，历史轮次回读不得带回派生事实。

离线确定性门槛（权限、状态、引用、OCC、迟到结果、三库）应继续作为发布硬门。真模型流畅和接口 200 不能单独过关——方案第 9 节最后一段保留即可。

## 7. 审查结论

**有条件批准一期范围：** 运行诊断、已保存定义解释、三类受限单步候选、功能导览，以及为它们服务的路由分槽、独立平台模型配置、会话恢复和治理。

批准实现前，方案应回收第 3 节：权限码与只读角色、闭合的引用 / 下一步动作、敏感 fill 与投影、placement 等待语义、快捷入口冲突、在途请求的取消与超时。第 4 节可在实现说明里收口，但 P2-1 和 P2-3 建议写进正文。第 5 节由用户拍板后，再按工程计划开工。
