# A/B/C 三线实施与衔接复查

日期：2026-09-14。审查基线：`388bb4c` 及复查时的未提交工作区，验证截至本机约 01:53（Asia/Taipei）。其他任务仍在修改工作区；浏览器输入适配更新后，已重跑 Worker 定向测试与本报告的三项故障复现。本报告记录这一时点的结果，不代表后续修改已经复核。

对应方案：

- A：[Run 实时状态与观察](../spec/2026-09-13-run-realtime-observation.md)
- B：[受管浏览器实时画面与人工认证](../spec/2026-09-13-managed-browser-view-and-auth.md)
- C：[录制与 Scenario Studio 集成](../spec/2026-09-13-recording-studio-integration.md)

结论：**三条线的主体实现已经接通，本次范围内没有发现整体架构转向，但还不能按“全部开发完成并通过验收”收口。** 已确认 4 项 P1、4 项 P2。建议当前状态记为“主要实现完成，故障处理与联合验收待完成”。本次只复查、补故障复现和记录结果，未修改业务实现。

## 1. P1 / A：变化提示失败可使进程退出，首次并发发布还存在连接竞争

位置：[createChangeHintBus / createPostgresHint](../../packages/db/src/observe/create-hint.ts)，第 44–46、75–93 行；[publisher 契约](../../packages/db/src/observe/hint.ts)，第 8–17 行。

提交后回调用 `void bus.publish(...)` 丢弃 Promise，发布异常不会传回已有 `onCommit` 的错误处理。用 Node 24 独立进程，将变化提示连接指向本机关闭的端口，再调用 `publishChangeHint`，调用先返回，随后未处理的 `ECONNREFUSED` 导致进程以退出码 1 结束。该探针未写数据库业务数据。

另一个探针使用可连接的 PostgreSQL 和隔离的通知 namespace，同时调用两次首次 `publish`：第二次报 `Client has already been connected. You cannot reuse a client.`，另一次在 5 秒观察窗口内未完成。原因是 `publisherReady` 只在 `connect()` 完成后更新，没有共享连接中的 Promise；对同一个 `Client` 重复调用了 `connect()`。

这使辅助通知通道能够拖垮 API/Worker，破坏“通知只是变化提示”的可靠性边界。已经提交的数据库事实仍在，但运行进程及其活跃执行会受影响。

修复要求：在共同发布边界接住异步失败，使其可观测且不使进程退出；若交给 `onCommit` 处理，须同时贯通 publisher 类型与返回值。并发调用共享一次连接过程，失败连接可被替换。检查同文件的订阅恢复：目前 `end` 处理只挂在首次 listener 上，重连失败只尝试一次；这部分为静态检查发现，尚未做多轮断库实测。

验收：首次并发发布、发布时断连、初次 LISTEN 失败和多轮重连都不崩溃；恢复后能重新收到提示并从数据库补齐状态。

## 2. P1 / B：排队中的认证输入会重复执行，也能越过新的控制代次

位置：[BrowserSessionManager.inputRunAuthControl](../../packages/worker/src/browser/session-manager.ts)，第 1020–1084 行。

命令去重、序号、Run 状态、PageRef 和控制 token 校验在入队前完成；真正执行的串行回调只检查最新控制者与过期时间，没有重新核对控制 epoch/token，也没有再检查回执或序号。

两项受控故障复现均失败：

1. 暂停执行队列，同时提交两个相同 `commandId` 的输入，再放行队列。预期只调用一次浏览器输入，实际调用两次。
2. 合法输入入队后，同一 actor 的控制 epoch 从 1 变为 2，再放行旧输入。预期拒绝旧代次命令，实际成功执行。

复现运行真实 `inputRunAuthControl` 与串行队列逻辑，数据库读取和浏览器动作以受控替身注入时序；不是完整的双客户端浏览器验收。由代码同样可见，等待期间页面导航、Run 恢复等变化也没有在执行点完整复核。

修复要求：在同一串行受理/执行边界完成去重和序号判断，并在产生浏览器副作用之前复核所绑定的控制 epoch/token、Run 状态及页面身份；不能只检查 actor 相同。`resumeRunAuth` 也应按方案先关闭人工输入入口，再排空队列、验证登录和恢复运行，不能只插入一个空任务后继续受理新输入。

