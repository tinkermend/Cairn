# 编写观察面接续实施报告

日期：2026-09-14。对应方案：[编写观察面：指认、调试会话与步骤词表](../spec/2026-09-14-authoring-observation-debug-steps.md)。

先前开发停在契约、迁移、部分 DB 与半成品引擎。对照方案接续完成后，本轮补上测试夹具、Studio Hold 条重复、写回草稿丢覆盖，以及二次收口时发现的契约分叉。

## 相对方案的进度

| 增量 | 状态 | 说明 |
| --- | --- | --- |
| I1 观察 / 高亮 | 已落地 | pick 先提取描述符再走 `locate()`；AMBIGUOUS 列出邻近文本；Live View SVG 叠加用 `--action-primary` |
| I2 Hold 中 pick / 写回 / 覆盖 | 已落地 | 指认只出 Observation；「本次验证」写 `debugOverlay`；「写回草稿」OCC 保存后丢掉该步覆盖 |
| I3 词表 + normalizer@3 | 已落地 | select / keyboard / wait；click 语义字段；缺 click 字段不猜左键；采集端按定位补 `inputType` |
| I4 HOLDING / retry / continue / stop | 已落地 | 检查点写 `pageRef`/`url`；页变未确认拒绝再试；成功 Hold 后 continue 不截断 Snapshot |
| I5 插件观察 | 已补采集 | `isSensitiveFill` 清洗插件目标；选取后可「提交指认」；JSONL 仍不猜普通左键 |
| I6 编写辅助 | 明确不做 | `authoring.assist = closed` |

## 本轮收口

- 指认不再同时改草稿和覆盖。Studio「本次验证」与「写回草稿」分开。
- pick 不再伪造 `matches: 1`，命中后必须经 Resolver；同源 iframe 会继续 `elementFromPoint`。
- highlight 不再默认 `html`。没有目标时只签发 grant 或清理覆盖，不假装找到页面根节点。
- `observeGrant`：highlight 签发/刷新，pick 必须拿着未过期且同页的 grant，过期返回 `OBSERVE_GRANT_EXPIRED`。
- 检查点写入当前 `pageRef`/`url`；`retry_current` 在页变且未 `pageChangedAck` 时拒绝，Studio Hold 条弹出确认。
- 能力位关闭时隐藏指认 / 校验；Hold 条展示期望 vs 实际。
- 插件选取可提交指认；密码定位在 JSONL 解析时补 `inputType`。

## 验证范围

在包内用 `pnpm exec vitest run <files>` 跑过（不要用 `pnpm test -- file`，多一层 `--` 会丢掉文件过滤）：

| 包 | 文件 | 结果 |
| --- | --- | --- |
| `@cairn/shared` | `authoring-observation` / `recording` | 23 通过 |
| `@cairn/worker` | `observe-grant` / `engine.browser` | 33 通过 |
| `@cairn/worker` | `surface.lab`（含编写夹具页） | 7 通过 |
| `@cairn/web` | `authoring-observe` / `studio` | 29 通过 |
| 录制插件 | `workbench` | 26 通过 |
| 设计检查 | `pnpm check:design` | 通过 |

控制台抽查：已登录管理员打开「录制回填验收」点击步，可见「在页面上指认 / 校验高亮」，无调试会话时没有「本次验证」。未开真实试跑，因此没有 Hold 条和 Live View 指认。

未在本报告中宣称通过：

- AO01–AO20 全量控制台与真实受管页画面（含 AuthControl 对打、刷新 Studio 仍 HOLDING 的人工路径）
- 1366 / 1440 / 1920 与窄屏的人工画面全套验收
- 插件在真实目标页点选后回填的端到端

正式开放前不得把本线写成已交付。

## 已知限制

- I6 编写辅助保持 closed
- 无调试会话时指认只提示走插件或先试跑，不另开裸浏览器
- Playwright JSONL 若不带 `button` / `clickCount` / `modifiers`，归一化仍标 unresolved，不会猜成左键
- Hold 超时走 `DEBUG_SESSION_TIMEOUT`；Worker 失联仍由 `settleLeaselessRun` 收成 `DEBUG_WORKER_LOST`
