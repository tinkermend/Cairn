# 平台配置中心实施复查

日期：2026-09-14。依据：[最新方案](../spec/2026-09-13-platform-configuration-center-assessment.md)，包括第 11 节审查修订。范围为配置中心及其 Run 创建、Worker 消费、权限、历史与 Web 交互。审查基线为 `b47a35f`、`388bb4c` 及复查时的工作区；其他并行任务的未提交改动保留原状。

状态：**6 项缺陷已修复（2026-09-14），相关回归通过**。下列第 1–6 节保留复查时的原始证据与修复要求；当时确认 3 项 P1、3 项 P2，由 7 个失败复现用例覆盖。修复后的结果见末节，不将本次定向回归等同于全平台验收。

## 1. P1：表单与修订号脱离，会覆盖他人配置或刚恢复的配置

位置：[PlatformConfigPage](../../packages/web/src/features/platform-config/index.tsx)，第 100–104、111–120、310–313 行。

表单只在第一次读取配置时初始化，之后查询缓存更新不会同步表单；保存却从缓存取得最新 `expectedRevision`，再提交整份旧表单。生产环境开启窗口聚焦重新查询，因此正常切换窗口也能触发这个路径。

复现：管理员 A 在修订 1 上把步骤超时由 30 秒改为 45 秒；管理员 B 已在修订 2 把会话空闲期由 600 秒改为 900 秒。A 的页面重新查询后显示修订 2，但保存提交的是 `expectedRevision: 2` 和旧的 `idleTtlSeconds: 600`。数据库会正常通过并发校验，B 的修改被静默覆盖。

同一根因也影响恢复：在变更记录中恢复含 45 秒超时的修订，页面显示恢复产生的新修订 3，切回执行默认值仍为 30000 ms。之后保存其他分组会再次写回恢复前的值。两个浏览器复现均失败。

修复要求：编辑值必须与其基准修订一起维护。后台刷新遇到脏表单时保留原基准并提示冲突，不能只提升修订号；保存与恢复成功时同步重置表单及基准。409 后再次保存也需要明确解决差异，不能自动把旧整份文档配上新修订。

验收：后台刷新、其他分组并发修改、恢复后切页与再次保存都不得静默丢失已提交值。

## 2. P1：连接测试跳过地址与凭据绑定，会发送旧密钥到新地址

位置：[PlatformConfigService.testConnection](../../packages/api/src/platform-config/platform-config.service.ts)，第 117–139 行；前端入口为 `onTestConnection`。

保存路径会检查更换服务 origin 是否重新登记密钥，但连接测试直接解密传入的 `secretRef` 并向表单中的 `baseUrl` 发请求。用户修改模型地址后、保存前点击「测试连接」，现有旧密钥仍留在表单中，此时就会被发给新服务。保存时的拦截已经来不及保护它。

复现使用独立 AES 测试密钥和伪造模型 Key，拦截 `fetch`，未访问真实供应商。传入新地址 `https://changed.example/v1` 后，实际构造了发往该地址 `/models` 的请求，带有旧测试 Key 的 `Authorization: Bearer …`。期望不发送请求，实际发送 1 次。

修复要求：在解密和发送请求之前校验凭据对应的服务 origin，连接测试、保存、恢复复用同一绑定规则。新的测试地址不能仅凭拥有旧 `secretRef` 就接收其明文。

验收：保留原引用修改 origin 后，测试请求应被拒绝；登记并绑定新凭据后允许测试。同 origin 的允许变更维持原约定。

## 3. P1：停用再启用可绕过保存路径的凭据绑定

位置：[requiresAiSecretRebind](../../packages/shared/src/platform-config.ts)，第 453–459 行；调用方为配置保存与恢复的 `assertSecretBinding`。

函数在上一份配置 `enabled=false` 时直接返回不需要重绑。先停用原服务，再改地址、保留原 Secret 引用并启用，保存就会通过，后续新 Run 将把旧密钥用于新服务。停用期间先改地址也会丢失原地址与密钥之间的约束。

复现：上一修订为原地址、原引用且停用；提交新 origin、相同引用且启用。真实 Service 方法接受了更新并返回修订 3，未要求登记密钥。

修复要求：停用状态不能清除凭据已经绑定的 origin。需要保留引用对应的绑定事实，不能仅比较前后两份启用配置；否则只删除 `previous.enabled` 判断仍无法覆盖「停用时先保存新地址，再启用」的路径。

验收：直接换地址、停用后换地址启用、停用时改地址再启用，以及恢复旧修订，都遵守同一绑定规则。第 2 项保护测试请求，本项保护配置持久化与随后执行，两条路径分别验证。

## 4. P2：AI 请求超时校验忽略本次 Run 的显式策略