验收：并发重复命令只执行一次；旧控制代次、旧文档和恢复后的迟到输入均被拒绝；结果未知的输入不自动重放。

## 3. P1 / C：敏感字段判断没有接到真实采集端，普通命名的密码框仍会保留明文

位置：[previewRecording](../../packages/extension/playwright-crx/src/cairn/preview.ts)，第 28–40 行；[上传边界](../../packages/extension/playwright-crx/src/cairn/panel.tsx)，第 217–228 行；[isSensitiveFill](../../packages/shared/src/recording.ts)，第 457–463 行。

共享契约新增了 `inputType`、`autocomplete`、`markedSensitive`，清洗器也检查这些字段，但当前 Extension 直接读取 recorder 的 JSONL，没有补充这些 DOM 信息。核对已安装 `playwright-crx@0.15.0` 的 sourcemap：`pollingRecorderSource.ts` 对普通输入记录 `name/selector/signals/text`；`codegen/jsonl.ts` 只是展开 action/frame 并生成 locator。两处都没有提供上述敏感标记。

本地转换复现使用假值：

```js
{ name: 'fill', selector: '#field1', text: 'REVIEW_FAKE_PASSWORD_ONLY',
  signals: [], pageAlias: 'page', framePath: [] }
```

结果为 `mapped`，清洗后的源事件和候选步骤都保留假密码；补上 `inputType: 'password'` 后才正确转为参数化项并移除文本。因此，仅依靠 selector 中出现 password/otp 等词不能满足方案对真实密码框、验证码框的承诺。上传继续使用 `preview.events`，API 再调用同一归一化规则也无法恢复缺失的 DOM 信息。

修复要求：在真实采集边界识别并移除敏感值，保留必要的字段语义；敏感明文不得先进入可展示的录制 sources 或临时缓存。继续保留 API 清洗作为第二层校验，不用扩建一套凭据系统。

验收：用无敏感命名的 `input[type=password]`、`autocomplete=one-time-code` 与手动标记字段做实际 Chrome 录制，验证面板、上传体、持久化源事件及候选步骤都不含假秘密。本次完成的是采集源码追踪和转换复现，未输入或上传真实凭据。

## 4. P1 / 共用：现有工程门禁未通过，不能用单测通过代替可交付状态

`pnpm check` 失败：新增 [managed-browser.lab.spec.ts](../../packages/worker/src/browser/managed-browser.lab.spec.ts) 的三处 AI 适配层 import 被依赖检查器按 Worker 生产路径拦截。它是测试位置/检查规则不匹配，不应描述成已证实生产代码绕过了 AI 边界；也不能为了通过而删除生产路径的隔离检查。

`pnpm typecheck` 首先在 [managed-browser.test.ts](../../packages/shared/src/__tests__/managed-browser.test.ts) 第 81 行失败：联合类型解析结果未按 `type` 收窄就访问 `text`。独立检查其他受影响包还确认：

- Web：[browser-view.tsx](../../packages/web/src/features/runs/browser-view.tsx) 第 135 行对联合类型直接使用 `Omit`，使多处输入命令失去 `button/x/text/key` 属性；第 315 行还有 nullable `meta` 访问。
- Web：[step-editor.tsx](../../packages/web/src/features/scenarios/step-editor.tsx) 第 450 行的 `pageAfter` 被推断为普通 `string`，不满足 `'same' | 'popup'` 契约；A 的观察 hook 测试另有未使用参数。
- Worker：[engine.browser.spec.ts](../../packages/worker/src/engine/engine.browser.spec.ts) 第 412 行的 popup 用例没有正确收窄 Step 联合类型。
- API 独立 `typecheck` 通过。Web 日志另有已有 Step Editor 测试的 `Array.at` 库版本问题，本报告不将其全部归因于 A/B/C 新增改动。

修复要求：收窄/保留正确的命令和 Step 联合类型，并按实际测试边界修正 lab 放置或检查器识别。修复后重新通过根目录 `pnpm check` 与 `pnpm typecheck`。Vitest 的运行通过不包含这些类型验证。

## 5. P2 / C：右键、双击和带修饰键的点击被静默转换为普通左键点击

位置：[clickItem](../../packages/shared/src/recording.ts)，第 532–555 行。

