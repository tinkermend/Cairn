# 会话管理联合测试

对应 [会话管理总架构](../../docs/spec/2026-09-15-session-management-and-auth-lifecycle.md)及 A–D 子方案。这里维护可执行场景与运行方法；每次结果由测试输出和隔离目录中的 `results.json` 给出。

## 运行

需要 Node 24、pnpm、已安装的 Chromium，以及可创建隔离数据库的本地 PostgreSQL。默认读取根 `.env` 的连接配置，不写入其中配置的业务库。

```sh
pnpm test:sessions:e2e
pnpm test:sessions:adversarial

# 仅在数据库适配、迁移、事务／锁语义变更或发布前，才运行 MySQL 链路；先完成上面的服务构建
CAIRN_E2E_DB_DRIVER=mysql node tests/session-management-e2e/run.mjs
CAIRN_E2E_DB_DRIVER=mysql node tests/session-management-e2e/adversarial.mjs
```

MySQL 读取 `CAIRN_TEST_MYSQL_HOST/PORT/USER/PASSWORD/DATABASE`，默认端口 3307。密码也可来自本机 `.run/database-portability/mysql.env`；未提供不会跳过。端到端链路只接受 PostgreSQL 与 MySQL。

普通会话功能改动按影响范围运行默认 PostgreSQL 链路和定向测试。数据库适配层、SQL/迁移、事务／锁／并发持久化语义变化，以及发布前，除这里的 MySQL 链路外还须运行 `pnpm test:db:compatibility`。

每次启动真实 API、两个 Worker、Chromium 和需要时的 Vite；创建独立数据库、账号、浏览器 Profile、对象目录与临时端口。业务对象由正式 API 创建，故障只注入本地靶场或测试进程；数据库只读查询用于核对持久化事实。退出后关闭自有进程并删除隔离数据库，日志、截图和机器结果留在被 Git 忽略的 `.run/session-management-e2e/`。浏览器 Profile 含测试登录态，不作为提交物。

`target.mjs` 是真实 Cookie 登录服务，提供测试账号、只读页面、身份探针、提交和服务端撤销登录态。固定口令只供本地夹具使用。完整链路中的基础设施退避缩短为 1/2 秒；另有专门用例验证 30 秒退避可被取消。故障退出用例把该 Run 的租约设为 6 秒，Worker 存活期限为 9 秒。

## 完整链路场景

| 维度 | 可执行断言 | 对应边界 |
| --- | --- | --- |
| 基础执行与复用 | API → Worker → Chromium → Evidence；连续 Run 使用同一登录；不同账号的实例与业务输出隔离 | SM02/03/37 |
| 认证规则 | 真实 Worker 完成有效登录、服务端撤销、另一身份三步观察；新 Run 冻结能力与修订 | SM35、SM27 部分 |
| 能力分级 | LOGIN_VERIFIED 可复用，开跑前失效必须人工登录，运行中失效明确失败且不重登；配置升级不改变历史 Run 的能力快照 | SM42 部分 |
| 新鲜度与 UNKNOWN | 新鲜证据不重复探测；已知 UNKNOWN/MISMATCH 覆盖旧成功证据；基础设施退避回交释放 SessionLease；恢复服务后原 Run 可再次领取 | SM04/10/19/36/41 |
| 取消 | 30 秒退避期间及时取消；认证等待取消释放占用与控制权；迟到完成被拒绝 | SM18 |
| 并发调度 | 两个独立 Worker 下同账号 Run 串行，排队 Run 提供真实占用原因 | SM05/31 |
| 自动恢复 | 两步间服务端撤销登录态，恢复后保留 Context，不重放已成功 Attempt | SM08/14 |
| 副作用 | 提交已经到达服务器后失去认证，只提交一次并进入 NEEDS_REVIEW | SM15 |
| 人工认证 | 单控制者、真实 SSE 画面和输入；重复命令不重复输入；乱序拒绝；完成后重新核验身份 | SM17C/17D |
| 画面重连 | 连续 20 次打开和中止画面流，仍能输入；页面数不增长；API 不重复写响应头 | SM24 部分 |
| 恢复预算与现场 | 新 Run 冻结新预算，旧 Run 不变；REUSE_PAGE 被登录跳转替换后明确不可恢复 | SM13/16/44D |
| 权限 | 真实 viewer JWT 拒绝维护和接管；跨 Target 账号写入拒绝 | SM25 部分 |
| 维护与保留 | 重启复用持久 Cookie；代次变化使旧操作失效；清除 Profile 后旧登录不能复活 | SM20/21 |
| 后台维护 | 修改维护间隔不重启生效；只核验保留账号，不延长 lastUsedAt 或 retainUntil | SM38/44C |
| 控制台 | 真实登录、总览、详情、保留修改、刷新持久化；1440/768/390 宽度截图及横向溢出检查 | SM29/30 部分 |
| 重连恢复 | 重启 API 后读取同一 Session 与保留期限；SSE 可重新读取持久化事件 | SM23 |
| 凭据 | 假密码不出现在 API/Worker 日志、会话事件和 Evidence JSON | SM26 部分 |
| 超时与失联 | AUTH_WAIT 截止释放占用；杀死 owner 后另一 Worker 收敛租约、计入恢复次数；LOST 保留账号键、旧控制失效 | SM18A/22/33 |

