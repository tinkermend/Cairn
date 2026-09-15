# @cairn/web

React 19 + Vite 控制台。SPA。

## 脚手架来源

由 [satnaing/shadcn-admin](https://github.com/satnaing/shadcn-admin) 复制而来（MIT）：

| | |
| --- | --- |
| commit | `e16c87f213a5ba5e45964e9b67c792105ec74d26` |
| 日期 | 2026-06-11 |
| 取用于 | 2026-09-09 |

**这是复制不是依赖。** shadcn 系的组件进入本仓库后即由本项目拥有，不跟随上游更新——上游 main 自 2026-04-21 起无人工提交。需要对照上游时用上面的 commit。

## 相对上游的改动

- **移除 Clerk**（托管认证，私有化部署不能依赖外部服务）：`src/routes/clerk/`、`src/assets/clerk-{logo,full-logo}.tsx`、`package.json` 的 `@clerk/react`、`.env.example` 的 `VITE_CLERK_PUBLISHABLE_KEY`、侧边栏导航组。
  `src/routes/(auth)/` 那套本地认证页面完整保留，后续接 `console_*` 域。
- **移除上游项目自身文件**：`.github/`、`netlify.toml`、`cz.yaml`、`CHANGELOG.md`。
- **移除 `pnpm-lock.yaml`**：pnpm workspace 的 lockfile 只应存在于仓库根。

## 功能范围与设计

开发前先读[前端工作流](../../docs/design/front/ai-workflow.md)和[设计规范](../../docs/design/front/README.md)。当前范围与交付顺序以[主计划](../../docs/plan/识途开发路线与工程实施计划.md)及对应方案为准；脚手架候选能力不作为独立待办清单。