源事件可以携带 `button`、`clickCount`、`modifiers`，但转换器只处理 target 和 popup。分别输入普通左键、右键、双击、带修饰键的 click，四者都得到 `status: 'mapped'`、相同的普通 click input，且没有不支持诊断。

例如，录制“右键打开菜单”可能回放为“左键激活该行”。这属于执行含义被改变，不能仅靠来源信息保留来弥补。该映射弱点也影响已有独立录制入口，现在接入可执行 Scenario 后成为 C 验收的明确缺口；不将它全部称为本次新引入的代码回归。

修复要求：现有 Step 契约不能精确表达的点击变体直接标为待处理，禁止 accept。先做这一最小修复，无需为了录制器的全部能力扩充 Runtime。

验收：上述变体要么按明确契约准确回放，要么阻止自动回填，不能默认为普通点击。

## 6. P2 / B+C：popup 之后回到父页的录制，仍会在 popup 上执行

位置：[normalizeRecording](../../packages/shared/src/recording.ts)，第 298–303 行；同文件 `sanitizeSignals` 第 418–425 行、`clickItem` 第 541–554 行。

复现输入为：父页 `page` 点击并打开 `page1`，随后用户回到父页 `page` 点击另一按钮。两个操作都被标为可接受；第一个产生 `pageAfter: 'popup'`，第二个只保留普通 target。`pageAlias` 仅在 Authoring 来源中保留，转换过程不维护当前页，信号清洗还移除了 popup alias。

B 执行第一步后已将当前受管页交给 popup，第二步便被解释到 popup。页面交接字段存在，并不等于录制的跨页来源都已被正确解释。

修复要求：转换时校验录制页面与当前执行页的关系。支持明确的前向 popup 交接即可；当前 IR 无法表达的返回父页、多页往返，标为待处理并阻止自动回填，不猜测当前页。若为校验保留来源 alias，应更新对应白名单和测试，不把录制器专有结构带进 Runtime。

验收：前向 popup 在真实 Worker 当前页上继续执行；返回父页等未支持路径必须显示诊断。这一项必须由 B+C 联合验证。

## 7. P2 / B：关闭画面连接没有中止 Worker 的订阅

位置：[streamFrames](../../packages/worker/src/internal/http-server.ts)，第 169–183 行；[pipeFrames](../../packages/worker/src/browser/session-manager.ts)，第 1172–1221 行。

内部 HTTP 入口在读取请求结束后才监听 `req.close`，没有绑定实际长响应的关闭生命周期。用真实内部 HTTP server、合法测试签名和 `fetch` 建立流，收到首条消息后中止连接，订阅收到的 `AbortSignal` 仍为 `false`；该回归断言失败。

Worker 的 `pipeFrames` 依赖此信号结束，每个残留订阅会继续定时读取 Run/Session 并处理画面，直到其他状态条件使其退出。同一实现没有在观察者离开时回收 screencast 的收尾逻辑。重复打开和关闭会累积无用订阅，现有单次连接测试没有覆盖这一点。

修复要求：用 response/socket 的断开事件可靠传播取消，并在订阅退出时移除监听、清除定时器，按现有观察者数量停止无人使用的画面采集。关闭观察不应销毁仍健康、可复用的 Browser Session。

验收：客户端取消后订阅及时结束；20 次连接/切页/关闭循环不持续增长连接、定时器和采集资源。同步验证认证持权期间掉线的撤权/到期行为，不能把 TTL 最终过期当作连接正确释放。

## 8. P2 / A：SSE 鉴权复核把数据库故障误判成登录失效

位置：[ObserveService.recheck](../../packages/api/src/runs/observe.service.ts)，第 296–307 行；[useRunObservation](../../packages/web/src/features/runs/use-run-observation.ts)，第 101–110 行。

`resolveAccount` 的任何异常都被转为 `UNAUTHORIZED`，Web 收到这个控制消息后会清空当前登录。直接对真实 `recheck` 方法注入一次数据库 `ECONNRESET`，得到的结果就是 `UNAUTHORIZED`，而不是可恢复的基础设施故障。

因此，一次数据库短暂不可用可能让原本有效的控制台用户被登出。这条新 SSE 路径需要遵守已有鉴权错误分类，不能退回到“读取账号失败就认为 token 无效”。

修复要求：区分真正的无效身份、权限撤销和基础设施错误。无法复核时停止发送受保护数据并进入可恢复状态，但不要清除仍可能有效的登录凭据；恢复后重新鉴权再开流。