## 故障注入场景

`adversarial.mjs` 的 15 组用例使用真实 API、两个 Worker 和 Chromium，在目标请求到达指定位置后才注入故障。核对目标收到的登录／业务请求、Run 与 Attempt 终态、租约、持久登录预算；故障解除后还验证能否恢复。结果保存在 `adversarial-results.json`，目标请求与数据库事实摘要保存在 `fault-facts.json`。重启前后使用本轮固定的构建副本，避免其他任务重新构建改变测试对象。

| 场景 | 故障及断言 |
| --- | --- |
| N00 | 非法会话、操作、账号 ID 返回 400，不落到数据库异常 |
| N01 × 4 | 身份端点返回未配置的 403、损坏 JSON、断连、无响应；保留 UNKNOWN，零登录提交、零业务 Attempt，释放执行占用，故障解除可正常执行 |
| N02 | 错密码只自动提交一次；真正重启持有者后，账号级预算仍阻止重复提交 |
| N03 | 服务端已经接受登录但连接在响应前断开；平台只占用一次登录预算，下一 Run 不再次自动提交 |
| N04 | 正向身份响应在途中时停用账号；拒绝业务派发且释放占用 |
| N05 / N05B | 分别在身份探针途中、密码已读入内存但登录页尚未返回时清除凭据；旧密码不得提交 |
| N06 | 在途核验期间取消；迟到成功不能复活 Run 或创建 Attempt |
| N07 / N07B | 人工登录成另一身份被拒绝；持有人控制期间停用账号，后续输入和完成被拒绝 |
| N08 | 副作用已到达目标后响应丢失；进入 NEEDS_REVIEW，平台不重试，保留一个 Attempt |
| N09 | 暂停而非杀死 owner，超过租约与登记期限后恢复；排队 Run 不能并行抢占，旧 Worker 不能写成功或重新提交，两 Worker 可恢复工作 |

N09 在 PostgreSQL / MySQL 中要求存活 Worker 在旧进程暂停期间标记 LOST，随后拒绝旧租约结果并完成节点重新登记。

N03 / N08 同时记录平台尝试数和目标实际 POST 数。真实 Chromium 在响应一个字节都没到达时可能透明重发同一请求，测试已观察到一次点击产生两次 POST。平台能保证此后不自动重登、恢复或重试该副作用；要保证目标业务只执行一次，仍需目标业务幂等键、去重或明确的结果查询契约。点击完成也不等于业务交易成功，业务成功须由 Scenario 的后置断言核实。

