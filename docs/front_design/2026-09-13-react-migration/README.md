# Target / Scenario · React 迁移样板

2026-09-13。用户批准把「目标系统」与「场景」迁到认可的 Foundation 设计语言，现已应用到生产源码的四个路由。

[打开截图画廊](index.html) · [机器检查结果](results.json)

| 路由 | 已迁移的真实页面 | 主要效果 |
| --- | --- | --- |
| `/targets` | [目标系统列表](../../../packages/web/src/features/targets/index.tsx) | 集合摘要、搜索与状态筛选、表格、当前对象概览 |
| `/targets/:targetId` | [系统与目标账号](../../../packages/web/src/features/targets/detail.tsx) | 账号管理为主区，系统资料为侧区；低频登录定位按需展开 |
| `/scenarios` | [场景列表](../../../packages/web/src/features/scenarios/index.tsx) | 场景与目标名称、定义状态、版本、步骤数、搜索筛选 |
| `/scenarios/:scenarioId` | [有序步骤工作区](../../../packages/web/src/features/scenarios/detail.tsx) | Target / 版本上下文、步骤选择、可读属性与断言、执行策略、原有运行入口 |

生产页面沿用已有 API 与权限。截图中使用固定的虚构数据，包括可由现有 Step Schema 表达的浏览器步骤；截图不是后端执行结果。当前手工创建表单仍只支持回显、等待、主动失败，完整顺序编辑与 AI Authoring 尚未在这次 UI 迁移中实现。

## 共用设计与纠偏

- Token 升为 v1.3：统一主蓝、冷灰画布、白卡片、浅边框、克制阴影；控件 / 卡片 / 弹层圆角分别为 9 / 14 / 18px，使用已有字体刻度。
- 复用 Main、PageHeader、Table、Card、StatusBadge 与 Radix 控件。两类列表共用 CollectionSummary，仅统计已加载数据。
- 修复真实 Button 的加载宽度变化；加载保留标签占位和可访问名称，减少动效时停止旋转。
- 浏览器验收发现受控弹窗关闭后焦点掉到 body，已在 Dialog / AlertDialog 统一修复并补回归测试；保留调用方自定义焦点策略。
- 修复详情页父导航高亮丢失；属性面板用业务描述呈现定位与断言，完整定义仍可展开。敏感 Fill 值在两处均遮蔽。
- 场景创建失败保留输入并可重试；停用目标不可选，等待 0ms 不再被改写为 100ms。已有创建与账号编辑请求契约保持一致。

## 已执行验收

按前端验收 skill 的「页面或底座」级别执行，因为修改了两类业务页面及共用 Token / 控件。

1. Web TypeScript 与生产构建通过；变更业务文件 lint 通过。
2. `pnpm check:design`：16 组文本对比度、输入边界、表面层次、样式规则、组件 HTML 样本交互通过。
3. 9 个相关 Vitest 文件、30 个测试通过，覆盖 Target 表单、Scenario 创建、Button、受控弹窗及关联登录 / 权限 / Run 调用方。
4. 实际 React 路由的 9 组浏览器检查通过。包括筛选与选中对象一致、删除取消无写请求、账号请求绑定、保存失败保留输入、按钮稳定、步骤 / 条件 / 副作用映射、只读权限、空态、503 与重试。
5. 四个路由在 1366 / 1440 / 1920 / 768 / 390px 检查边界，另加长名称、长 URL 与 32 步骤；表格在自身容器内横向滚动，工作区窄屏上下重排。实际查看桌面与窄屏截图后收敛属性展示。

所有 API 请求由 Playwright 截获，写请求返回受控错误，不落到真实数据库；Scenario 正常创建契约由 Vitest mock 验证。**尚未执行本次迁移的真实后端写入、真实目标系统运行或远端 CI。** 样本中的后端状态同样来自 fixture。

## 定向复测

复用正在运行的本地 Web：

```sh
pnpm --filter @cairn/web dev
node docs/front_design/2026-09-13-react-migration/check.mjs
```

脚本默认连接 `http://127.0.0.1:5173`，可通过 `CAIRN_WEB_REVIEW_ORIGIN` 改为其他本地端口；脚本只接受 localhost / 127.0.0.1。截图、结果保存在本目录。需先安装项目既有 Playwright Chromium。

这份页面检查用于涉及本样板或公共布局的迭代；普通文案、孤立装饰、无语义变化的格式修改按 skill 轻量验收，不要求每次运行完整页面检查。
