# FlowGram 10 步混编验证

本目录用于独立 worktree 中的接入验证。正式方案仍待审查，默认步骤列表保留。FlowGram 仅负责顺序画布；ScenarioDocument、Compiler、草稿 revision、试跑和 Evidence 继续走识途已有链路。

## 本次工作区

- 分支：`codex/flowgram-sequence-spike`
- 基线：`97cf9629b119fdc734619c329b1497d2042423f9`。该提交保存了原工作区当时的未提交状态；审查本次变化应对比此提交，不能把它与更早主线之间的差异当成 FlowGram 改动。
- 独立前端默认 5186；独立靶场 4186；复用本地 API 3030 和已运行 Worker。本次未重启或迁移既有服务。
- 样例需要平台 browser AI 已配置可执行模型。平台管理员使用 `.env` 中的 bootstrap 配置登录；脚本不打印或落盘登录 token、账号口令。

## 复现

在 worktree 根目录安装依赖、构建 shared：

```sh
pnpm install --frozen-lockfile --filter @cairn/web...
pnpm --filter @cairn/shared build
```

分别启动两个本地预览进程：

```sh
LAB_PORT=4186 node tests/target-surface-lab/server.mjs
pnpm --filter @cairn/web exec vite --host 127.0.0.1 --port 5186 --strictPort
```

指定实际环境文件运行。每次 seed 创建一个新的 Scenario，同时复用本样例 Target / Account；已有样例无需重复 seed。

```sh
node --env-file=../Cairn/.env tools/flowgram-spike/seed.mjs
node --env-file=../Cairn/.env tools/flowgram-spike/verify-editor.mjs
node --env-file=../Cairn/.env tools/flowgram-spike/trial.mjs
node --env-file=../Cairn/.env tools/flowgram-spike/verify-boundaries.mjs
node --env-file=../Cairn/.env tools/flowgram-spike/proof.mjs
```

seed 支持 `CAIRN_API_ORIGIN`、`FLOWGRAM_LAB_ORIGIN`、`FLOWGRAM_WEB_ORIGIN`；验证脚本按默认靶场端口运行。入口和当前成功 Run ID 保存在 `.artifacts/flowgram-spike/sample.json`。试跑通过 UI 发起，终态等待沿用 UI 的 SSE 更新；超时才做一次恢复读取。

编辑验证会修改本样例草稿并恢复原定义，revision 按真实保存次数递增。它不会修改其他 Scenario。若中途失败，先检查该样例当前草稿及 `.artifacts/flowgram-spike/` 中的结果，不要将失败当作通过。试跑遇到 HOLDING 时应先在控制台查看原因和处理，再创建下一次运行。

本地业务靶场的登录仅用于验证平台 TargetAccount / Session / Lease 链路，接受非空测试账号与口令，**没有真实业务系统的鉴权强度**。业务登记写入独立靶场 journal，未写入外部业务系统。应单独串行运行本样例，使按 Run 时间窗核对登记次数具有可解释性。

## 检查与记录

9/15 按用户反馈恢复并排编辑并修正诊断表达，见[交互修正报告](../../docs/reviews/2026-09-15-flowgram-editor-ux.md)。本机恢复服务使用 `../Cairn/.env.local` 的本地数据库；新的只读联调脚本不保存草稿、不发起试跑：

```sh
node --env-file=../Cairn/.env.local tools/flowgram-spike/verify-navigation.mjs
node --env-file=../Cairn/.env.local tools/flowgram-spike/verify-snake.mjs
```

```sh
pnpm --filter @cairn/web test src/features/scenarios/flowgram/adapter.test.ts src/features/scenarios/studio.test.tsx src/features/scenarios/studio-document.test.ts src/features/scenarios/trial-dialog.test.tsx
pnpm --filter @cairn/web exec eslint src/features/scenarios/flowgram
pnpm check:design
pnpm --filter @cairn/web exec vite build
pnpm --filter @cairn/web typecheck
```

蛇形排布、列表空列修正及实际截图见[9/15 排布验收](../../docs/reviews/2026-09-15-flowgram-snake-layout.md)。`verify-navigation` 显式选择纵向以复测原交互，`verify-snake` 覆盖折行方向、拖动、插入、视图切换与响应式；两者仅编辑浏览器内草稿。

运行截图和原始读取结果留在被忽略的 `.artifacts/`；审查用的脱敏摘要和最终截图在 [验证报告](../../docs/reviews/2026-09-14-flowgram-sequence-spike.md) 中登记。完整 typecheck 的已有阻断也在报告中列出。
