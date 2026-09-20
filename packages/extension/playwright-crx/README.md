# `@cairn/extension-playwright-crx`

识途录制器。对 [playwright-crx](https://github.com/ruifigueira/playwright-crx) `examples/recorder-crx` 的二开。上游来源见 [UPSTREAM.md](./UPSTREAM.md)。

- **留下**：挂 tab、Side Panel 采集。引擎仍是 `playwright-crx@0.15.0`。
- **产品壳**：`src/cairn/`。未登录不能录制；环境写在代码里（本期只有本地 `http://localhost:3030`）；主界面是 IR 步骤列表，不是代码窗。
- **不要**：Python / 语言下拉、主题切换、Player 当正式 Run、手填 API、实验「保存代码 / storage state」。

方案：[工作台收敛与设计语言对齐](../../../docs/spec/2026-09-13-extension-workbench-ui.md)。

示教一期增加 `cairn-crx-capture@1`：在固定的 `playwright-crx@0.15.0` 录制接缝采集合并前事实，上传到现有录制草稿与 Studio。原生输入发生后取到的观察只标最近缓存或缺失，不能冒充原始前态；页面、Frame、导航代次与缺口随事实保存。构建插件验证接缝形状，升级录制内核时必须重新验证。旧 JSONL 仍可导入；任意 Playwright JS/TS 文件不在支持范围。

## 开发

产物在 `dist/`。Chrome 只认这个目录，不认 `src/`。

在本目录执行：

```bash
pnpm build
```

Chrome 打开 `chrome://extensions` → 打开开发者模式 →「加载已解压的扩展程序」→ 选本目录下的 `dist`。

以后改了代码：再跑一遍 `pnpm build`，回到扩展页点**重新加载**。已打开的 Side Panel 先关掉，再点工具栏图标。

只编译、不点重新加载，service worker 还是旧的。改了 `manifest.json` 的权限、命令或后台脚本名时，卸掉再加载一次。

边改边编用 `pnpm dev`（`vite build --watch`）。`dist/` 会自动更新，Chrome 里仍要手动重新加载。

人在仓库根目录时，也可以 `pnpm --filter @cairn/extension-playwright-crx build`，效果一样。

不要把 `src/` 或仓库根目录加载进 Chrome。

未登录时点图标只打开登录页，不会挂 `chrome.debugger`。登录后在侧栏点「录制」才挂当前标签页。正式 Run 走平台 Worker。

## 真实 Chrome 验收

`pnpm test` 覆盖不到侧栏接管：登录门禁、面板内点录制、真实操作产生步骤、删除与撤销这些都要真的 Chrome 才会暴露问题。改了 `background.ts`、`panel.tsx`、`preview.ts` 或 `manifest.json` 后跑一次探针：

```bash
pnpm build          # 探针只认 dist/
pnpm probe:panel
pnpm probe:import   # D2：绑定领取、真实录制上传、Studio 回填
```

要求本地 API 在跑（默认 `http://localhost:3030`）。`probe:import` 还要本地 Web（默认 `http://localhost:5173`）。默认账号 `admin` / `cairn-admin`，用环境变量覆盖：`CAIRN_PROBE_API`、`CAIRN_PROBE_WEB`、`CAIRN_PROBE_EMAIL`、`CAIRN_PROBE_PASSWORD`。

会开一个有头 Chrome，被录页面是脚本内置的本地夹具，不打外部站点。全部通过时退出码 0，任一项失败退出码 1 并逐条打印。

两处与真实使用不同，看结果时要知道：`sidePanel.open()` 需要用户手势，自动化打不开侧栏，所以脚本用扩展页标签顶替侧栏，并用重载那一页顶替真实侧栏「换路径 → 重载 → 重连」里的重连。侧栏本身的接管时序另有回归单测 `src/cairn/__tests__/attach-panel.test.ts`。
