# 浏览器扩展

本目录是**命名空间，不是一个 npm 包**。不要在这里放 `package.json`。

每个要二开的上游插件占一个子目录、一个独立 workspace 包、一份独立的 Chrome 扩展产物。不要把 Playwright 录制器、Midscene、page-agent 揉进同一个 MV3 扩展。

```text
packages/extension/
  playwright-crx/    # @cairn/extension-playwright-crx   识途录制器（P12）
  shared/            # @cairn/extension-shared           两个以上插件要共用登录/上传时再拆
```

Midscene、page-agent 是整仓二开，源码在 [`vendor/`](../../vendor/README.md)，不要再拷进本目录。扩展在 fork 里编：`vendor/midscene/apps/chrome-extension`、`vendor/page-agent/packages/extension`。

| 子目录 | 上游 | 识途用途 |
| --- | --- | --- |
| `playwright-crx` | [ruifigueira/playwright-crx](https://github.com/ruifigueira/playwright-crx) 的 `examples/recorder-crx` | 挂用户 Chrome，录结构化操作，用控制台账号上传进录制草稿 / IR |

约定：

1. 包名 `@cairn/extension-<子目录名>`。
2. 只允许依赖 `@cairn/shared`（以及将来的 `@cairn/extension-shared`）。不得依赖 `api` / `worker` / `db` / `web`，扩展之间也不得互相 import。
3. 保留该上游扩展自己的能力，识途功能放在子目录内的 `src/cairn/`（或等价隔离目录），不要改上游内核。
4. 本地 Player / Playground 只做 Authoring 预览。正式 Run 仍走 Worker；卸载扩展不得影响执行。
5. 新增子目录时：建包 → 在 `tools/check-deps.mjs` 登记边表 → 写该插件的 `UPSTREAM.md`。
