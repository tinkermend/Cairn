# 识途 Recorder 扩展：图标、中文与忽略规则

日期：2026-09-10。状态：**已落地**。  
范围：`packages/extension/playwright-crx` 已迁入的 `recorder-crx` 壳。不接上传、登录、Target，不改采集内核。

## 1. 为什么现在写

扩展已经能编、能加载，但还是 Playwright CRX 的脸：工具栏图标是上游 PNG，面板里是英文，Chrome 商店原版和识途装在一起时不好认。这三件事不碰 Runtime，适合在加上传之前先收口，避免后面文案和资源再和功能改动缠在一起。

品牌已选定 B「观测证据」（`docs/design/front/brand.md`）。控制台 `Logo` 用的就是 `packages/web/src/assets/brand/logo-observe.svg`。扩展必须用同一份，不能另画。

## 2. 目标与非目标

### 目标

1. 工具栏、扩展管理页、Side Panel 页签图标都换成识途观测证据标。
2. 用户能看见的描述性文字改成中文；专有名词、代码、快捷键保留原文。
3. 扩展目录里不该进 git 的产物写进忽略规则，并写清 `vendor/` 为什么要进仓。

### 非目标

- 不上传 Raw Trace、不接控制台登录、不绑 Target。
- 不改 Player / 录制事件语义，不改 `playwright-crx` 引擎。
- 不建 i18n 框架、不做英文回退。
- 不翻译生成的 Playwright 代码、Call Log 里的 API 调用串、LICENSE 头。
- 不把 `vendor/playwright-web`、`vendor/playwright-isomorphic` 整包汉化。
- 不打 Chrome 网上应用店包、不改权限模型。

## 3. 决策

### D1. 图标只用观测证据标

源文件：`packages/web/src/assets/brand/logo-observe.svg`。扩展里放一份拷贝，避免扩展包 import `@cairn/web`（依赖方向禁止）。

| 用途 | 文件 | 尺寸 |
| --- | --- | --- |
| 工具栏 / 扩展管理 | `public/icon-16x16.png` 等 | 16 / 32 / 48 / 128（128 用现有 `icon-192x192.png` 槽位，按 128 导出） |
| 面板 favicon | `public/playwright-logo.svg` 换成同一 SVG，文件可改名为 `logo-observe.svg`，并改 `index.html` | 矢量 |

生成方式：本机用 `sips`（macOS）或一次性脚本从 SVG 栅格化 PNG，**把 PNG 和 SVG 一齐提交**。不在每次 `pnpm build` 里生成，避免构建依赖图像工具。

旧的 Playwright 面具 PNG / `playwright-logo.svg` 删除，不留双套图标。

### D2. 只改用户可见文案，专有名词不译

**保留原文**

| 类 | 例子 |
| --- | --- |
| 产品 / 引擎 | Playwright、识途、Recorder（仅包名与路径） |
| 语言与运行器 | Node.js、Java、Python、C#、JUnit、Pytest、MSTest、NUnit |
| 选择器属性 | `data-testid`、testid 属性名本身 |
| 快捷键 | F8、F10、Alt+Shift+R、Alt+Shift+C |
| 代码与导出 | `page.getByRole(...)`、文件名 `example.spec.ts` |
| 协议词 | Aria（面板专有，保留；说明可用「无障碍快照」作副标，本期只改标题的话用「Aria」） |

**会和平台词撞车的，必须改掉**

录制器工具栏上的 `Target:` 是「导出哪种代码」，不是识途的 Target。改成 **「代码语言」**，避免和目标系统混淆。

**扩展显示名**：`识途 Recorder` 改为 **「识途录制器」**。包名 `@cairn/extension-playwright-crx` 不动。

**改文案的文件（壳，必做）**

| 位置 | 现行 | 改为 |
| --- | --- | --- |
| `public/manifest.json` `name` | 识途 Recorder | 识途录制器 |
| 同上 `action.default_title` | Record | 开始录制 |
| 同上 `commands.*.description` | Start recording / Start inspecting | 开始录制 / 开始检查 |
| `index.html` / `preferences.html` `<title>` | 识途 Recorder… | 识途录制器 / 识途录制器 - 偏好设置 |
| `background.ts` 工具栏标题 | Stopped / Record / Recording / Inspecting | 已停止 / 录制 / 正在录制 / 正在检查 |
| 同上右键菜单 | Attach to Playwright Recorder | 挂到识途录制器 |
| 同上无痕错误 | Not authorized to launch in Incognito mode. | 未授权在无痕窗口运行。 |
| `preferencesForm.tsx` | Default language 等整表 | 见下 |
| `crxRecorder.tsx` 实验工具条 | Preferences / Save / Tools / Download storage state | 偏好设置 / 保存 / 工具 / 下载 storage state |
| `saveCodeForm.tsx` | File Name / Enter file name / Save | 文件名 / 输入文件名 / 保存 |

