# 前端落地约定

版本：v1.0 · [返回索引](README.md)

## 1. 本轮交付边界

Design Token 已由 `packages/web` 全局主题直接导入，登录页与共用 Input / PasswordInput 是首批正式接入样本，Target / Scenario / Run 已有业务实现。2026-09-13 的[交互原型](../../front_design/2026-09-13-foundation-lab/index.html)已获用户认可，Target / Scenario 列表与详情已完成首批 React 迁移，验收记录见[迁移样板](../../front_design/2026-09-13-react-migration/README.md)，范围见[正式接入方案](../../spec/2026-09-13-ui-foundation-review.md#正式接入方案)。本文记录工程接入约定，日常开发与纠偏执行 [AI 前端开发工作流](ai-workflow.md)。

视觉样本是评审材料，不是另一套要维护的生产组件库。正式界面继续使用现有 React 19、Vite、Tailwind、shadcn/ui、Radix，并从共用 Token 与基础组件继承视觉状态。

## 2. 现有脚手架的复用位置

以下只盘点 UI 基础设施，不将模板里的示例页面当作已实现业务功能。

| 现有位置 | 复用内容 | 接入方式 |
| --- | --- | --- |
| `packages/web/src/styles/theme.css` | 语义变量、Tailwind 映射、深色变量 | 直接导入规范 Token；不重复定义浅色 `:root` |
| `packages/web/src/styles/index.css` | 基础样式、字体、全局行为 | 统一字体与文字颜色，补 reduced-motion 与焦点基线 |
| `packages/web/src/components/ui/` | 基础控件与 Radix 组合 | 优先改变量和 variant，保留公开 API |
| `packages/web/src/components/layout/` | Header、Sidebar、导航组 | 应用尺寸、选中、收起与中文排版规范 |
| `packages/web/src/components/data-table/` | 工具栏、页码分页、游标分页、选择与列设置 | 保留 TanStack Table 状态与查询约定。判定表格会持续增长时必须服务端分页：有总数用 `DataTablePagination`，只有游标用 `CursorPagination`；不要先拉全量再前端切页，也不要把「加载更多」当默认 |
| `packages/web/src/components/confirm-dialog.tsx` | 已有确认入口 | 统一标题、后果、焦点和按钮优先级 |
| `packages/web/src/components/password-input.tsx` | 密码显隐 | 复用可访问名称与原有行为 |
| `packages/web/src/features/auth/` | 认证布局与登录表单 | 作为品牌区、低密度背景和 48px 高聚焦表单的接入参考 |
| `packages/web/src/components/collection-summary.tsx` | 两类管理页共用的集合摘要 | 只统计已加载的集合；不伪造健康、趋势或运行成功率 |
| `packages/web/src/features/targets/` | 管理页真实样板 | 表格、筛选、对象概览、详情与账号管理 |
| `packages/web/src/features/scenarios/` | 顺序工作区真实样板 | 场景列表、目标绑定、步骤属性与原有运行入口；不代表完整编辑器 |
| `packages/web/src/components/date-picker.tsx` | 单日选择 | 仅用于只要一天的表单字段 |
| `packages/web/src/components/date-range-picker.tsx` | 日期范围（Range Picker） | 筛选栏的起止日期一律用这个；中文、`YYYY-MM-DD`、双月历 |
| `packages/web/src/components/command-menu.tsx` | 全局搜索 / 命令入口 | 复用命令菜单，不另造搜索弹窗框架 |

### 组件实现覆盖

| 类别 | 已有基础 | 按需组合 / 补充 |
| --- | --- | --- |
| 动作 | Button、Dropdown Menu | Text 语义沿用 link variant；Split Button 组合二者 |
| 输入 | Input、Textarea、Form、Label、Select、Checkbox、Radio、Switch、Calendar | Number 使用原生 input；Multi Select、Cascader、Upload、Tag Input 按需求组合 |
| 代码 / 数据编辑 | Input / Textarea、Zod | JSON 校验与格式化先用已有能力；实际需要语法导航等再引入编辑器 |
| 导航 | Sidebar、Collapsible、Tabs、Command、分页组合 | Breadcrumb、Steps 按实际导航语义补充 |
| 展示 | Table、Card、Badge、Avatar、Tooltip、Popover、Skeleton、ScrollArea | Description List 用语义 HTML；Statistic、Empty、Result、Timeline、Tree 按需组合 |
| 反馈 | Alert、Dialog、AlertDialog、Sheet、Sonner | Drawer 复用 Sheet；Message 复用 Alert/Sonner；Loading 与 Progress 按使用处组合 |
| 图表 | 已安装 Recharts | 后续统一图例、Tooltip、系列色与可读数据入口 |

规范中的组件名字不必全部对应新的源码文件。例如 Statistic Card 可以是 Card 的轻量组合，Description List 可以直接使用 `dl`。不为一处使用建立通用工厂或复杂配置层。

## 3. Token 接入规则

### 浅色映射

| 现有 Token | 设计 Token | 注意 |
| --- | --- | --- |
| `--background` / `--foreground` | `surface-page` / `text-primary` | 画布是三层平面的中间层，不是纯白 |
| `--card` / `--popover` | `surface-card` | 白色内容表面 |
| `--sidebar` | `surface-nav` | 导航平面为白，**不得指回 `surface-page`**，否则侧边栏与画布同色、层级消失 |
| `--primary` / foreground | `action-primary` / 白色 | 保留现有 Button default API |
| `--secondary` / foreground | `action-secondary` / 深蓝 | 次操作不与主操作同等强调 |
| `--muted` / foreground | `surface-subtle` / `text-muted` | 前者必须是背景，不要把正文灰赋给它 |
| `--accent` / foreground | `selection-background` / 深蓝 | Hover 与 Selected 仍需图标 / 指示线区分 |
| `--destructive` | `status-error-foreground` | 深红配白字；状态图形使用 error accent |
| `--input` | `border-control` | 输入框应引用 input，而不是过浅的 border；该值对白底不低于 3:1，由 `check.mjs` 断言 |
| `--ring` | `focus-ring` | 按钮等通用控件的 `focus-visible` 使用 ring + offset；输入类控件改用 `control-focus` / `control-focus-shadow` |
| `--chart-1…5` | 同名图表 Token | 状态图采用 status Token 覆盖类别色 |
| `--sidebar-*` | 同名兼容映射 | 使用同一套蓝白语义，不另选配色 |

将新语义变量映射到现有 `@theme inline` 后，可在组件中使用语义类，例如 `bg-status-success-background`。只暴露实际使用的语义类，不生成无需求的所有色号 × 所有组件组合。

```css
/* 当前 theme.css 的语义映射方式。 */
@theme inline {
  --font-sans: Inter, -apple-system, BlinkMacSystemFont, 'PingFang SC',
    'Microsoft YaHei', 'Source Han Sans SC', system-ui, sans-serif;
  --color-surface-nav: var(--surface-nav);
  --color-status-success-background: var(--status-success-background);
  --color-ai-foreground: var(--ai-foreground);
  --radius-lg: var(--radius-card);
  --shadow-card: var(--card-shadow);
  /* 字号刻度必须接进 --text-* 命名空间，否则页面消费不到。 */
  --text-body: var(--font-size-body);
  --text-body--line-height: var(--line-height-body);
}
```

**没有映射进 `@theme` 的 Token 等于不存在。** 一个只写在 tokens.css 里、既没进 `@theme`
也没被 `var()` 引用的值，不会有任何页面消费它，只会让规范看起来比实际落地的更完整。
新增 Token 时同步映射；映射不了又没人用的，从 tokens.css 删掉，不要留着充数。

阴影数值只在 tokens.css 声明一次（`--card-shadow`、`--control-shadow`、`--action-shadow` …），
`@theme` 里的 `--shadow-*` 一律 `var()` 指过去，不在两个文件里各写一份数值。

现有 `--radius-sm/md/lg/xl` 与每种控件的实际类名一起检查。按钮与输入的 `rounded-md` 映射到 9px，Card 的 `rounded-lg` 映射到 14px，Dialog 的 `rounded-xl` 映射到 18px。统计卡沿用 Card 圆角。

现有主按钮已有 32/36/40px 高度，优先保留。新增 Loading 时在相同位置替换图标与文案，不改变尺寸。不应因设计更新重做 Button、Dialog、Tabs 的行为层。

深色变量不能在未设计、未验证时被宣称符合此规范。当前界面锁定浅色，并已关闭自动套用未完成深色样式的入口；未来恢复暗色选项时需单独完成设计与验证。

## 4. 实现约束

- 页面不写任意十六进制颜色；图标与图表也从语义 Token 取色。目标系统截图等外部内容不受页面配色控制。
- 低密度页面的科技质感统一使用 `technical-*` 与共用阴影 Token；输入使用与卡片相同的白底，靠边界识别。业务页面不自行发明渐变、光晕或网格。
- 样式组合沿用现有 `cva`、`cn`、Tailwind，不增加新的 CSS-in-JS 或组件框架。
- 状态以原生属性、Radix 的 `data-state`、`aria-*` 和已有 variant 表达；Hover/Active 不依赖 JS 监听模拟。
- 表单复用 React Hook Form + Zod；服务端校验仍是信任边界，前端校验只改善体验。
- Select、Dialog、Tooltip 等继续使用 Radix 的键盘与焦点管理；不复制视觉样本的简化行为到生产。
- 数据查询沿用 TanStack Query，表格沿用 TanStack Table；只为界面交互使用局部状态，不把 API 数据复制到新的全局 Store。
- 优先原生输入与已安装的日期组件，不为数字、时间、简单 JSON 文本额外安装依赖。
- 日志、示例、Toast 与 Tooltip 不携带目标账号明文凭证。无障碍名称不能意外包含隐藏敏感值。

## 5. 接入顺序

| 步骤 | 交付范围 | 完成条件 |
| --- | --- | --- |
| 1. 基础 Token | 浅色、字体、尺寸、边界、状态色映射 | 同一数值只有一个事实源；主要色对通过检查 |
| 2. 基础组件 | Button、Input、Select、Badge、Card、Alert、Dialog | 八态适用性明确；键盘、禁用、错误和焦点不退化 |
| 3. 通用组合 | Form、Table Toolbar、Pagination、Sidebar、Header | 不改变现有交互契约；中文与长内容布局稳定 |
| 4. 实际模块 | 按另行审阅的功能方案组合组件 | 页面无独立配色；状态、反馈和布局符合规范 |

这是持续接入次序。基础 Token、登录页和共用输入已落地，不因规范清单完整而一次性开发其余组件。

## 6. 评审与验收

### 视觉

- 1366、1440、1920px 桌面宽度，无页面整体横向溢出；窄屏采用重排而非缩放。
- 所有页面用同一组 Token；白卡与浅底分层稳定；主操作只有一个最高强调。
- 中文标签、长字段、三位数数量、空值、错误文本和数值对齐均检查。
- 状态包含文字与图标，不能只靠颜色；浅色 Accent 不用于浅底小字。

### 交互与无障碍

- 键盘可用 Tab/Shift+Tab、方向键、Enter/Space、Escape 完成必要操作；焦点位置清晰。
- Dialog/Drawer 正确管理焦点，关闭后回到触发器；不因错误清空表单。
- Disabled/Loading 不重复触发；需要可读原因的禁用项有独立说明。
- 表单 Label、Description、Error 正确关联；屏幕阅读器收到必要反馈而不被频繁进度刷屏。
- 触控区域、200% 缩放、reduced-motion 与对比度按[设计语言](design-language.md#10-动效与无障碍)检查。

### 测试范围

`check.mjs` 另有四条**源码 / Token 断言**，对应真实发生过的回归，不要因为"暂时没人违反"就删掉：

| 断言 | 范围 | 为什么 |
| --- | --- | --- |
| 颜色使用语义 Token | 全部 `.tsx` 的可识别样式字符串与属性 | 检查 Tailwind 常用色板、任意色值和内联颜色函数，跳过注释与锚点等非样式内容 |
| 不得出现 `transition-all` | 全部 `.tsx` | 什么都动等于不解释任何东西，见[设计语言 §10](design-language.md#10-动效与无障碍) |
| 字号必须在职务刻度上 | `features/` + `components/layout/` | 检查默认字号类、任意数值字号与直接数值 fontSize；`components/ui/` 是控件字号，不在此列 |
| `surface-control` 必须与 `surface-card` 同色 | `tokens.css` | 输入不得再铺浅灰或冷白底；叠在白卡片上会发脏 |

视觉样本的 `check.mjs` 还验证内部文档链接、核心色对、1366/1440/1920px 布局、原生表单校验、确认取消与焦点返回。它是可运行的样本检查，不是正式应用的无障碍认证，也不替代应用现有测试。

2026-09-13 定向复查后，源码检查使用项目已有 TypeScript 解析器，并加入 14 个合法 / 违规回归样本，验证漏报与误报。认证配图标题的 28 / 34px 字号以精确文件、精确类名保留例外；表单和按钮使用语义字号，不豁免整个认证模块。共用 `cn` 将六档语义字号注册到 tailwind-merge 的 font-size 组，避免字号被当成文字颜色、意外移除按钮前景色；`utils.test.ts` 验证颜色保留和响应式字号覆盖。

检查不做完整数据流推断，也不穷举动态拼接、外部 CSS 或所有可写的颜色形式。通过这些检查只能说明已覆盖的规则满足，实际布局和真实组件状态仍需按验收 skill 检查。

正式样式接入时运行相关组件已有测试与 typecheck/build。仅当新增行为、修复失败或存在新的风险时增加测试；不为纯色值或静态文档逐项建测试套件。

## 7. 规范演进

调整语义色含义、组件状态或公开 API 时，需要在本目录记录原因、影响范围与迁移方式，同步 Token 与视觉样本。普通像素调整留在规范，不添加到宪法不变量。

具体功能模块需要新的领域组件时，先组合基础组件，并在该模块方案中定义数据契约、交互与验收；多处真实复用后再抽取共用能力。不要让 UI 组件清单反向扩大 MVP 范围。