位置：[resolveAiExecutionFromPlatform](../../packages/shared/src/ai-runtime.ts)，第 151–152 行；[共同创建边界](../../packages/db/src/runs/runs.ts) 的策略解析与 `resolveAiExecutionFromPlatform` 调用处。

创建边界已经解析出本次 Run 的有效 `policy`，但 AI 配置解析重新用 `undefined` 覆盖项生成平台默认策略，校验时丢掉 Run 显式值。Step 显式超时能被校验，Run 层超时不能。

SQLite 隔离库复现：平台默认步骤超时 30000 ms、AI 请求超时 15000 ms；AI Step 未单独写超时；创建请求指定 `policy.timeoutMs=10000`。创建成功，快照同时保存步骤超时 10000 ms 和 AI 请求超时 15000 ms，违反方案 §7.1 的最终有效超时校验。运行可能先耗尽步骤预算，再等模型请求结束。

修复要求：在共同创建边界用最终 `snapshot.policy` 和 Step 覆盖校验，保证校验对象就是实际冻结、执行的策略。

验收：过短 Run 超时应在创建前报 `AI_CONFIG_INVALID`；Step 显式覆盖仍按优先级计算；确定性步骤不受 AI 请求超时校验影响。

## 5. P2：旧幂等摘要不兼容部分嵌套覆盖

位置：[overridesCompatible](../../packages/shared/src/platform-config.ts)，第 368–376 行；[共同创建边界的旧摘要分支](../../packages/db/src/runs/runs.ts)。

旧请求只写 `evidencePolicy.retainDays.screenshot=10` 时，旧快照会补齐 `retainDays.trace=14`。目前兼容检查在顶层将两个 `retainDays` 对象整体 `JSON.stringify` 比较，把 `{screenshot:10}` 与 `{screenshot:10,trace:14}` 判成不同请求。

SQLite 隔离库中按旧 resolved 规则生成并保存幂等摘要，再原样重发上述请求，得到 `RUN_IDEMPOTENCY_CONFLICT`，没有返回原 Run。复现通过内部创建选项注入旧格式摘要，没有修改或绕过不可变 Run 约束；即使未修改平台默认值也会失败。

修复要求：按请求实际提供的嵌套字段逐字段比较，数组按自身契约比较；继续从原快照解释旧默认值，保留对真正不同请求的拒绝。

验收：仅截图天数、仅 Trace 天数、两个天数同时提供、改变其中一个值，以及平台默认变化后的原样重发均应覆盖。

## 6. P2：Trace 模式覆盖后使用了错误的保留期

位置：[resolvePlatformEvidencePolicy](../../packages/shared/src/platform-config.ts)，第 313–323 行。

函数先按平台的 Trace 模式选择保留期，再应用 Run 的模式覆盖；只补偿最终模式为 `always` 的方向，没有处理从 `always` 改为 `on_failure` 的方向。

SQLite 隔离库复现：平台设置 Trace「始终」，调试 Trace 保留 7 天、普通 Trace 保留 14 天；Run 显式改成「失败时」且不覆盖保留天数。新快照得到 `trace=on_failure`、`retainDays.trace=7`，期望为 14。Worker 继续使用这一冻结值计算对象 `retainUntil`，失败 Trace 会比普通策略提前 7 天过期。

修复要求：先求最终 Trace 模式，再选择平台普通/调试保留期，最后应用 Run 显式天数。

验收：平台与 Run 的模式组合、普通/调试天数不同、显式天数覆盖，都按最终有效模式解析。

## 复查时的修订与验证结果

源码已确认：平台四组配置独立于部署连接与根密钥；三个创建入口的运行策略在共同创建边界读取；新快照保存策略、模型配置、修订和 Target 认证解释；Worker 读取冻结值；SessionLease 续租优先使用授租 TTL；AI Action 强制零重试；前端未改证据选项时不发送覆盖；专用配置权限与业务精简默认值分开。这些正确的结构不抵消上述组合路径缺陷。

| 本次执行的现有检查 | 结果 |
| --- | --- |
| `pnpm check` | 依赖方向、三库 40 个迁移文件、架构不变量通过 |
| shared / db 构建 | 通过 |
| shared：platform-config / policy / evidence-policy | 19 项通过 |
| db：platform-config | PostgreSQL / MySQL / SQLite 共 9 项通过 |
| api：platform-config HTTP / browser-ai | 11 项通过 |
| web：platform-config / trial-dialog | Chromium 共 6 项通过 |
| worker：ai-executor / ai/port | 7 项通过，1 项失败 |

