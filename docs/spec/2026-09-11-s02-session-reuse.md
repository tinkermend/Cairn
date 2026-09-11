# S02 会话复用实验记录

日期：2026-09-11。状态：**限制采用**。  
对应路线图 S02、P4 / RF10 / RF12、[P4 后半方案](2026-09-11-session-affinity.md) D10。  
这是受控夹具上的证据包，不是平台对某家企业系统的兼容承诺。

## 问题和假设

同账号连续两个 Run 能否只登录一次？`NEW_PAGE` 与 `REUSE_PAGE` 在受控登录页上是否可区分且可复跑？浏览器被杀或 profile 被锁时，未确认旧进程停止是否会双开？

假设：Session 键 `Target + TargetAccount` + 本进程句柄足以在受控账密页上复用 Cookie；`storageState` 不等于活会话备份；真实企业系统的 sessionStorage / SPA 内存 / MFA 不在本期证明范围内。

## 依赖版本与提交号

| 项 | 值 |
| --- | --- |
| 基线提交 | `7c54f3b`（本记录对应其后的 P4 后半落地工作树） |
| Node | 24 LTS |
| Playwright | 1.63.0（worker / web 对齐，chromium revision 1243） |
| PostgreSQL | 16+（测试用 `openIsolatedDb` 独立 schema） |

## 测试环境

本机 Worker 集成测试与 HMI runtime 测。内嵌 HTTP 登录夹具（`username` / `password` / `submit`，登录后写 Cookie），不指向公网。无 chromium 的机器上浏览器路径会走 `BROWSER_UNAVAILABLE` 并回交，不把缺浏览器写成业务失败。

未接入任何真实企业系统页面。

## 页面或数据样本标识

- Worker 集成：`packages/worker/src/browser/session-manager.integration.spec.ts` 内嵌 `/login` → `/` Cookie 夹具
- Runtime HMI：`packages/worker/src/browser/runtime.hmi.spec.ts` 同类内嵌页
- 联调夹具（人工，不进 Engine）：[`tests/target-login-hmi/`](../../tests/target-login-hmi/README.md)
- 复用档位单测：`packages/worker/src/browser/reuse.spec.ts`

## 运行步骤

1. 同一 `target_id + target_account_id` 连续两次 `BrowserSessionManager.acquire`；第一次自动登录，释放 SessionLease 后第二次再 acquire。
2. 换另一账号再 acquire，核对 `profileKey` / owner。
3. `NEW_PAGE`：开 Run 页，释放后关页；HMI 夹具循环 50 次后页面数回到 1（仅 basePage）。
4. `REUSE_PAGE`：单测断言走基准页，不新开页。
5. `PROFILE_LOCKED`：刚插入的行标 `LOST` + `profile_locked`，同键 `createSession` 失败。
6. 无句柄的 `stopAllLocal`：`OPEN` → `LOST`，同键不能再建。

可复跑命令：`pnpm --filter @cairn/worker exec vitest run src/browser/session-manager.integration.spec.ts src/browser/runtime.hmi.spec.ts src/browser/reuse.spec.ts`

## 成功判据

- 同账号第二次 acquire 不再解析凭据（`resolveCredential` 只调用一次），`holderWorkerId` 仍是同一 owner。
- 另一账号 `profileKey` 不同，不复用前一会话行。
- `NEW_PAGE` / `REUSE_PAGE` 档位语义与单测、HMI 页数断言一致。
- 锁定或无法确认退出时键仍被 `LOST` 占住，他 Worker 不能建同键会话。

## 原始结果

2026-09-11 本机：`session-manager.integration.spec.ts` 与 `reuse.spec.ts` 全绿。有 chromium 时连续两次 acquire 走 `session.reused`，凭据解析一次；另一账号新建会话。`PROFILE_LOCKED` → `LOST` + `profile_locked`。`stopAllLocal` 无句柄 → `LOST`。HMI 夹具在有浏览器时证明登录 Cookie 与 `NEW_PAGE` 不累积页面。

## 失败分类

- 本机无 Playwright 浏览器：launch 归 `BROWSER_UNAVAILABLE`，按 Affinity D5 回交，不记为复用失败。
- 登录框不完整 / 自动登录失败：既有 `SESSION_AUTH_UNSUPPORTED` + `WAITING_FOR_AUTH`，不是复用档位失败。
- 未观察到受控页上的 sessionStorage / SPA 内存导致 `NEW_PAGE` 不等于原页——夹具页没有这类状态。

## 限制

1. 只证明受控账密 Cookie 页。没有对任何真实企业系统做 S02，**不得**写该系统已兼容。
2. storageState 不是活会话备份。sessionStorage、SPA 内存、WebSocket 若使 `NEW_PAGE` 不等价于原页，属于 Target 限制，不改三档枚举。
3. 未补测真实 MFA / 过期会话 / 真进程 kill。路线图里那几项仍是限制，不是本期通过项（P4 后半方案验收 26）。
4. 腾位会关掉一份已登录的空闲会话，被腾账号下次要重新登录（Affinity 债务 5.1）。

## 最终决策

**限制采用。**

- 采用：`NEW_PAGE`（默认）、`REUSE_PAGE`；同账号活会话复用；账号键隔离 profile。
- 限制：只对受控夹具承诺；真实系统有样本再记一页限制，没有则内部 Foundation 可过。
- 拒绝：不把 storageState 当完整备份；不做 `NEW_CONTEXT`；不把一次成功轨迹写成平台通用复用承诺。

## 关联阶段和 ADR

- 阶段：P4 后半（RF10 / RF12 / S02 / A04）
- 方案：[2026-09-11-session-affinity.md](2026-09-11-session-affinity.md) D8 / D10
- 架构：`docs/arch/03` §7 Session 复用、§8 Affinity
- 后续：P5 才让 Engine 正式 `acquire`；企业系统样本若出现，另开一页限制，不改本期决策
