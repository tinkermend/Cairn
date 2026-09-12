# 方案目录

| 方案 | 状态 | 原型 |
| --- | --- | --- |
| [平台工程地基收口](2026-09-10-platform-foundation.md) | 已落地（2026-09-10）：HTTP 信封与关联 ID 冻结、凭证脱敏、配置生产硬失败、依赖方向检查 | — |
| [最小执行契约](2026-09-10-runtime-contracts.md) | 已落地（2026-09-10）：Step / Echo·Delay·Fail / RunSnapshot / 执行错误 / Evidence 元数据 / 事件信封 | — |
| [目标系统（接入目录）](2026-09-10-target-catalog.md) | 已落地（2026-09-10）：Target / TargetAccount 目录、本地凭据引用；不含会话与登录绑定。联调夹具见 [`tests/target-login-hmi/`](../tests/target-login-hmi/README.md)；外部 L3 清单见 [`docs/targets/`](../targets/README.md) | — |
| [目标系统补丁：首个账号与登录框定位](2026-09-10-target-login-fields.md) | 已落地（2026-09-10）：新建可带首个账号与可选定位；启发式清单进代码；不含探测与插件 | — |
| [识途 Recorder 扩展：图标、中文与忽略规则](2026-09-10-extension-playwright-crx-chrome.md) | 已落地（2026-09-10）：观测证据标、可见文案中文、包内 gitignore；不含上传与登录 | — |
| [执行内核：账本与无浏览器引擎](2026-09-10-execution-kernel.md) | 已落地（2026-09-10）：Scenario / Version / Run 账本 + Echo·Delay·Fail Engine；含参数化 `from` 三层校验、副作用未知一律 `NEEDS_REVIEW`；不含浏览器、会话、编辑器、SSE | — |
| [对象存储内核](2026-09-10-object-store.md) | 已落地（2026-09-10）：put / get / delete、本地与一份 S3 适配、保留期与清理；证据索引只挂指针；不含截图、Trace、浏览器、授权下载 | — |
| [BrowserSession / SessionLease](2026-09-10-browser-session-manager.md) | 已落地（2026-09-11）：Session 键与部分唯一索引、生命周期 / 健康 / 认证三列分离、租约四操作与丢租即停、WAITING_FOR_AUTH / 认证超时、SecretProvider 自动登录、回收与重启自愈、卡死会话人工处置出口；不含 Affinity 排队、页面定位、截图 Trace、SSE | — |
| [RunLease / Fencing / 恢复](2026-09-11-run-lease.md) | 已落地（2026-09-11）：Worker 注册与心跳、RunLease 四操作、Run 行锁 + fencing 写入、过期 / 漂移同事务恢复与孤儿 Attempt、恢复次数上限、NEEDS_REVIEW / 确认目标系统登录、无租约状态直接取消、回填会话 `run_fencing_token`、场景与运行最小观察面（手动刷新）；不含 Affinity、SSE、会话菜单、Sequence Editor | — |
| [P4 后半：Affinity / 容量等待 / 失联隔离](2026-09-11-session-affinity.md) | 已落地（2026-09-11，2026-09-12 回交接上 `yieldPlacement`）：领取时 Affinity、容量不足回交（会话位满先腾位、回交带退避）、回交与失败的码分流、`LOST` 不自动放键、`PROFILE_LOCKED` 视为旧浏览器可能仍在、GET `placement`；不含页面定位、新 Step Type、SSE、会话菜单 | — |
| [S02 会话复用证据包](2026-09-11-s02-session-reuse.md) | 已记录（2026-09-11）：受控夹具限制采用 `NEW_PAGE` / `REUSE_PAGE` 与同账号复用；无真实企业系统，不得宣称已兼容 | — |
| [Browser Surface 与浏览器步骤](2026-09-11-browser-surface.md) | 已落地（2026-09-12）：Engine 按需 acquire / release、五个 Web Step、Resolver 四种结果、失败截一张；L2 受控站点；Engine×真浏览器垂直切片进 CI 硬门槛；L3 只读打 [SNC DPM](../targets/snc-dpm.md)（`CAIRN_L3_DPM=1`），未宣称任意企业系统已兼容。不含 AI Step、Trace、SSE、Sequence Editor | [`tests/target-surface-lab/`](../tests/target-surface-lab/README.md) |
| [Evidence / Trace / 授权下载](2026-09-12-evidence-trace.md) | 已落地（2026-09-12，同日复查整改）：P6 其余部分。两根轴、债务先登记后上传、同一调用内有界补传、对象已在只 commit 证据（进程内与 cleanup 同一条路）、核查与 cleanup 闭环迁出证据轴、授权下载与 Viewer、Trace 分 chunk、写入前脱敏、S04。不含 SSE（P7）、AI 证据（P8 / P9）、Target 遮罩选择器（债务 9） | [`tests/target-surface-lab/`](../tests/target-surface-lab/README.md) |
