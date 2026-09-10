# `@cairn/extension-playwright-crx`

识途录制器。对 [playwright-crx](https://github.com/ruifigueira/playwright-crx) `examples/recorder-crx` 的二开。上游来源见 [UPSTREAM.md](./UPSTREAM.md)。

- **留下**：挂 tab、Side Panel 录制、快捷键、Player、导出代码、选项页。
- **加上**：`src/cairn/`。目前只接管安装钩子；登录、Target、上传后续加在这里。
- **引擎**：npm `playwright-crx@0.15.0`。`vendor/` 只放编 UI 用的 Playwright 内部源。

## 开发

产物在 `dist/`。Chrome 只认这个目录，不认 `src/`。

在本目录执行：

```bash
pnpm build
```

Chrome 打开 `chrome://extensions` → 打开开发者模式 →「加载已解压的扩展程序」→ 选本目录下的 `dist`。

以后改了代码：再跑一遍 `pnpm build`，回到扩展页点**重新加载**。已打开的 Side Panel 先关掉，再点工具栏图标挂一次 tab。

只编译、不点重新加载，service worker 还是旧的。改了 `manifest.json` 的权限、命令或后台脚本名时，卸掉再加载一次。

边改边编用 `pnpm dev`（`vite build --watch`）。`dist/` 会自动更新，Chrome 里仍要手动重新加载。

人在仓库根目录时，也可以 `pnpm --filter @cairn/extension-playwright-crx build`，效果一样。

不要把 `src/` 或仓库根目录加载进 Chrome。

Player 只做本地预览。正式 Run 走平台 Worker。
