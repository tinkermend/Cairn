# 受管浏览器 Studio 控制台用户路径

日期：2026-09-15。对应 [B 方案](../spec/2026-09-13-managed-browser-view-and-auth.md) BV09 用户闭环，以及 fencing 报告里未关上的控制台入口。

## 结论

先前 fencing 报告只关上了 Worker 侧。控制台试跑页长期看不到受管画面，不能把 S-LIVE 或「Worker 已补」写成 BV09 通过。

本轮在真实 Studio 上走完：发现等待认证、独占输入、看见登录后画面、续跑、续跑后只读画面、证据。**不宣称** BV08 的 Web 展示路径 p95 / 20 次循环，**不宣称** D1 联合验收，**不宣称**操作系统弹窗、证书选择或复杂 SSO。

## 画面空白的实际原因

分层叠在一起，不是单一 Worker 漏实现：

1. Studio 只在 `WAITING_FOR_AUTH` / `HOLDING` 才自动展开；普通试跑折叠时根本不订画面。窄视口试跑面板藏在「页面」页签后，开跑后仍停在「步骤」。
2. Node 24 的 GET 空 body 会立刻 `req.close` / `req.destroyed`，API 与 Worker 把这当成客户端断开，`/browser/frames` 约 700ms 结束且 `encodedBodySize=0`。UI 清结束不报错，一直停在「正在连接受管浏览器画面…」。
3. Vite `/api` 代理默认超时会把大 SSE 帧缓冲到断开。

本轮对应改动：在途 Run 自动展开并订流、窄屏开跑切到「页面」、SSE 只在响应未结束时跟 `res.close`、代理 `timeout/proxyTimeout=0`。结束态若 Worker 已不可达，占位改回「运行已结束」，不再盖成「执行面暂时不可达」。

## 控制台实测

环境：本机 Vite `localhost:5173`，API/Worker 本机，HMI 夹具 `127.0.0.1:4177`，远程 PostgreSQL。场景「试跑画面验收」，账号「验收人工登录2」（无密码，人工登录）。Run `01a0a31a-61c1-7299-ba7b-ce3ac83c3452`。

| 路径 | 结果 |
| --- | --- |
| Studio 发现等待认证 | 开跑后自动切到「页面」，折叠态可见「处理登录」 |
| 独占输入 | 「处理登录」后心跳续权，输入框与「登录完成，继续运行」只给当前控制者 |
| 看见画面 | 取得控制权后 SSE 保持打开；JPEG 1280×720，内容是登录后的「1号场站总览」，不是登录表 |
| 验证登录并续跑 | 首条 Run `POST .../resume-auth` 200；Worker 复用同一 Session `generation=1`，领取后续步骤。同日补测 Run `01a0a32e-c145-73a2-95c6-22e58cbca5e0`：交回后等待步 `framesAvailable=true`，Studio 仍有 1280×720 JPEG |
| 证据 | Run `SUCCEEDED`，`evidenceStatus=COMPLETE`。详情页：成功 / 证据完整；打开登录页 203ms、停留观察画面 20s，输入输出均「已就绪」 |

时间（UTC）：试跑 `03:26:51` 进入等待；`03:27:22` 左右取得控制权（冷启动 Chromium，acquire 约 6.5s）；`03:29:34` 续跑；`03:30:03` 结束。

## 续跑只读画面与处置（同日补）

上一轮交回后等待步里画面不回来，根因是：领取后 `placement.sessionId` 为空，Worker 元数据不再报告可观察会话，控制台因此不订流；续跑空隙 hold/租约都空时 API 也转发不成。处置卡死会话只清了 worker/到期，留下 runId/代次会撞 `auth_hold_binding_check`，LOST 亲和就会一直堵住同账号新试跑。

本轮改动：Worker 用 hold → placement → 本进程页面归属同一条查找；续跑后 `RECOVERING` 且尚无租约时 API 转到该账号 OPEN 会话；`dispose` 一次清完整 hold 绑定和控制权。

控制台复测 Run `01a0a32e-c145-73a2-95c6-22e58cbca5e0`（同一场景与「验收人工登录2」）：`resume-auth` 200 后进入 `RECOVERING`，随后 `RUNNING` 时 `GET .../browser` 为 `framesAvailable=true` 且 Studio 仍有 1280×720 JPEG；等待步约 22s 后 `SUCCEEDED` / `evidenceStatus=COMPLETE`。结束后画面关闭、`worker_unreachable` 是预期，不是回归。

LOST 亲和本身不改：失联会话继续占键，必须人工处置。处置带完整 hold 绑定的 LOST 由 SQLite/Postgres 集成用例钉住；本轮控制台没有再造一条等待认证中的 LOST 去点治理页。MySQL 集成因本机 3307 未起来未跑。

## 仍未关上

| 项 | 说明 |
| --- | --- |
| BV08 | 只有 Web 路径样本。没有 20 次循环，没有帧捕获到展示的 p95。S-LIVE 数字不能顶替 |
| BV09 断线条款 | A 断线不开放输入、B 断线不伪造 Run 状态，仍以 2026-09-14 Worker fencing / S-LIVE 为准，未在控制台重做断线 |
| D1 / 未验类别 | 10 步样例联合验收、操作系统弹窗、证书选择、复杂 SSO 未做 |

定向用例：API `sse-abort.spec.ts`、Worker `http-server.spec.ts` / `observed-session.spec.ts`（含领取后 placement 无 sessionId、续跑空隙无租约映射）、DB `sessions-repository` 处置完整 hold、`worker-registry` 续跑转发。不要和 Studio 其它用例同进程混跑 `runs-api` mock。
