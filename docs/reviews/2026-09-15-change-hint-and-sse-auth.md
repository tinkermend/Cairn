# 变化提示与 SSE 鉴权故障隔离

日期：2026-09-15。对应 [A 方案](../spec/2026-09-13-run-realtime-observation.md) 与 [A/B/C 复查](2026-09-14-abc-integration-review.md) 第 1、8 项。

## 结论

复查指出的两类故障仍然存在，本轮按方案边界补齐：变化提示失败不得伤害运行进程；SSE 存活复核不得把基础设施错误当成登录失效。MySQL / SQLite 未配 Redis 时 `realtime: false` 是方案约定，不是缺陷。

已关上：

- 提交后 `void publish` 的拒绝被接住，未处理的 `ECONNREFUSED` 不再把 API/Worker 打退出。
- 首次并发发布共享一次连接过程；失败连接丢弃，下次用新 Client。
- PG LISTEN 的 `end` 挂在当前 listener 上，重连失败按退避多次再试，恢复后触发补读。
- Redis 发布端同样共享 `connect()`，并监听 `error`，避免辅助通道掀进程。
- `resolveAccount` 只有账号不存在 / 凭证无效才发 `UNAUTHORIZED`；库故障发 `INTERNAL`。Web 收到 `INTERNAL` 保留登录并重连。

## RT07

| 项 | 状态 |
| --- | --- |
| PG LISTEN/NOTIFY 作为默认实时通道 | 仍是交付组合；补了并发发布与多轮重连 |
| MySQL / SQLite 未配 Redis → `realtime: false` | 按方案保留，不是要改成原生通知 |
| MySQL+Redis / SQLite+Redis 单测装配 | 仍可装配；本轮用替身覆盖并发连接与失败重试。未对真实 Redis 做跨库直播声明 |

## 验证

| 验证 | 结果 |
| --- | --- |
| DB `change-hint` + `change-hint-publish-fault` | 6 项通过：并发连接、失败换 Client、未处理拒绝隔离、LISTEN 多轮重连、Redis 装配与重试 |
| DB `run-observation` postgres / sqlite | 各 12 项通过；含 PG 并发首次发布。本机未起 MySQL 3307，该库套件未跑 |
| API `observe.service` + `domain-error` | 12 项通过：库故障发 INTERNAL、账号不存在仍 UNAUTHORIZED |
| Web `use-run-observation` | 7 项通过：INTERNAL 保留登录并重连，UNAUTHORIZED 仍清登录 |

未在本轮宣称：真实 Redis 上的 MySQL/SQLite 实时组合、D1 联合验收。
