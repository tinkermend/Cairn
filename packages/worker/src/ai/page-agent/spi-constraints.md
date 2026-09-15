# Page Agent SPI 约束（S07-lite）

日期：2026-09-13。本清单不是采用或拒绝结论。完整真模型、凭据代理与分类评估在 P8 之后、归 D3。

## 必须由平台决定、不能按 Midscene Playwright Agent 的形状偷懒

1. **循环跑在哪**：Midscene 的规划循环在 Worker 进程。Page Agent 官方循环在页内。P8 Provider SPI 必须同时表达「进程内循环」和「页内循环 + Worker 代理」。只按 `PlaywrightAgent.aiAct` 设计，页内 Agent 以后接不进来。
2. **谁持有凭据**：页内 JS 不得看见 API Key / 平台 Token / TargetAccount 口令。模型请求必须经 Worker 绑定或等价代理。官方 demo IIFE 从 script URL 读 key，禁止用于正式 Run。
3. **取消怎么送达**：页内循环收不到 Playwright `AbortSignal`。Worker 必须有显式 stop（本探针：binding 侧 `stopped`）。导航会销毁页内状态，stop 与「必须重建」是两件事。
4. **导航之后**：页内 Agent 默认随文档消失。SPI 要声明：导航后是失效、由平台重建，还是禁止该类别改导航。
5. **Binding 反向滥用**：`exposeBinding` 挂在页面上，目标站自己的脚本也能调。必须按 Attempt 发 nonce，并校验请求形状。没有 nonce 的调用必须失败。
6. **网络边界**：夹具与探针禁止访问外网。`context.route` 拦截非 Lab origin。官方 demo 默认连公网演示端点，不得注入。
7. **官方已写明的能力限制**（不必再「发现」）：只管当前页；只支持同源单层 iframe；不支持嵌套 / 跨域 iframe；多标签页依赖官方扩展。正式调度 Run 不依赖 Extension。
8. **UI 副作用**：官方入口默认面板和遮罩。受管执行必须无头：`PageAgentCore` + `PageController({ enableMask: false })`，不带面板。
9. **证据**：页内动作仍要落到平台 Attempt / Evidence。页内 console 或 demo 报告不能当 Run 事实源。

## 本探针已覆盖

以下均用只转调 binding 的替身脚本验证，没有注入 Page Agent（`PageAgentCore` + `PageController`）本体，`@page-agent/*` 也不在依赖里。结论只对 binding 机制成立。

- 替身脚本注入（非 demo IIFE）
- nonce + 形状校验
- Worker 侧 stop
- CSP 页不加载外网脚本；`connect-src 'self'` 拦页内 fetch
- CSP 页上自建注入后 binding 仍可用
- `context.route` 挡外网
- 导航后页内入口丢失（须重建）

## 留给 P8

- Page Agent 本体的注入、`stop()` 与导航后重建（替身验证不了 SDK 自己的循环）
- 真实 tool-calling 模型
- 凭据代理与预算
- 分类别评估与采用 / 限制 / 拒绝
