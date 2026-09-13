# 平台动态配置与参数中心：现状评估及范围建议

日期：2026-09-13。状态：**已实施**。

依据当前工作区源码，包含尚未提交的实现。范围覆盖平台自有 API、Worker、shared、DB、Web、Extension、环境模板与相关方案；未读取或导出实际环境文件中的凭据，未连接外部模型/Target。本文中的「已有」指存在代码消费链路，不代表相关模块的全部验收已经通过。

遵循[识途宪法](../../CLAUDE.md)、[两类 AI 配置边界](2026-09-13-ai-model-configuration-boundaries.md)、[角色与能力地图](2026-09-13-console-product-roles-and-capability-map.md)。交付顺序仍只维护在[工程实施计划](../plan/识途开发路线与工程实施计划.md#5-当前交付顺序与验收样例)，本文不另建排期。

## 1. 判断与首期建议

**现在有必要建设轻量的平台配置能力。** AI 步骤、手工 Run、草稿试跑、外部服务执行、会话复用和证据清理已有真实消费方。部分参数需要管理员跨场景调整，继续依靠环境文件与代码常量，会越来越难回答「什么时候生效、哪个进程采用、旧 Run 为什么用另一组值」。

建议在「治理」增加 **平台配置**，现有「设置」明确为个人设置。首期只纳入四组：**浏览器 AI、执行默认值、会话默认策略、证据策略**，共用配置版本、权限、变更记录和恢复旧配置能力。复用现有数据库、Zod、SecretProvider、RunSnapshot，不增加独立配置服务或任意 key/value 编辑器。

平台配置管理跨业务对象的默认策略。Target、TargetAccount、Scenario、开放服务、个人设置继续拥有自己的配置，不能全部搬成全局参数。平台通用 AI 保留独立配置域，随首个真实功能接入，当前不做设置后没有消费方的空表单。

## 2. 配置归属的判断规则

| 类别 | 判断依据 | 归属 |
| --- | --- | --- |
| 部署与引导 | 不配就无法连库、鉴权、解密或启动；与机器/拓扑相关 | 环境变量、部署文件、部署 Secret |
| 平台业务策略 | 管理员确实需要跨场景调整，且有可验证的消费行为 | 数据库中的平台配置 |
| 业务对象配置 | 属于某个 Target、账号、场景、服务或计划 | 对应业务对象及其版本/权限 |
| 个人/设备偏好 | 只影响当前用户或本地录制器 | 个人设置、扩展设置 |
| 实现常量与安全边界 | 协议、算法、能力上限、状态机、产品不变量 | 代码、Schema、数据库约束 |
| 尚无消费方 | 目前只能设想用途 | 先记录需求，与功能一起定义 |

还要区分三种语义：**默认值**允许指定范围内的覆盖；**硬上限**不可被业务配置突破；**功能开关**必须有服务端闸门。不能全部套用「最后一个值覆盖前面」的规则。

## 3. 当前已有的基础

根 [`.env.example`](../../.env.example) 有 66 个 `CAIRN_` 变量声明，包含部署、策略、AI、探针及预留项；不是 66 项都应进入界面。[`shared/env.ts`](../../packages/shared/src/env.ts) 已有统一启动校验，[API](../../packages/api/src/config/env.ts) / [Worker](../../packages/worker/src/config/env.ts) 缓存解析结果，修改文件不会刷新已启动进程。

| 现有能力 | 真实实现 | 判断 |
| --- | --- | --- |
| 个人资料、修改密码 | [`features/settings`](../../packages/web/src/features/settings/index.tsx) 调用 `/me`；外观页说明固定浅色主题 | 个人设置，不能算平台配置中心 |
| Target / TargetAccount | [`target.ts`](../../packages/shared/src/target.ts)：入口、登录地址、认证、验证码、登录定位、状态、账号和凭据 | 已持久化，保留所属业务页面 |
| 场景与步骤 | [`step.ts`](../../packages/shared/src/step.ts)、[`scenario.ts`](../../packages/shared/src/scenario.ts)：输入输出、步骤策略、草稿和发布版本 | 已有业务配置，不迁成系统参数 |
| 单次 Run 策略 | [`run-api.ts`](../../packages/shared/src/run-api.ts)：执行、会话、证据覆盖 | 平台默认值的主要消费入口 |
| 用户、角色、审计 | [`rbac.ts`](../../packages/shared/src/rbac.ts) 及 API / DB 模块 | 配置中心复用已有授权审计 |
| 开放服务 | [`service-access.ts`](../../packages/shared/src/service-access.ts)：限速、未结束 Run 上限、总期限、Key 授权与到期 | 已能按对象配置；模块已知缺陷以[原方案复查](2026-09-13-controlled-execution-api-and-service-credentials.md)为准 |
| 浏览器 AI | [`config/browser-ai.ts`](../../packages/api/src/config/browser-ai.ts) 生成配置，Run 冻结，Worker 消费 | 有真实运行链路，配置仍来自 env |
| 平台配置后端 | 当前 [`AppModule`](../../packages/api/src/app.module.ts) / [`DB Schema`](../../packages/db/src/schema/index.ts) 未见配置模块、修订或 CRUD | 需要最小增量建设 |

### 3.1 迁移不能忽略的实际问题

下列为源码结论及影响，未通过修改运行环境作在线验证。

| 发现 | 依据及影响 | 迁移要求 |
| --- | --- | --- |
| 会话 env 默认值没有完全接通 | `CAIRN_SESSION_IDLE_TTL_SECONDS` / `MAX_LIFETIME_SECONDS` 只见 Schema 定义/校验，未传入 [`BrowserModule`](../../packages/worker/src/browser/browser.module.ts)；[`createRunWithSnapshot`](../../packages/db/src/runs/runs.ts) 用共享默认值 | 以真实生效值初始化，不能意外激活以前未消费的 env 值 |
| 首次授予 SessionLease 与续租的 TTL 来源不同 | [`session-manager.ts`](../../packages/worker/src/browser/session-manager.ts) 首次使用 Run policy，`renew()` 默认用 Worker options | TTL 首期不热改；会话组上线前统一一次租约的解释，验证心跳约束 |
| 执行默认值未完全冻结 | [`policy.ts`](../../packages/shared/src/policy.ts) 默认 30 秒、重试 0；Run 的 policy 可以缺省，Engine 执行时补值 | 新 Run 冻结解析后的默认值；旧快照缺字段不得读取新平台配置 |
| Web 显式覆盖证据默认值 | [`RunCreateDialog`](../../packages/web/src/features/runs/create-dialog.tsx) 固定失败截图/关闭 Trace，每次提交两字段 | 增加继承语义，用户未主动修改就不提交覆盖；只改后端不会实际改变普通用户行为 |
| 对象默认保留期不是截图/Trace 的唯一来源 | [`evidence-policy.ts`](../../packages/shared/src/evidence-policy.ts) 生成策略；执行器传 retainUntil，优先于 [`ObjectService`](../../packages/worker/src/objects/object.service.ts) 默认值 | 不能把 `CAIRN_OBJECT_RETAIN_DAYS` 当成所有证据的保留期 |
| AI 配置版本是固定字符串 | [`ai-runtime.ts`](../../packages/shared/src/ai-runtime.ts) 中 `configVersion='1'`，实际配置已进快照摘要 | 配置修订独立于 SDK / Prompt / Policy 版本，每次变更产生新修订 |
| API 与 Worker 各读 AI env | API 管能力/准入/冻结；Worker 启动检查模型族，开发 Key 可从自己的 env 读取 | 动态化要一起调整 Worker 校验和凭据入口，不能只做 API 表单 |
| 创建 Run 有多个入口 | [`RunsService`](../../packages/api/src/runs/runs.service.ts)、[`ScenariosService`](../../packages/api/src/scenarios/scenarios.service.ts)、[`ServicesService`](../../packages/api/src/services/services.service.ts) 汇入统一创建链路 | 手工、试跑、服务调用共同消费同一解析结果 |
| 幂等摘要含解析后的默认值 | 控制台 Run 创建把 session/evidence 默认值纳入 [`idempotencyDigestPayload`](../../packages/shared/src/digest-payload.ts)；开放服务已有原请求摘要/提前去重 | 默认值变化后原请求重发仍返回原 Run，不能误报冲突或重建 |
| 现有设置读权限太宽 | `settings:read` 默认给多个业务角色，`settings:write` 尚无平台配置 API | 不能直接沿用此读权限暴露模型地址、凭据引用及部署信息 |
| Target 部分认证配置仍读当前行 | [`loadTargetAuth()`](../../packages/worker/src/browser/session-manager.ts) 读取入口、定位、认证方式和验证码；Snapshot 已冻结 origin/login scope，但未涵盖全部认证解释 | 配置继续归 Target；补齐影响执行解释的认证信息冻结，防止编辑 Target 改变旧 Run 认证路径 |
| AI 环境模板注释落后 | `.env.example` 仍写正式读取方待实现，但 API / Worker 已消费 | 迁移时同步更新模板与部署说明 |

## 4. 环境文件配置清单与去向

以下变量均保留 `CAIRN_` 前缀；为避免歧义，表中列出完整变量名。只记录键和公开默认值，不记录实际凭据。

| 配置项 | 建议处理 |
| --- | --- |
| `CAIRN_DB_DRIVER`、`CAIRN_DB_FILE`、`CAIRN_DB_HOST`、`CAIRN_DB_PORT`、`CAIRN_DB_NAME`、`CAIRN_DB_USER`、`CAIRN_DB_PASSWORD`、`CAIRN_DB_SCHEMA` | **留部署配置**。数据库无法负责提供连接自身所需的唯一配置 |
| `CAIRN_ENV` | **留部署配置**，不允许在界面切换安全强度 |
| `CAIRN_API_PORT`、`CAIRN_CORS_ORIGINS`、`CAIRN_TRUST_PROXY_HOPS` | **留部署配置**，与网络入口、反代信任相关 |
| `CAIRN_JWT_SECRET`、`CAIRN_CREDENTIAL_KEY` | **留部署 Secret**。签名/加密根密钥轮换走专门运维流程 |
| `CAIRN_BOOTSTRAP_ADMIN_EMAIL`、`CAIRN_BOOTSTRAP_ADMIN_PASSWORD`、`CAIRN_BOOTSTRAP_ADMIN_NAME` | **留引导配置**。已有管理员由用户管理修改，改 env 不等于改现有账号 |
| `CAIRN_JWT_EXPIRES_IN` | 默认 12 小时，**首期留 env**；安全策略产品化时按新 Token 签发动态读取，旧 Token 不自动改期 |
| `CAIRN_LOG_LEVEL` | **首期留 env**；真实排障需要后再做带到期恢复的动态调级 |
| `CAIRN_WORKER_ID`、`CAIRN_WORKER_CAPACITY` | **留部署配置**。身份与单机容量不同于全平台额度；默认执行槽 1 |
| `CAIRN_WORKER_HEARTBEAT_MS`、`CAIRN_RUN_LEASE_TTL_SECONDS`、`CAIRN_WORKER_LOST_AFTER_SECONDS` | **留基础设施配置**，保持联动校验，首期不热改 |
| `CAIRN_RUN_MAX_RECOVERIES` | 默认 3，**首期留 env**；未来产品化前明确按 Run 冻结还是治理硬限制，并调整全部恢复读取方 |
| `CAIRN_BROWSER_HEADLESS`、`CAIRN_BROWSER_PROFILE_DIR`、`CAIRN_BROWSER_EXECUTABLE_PATH`、`CAIRN_BROWSER_MAX_SESSIONS` | **留部署配置**。浏览器环境及单 Worker 容量，默认会话上限 2 |
| `CAIRN_SESSION_IDLE_TTL_SECONDS`、`CAIRN_SESSION_MAX_LIFETIME_SECONDS`、`CAIRN_SESSION_AUTH_WAIT_SECONDS` | **迁入会话默认策略**，当前共享默认分别为 600 / 14,400 / 300 秒；先修正消费来源 |
| `CAIRN_SESSION_LEASE_TTL_SECONDS`、`CAIRN_SESSION_HEARTBEAT_MS`、`CAIRN_SESSION_REAPER_INTERVAL_MS` | **留基础设施配置**。租约、心跳、扫描节奏与业务空闲 TTL 分开 |
| `CAIRN_OBJECT_STORE`、`CAIRN_OBJECT_STORE_DIR` | **留部署配置**。切驱动/目录要考虑旧对象访问及迁移 |
| `CAIRN_S3_ENDPOINT`、`CAIRN_S3_REGION`、`CAIRN_S3_BUCKET`、`CAIRN_S3_ACCESS_KEY`、`CAIRN_S3_SECRET_KEY`、`CAIRN_S3_FORCE_PATH_STYLE` | **留部署配置/Secret**，不做存储即时切换 |
| `CAIRN_OBJECT_MAX_BYTES`、`CAIRN_TRACE_MAX_BYTES` | 默认 32 / 128 MiB，**首期留部署硬上限**。以后可设更低业务额度，不能超越适配器能力 |
| `CAIRN_OBJECT_RETAIN_DAYS` | **不直接迁作证据保留期**。首期保留一般对象的兜底；截图/Trace 在证据组明确设置 |
| `CAIRN_OBJECT_PENDING_TTL_SECONDS`、`CAIRN_OBJECT_CLEANUP_INTERVAL_MS`、`CAIRN_EVIDENCE_UPLOAD_MAX_ATTEMPTS` | **首期留基础设施配置**。Pending TTL 缩短会影响已有待上传对象，不能当普通期限热改 |
| `CAIRN_BROWSER_AI_ENABLED` | **迁入浏览器 AI**，控制新发布/试跑/Run 创建；关闭不隐式取消既有 Run |
| `CAIRN_BROWSER_AI_BASE_URL`、`CAIRN_BROWSER_AI_MODEL`、`CAIRN_BROWSER_AI_MODEL_FAMILY` | **迁入浏览器 AI**，新 Run 冻结地址、模型及适配信息 |
| `CAIRN_BROWSER_AI_API_KEY_SECRET_ID` | **迁入浏览器 AI**，只保存 Secret 引用 |
| `CAIRN_BROWSER_AI_API_KEY` | **转为 Secret 登记输入**，不成为明文动态参数。复用已有 [`register-browser-ai-secret`](../../packages/worker/src/bin/register-browser-ai-secret.ts) 能力 |
| `CAIRN_BROWSER_AI_REQUEST_TIMEOUT_MS`、`CAIRN_BROWSER_AI_STEP_MAX_CALLS`、`CAIRN_BROWSER_AI_MAX_OUTPUT_TOKENS` | **迁入浏览器 AI**，默认 15 秒 / 每 StepRun 20 次 / 每响应 2048 tokens，冻结并执行预算约束 |
| `CAIRN_BROWSER_AI_HANG_WAIT_MS` | 默认 5 秒，**首期留高级运行配置并继续冻结**；这是取消落定窗口，不是效果调参 |
| `CAIRN_API_ORIGIN` | **留开发配置**，仅 Vite 代理，不是业务 Target 地址 |
| `CAIRN_SCRIPT_ROOT` | **不迁移**，当前正式 Step 无脚本执行消费链路 |
| `CAIRN_S06_ONLINE`、`CAIRN_S06_MODEL_NAME`、`CAIRN_S06_MODEL_FAMILY`、`CAIRN_S06_MODEL_API_KEY`、`CAIRN_S06_MODEL_BASE_URL` | **留探针/测试配置**，不得作为正式 AI 参数 |
| `DATABASE_URL` | 第三方原名预留，平台 DB 使用 `CAIRN_DB_*`，**不纳入动态配置** |

[`deploy/.env.example`](../../deploy/.env.example) 额外的 `CAIRN_S3_API_PORT` / `CAIRN_S3_CONSOLE_PORT` 留部署侧。`.env.local` / `.env.remote` 是开发连接画像，不应成为控制台即时切换运行数据库的功能。

## 5. 代码中及平台自身的配置功能

### 5.1 已存在的默认值、业务配置和实现边界

| 项目 | 当前情况 | 建议 |
| --- | --- | --- |
| 默认 Step 超时 | `DEFAULT_STEP_TIMEOUT_MS=30_000` | 首期动态化，保留当前初始值，供未显式设置的步骤使用 |
| 默认自动重试 | `DEFAULT_RETRY_LIMIT=0`；Step 可设 0–10，AI Action 禁止自动重试 | 全局默认保持 0，不新增「统一开启重试」开关；保留已有 Step 编辑能力 |
| 页面复用默认 | `NEW_PAGE`，健康 Session 内换页 | 首期会话组提供 NEW_PAGE / REUSE_PAGE；RECREATE 留明确的单 Run 操作，不默认每次重建登录 |
| 截图/Trace 采集 | 默认失败截图、关闭 Trace；支持 off/on_failure/always | 首期证据组，保留单 Run 覆盖 |
| 截图/Trace 保留 | 截图 30 天、Trace 14 天；always Trace 未指定时 7 天 | 首期证据组明确一般/调试 Trace 期限，always 不等于永久存储 |
| 必要 Evidence | 默认 required 包含 input；其他执行事实另由引擎约束 | 不开放任意删掉必要证据的设置，完整性底线仍由代码卡住 |
| 用户默认角色 | `DEFAULT_ACCOUNT_ROLE_KEY='author'` | 保持已确定的产品角色；逐账号显式指定，没有邀请/自注册需求前不新增默认角色参数 |
| 密码长度 | [`passwordSchema`](../../packages/shared/src/rbac.ts) 8–128 位，Web 有校验提示 | 后续安全策略候选；动态化必须一起覆盖创建、重置、修改、API 与前端 |
| 开放服务额度 | 默认每分钟 60 次、未结束 Run 2 个、期限 600 秒、Key 90 天 | 已按服务/凭据管理，平台页提供现有入口；有统一治理需求再加全局上限 |
| Target 认证与定位 | 已持久化，通用定位启发式在 [`login-fields.ts`](../../packages/shared/src/login-fields.ts) | 具体值归 Target，启发式归实现；Target Schema 当前尚无会话/证据策略覆盖，不能假装已支持 |
| AI instruction / outputSchema | 随 Scenario Step 版本化 | 留 Scenario，不允许平台参数改变历史业务意图 |
| Executor / SDK / Prompt / Policy 版本 | 代码声明并进入快照 | 随发布产生，不能让管理员手填版本号伪造能力 |
| 场景/输入/录制规模 | Scenario 32 步、Run input 64 个根键、录制 200 事件/256,000 字节 | 当前验证与防护边界，留 Schema；不因写在代码里就开放任意调大 |
| 定位能力与超时 | Frame 深度 4、候选 5、定位等待 8 秒 | 留 Browser Surface；按真实 Target 需求扩展。只调 Step 超时未必延长底层定位 |
| 开放 API 输入保护 | 请求体 64 KiB、嵌套 8 层等 | 留服务端与 Schema，不提供普通参数编辑 |
| Worker 内部节奏 | 领取 1 秒、取消检查 250 ms、placement 退避 10 秒、清理批量及补传退避 | 留实现/高级部署配置，不作为用户参数；也不等于 Web 的 Run 实时机制 |
| 录制器连接环境 | [`cairn/config.ts`](../../packages/extension/playwright-crx/src/cairn/config.ts) 当前代码内名单，仅本地 | 客户端连接引导，不能在尚未连接前依赖平台下发唯一地址 |
| 录制器偏好 | [`settings.ts`](../../packages/extension/playwright-crx/src/settings.ts) 的 testId 属性、侧栏、隐身，存 Chrome storage | 保留设备/Authoring 范围；统一 testId 时先对齐 Target 定位契约 |
| 字体、颜色、菜单与角色能力图 | Design Token、代码声明，主题当前固定浅色 | 留设计系统和权限模型，不建菜单表、任意 CSS 或状态颜色参数 |

### 5.2 需要梳理，但不宜先建空配置的能力

| 候选域 | 尚需定义的内容 | 时机与归属 |
| --- | --- | --- |
| 平台通用 AI | 独立启用、模型服务、Secret、超时/预算，首个生成/分析功能的输入输出及调用记录 | 随首个功能加入平台配置；按既定需求验证 DeepSeek / 千问，不回退浏览器 AI |
| 控制台安全策略 | 登录失败限速/锁定窗口、有效期、密码策略；更高要求下的 MFA/企业身份 | 对外部署前评估真实需求；要有执行和解锁机制，不能只建数字字段 |
| 平台执行准入/维护 | 暂停新 Run、队列等待上限、控制台 Run 总期限 | 试点确需暂停/控量时建设；不能阻断查询、取消、认证处理和 Worker 续租 |
| Worker 运维控制 | 暂停领取、排空、恢复接单与容量观察 | 复用现有 Worker 生命周期；排空是有状态的运维操作，不是修改一个全局容量参数，不能撤销在途所有权 |
| 跨 Run AI 额度 | 按平台/用途的预算周期、并发与告警阈值 | 当前每 StepRun 预算不等于全局成本中心；需要原子计量/预扣，未知价格不伪造金额 |
| 数据生命周期 | 登录/操作审计、Run/Attempt 元数据的保留、归档与关联完整性 | 数据增长或交付要求出现时建设；不能套用对象存储 TTL |
| 证据隐私 | Target 截图遮罩、输出脱敏、外部证据可见性 | 遮罩归 Target；平台底线不可关闭；已有服务证据人工发布留开放服务 |
| 通知与告警 | 失败、核查、认证、证据缺口、预算事件；接收人、去重、静默、失败重试 | 巡检有真实收件人时建设；通道归平台，订阅归用户/Target/计划，Secret 单独保存 |
| 巡检与调度 | 时区、频率、错过/重叠策略、固定发布版本和目标账号 | 按工程计划 D4 需要建设 Schedule 对象；平台提供默认，时间事实仍用 UTC |
| 平台基本信息 | 实例名称、环境标识、帮助入口、必要的显示时区 | 多实例容易混淆时增加；Logo/主题定制不作为本次前置 |
| Live View / 人工操作 | 观看/控制权限、空闲断开、认证窗口、控制权移交 | 随真实协议定义，设置开关不能替代所有权控制 |
| 导入与编写辅助 | 导入映射、模板、术语、Business Action、AI 建议策略 | 归版本化业务资产/Authoring 功能，正文不塞进系统参数 |
| 可复用业务参数集 | 查询条件、测试数据、环境差异参数及敏感值引用 | 现有 Scenario 输入契约与 Run input 已承担基本能力；出现跨场景复用需求时按 Target/Scenario 定义参数集，解析结果进入 Run Context/Snapshot，不能依赖隐形全局变量 |
| 诊断配置 | 限时日志级别、采样、资源预警 | 出现明确排障需求再动态化，不为参数中心另造监控平台 |

## 6. 首期界面与权限

「治理 → 平台配置」包含浏览器 AI、执行默认值、会话默认策略、证据策略及变更记录。普通「个人设置」继续管理资料、密码和已支持的偏好。

用户完成「查看当前策略 → 修改 → 校验 → 保存并生效」。每项显示作用范围、继承/覆盖关系、当前修订及生效时刻；配置变更记录显示操作者、原因、时间和非明文差异。恢复旧配置会创建新修订。

首期不做草稿发布流、灰度人群、多级 namespace、配置表达式或自定义参数类型。当前分组的「保存并生效」是唯一突出主操作，连接测试/校验为次要操作；保存失败保留输入，分别处理无权限、非法值、凭据不可用、读取失败和并发编辑冲突。

复用现有 Main、PageHeader、表单、Tabs、审计表格和 Design Token；实施按[前端工作流](../design/front/ai-workflow.md)及[验收规范](../../.agents/skills/shitu-frontend-acceptance/SKILL.md)检查导航、表单、权限与响应式。实施阶段制作「治理 → 平台配置」页，并修正 Run 创建 / 试跑的继承提交。

建议新增 `platform-config:read` / `platform-config:write`，默认仅管理员持有，可显式授予自定义角色。现有 `settings:*` 暂不改义。同步菜单、路由、API Guard、能力地图及三库系统角色对账。服务 Key 无平台管理权限。

业务用户通过现有能力接口和精简默认策略响应获得所需值，这些配置响应不返回整份平台配置、部署信息或凭据引用。Run 详情当前会返回包含 AI 配置的 Snapshot，属于另一个读取入口；实施时核对其按 run:read 提供的历史解释字段，不能误称新增配置权限已收紧全部旧接口。用户/角色/审计/服务继续使用原入口。运行资源只读摘要可复用已登记数据，但必须标明来源/更新时间，不能把 API 本机 env 当成所有 Worker 的实际配置。

## 7. 覆盖与动态生效语义

### 7.1 首期只增加一个平台作用域

共享同一运行数据库的逻辑平台对应一份配置，多个 API / Worker 实例共享它；不引入 Workspace、项目或多租户层。已有业务对象维持自己的范围。

| 配置域 | 解析顺序与限制 |
| --- | --- |
| Step 执行 | Step 显式值 → 本次 Run 显式值 → 平台默认 → 固定出厂默认。现有 Schema 没有 Scenario 根级执行策略，不虚构这一层 |
| 会话/证据 | 本次 Run 允许的显式字段 → 平台默认 → 固定出厂默认。后续 Target 覆盖须新增明确契约；必要证据独立约束 |
| AI | 服务端从对应配置域解析并冻结；普通 Run 请求不允许任意模型地址、Key 或预算提权 |
| 开放服务限制 | 继续按 ServiceCaller / Credential 当前准入检查并冻结必要事实，不扩大服务身份权限 |

只在未提供时继承；`false`、`0`、`off` 是有效值。嵌套字段逐字段合并，单位固定，突破硬上限返回错误而不静默截断。平台默认不能改变副作用类别、只读语义或 AI Action 的重试禁令。

AI 请求超时必须与每个 AI Step **解析后的**步骤超时校验，不能继续只比较代码里固定的 30 秒。

### 7.2 明确什么会受改动影响

| 修改 | 生效边界 | 既有对象 |
| --- | --- | --- |
| 执行/证据/模型默认 | 创建新 Run 时读完整修订并冻结 | 包括 QUEUED：已经创建的 Run、重试及恢复使用旧快照 |
| 浏览器 AI 启用 | 新能力查询、发布、运行创建 | 草稿保留，已有 Run 保留配置；紧急停止走显式取消/处置 |
| 会话空闲/最大寿命 | 新 Run 冻结；由其新建 Session 时写生命周期 | 复用 Session 服从其已持久化到期规则，不能用新默认无限续命 |
| 人工认证等待 | 新 Run 进入等待时按自己的快照计算到期点 | 不重置已有等待窗口 |
| 证据保留期 | 新 Run 冻结；创建对象时持久化 retainUntil | 旧对象 retainUntil 不变；追溯修改是独立且有审计的操作 |
| 恢复旧配置 | 旧值创建一个新修订 | 不回写旧 Run、旧对象或审计；不保证被撤销的外部密钥复活 |
| 部署配置 | 部署/重启或专用运维过程 | 页面不能宣称即时生效 |

动态配置首先意味着无需重启即可影响后续业务，不意味着所有在途对象都热切换。

## 8. 最小技术实现建议

### 8.1 结构与原子保存

- `shared`：封闭分组的 Zod Schema、DTO、解析结果与配置 Schema 版本，不是任意字符串参数袋。
- `db`：当前配置记录 + 不可变修订记录，保存完整非明文配置、修订、操作者、原因、时间；使用现有原子提交和条件更新，覆盖 PG / MySQL / SQLite。
- `api`：读取、校验、保存、历史、恢复、受控凭据登记；通过仓储访问，不接触物理表/SQL。
- `worker`：继续消费 RunSnapshot，不通过 API 写运行事实，也不每 Step 重读全局默认。
- `web`：分组表单和变更记录，同时修正 Run 创建的默认继承行为。

保存携带 `expectedRevision`；当前配置更新、修订追加、操作审计同事务，冲突返回 409。恢复重新校验 Schema、权限、凭据引用并产生新修订。现有审计主要是摘要，不能用摘要文本充当配置历史；完整非明文值由配置修订保存，审计关联修订资源，不新建第二套通用审计框架。

接口遵循 GET / POST，可采用 `GET /api/platform-config`、`POST /api/platform-config/validate`、`POST /api/platform-config/update`、`GET /api/platform-config/revisions`、`POST /api/platform-config/restore`。凭据更换/连接测试单独使用受控 POST。路径是实施建议，不属于宪法。

### 8.2 读取、冻结与故障

首期在业务边界直接读数据库：能力/发布查询和 Run 创建按需读取，不需要配置订阅总线。一次创建只解析一个完整修订；保存与创建并发时允许旧或新完整修订，禁止混用不同版本的地址/模型/凭据。保存成功后发起的新请求读取新修订。

手工、试跑、外部服务在共同创建边界应用默认值和冻结规则，快照存实际有效值及配置修订，摘要覆盖解释字段。不能让三个 Controller 各写一套优先级，也不能只冻结修订 ID 而让历史 Run 依赖当前配置表。

数据库不可用时拒绝需要读取配置的新操作，不静默回退 env。已有完整快照不因设置页面或配置读取故障改用另一组参数；执行事实数据库自身不可用时仍按既有租约/故障规则处理。

配置生效不依赖 SSE / NOTIFY。未来出现实际读负载再增加按修订缓存；通知只作失效提示，丢失仍可恢复。这不改变 Web Run 实时进度采用 SSE 的产品要求。

### 8.3 幂等与历史

同一主体、幂等键和规范化原始请求应返回第一次的 Run，不能用最新默认值重新算出冲突。复用开放服务原请求摘要/提前去重思路，权限仍须检查。原始请求不同仍然冲突。

旧摘要按旧规则和原 Snapshot 兼容判断，不直接替换所有摘要算法或批量重算历史 digest。旧快照缺字段时使用对应历史契约的固定默认值，不读取最新平台配置。验收覆盖排队、恢复和已完成记录。

### 8.4 模型凭据与适配

密钥以受控 POST 只写输入交给 SecretProvider，配置只存引用；响应、快照、日志、异常、导出和审计不得回显明文。更换密钥创建新引用，旧 Run 保留原引用；紧急撤销独立记录，不承诺已撤销的密钥仍可执行。

模型地址与凭据绑定必须受配置写权限控制：校验协议、禁止 URL 内嵌凭据，变更服务地址时重新校验对应凭据绑定，避免误发旧供应商密钥。测试连接不携带 Target 页面或业务输入；连接成功只证明当时可访问，真实视觉/动作能力仍由 Worker 受控样例验证，API 不创建正式浏览器。

保存验证结构及可知能力，Worker 使用冻结配置前验证适配能力，不能仅靠进程启动时的旧 env 检查。首期按兼容版本的 API / Worker 部署，不增设多版本协商平台。平台通用 AI 独立配置、独立消费，不依赖 Midscene 或 Browser Session。

## 9. 迁移与实施前置

按域迁移，每一域同时完成消费方、初始化、快照、前端继承、权限审计及兼容检查。四组复用同一基础，不拆成四套配置系统，也不先上线无人消费的表单。

初始修订以**当前真实生效行为**为准；从指定部署配置导入时显示来源及差异，旧 env 中未被消费的会话值不得自动激活。开发明文模型 Key 经 SecretProvider 转成引用。初始化只发生一次，重启不能重新导入覆盖。

迁入平台后，数据库成为该域唯一业务配置源；旧 env 项标记废弃/忽略，不保留隐藏的 env 优先级。同步修改启动校验，不再要求已迁移的模型设置必须存在于 env。数据库连接、根密钥、资源/租约基础配置继续启动硬校验。

必要前置：执行默认值冻结、Run 幂等兼容、Web 继承、SessionLease TTL 一致性、影响执行解释的 Target 认证信息冻结。它们是正确迁移的条件，不靠多建几个配置页面解决。

当前不扩充全局自动重试、Target 全策略继承、跨 Run 成本预算、通知、调度、安全策略、品牌定制或自定义参数；候选已列于 §5.2，随真实功能决定。`CAIRN_RUN_MAX_RECOVERIES` 等暂留 env 的策略，不宣称已由新平台配置统一冻结。

审查修订见第 11 节。实施按修订后的契约进行，并在唯一工程计划登记范围；不新增 D 阶段，不改变 D0–D4 顺序。

## 10. 实施验收

| 用例 | 通过条件 |
| --- | --- |
| 动态默认值 | 不重启，手工/试跑/服务的新 Run 都使用新修订，Web 未主动覆盖时确实继承 |
| 历史不漂移 | 已创建的 QUEUED / RUNNING / RECOVERING Run 的快照、摘要、模型与策略保持原值 |
| 跨变更重发 | 同请求返回原 Run，改默认不误冲突；不同请求仍冲突；旧摘要兼容 |
| 覆盖与边界 | Step 显式值优先，off/false/0 不丢失，AI Action 重试和必要 Evidence 不能被绕过 |
| AI 与凭据 | 配置域独立，换 Key 不静默替换旧引用，确定性执行不依赖 AI；不支持的能力明确报错 |
| 会话与认证 | 新 Session 用新寿命，旧 Session 保留到期规则，等待不重置，授租/续租 TTL 一致，Target 编辑不改旧认证定义 |
| 证据生命周期 | 新对象用新冻结策略，旧 retainUntil 不变；清理依据持久化期限，旧缺字段使用兼容默认 |
| 并发与故障 | 双 API 同 revision 只允许一个成功，不混用配置修订，读库失败不回落 env，重启不覆盖配置 |
| 授权审计 | settings:read 用户及服务 Key 无平台管理权限，授权角色可操作，修改审计同事务且所有路径无明文 Secret |
| 三库与前端 | 三库保存/冲突/恢复/冻结行为相同；权限、表单错误、继承说明、窄屏及相关自动检查通过 |

## 11. 审查修订（2026-09-13）

对照当前工作区源码审查后，原评估成立，但下列缺口若不写进契约，实施会复现已有缺陷或把未消费的 env 当成已生效。

| 修订 | 依据 | 实施约定 |
| --- | --- | --- |
| 开放服务创建路径把任意 Run 当成含 `ai_action` | `ServicesService.create` 固定调用 `resolveAiExecution([{ type: 'ai_action' }])`，AI 开启时确定性场景也会冻结模型配置 | 与手工 / 试跑共用同一创建边界，只按真实步骤决定是否冻结 AI |
| 试跑与控制台创建的证据继承不一致 | 创建对话框每次提交 `screenshot` / `trace`；试跑对话框不提交 | 两处都未主动修改就不提交覆盖；精简默认值走能力接口的 `defaults`，不含地址、凭据引用或部署信息 |
| 控制台幂等摘要含解析后的默认值 | `idempotencyDigestPayload` 写入 resolved session/evidence；默认值变化后同键重发会误报冲突 | 新摘要只哈希规范化原始请求；查找时同时兼容旧 resolved 摘要，并用快照字段判断覆盖是否仍等同，不批量重算历史 digest |
| SessionLease 授租与续租 TTL 来源不同 | 首次授予用快照 `leaseTtlSeconds`，心跳续租用 Worker env | 租约 TTL 仍属基础设施，不进平台会话组。同一次 Lease 的授予与续租使用授予时写入的 TTL；缺字段的旧快照才回落 Worker env |
| 会话空闲 / 最大寿命 env 从未进入快照 | API 冻结 `DEFAULT_SESSION_POLICY`，Worker 未把这两项注入 `BrowserModule` | 初始修订按当前真实生效的代码默认导入，不得把未消费的 `CAIRN_SESSION_IDLE_TTL_SECONDS` / `MAX_LIFETIME_SECONDS` 自动激活 |
| Worker 可用当前进程明文 Key 执行无 `secretRef` 的快照 | `resolveApiKey` 在缺少引用时回落 `CAIRN_BROWSER_AI_API_KEY` | 新快照必须带 Secret 引用；有引用时禁止用当前进程明文覆盖。仅兼容迁移前没有 `secretRef` 的旧快照 |
| 执行默认重试若写进快照会抬高 AI Action | `resolveStepPolicy` 在步骤未写 `retryLimit` 时继承快照值；AI Action 只禁止步骤显式重试 | 执行组首期只开放默认步骤超时；平台重试默认固定为 0 且不可改。引擎对 `ai_action` 强制 `retryLimit=0` |
| 必要证据与 Target 认证冻结 | 现网 `required` 不可删；`loadTargetAuth` 读当前 Target 行 | 平台证据组不开放删除必要 Evidence。新 Run 冻结 `entryUrl` / `loginUrl` / `authMethod` / `captchaMode` / `loginFields`；Worker 用冻结值解释认证，但仍须 Target 行存在才能建会话。旧快照缺字段仍走历史实时读取 |
| 迁移编号 | PG 已有 `0021_audit_login_shape_portable.sql` | PG `0022`，MySQL / SQLite `0006` |
| 启动校验 | 迁入后数据库是业务配置源 | API / Worker 启动不再要求 `CAIRN_BROWSER_AI_*` 齐套；非 development 仍禁止 env 直填明文 Key。初始化只发生一次，由 API 在首次读取时原子导入，Run 创建路径不得抢先写入出厂值以免丢掉已消费的 AI env |
| 权限与接口 | `settings:read` 过宽 | 新增 `platform-config:read` / `write`，默认仅管理员。完整配置走 `GET/POST /api/platform-config*`；业务侧只通过能力接口拿到精简 `defaults` |
| 首份修订差异 | 与不存在的上一版做整份对比会得到空 path | 没有上一版时差异为空；后续修订只列字段路径 |
| 试跑 / 能力查询回落写出厂值 | `ScenariosService` 在未注入配置服务时调用 `getOrCreatePlatformConfig` | 只有 `ensure()` 可以原子导入；Run / 试跑 / 能力查询的回落只读出厂值，不得抢先写入 |
| 控制台创建先解析 AI 再读配置 | `RunsService.create` 与试跑各自解析后再进 `createRunWithSnapshot` | 一次创建只在共同创建边界读一份完整修订；API 只做权限与 hangWait 注入 |
| 恢复与改地址未重验凭据 | 保存只看有没有 `secretRef` | 启用时校验引用仍在；更换模型服务 origin 必须重新登记密钥 |

前端任务：管理员查看当前四组策略、保存并生效、查看非明文差异并恢复旧修订。主操作是当前分组的「保存并生效」；连接测试与登记密钥为次要操作。布局复用治理页的 `Main` + `PageHeader` + Tabs，表单复用 settings / services 控件，变更记录复用审计表格。需要验证：有权限保存、无权限 403、校验失败保留输入、409 冲突、密钥不回显、窄屏 Tabs 与继承说明。

实施完成后更新本页状态、[方案目录](README.md)、CHANGELOG 与工程计划第 5 节增量说明。
