# 方案目录

本目录专门存放技术方案，记录设计、范围、实施约定和验收标准，可附简短实施状态。代码 Review、复查、测试验证与验收结果统一见[评审与验证报告目录](../reviews/README.md)。

历史方案中的宪法数字节号保留当时语境；2026-09-14 瘦身后的对应条款见[原章节迁移映射](../reviews/2026-09-14-constitution-slimming-review.md#7-原章节迁移映射)。新增引用使用当前条款名称或锚点。

交付顺序与里程碑只维护在[识途开发路线与工程实施计划](../plan/识途开发路线与工程实施计划.md#5-当前交付顺序与验收样例)。

| 方案 | 状态 | 原型 |
| --- | --- | --- |
| [Worker 登记、内部入口与执行节点治理](2026-09-14-worker-registry-and-fleet.md) | 已落地（2026-09-14）：显式广告入口、持久化期限、Worker/Session 代次隔离、查表转发与治理页。WR03 跨命名空间 HTTPS、WR13 旧/新二进制升级未跑，跳过≠通过；[实施报告](../reviews/2026-09-14-worker-registry-implementation.md)、[修订对照](../reviews/2026-09-14-worker-registry-review.md)。不新增 D 阶段 | — |
| [编写观察面：指认、调试会话与步骤词表](2026-09-14-authoring-observation-debug-steps.md) | 已实施（2026-09-14）：I1–I5 已落地并二次收口指认/覆盖拆分、Resolver pick、页变确认与 grant 过期；I6 编写辅助保持 closed。正式开放前验收见[实施报告](../reviews/2026-09-14-authoring-observation-debug-steps-implementation.md) | — |
| [平台助手一期：运行诊断、步骤辅助与功能导览](2026-09-14-platform-assistant-phase-one.md) | 已落地（2026-09-14）：权限先行，`ai:assist` 只赋能已有角色能力；运行诊断 / 步骤解释 / 单步候选 / 功能导览与独立 `platformAi` 配置。真实 60 条模型门槛未跑，效果门槛待验证 | — |
| [平台助手：架构复用边界与分层约定](2026-09-14-platform-assistant-architecture.md) | 复用方向已确认（2026-09-14）：借鉴 snc-log 的意图路由、分槽、校验与 Agent 分派；具体业务 Agent 由识途定义，分层与契约为设计建议，未实施 | — |
| [资源生命周期与列表管理补齐方案](2026-09-14-resource-lifecycle-and-list-management.md) | 已落地（2026-09-14）：软删除与级联、活跃运行闸门、对象清理登记、服务端筛选分页与删除 200/202；[实施报告](../reviews/2026-09-14-resource-lifecycle-and-lists-implementation.md)。真 S3 版本桶与根目录全量门禁未宣称通过 | — |
| [A · P7：运行实时状态、SSE 与断线恢复](2026-09-13-run-realtime-observation.md) | 已落地（2026-09-13），2026-09-15 补提示通道与 SSE 复核故障隔离：[复查整改](../reviews/2026-09-15-change-hint-and-sse-auth.md)。PG 用 LISTEN/NOTIFY，MySQL/SQLite 可接 Redis，未配置则 realtime=false。不含 Live View、录制回填与 Worker 唤醒 | — |
| [B · P7 / P5：受管浏览器查看、认证续跑与页面交接](2026-09-13-managed-browser-view-and-auth.md) | 已落地（2026-09-13），2026-09-14 补 fencing：[复查](../reviews/2026-09-14-managed-browser-auth-fence.md)。2026-09-15 控制台走完 Studio 等待认证、输入、续跑、续跑后只读画面与证据：[控制台报告](../reviews/2026-09-15-managed-browser-studio-console.md)。BV08 Web p95、D1 未宣称 | — |
| [C · D2：从平台发起录制并回填同一 Scenario Studio](2026-09-13-recording-studio-integration.md) | 已落地（2026-09-14）：绑定票据、`recording-normalizer@2` 精确转换、预览/OCC 回填、Studio 次级入口与插件握手；同日按实现收口网页不写录制中、open 绑定全局、replace 仅参数化 fill、本地 origin 等偏差 | — |
| [平台动态配置与参数中心：现状评估及范围建议](2026-09-13-platform-configuration-center-assessment.md) | 已落地并修复复查问题（2026-09-14）：四组配置使用数据库修订，新 Run 冻结完整策略；表单并发、密钥绑定、有效超时、旧摘要和 Trace 保留期已补回归 | — |
| [受控执行 API 与服务凭据基础方案](2026-09-13-controlled-execution-api-and-service-credentials.md) | 基础已实施；二次复查的 3 项缺陷已修复（2026-09-13）：未知副作用保留核查、64 KiB 解析入口、PG 0020 前向修复；424 项回归通过，验证及 API 既有类型检查错误见第 14 节 | 3 项缺陷已关闭；其余验收缺口及外部 Target/AI 试点仍按方案 Gate |
| [控制台产品角色与能力地图](2026-09-13-console-product-roles-and-capability-map.md) | 已落地（2026-09-13）：四产品角色、业务/治理侧栏、能力预览、开跑组合闸门、录制收进编写面；存量 operator 静默降权，需管理员补挂编写者。不做 Workspace 与菜单表，不进 D0–D4 | — |
| [D1：顺序编排与 AI 步骤编辑增强](2026-09-13-sequence-studio-foundation.md) | 本线已落地（2026-09-13）：ST02 / ST03 根键与 fromField / ST05；消费已有 shared 契约，未另造生产 DTO。ST04 已挂载现有 AI 表单与证据组件，步骤库仍受能力闸门约束。本机库已对齐到 0017，真实 API 验过保存 / OCC / 试跑。ST06 / 真模型 / SSE / Live View 未宣称通过 | 沿用 [Studio 视觉参考](../front_design/2026-09-13-foundation-lab/index.html#studio) |
| [控制台审计拆分：操作记录与登录记录](2026-09-13-console-audit-operations-and-logins.md) | 已落地（2026-09-13）：侧栏单入口，页内操作 / 登录两表；登录补 IP 与成败原因；`audit:login` 默认仅 admin | — |
| [底座通用性演进设计：面向持续功能迭代的架构抽象与自测试增强](2026-09-13-foundation-genericity-evolution.md) | 方案待审（2026-09-13）：基于后续演进审视，提炼执行器 SPI、AI 模型路由 SPI、声明式动态靶场引擎、分层可组装 Harness 与规则化看门狗五大通用性支柱 | — |
| [Midscene 正式接入：统一 Run 中的 AI 混编](2026-09-13-midscene-runtime-integration.md) | 已落地（2026-09-13）：三类 AI Step 混编、配置冻结、预算预扣、迟到隔离、`ai:execute` 与能力闸门、Studio 表单与运行证据；在线真模型验收已完成（普通 DOM 5 任务 × 3 次共 15 次全成功，105 次模型调用），原生 `<select>` 与未开放类别照原样登记；SSE / Live View 仍不作为本线前置 | — |
| [浏览器仿真 AI 与平台通用 AI：独立模型配置边界](2026-09-13-ai-model-configuration-boundaries.md) | 需求边界已记录（2026-09-13）：Midscene 视觉仿真与平台通用 AI 分别配置；平台 AI 接入需求包括 DeepSeek / 千问，具体功能与实现方案待定，未实施 | — |
| [面向 AI 敏捷自测与验证的底座增强方案](2026-09-13-ai-testing-foundation.md) | 方案待审（2026-09-13）：测试分层、PostgreSQL 模板库加速、确定性 AI Mock 桩、垂直切片脚手架、业务受控靶场与宪法看门狗 | — |
| [数据库可替换性：现状审计与 PostgreSQL / MySQL / SQLite 适配方案](2026-09-13-database-portability.md) | 已实现并验证（2026-09-13）：PG / MySQL / SQLite 持久化适配、事务与租约、六方向受控迁移；二次复查后 282 项 DB 测试通过；全仓独立失败与 P7 通知边界见方案第 11 节 | — |
| [确定性场景编写：草稿、编译与顺序编辑](2026-09-13-deterministic-authoring-studio.md) | 已落地（2026-09-13）：草稿 OCC、Compiler、发布幂等、试跑绑 `kind='trial'` 版本行、顺序编辑与最小断言表单；不改快照与摘要契约；不含 AI、SSE、Live View、录制回填 | — |
| [D0 混编关键未知：受管 Page 适配层探针](2026-09-13-d0-hybrid-probes.md) | 离线 Gate 已记录（2026-09-13）：S06 限制采用（控制面）；S07-lite 已出 SPI；在线 VL 未跑 | [`packages/worker/src/ai/`](../../packages/worker/src/ai/README.md) |
| [混合自动化与录制编排：方向复核与浏览器交互边界](2026-09-13-hybrid-authoring-direction-review.md) | 已完成分析（2026-09-13）：商业产品对照、源码复用取舍、Cairn / PulseAI 现状、本地录制与 Live View／受控认证边界；交付调整已合并到唯一工程计划，新增模块待详细方案评审 | — |
| [UI 底座交互评审与正式接入方案](2026-09-13-ui-foundation-review.md) | v1.3 Token 与 Target / Scenario 真实页面已迁移；工作流、分档 skill、定向验收与截图已补 | [交互评审台](../front_design/2026-09-13-foundation-lab/index.html) / [React 样板](../front_design/2026-09-13-react-migration/README.md) |
| [平台工程地基收口](2026-09-10-platform-foundation.md) | 已落地（2026-09-10）：HTTP 信封与关联 ID 冻结、凭证脱敏、配置生产硬失败、依赖方向检查 | — |
| [最小执行契约](2026-09-10-runtime-contracts.md) | 已落地（2026-09-10）：Step / Echo·Delay·Fail / RunSnapshot / 执行错误 / Evidence 元数据 / 事件信封 | — |
| [目标系统（接入目录）](2026-09-10-target-catalog.md) | 已落地（2026-09-10）：Target / TargetAccount 目录、本地凭据引用；不含会话与登录绑定。联调夹具见 [`tests/target-login-hmi/`](../tests/target-login-hmi/README.md)；外部 L3 清单见 [`docs/targets/`](../targets/README.md) | — |
| [目标系统补丁：首个账号与登录框定位](2026-09-10-target-login-fields.md) | 已落地（2026-09-10）：新建可带首个账号与可选定位；启发式清单进代码；不含探测与插件 | — |
| [识途 Recorder 扩展：图标、中文与忽略规则](2026-09-10-extension-playwright-crx-chrome.md) | 已落地（2026-09-10）：观测证据标、可见文案中文、包内 gitignore；不含上传与登录 | — |
| [识途录制器：控制台登录与录制上传](2026-09-13-extension-login-and-recording-upload.md) | 已落地（2026-09-13）：插件控制台登录、Target 绑定、JSONL 整批上传为 IR 草稿；不发布 Scenario、不改采集内核 | — |
| [识途录制器：步骤纠错、录制上下文与真实浏览器验收](2026-09-13-extension-step-correction.md) | 已落地（2026-09-13）：删除误录步（按原始行排除 + 撤销）、被录页面上下文、步骤悬停高亮、真实 Chrome 验收固化为 `pnpm probe:panel`；重排与改值留给控制台顺序编辑 | [侧栏样本](../front_design/2026-09-13-extension-workbench/index.html) |
| [识途录制器：工作台收敛与设计语言对齐](2026-09-13-extension-workbench-ui.md) | 已落地（2026-09-13）：登录门禁、代码内环境名单（登录页下拉选名称，本期仅本地）、去掉代码语言与 Playwright 代码窗、步骤列表对齐平台视觉、面板内接管（换侧栏路径重连 + 超时）、步骤定位摘要与展开原始字段；采集与上传契约不改 | [侧栏样本](../front_design/2026-09-13-extension-workbench/index.html) |
| [执行内核：账本与无浏览器引擎](2026-09-10-execution-kernel.md) | 已落地（2026-09-10）：Scenario / Version / Run 账本 + Echo·Delay·Fail Engine；含参数化 `from` 三层校验、副作用未知一律 `NEEDS_REVIEW`；不含浏览器、会话、编辑器、SSE | — |
| [对象存储内核](2026-09-10-object-store.md) | 已落地（2026-09-10）：put / get / delete、本地与一份 S3 适配、保留期与清理；证据索引只挂指针；不含截图、Trace、浏览器、授权下载 | — |
| [BrowserSession / SessionLease](2026-09-10-browser-session-manager.md) | 已落地（2026-09-11）：Session 键与部分唯一索引、生命周期 / 健康 / 认证三列分离、租约四操作与丢租即停、WAITING_FOR_AUTH / 认证超时、SecretProvider 自动登录、回收与重启自愈、卡死会话人工处置出口；不含 Affinity 排队、页面定位、截图 Trace、SSE | — |
| [RunLease / Fencing / 恢复](2026-09-11-run-lease.md) | 已落地（2026-09-11）：Worker 注册与心跳、RunLease 四操作、Run 行锁 + fencing 写入、过期 / 漂移同事务恢复与孤儿 Attempt、恢复次数上限、NEEDS_REVIEW / 确认目标系统登录、无租约状态直接取消、回填会话 `run_fencing_token`、场景与运行最小观察面（手动刷新）；不含 Affinity、SSE、会话菜单、Sequence Editor | — |
| [P4 后半：Affinity / 容量等待 / 失联隔离](2026-09-11-session-affinity.md) | 已落地（2026-09-11，2026-09-12 回交接上 `yieldPlacement`）：领取时 Affinity、容量不足回交（会话位满先腾位、回交带退避）、回交与失败的码分流、`LOST` 不自动放键、`PROFILE_LOCKED` 视为旧浏览器可能仍在、GET `placement`；S02 受控夹具限制采用，无真实企业系统承诺。不含页面定位、新 Step Type、SSE、会话菜单 | — |
| [Browser Surface 与浏览器步骤](2026-09-11-browser-surface.md) | 已落地（2026-09-12）：Engine 按需 acquire / release、五个 Web Step、Resolver 四种结果、失败截一张；L2 受控站点；Engine×真浏览器垂直切片进 CI 硬门槛；L3 只读打 [SNC DPM](../targets/snc-dpm.md)（`CAIRN_L3_DPM=1`），未宣称任意企业系统已兼容。不含 AI Step、Trace、SSE、Sequence Editor | [`tests/target-surface-lab/`](../tests/target-surface-lab/README.md) |
| [Evidence / Trace / 授权下载](2026-09-12-evidence-trace.md) | 已落地（2026-09-12，同日复查整改）：P6 其余部分。两根轴、债务先登记后上传、同一调用内有界补传、对象已在只 commit 证据（进程内与 cleanup 同一条路）、核查与 cleanup 闭环迁出证据轴、授权下载与 Viewer、Trace 分 chunk、写入前脱敏、S04。不含 SSE（P7）、AI 证据（P8 / P9）、Target 遮罩选择器（债务 9） | [`tests/target-surface-lab/`](../tests/target-surface-lab/README.md) |
