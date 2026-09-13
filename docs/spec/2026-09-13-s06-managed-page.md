# S06 受管 Page 适配层实验记录

日期：2026-09-13。状态：**限制采用**。  
对应路线图 S06、[D0 探针方案](2026-09-13-d0-hybrid-probes.md)。  
这是 Surface Lab 上的控制面证据包，不是对 Midscene 默认行为或某家企业系统的兼容承诺。在线 VL 未跑，不否定离线结论。

## 问题和假设

上一问「Midscene 默认是否服从受管 Page」从 vendor 即可读出：**默认不服从**（abort 非抢占、默认 popup 劫持、select 样式残留、`aiQuery` 不透传 abort）。

本记录问：识途适配层能不能让它服从？假设：在 `new Agent` 之前包装 `actionSpace`、显式 `modelConfig` + 包装 client、关闭 `forceSameTabNavigation` / `forceChromeSelectRendering` / `generateReport`，并用 `setMidsceneRunDir` 代替进程 `MIDSCENE_RUN_DIR`，即可在离线假模型下证明取消、残留、受管 Page 与编造检测。

完整 `aiAct` 假响应回放超时则记限制；未完成前不得把「aiAct 在 abort 后零新动作」写成已证明。

## 依赖版本与提交号

| 项 | 值 |
| --- | --- |
| 基线提交 | 本记录与实现同提交（引入本文件的提交） |
| Node | 24 LTS |
| Playwright | 1.63.0 |
| Midscene | `@midscene/web` / `@midscene/core` / `@midscene/shared` **1.12.6**（与 vendor 快照同版本；npm，不把 vendor 推进 workspace） |
| PostgreSQL | 16+（`openIsolatedDb` 独立 schema） |

## 测试环境

本机 Worker 集成测试。内嵌 Surface Lab HTTP + 登录 Cookie 夹具，不指向公网。受管路径：`openIsolatedDb` → 登记 Target / Account → `registerWorker` → `BrowserSessionManager.acquire` → `pageForGrant`。离线跑前删除进程 `MIDSCENE_*` / `OPENAI_*`。运行目录走 `setMidsceneRunDir`，不设 `MIDSCENE_RUN_DIR`。

未接入任何真实企业系统页面。L3 / DPM 默认不跑 AI。

## 页面或数据样本标识

- `/canvas`、`/hybrid-missing`、`/popup`、`/`、`/csp`（均引入 `/lab-events.js`）
- Worker 适配层：`packages/worker/src/ai/midscene/`
- S07-lite：`packages/worker/src/ai/page-agent/`
- Engine 已知缺口钉：`packages/worker/src/engine/engine.browser.spec.ts`（`fill.from` 对象 stringify）
- 边界：`tools/check-deps.mjs`、`packages/worker/src/engine/engine.boundary.spec.ts`

## 运行步骤

可复跑命令（在 `packages/worker` 下，避免仓根 `pnpm --filter` 触发 ignored `sharp` 构建脚本）：

```text
npx vitest run src/ai/page-agent/inpage-binding.spec.ts src/ai/midscene src/engine/engine.boundary.spec.ts src/engine/engine.browser.spec.ts
node ../../tools/check-deps.mjs
```

1. 受管 acquire → 规则 `navigate` `/canvas`；包装动作边点画布。
2. 假模型给 `{ orderNo }`；独立 DOM 核对页面含该号后，字符串填入 `#echo`。
3. `/hybrid-missing` + 假模型编造 → `fabricated`，输入框保持空。
4. 屏障扣住第 1 次模型调用 → abort / `leaseLost` → 放行 → `__labEvents` 无新 click。
5. 安全标志构造 Agent；`destroy` 后规则 click 开 `/popup` 子窗，当前页不 `goto` 子窗 URL。
6. `REUSE_PAGE` 下一 Run 无 popup / interceptor 残留。
7. 构造期间 `MIDSCENE_*` 为空；`chromium.launch` / `launchPersistentContext` / `browser.newContext` 打桩；`context.pages()` 集合差为空；profile 目录相关进程数不净增。
8. S07-lite：nonce、stop、导航丢失、CSP + `connect-src` 下 binding 仍可用、页内 fetch 被拦。