验收：数据库故障不清空登录；token 过期、账号停用、权限收回仍按其正确语义停止访问。

## 9. 验证结果与覆盖边界

| 验证 | 本次结果 | 范围 |
| --- | --- | --- |
| Shared | 27 项通过 | event、managed-browser、recording-import、recording |
| DB | 54 项通过 | run-observation、auth-control、recordings-import，含 PostgreSQL/MySQL/SQLite 隔离库 |
| API | 17 项通过 | observe、browser HTTP、recordings HTTP、Scenario recording integration |
| Worker | 5 项通过 | managed-browser lab/helper/boundary、internal HTTP；`CAIRN_S_LIVE=1`，真实 Chromium；输入适配更新后重跑通过 |
| Web | 37 项通过 | SSE、观察 hook、BrowserView、Studio，Chromium 测试 |
| Extension | 29 项通过 | 当前两份单元测试文件 |
| 本次新增故障复现 | **3 项失败** | 输入重复执行、旧控制 epoch 放行、断开画面未中止订阅 |
| 根目录 `pnpm check` | **失败** | AI 隔离检查误把新增 lab 按生产路径拦截 |
| 根目录 `pnpm typecheck` | **失败** | Shared 首个失败；独立检查确认 Web/Worker 也失败，API 通过 |
| 迁移文件检查、宪法不变量检查 | 通过 | 单独执行检查脚本，三库共 46 份迁移文件；不等同于所有运行时不变量都已验证 |

现有定向测试合计 **169 项通过**，重跑同一用例不重复计数。三个诊断用例没有算入这 169 项，失败证据见[归档复现代码](2026-09-14-abc-repro/worker-races.spec.ts.txt)。独立通知、转换器和 SSE 鉴权探针另作为上述条目的证据，不伪装成已经加入常规套件的测试。

本次没有执行全仓所有测试，也没有重跑 Extension 的真实 Chrome 导入探针、实际控制台目标登录闭环和外部目标系统联调。B 方案自己保留的 **BV08 展示链路 p95/20 次循环、BV09 Studio 真实登录闭环**仍未关闭；headless S-LIVE 成功不能替代这两项。

复现代码为审查留档，已从 Worker 源码目录移出，不给其他任务留下额外的必失败测试文件。修复时可在确认目标文件不存在后，临时复制到 `packages/worker/src/browser/abc-review-repro.spec.ts`，执行：

```sh
pnpm --filter @cairn/worker exec vitest run src/browser/abc-review-repro.spec.ts
```

完成后将有效回归纳入相应正式测试，并删除临时副本。原始执行日志保留在本机 `/tmp/cairn-abc-review-*.log`，属于临时诊断文件；本报告和归档复现是持久记录。

## 10. 收口顺序与并行边界

开发排序仍以[工程实施计划第 5 节](../plan/识途开发路线与工程实施计划.md#5-当前交付顺序与验收样例)为准，本报告不另建一套排期。

| 工作 | 可并行性 | 本次建议的完成条件 |
| --- | --- | --- |
| A 修复通知和鉴权恢复 | 可与 B/C 同时修复 | 第 1、8 项复现关闭，通知故障不损害进程及有效登录 |
| B 修复输入与画面生命周期 | 可与 A/C 同时修复 | 第 2、7 项复现关闭，补 BV08/BV09 |
| C 修复采集敏感语义与转换 | 可与 A/B 同时修复 | 第 3、5、6 项关闭；popup 校验与 B 对齐 |
| 共用工程门禁 | 随上述修复收口 | 第 4 项关闭，共享 Schema/类型由一处协调，避免各线各改一版 |
| D1 联合验收 | 依赖 A+B 与已有 AI/Studio | 真实等待认证→独占输入→验证登录→续跑→实时状态/证据；同时验证断线、旧输入和页面交接 |
| D2 联合验收 | 依赖 C 和已通过的 D1 | 录制→预览回填→编辑/插入 AI→试跑→发布；正式运行不依赖插件，未支持动作不被静默接受 |

优先修复进程可靠性、认证控制权和敏感值处理，并让工程门禁恢复；其余缺陷可在各自线上一并解决。当前不需要重写三份方案或引入新的执行/录制框架，需要把现有方案承诺的故障边界和用户闭环补齐。
