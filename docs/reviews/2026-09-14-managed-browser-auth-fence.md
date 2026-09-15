# 受管浏览器认证 fencing 与画面回收

日期：2026-09-14。对应 [B 方案](../spec/2026-09-13-managed-browser-view-and-auth.md) 与 [A/B/C 复查](2026-09-14-abc-integration-review.md) 第 2、7 项。

## 结论

B 线主体原先已经接通。本轮只补方案承诺过、复查复现失败的故障边界，不新开 Live View 架构。

已关上：

- 认证输入在串行执行前复核 commandId 去重、序号、控制代次、token 摘要、Run 状态和页面代次；旧代次与重复命令不再打到页面上。
- 续跑先关闭输入门，再排空已入队命令；未登录失败后才把门重新打开。
- 画面 SSE 绑在响应/套接字断开上，不再等 GET body `end`；无人观察时停止 screencast，不销毁可复用 Session。

## 验证

| 验证 | 结果 |
| --- | --- |
| Worker `auth-input-fence` / `frame-subscribe` / 内部 HTTP 关流 | 通过 |
| API browser HTTP | 22 项通过 |
| `CAIRN_S_LIVE=1`（Playwright 1.63 / headless Chromium / darwin） | 3 项通过：原探针、20 次订阅/关闭无残留且首帧回调 p95 ≤ 3s、等待认证后独占输入并续跑到 `RECOVERING` |

2026-09-15 控制台用户路径及续跑后只读画面见 [Studio 控制台报告](2026-09-15-managed-browser-studio-console.md)。本报告仍不宣称：

- BV08 的 Web 展示路径 p95 与 20 次循环
- 操作系统弹窗、证书选择、复杂 SSO
- D1 联合验收

D1 联合验收（SSE + 画面 + 已有 AI/Studio 的 10 步样例）仍按工程计划另做。
