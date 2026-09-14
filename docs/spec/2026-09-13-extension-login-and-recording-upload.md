# 识途录制器：控制台登录与录制上传

日期：2026-09-13。状态：**已落地**。  
范围：在现有 `packages/extension/playwright-crx` 壳上接入控制台账号、Target 绑定与整批 Raw Trace 上传；平台新增 Authoring 草稿，不改采集内核，不发布可执行 Scenario。

前置：[识途 Recorder 扩展：图标、中文与忽略规则](2026-09-10-extension-playwright-crx-chrome.md)（已落地，当时明确不含登录与上传）。方向见 [混合自动化与录制编排复核](2026-09-13-hybrid-authoring-direction-review.md) §5.2–5.3。对应计划 P12 的第一段：能登录、能上传、能在控制台看到草稿。

## 1. 为什么现在写

采集引擎已经能挂用户 Chrome 并产出 JSONL。缺的是和平台账号体系打通，以及把操作序列交给平台变成可编辑草稿。不能把这段能力做成第二个扩展，也不能把 JSONL 直接 `POST /api/scenarios`。

## 2. 目标与非目标

### 目标

1. 插件用**控制台账号**登录同一套 API（`POST /api/auth/login` + Bearer）。
2. 登录后选择 **Target**，把本段录制整批上传。
3. 服务端从 JWT 认定上传人，校验 Target、体积、结构与幂等，归一成 IR 草稿并返回草稿 ID。
4. 控制台「录制草稿」可列出并打开草稿：已映射步骤、待处理项、敏感值已剥离。
5. 采集内核与 `vendor/` 不改。登录 / Target / 上传只在 `src/cairn/`。

### 非目标

- 不新开采集插件，不把 Midscene / page-agent 揉进同一 MV3。
- 不把 JSONL、codegen、storage state 当成 Scenario 事实源。
- 不在本期把草稿编译成正式 `ScenarioVersion`，不做 Sequence Editor。
- 不用插件 Player 当正式 Run。
- 不做配对码 / PAT / 刷新令牌；密码进扩展是权宜，写明即可。
- 不上传 Cookie、localStorage、storage state。
- 不流式上传。

## 3. 决策

### D1. 二开壳，不换采集引擎

`playwright-crx@0.15.0` 继续负责挂 tab 与采集。Side Panel 已能收到 `sources` 里 `id === 'jsonl'` 的 `actions` / `text`，不必 fork vendor 或引擎的 `getActions()`。

产品层（登录、选 Target、上传、本地 token）全部放 [`packages/extension/playwright-crx/src/cairn/`](../../packages/extension/playwright-crx/src/cairn/index.ts)。工具条加在 [`crxRecorder.tsx`](../../packages/extension/playwright-crx/src/crxRecorder.tsx) **上方**，与实验「保存代码」分开，且默认可见。

### D2. 插件登录 ≠ TargetAccount

复用 `POST /api/auth/login`。Token 存 `chrome.storage.local`。扩展读不到控制台 cookie，人在 Web 已登录 ≠ 插件已登录。打开面板先 `GET /api/me`，401 再登。

TargetAccount 是运行时登业务系统的账号，不能拿来推断上传者。viewer（无 `workflow:write`）不能上传。选 Target 需要 `target:read`。

API 源写在扩展设置，默认 `http://localhost:3030`。用 `optional_host_permissions` 在登录手势里申请该 origin。业务请求经 service worker 发出；API 同时放行 `chrome-extension://` Origin，避免 Side Panel 预检没有 `Access-Control-Allow-Origin`。不把具体扩展 ID 写进 `CAIRN_CORS_ORIGINS`。控制台 localStorage 与插件 `chrome.storage.local` 各持一份 JWT，互不覆盖。

### D3. 新 Authoring 接口，不复用创建场景

| 方法 | 路径 | 权限 | 作用 |
| --- | --- | --- | --- |
| `POST` | `/api/recordings` | `workflow:write` | 整批上传，幂等，返回草稿 |
| `GET` | `/api/recordings` | `workflow:read` | 列表 |
| `GET` | `/api/recordings/:id` | `workflow:read` | 详情（IR 项 + 脱敏后的来源事件） |

`POST /api/scenarios` 仍然只接受已可执行 Structured Step。录制重传不得插入第二条草稿：唯一键 `(created_by, idempotency_key)`，摘要相同返回原文，不同则 `RECORDING_IDEMPOTENCY_CONFLICT`。

### D4. 服务端归一化是真相

映射函数在 `@cairn/shared`（`normalizeRecording` / `parseJsonlSource`）。插件可预览诊断，服务端再跑一遍。IR 允许不完整，不进入正式调度。

### D5. 敏感值在采集侧与服务端各剥一次

`fill` 的定位串匹配密码 / 口令 / token / 验证码等则去掉 `text`，IR 标 `parameterized`。禁止请求体携带 `storageState` / `cookies` / `localStorage` / `sessionStorage`。不根据填写内容「看起来像密码」来猜。

## 4. JSONL 探针结论（S08 最小表）

夹具对齐 `JsonlLanguageGenerator` + `JsonlLocatorFactory`。`about:blank` 的 `openPage` 丢弃。连续相同目标的 `fill` 合并为最后一次值。

| 上游 action | 可捕获 | 可导入为 IR | 现有 Step 可执行 | 处理 |
| --- | --- | --- | --- | --- |
| `navigate` / 带 URL 的 `openPage` | 是 | 是 | `navigate` | 映射 |
| `click` | 是 | 是 | `click` | 映射；`role` / `label` / `text` / `title` / `test-id` / 简单 css |
| `check` / `uncheck` | 是 | 是（按点击） | `click` | 映射并诊断 |
| `fill` | 是 | 是 | `fill` | 映射；敏感则转参数 |
| iframe `framePath` | 是 | 是 | FrameStep.selector | 写入 `target.framePath` |
| `assertVisible` / `assertText` | 是 | 是 | `assert` | 映射 |
| `press` / `select` / `setInputFiles` | 是 | 待处理 | 无 | `unresolved`，不静默丢 |
| `closePage` | 是 | 待处理 | 无 | `unresolved` |
| `assertValue` / `assertChecked` / `assertSnapshot` | 是 | 待处理 | 无对应 kind | `unresolved` |
| popup / download / dialog signal | 是 | 诊断 | 否 | 不生成步骤 |

复杂 locator（`has` / `and` / `or` / `nth`）本期若不能落到四种 `LocatorBy`，该步 `unresolved`。`internal:` 选择器不能当 css 兜底。

## 5. 契约

```text
POST /api/recordings
{
  targetId, recordingId, sourceVersion, idempotencyKey, name?,
  events: [ /* JSONL action 对象 */ ]
}
→ RecordingDraftDetail
```

限制：最多 200 条；整包 JSON ≤ 256KiB；`sourceVersion` 建议 `playwright-crx@0.15.0`。业务 API 只用 GET / POST。

落库表 `recording_drafts`。审计 `recording.create`。卸载扩展不影响已上传草稿，更不影响正式 Run。

## 6. 现在不做

草稿编译发布、编辑器内补参数后试跑、配对码登录、流式上传、把 Player 当 Run、升级 playwright-crx 内核。
