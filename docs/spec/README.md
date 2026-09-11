# 方案目录

| 方案 | 状态 | 原型 |
| --- | --- | --- |
| [平台工程地基收口](2026-09-10-platform-foundation.md) | 已落地（2026-09-10）：HTTP 信封与关联 ID 冻结、凭证脱敏、配置生产硬失败、依赖方向检查 | — |
| [最小执行契约](2026-09-10-runtime-contracts.md) | 已落地（2026-09-10）：Step / Echo·Delay·Fail / RunSnapshot / 执行错误 / Evidence 元数据 / 事件信封 | — |
| [目标系统（接入目录）](2026-09-10-target-catalog.md) | 已落地（2026-09-10）：Target / TargetAccount 目录、本地凭据引用；不含会话与登录绑定。联调夹具见 [`tests/target-login-hmi/`](../tests/target-login-hmi/README.md) | — |
| [目标系统补丁：首个账号与登录框定位](2026-09-10-target-login-fields.md) | 已落地（2026-09-10）：新建可带首个账号与可选定位；启发式清单进代码；不含探测与插件 | — |
| [识途 Recorder 扩展：图标、中文与忽略规则](2026-09-10-extension-playwright-crx-chrome.md) | 已落地（2026-09-10）：观测证据标、可见文案中文、包内 gitignore；不含上传与登录 | — |
| [执行内核：账本与无浏览器引擎](2026-09-10-execution-kernel.md) | 已落地（2026-09-10）：Scenario / Version / Run 账本 + Echo·Delay·Fail Engine；含参数化 `from` 三层校验、副作用未知一律 `NEEDS_REVIEW`；不含浏览器、会话、编辑器、SSE | — |
| [对象存储内核](2026-09-10-object-store.md) | 已落地（2026-09-10）：put / get / delete、本地与一份 S3 适配、保留期与清理；证据索引只挂指针；不含截图、Trace、浏览器、授权下载 | — |
| [BrowserSession / SessionLease](2026-09-10-browser-session-manager.md) | 已落地（2026-09-11）：Session 键与部分唯一索引、生命周期 / 健康 / 认证三列分离、租约四操作与丢租即停、WAITING_FOR_AUTH / 认证超时、SecretProvider 自动登录、回收与重启自愈；不含 Affinity 排队、页面定位、截图 Trace、SSE | — |