偏好设置中文：

| 现行 | 改为 |
| --- | --- |
| Default language | 默认代码语言 |
| Library / Test Runner / Library Async | 程序库 / 测试运行器 / 异步程序库 |
| TestID Attribute Name | testid 属性名 |
| Enter Attribute Name | 输入属性名 |
| Must be a valid attribute name | 必须是合法的属性名 |
| Open in Side Panel | 在侧边栏打开 |
| Play in incognito | 在无痕窗口回放 |
| This feature requires… | 需要先允许此扩展在无痕模式下运行。 |
| Allow experimental features | 启用实验功能 |
| Save / Saved | 保存 / 已保存 |

**改文案的文件（录制器主界面，必做）**

用户每次录制都看这块，只改 `vendor/playwright-recorder/recorder.tsx`（及该目录里直接露出的标题），不改 `vendor/playwright-web`。

| 现行 | 改为 |
| --- | --- |
| Record | 录制 |
| Pick locator | 选取定位 |
| Assert visibility / text / value / snapshot | 断言可见 / 断言文本 / 断言值 / 断言快照 |
| Copy | 复制 |
| Resume (F8) / Pause (F8) / Step over (F10) | 继续 (F8) / 暂停 (F8) / 单步 (F10) |
| Target: | 代码语言： |
| Clear | 清空 |
| Toggle color mode | 切换配色 |
| Locator / Log / Aria | 定位 / 日志 / Aria |
| Type locator to inspect | 输入定位以检查 |
| Type aria template to match | 输入 Aria 模板以匹配 |

徽章 `REC` / `INS` 保持三个字母，工具栏空间不够写汉字。`title` 用中文。

升级 `vendor/` 时对照这张表重打补丁，在 `UPSTREAM.md` 加一节「汉化覆盖」。

### D3. 忽略规则：产物忽略，`vendor/` 进仓

根 `.gitignore` 已经忽略 `dist/`、`node_modules/`、`*.tsbuildinfo`、`.vite/`。扩展编出来的 `dist/` 本来就不会进库。

缺的是**打包与密钥**，写在包内忽略文件，避免以后打 zip / 签名时误提交：

`packages/extension/playwright-crx/.gitignore`

```gitignore
*.crx
*.zip
*.pem
```

**要进仓**

- `src/`、`public/`（新图标与 SVG）、配置、`UPSTREAM.md`
- `vendor/`：没有它 `pnpm build` 编不出录制器 UI。不 ignore。体积约 1MB 源码，换「每人先克隆上游再同步」更脆。

**不要进仓（已由根规则覆盖，方案里只确认）**

- `dist/`（含 `background.js` 和 `.map`）
- `node_modules/`

不在根 `.gitignore` 加 `packages/extension/**/dist` 之类重复规则。

## 4. 落地时改哪些文件

| 文件 | 动作 |
| --- | --- |
| `public/icon-*.png` | 用观测证据标重导 |
| `public/logo-observe.svg` | 从 web brand 拷入；删 `playwright-logo.svg` |
| `index.html` | favicon 与标题 |
| `public/manifest.json` | 名称、图标、命令说明 |
| `src/background.ts` | 工具栏 / 菜单 / 错误 |
| `src/preferencesForm.tsx`、`crxRecorder.tsx`、`saveCodeForm.tsx`、`preferences.html` | 壳文案 |
| `vendor/playwright-recorder/recorder.tsx` | 主界面文案 |
| `UPSTREAM.md` | 记录图标替换与汉化覆盖 |
| `packages/extension/playwright-crx/.gitignore` | 新增 |
| `packages/extension/playwright-crx/README.md` | 显示名改为录制器 |

不改 `tools/check-deps.mjs`、不改 workspace。

## 5. 验收

1. 未打包加载 `dist` 后，`chrome://extensions` 与工具栏是观测证据标，不是 Playwright 面具。
2. 侧边栏、偏好设置、右键菜单、工具栏 tooltip 无英文整句（专有名词表里的除外）。
3. 录制器工具栏是「录制 / 选取定位 / 代码语言」，不是 Record / Target。
4. `git status` 看不到 `dist/`、`*.crx`、`*.zip`、`*.pem`；`vendor/` 仍被跟踪。
5. `pnpm build` 在插件目录仍能通过。

## 6. 现在不做

上传、登录、Target 绑定、把 Player 当正式 Run、Midscene / page-agent 子目录、把扩展搬到 `apps/`。