现有 Worker 失败位于 [ai/port.spec.ts](../../packages/worker/src/ai/port.spec.ts) 第 8–15 行：mock 未提供消费方调用的 `validateBrowserAiModelFamily`，断言失败截图用例在进入目标断言前报错。该失败单列为验证缺口，不据此断言生产截图逻辑有问题，也不归因于配置中心提交。

补充复现共 8 项：7 项按正确行为断言失败，对应上述 6 个问题；1 项带真实 CSS 的 390 px 页面切换与横向溢出检查通过。已查看桌面恢复后截图及窄屏截图。前端使用真实组件、查询缓存和浏览器交互，API 数据为受控 mock；安全复现使用测试密钥且拦截出站请求；数据库策略复现使用独立 SQLite 库。没有调用真实模型，也未对真实目标系统执行运行；不把这些检查计为完整 L3 或长时间故障恢复验收。

复现测试已从常规测试目录移出，保存在本地[复现补丁](../../.run/platform-config-review-2026-09-14/reproduction-tests.patch)。截图：[恢复后旧表单](../../.run/platform-config-review-2026-09-14/restore-stale-form.png)、[窄屏](../../.run/platform-config-review-2026-09-14/narrow.png)。补丁仅添加三个测试文件，便于修复任务复用；不修改业务代码。

旧复现补丁仅保留审查证据。登记接口现已要求 `baseUrl`，正式回归已纳入现有测试文件，不再应用旧接口 mock 补丁。

## 修复与回归（2026-09-14）

| 问题 | 最终行为 |
| --- | --- |
| 1：旧表单覆盖新值 | 表单与编辑修订同步；后台刷新及 409 保留脏输入，阻止旧文档保存；明确重新载入后才采用新基准；保存、恢复后同步表单 |
| 2、3：密钥地址绑定 | 登记接口要求地址，Secret 与 origin 同事务保存且不可改删；保存、恢复、测试共用绑定校验，停用也不豁免；无绑定 Secret 不能借停用写入历史后取得绑定 |
| 4：AI 有效超时 | 共用 Run 创建边界按最终 Run / Step 策略检查；内部直接传入 AI 配置也不能绕过 |
| 5：旧摘要兼容 | 只比较请求实际提供的嵌套字段，数组保持精确比较；平台默认变化后原样重发仍返回历史 Run |
| 6：Trace 保留期 | 先解析最终 Trace 模式，再选普通或调试保留期，最后应用显式天数 |

密钥绑定迁移为 PG `0026_platform_ai_secret_binding.sql`、MySQL / SQLite `0010_platform_ai_secret_binding.sql`。已有 Secret 按首次不可变配置修订解释地址，保留旧密文格式与 Run 引用。转储包含平台当前配置、修订和绑定，三库之间六个迁移方向均验证保留。迁移已在隔离测试库验证；本次未操作正在运行的开发数据库。

| 修复后检查 | 结果 |
| --- | --- |
| shared：platform-config / policy / evidence-policy | 23 项通过 |
| db：platform-config / schema-parity / portability | 79 项通过，覆盖三库绑定、冻结、迁移幂等与转储 |
| api：platform-config HTTP / integration / browser-ai | 16 项通过；真实仓储与 HTTP，出站模型请求使用 stub |
| worker：ai-executor / ai/port | 8 项通过；补齐 `validateBrowserAiModelFamily` mock |
| web：platform-config / step-registry | Chromium 11 项通过；补齐能力响应测试中的平台默认值 |
| API / Worker 及其依赖构建 | 6 个 package 构建通过 |
| API typecheck | 通过 |
| 迁移与架构不变量检查 | 46 个迁移文件及核心架构不变量通过 |
| 前端设计检查 / 配置页 ESLint | 设计检查通过；ESLint 0 错误，保留 React Hook Form `watch()` 的编译兼容警告 |

上述定向测试共 **137 项通过**。已用真实 CSS 查看 [1440 px 冲突提示](../../.run/platform-config-fix-2026-09-14/conflict-desktop.png) 与 [390 px 冲突提示](../../.run/platform-config-fix-2026-09-14/conflict-narrow.png)，窄屏无横向溢出；冲突输入、放弃后重载和恢复后再保存均有浏览器断言。没有连接真实模型或运行真实 Target，不计为 L3。

全仓检查仍有本次修改之外的并行工作区错误：`pnpm check` 被 `worker/src/browser/managed-browser.lab.spec.ts` 引用 AI 内部实现的依赖方向检查拦截；完整 typecheck 在 shared 的 `managed-browser.test.ts`、DB 的 `session-affinity.test.ts` / `sessions-repository.test.ts`、Worker 的 `engine.browser.spec.ts`，以及 Web 的受管浏览器、运行观察和 Step Editor 中报错。本次未改写这些并行任务文件，因此不宣称全仓检查通过。
