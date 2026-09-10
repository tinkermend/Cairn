# 上游

| 项 | 值 |
| --- | --- |
| 仓库 | https://github.com/ruifigueira/playwright-crx |
| 标签 | `v0.15.0` |
| commit | `aafff2cf3d9bf96cb55ed605e2b2a0c44711e6ac` |
| 壳 | `examples/recorder-crx` |
| 引擎 | npm `playwright-crx@0.15.0` |
| 许可证 | Apache-2.0（见 `LICENSE` / `NOTICE`） |

`vendor/` 来自同一标签下的 Playwright 内部源，只够编录制器 UI，不是整仓 fork：

- `vendor/playwright-web` ← `playwright/packages/web/src`
- `vendor/playwright-recorder` ← `playwright/packages/recorder/src`
- `vendor/playwright-protocol` ← `playwright/packages/protocol/src`
- `vendor/playwright-isomorphic` ← `playwright/packages/playwright-core/src/utils/isomorphic`

构建：本包用 Vite 6（与上游 `recorder-crx` 一致）。Vite 8 / Rolldown 解析不了 npm 包里残留的 `require("../playwright")`。`vite.config.ts` 里对这两处相对路径做了空 stub，Player 主路径不依赖它们。

相对上游壳的故意差异：

1. 安装/更新不再打开 GitHub Release 页（`src/cairn/onExtensionInstalled`）。
2. 扩展显示名为「识途录制器」；图标换成观测证据标（`public/logo-observe.svg`）。
3. 用户可见描述性文案改为中文。专有名词与代码不译。录制器 `Target:` 改为「代码语言」，避免和平台 Target 撞车。

汉化覆盖（升级 `vendor/` 时对照重打）：

- `vendor/playwright-recorder/recorder.tsx`：工具栏、侧栏页签、placeholder。
