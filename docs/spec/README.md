# 方案目录

| 方案 | 状态 | 原型 |
| --- | --- | --- |
| [平台工程地基收口](2026-09-10-platform-foundation.md) | 已落地（2026-09-10）：HTTP 信封与关联 ID 冻结、凭证脱敏、配置生产硬失败、依赖方向检查 | — |
| [最小执行契约](2026-09-10-runtime-contracts.md) | 已落地（2026-09-10）：Step / Echo·Delay·Fail / RunSnapshot / 执行错误 / Evidence 元数据 / 事件信封 | — |
| [目标系统（接入目录）](2026-09-10-target-catalog.md) | 已落地（2026-09-10）：Target / TargetAccount 目录、本地凭据引用；不含会话与登录绑定。联调夹具见 [`tests/target-login-hmi/`](../tests/target-login-hmi/README.md) | — |
| [目标系统补丁：首个账号与登录框定位](2026-09-10-target-login-fields.md) | 已落地（2026-09-10）：新建可带首个账号与可选定位；启发式清单进代码；不含探测与插件 | — |
| [识途 Recorder 扩展：图标、中文与忽略规则](2026-09-10-extension-playwright-crx-chrome.md) | 已落地（2026-09-10）：观测证据标、可见文案中文、包内 gitignore；不含上传与登录 | — |
| [执行内核：账本与无浏览器引擎](2026-09-10-execution-kernel.md) | 待审查（2026-09-10，修订一版）：Scenario / Version / Run 账本 + Echo·Delay·Fail Engine；含参数化 `from` 三层校验、副作用未知一律 `NEEDS_REVIEW`；不含浏览器、会话、编辑器、SSE | — |