单项复现可设置 `CAIRN_FAULT_FILTER=N05B`；筛选执行不能作为全套通过的证据。

## 补充回归

完整链路之外，以下测试承担不适合全部通过 UI 注入的边界。它们不能被算作真实模型或真实外部目标的完整端到端验收。

```sh
cd packages/db
./node_modules/.bin/vitest run --no-file-parallelism --hookTimeout 180000 \
  src/__tests__/occupancy.test.ts src/__tests__/auth-profile.test.ts \
  src/__tests__/maintenance.test.ts src/__tests__/maintenance-regressions.test.ts \
  src/__tests__/run-auth-recovery.test.ts src/__tests__/auth-control.test.ts \
  src/__tests__/session-affinity.test.ts src/__tests__/worker-registry.test.ts \
  src/__tests__/run-lease-fencing.test.ts src/__tests__/schema-parity.test.ts \
  src/__tests__/migrate.test.ts
```

- 默认 PostgreSQL 占用契约每轮 20 次同账号并发；取消与超时、取消与完成认证并发；独立认证完成与租约／等待期限回收竞争；同 ID Worker 换代；恢复预算耗尽；失联重扫不重复计次；协议能力、配置失败拒绝领取、Profile 亲和和旧修订作废。数据库风险变更时由 PostgreSQL / MySQL 兼容矩阵重复相关持久化断言。
- 维护与认证契约覆盖权限撤回、维护冲突、排队过期、幂等、后台排程、登录提交结果未知、身份配置修订和账号级持久预算。
- Worker 的 `session-auth.page.spec.ts` 使用真实 Chromium 验证异步页面、明确失败信号和总核验预算；`session-maintenance.spec.ts` 检查验证码、人工认证、UNKNOWN、身份不匹配、无凭据时禁止自动提交。
- `runtime.health.spec.ts` 在真实 Chromium 中让导航打断健康探针：短暂执行上下文销毁只得到 UNKNOWN，下一次恢复 HEALTHY；页面关闭仍得到 UNHEALTHY，避免把正常登录导航误判为故障并关闭会话。
- `runtime.stop.spec.ts` 验证浏览器不响应关闭时有界返回未确认、迟到关闭不伪造成功；`lifecycle.spec.ts` 验证阻塞跨多个心跳周期也只发出一次心跳并只重新注册一次。
- `engine.auth-recovery`、`run-auth-recovery`、`run-auth-observer`、`action-gate` 与 `managed-page.lab` 覆盖认证门禁、被动观察、AI 派发之前中止、SDK 迟到动作与复用隔离。Midscene 适配器走真实浏览器和离线模型回放，不调用外部模型。
- shared 契约、API 权限与错误响应、Web 组件交互测试提供分层断言；`pnpm check`、`pnpm check:design` 校验架构和前端规范。

SNC DPM 使用独立的显式开关，读取既有本地目标登记：

```sh
CAIRN_L3_DPM=1 pnpm --filter @cairn/worker test src/browser/engine.dpm.spec.ts
```

范围为登录、只读提取、连续 Run 会话复用、无凭据等待和失败截图取回。不修改 DPM 业务数据，也不主动撤销 DPM 服务端登录态。

## 验证边界

- 本地靶场可证明状态机与故障处理；每个外部 Target 的身份核验规则、SSO/MFA/验证码流程仍需各自接入验证。DPM 只读用例不等于 DPM 的 IDENTITY_VERIFIED 三步认证配置验收。
- 离线 AI 回放验证动作门禁和隔离，不能证明真实模型在全部业务页面上的语义质量或恢复成功率。
- 响应式截图、20 次流重连和有限并发不替代所有 UI 状态的人工验收、长期内存分析、容量压测或多机网络分区测试。
- PostgreSQL / MySQL 结构及契约测试不替代带真实生产数据的停机导出／导入演练；实际部署仍须遵守[数据库支持范围](../../deploy/database-backends.md)。