在线（未跑）：`CAIRN_S06_ONLINE=1` 且显式 `CAIRN_S06_MODEL_*` 经 `modelConfig` 传入。

## 成功判据

- 动作边 abort / 丢租后零新 click（夹具事件 + 检查函数）。不得把 SDK 自带 abort 或一次随机 `aiAct` abort 当成通过。
- 假模型输出必须先 `takeStringField`；页面不含该值则 `fabricated`，不得 fill。
- Agent 构造使用安全标志；destroy 后无未登记 Page 监听 / 注入；`REUSE_PAGE` 下一 Run 无残留。
- 适配层调用返回后 Page / URL 仍是 `pageForGrant` 那一页（除非该步本身导航）。
- 进程无 `MIDSCENE_*` / `OPENAI_*`；不设 `MIDSCENE_RUN_DIR`。
- Engine / 非 `src/ai/` 不得 import Midscene；除 Worker 外任何包不得声明 `@midscene/*`。

## 原始结果

2026-09-13 本机复查后重跑：`vitest` 7 个文件、44 条通过；`tools/check-deps.mjs` 通过（8 个包）。未跑 `CAIRN_S06_ONLINE=1`。未做完整 `aiAct` 假响应回放——结论只能写「动作边检查成立」，不能写「aiAct 在 abort 后零新动作」。

默认开 `forceSameTabNavigation` 会注册永不移除的 `page.on('popup')` 并 `page.goto(popupUrl)`。产品适配层固定关闭；popup → 当前 Surface / `pageRef` 仍归 P5，本记录只对照、不进 Gate。

## 失败分类

- 无 Chromium：lab 在 `beforeAll` 直接失败，不准 skip 整个 S06。
- 缺 VL 模型：不得 skip 离线；在线步骤单独用 `CAIRN_S06_ONLINE=1`。
- Midscene 入口 `@midscene/web/playwright` 会拉 `@playwright/test`：已改走 `playwright/agent`。
- Lab 无扩展名路径须映射到 `.html`；CSP `default-src 'self'` 会先挡页内 fetch。
- `fill.from` 遇对象 `JSON.stringify`：Engine 已知缺口，本期用测试钉住，不修。

## 限制

1. 只证明 Surface Lab 控制面。不得写已兼容企业系统。
2. 未完成完整 `aiAct` 循环。D1 可写 AI 方案，但 AI Action 类别不得开放，完整循环列为 D1 内部前置。
3. 在线 VL 未跑。失败或未跑不否定离线。
4. 对象整包进 context 再 `fill.from` 关闭；必须先取字符串字段。
5. popup 页面交接未修。
6. S07-lite 只出 SPI 约束，无采用 / 拒绝。
7. 「本地录制与 Worker 的网络、登录条件」仍无人认领，不在本记录冒领。

## 最终决策

**限制采用。**

- 采用：动作边 abort / 丢租、显式 `modelConfig` + 包装 client、安全标志构造、编造检测、`REUSE_PAGE` 无残留、平台键 `CAIRN_S06_*`。
- 限制：结论对该 Midscene 1.12.6 npm 发布版成立；只覆盖直调包装后的 `DeviceAction.call` 与构造副作用，不是完整规划循环。
- 拒绝：不把 SDK 默认值、进程 `MIDSCENE_*`、demo IIFE、直接 `launchSession` 写成通过。

## 关联阶段和 ADR

- 阶段：D0 S06 离线 Gate；S07-lite 单独退出，不挡 D1 AI 方案。
- 下一步：可写 D1 AI 方案（P8 最小 Gateway + P9 收已验证控制面）。ADR A08 accepted 待起草。
- 不开放：AI Step 注册、Engine 分发、`EXECUTABLE_STEP_TYPES`。
