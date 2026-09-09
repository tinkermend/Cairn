# CLAUDE.md

## 目录结构

```
packages/shared/   @cairn/shared  领域类型 + zod，三层唯一契约源
packages/db/       @cairn/db      Drizzle schema + migrations
packages/api/      @cairn/api     NestJS 控制面
packages/worker/   @cairn/worker  执行面（Playwright + Midscene + CDP + adb）
packages/web/      @cairn/web     React 19 + Vite 控制台
docs/arch/         设计文档 —— 实质内容都在这里，但不入库（见下）
.claude/skills/    项目级 skill（archify 2.17）
```

其余目录待定，随需要逐步添加。

## 常用命令

仓库根执行，经 Turborepo 分发到各包：

```bash
pnpm install          # 安装全部 workspace 依赖
pnpm dev              # 启动开发服务（web 在 5173）
pnpm build            # 构建（web: tsc -b && vite build）
pnpm lint             # eslint
pnpm test             # vitest，浏览器模式跑在 playwright chromium 上
```

只作用于单个包时用 `--filter`：

```bash
pnpm --filter @cairn/web test
pnpm --filter @cairn/db add drizzle-orm
```

`packages/web` 的测试需要 playwright chromium（revision 1243，随 playwright 1.63 安装）。

## 技术栈

TypeScript / Node 24 LTS · pnpm + Turborepo · NestJS · Drizzle ORM · PostgreSQL 16+ · S3 兼容对象存储（MinIO）· Playwright + CDP · Midscene · React 19 + Vite + TanStack · @xyflow/react + Zustand · shadcn/Radix + Tailwind · pino · Docker Compose

> 本机：Node v24.17.0（`.nvmrc` 锁 `24`）、pnpm 11.5.2

## 命名约定

| 场景 | 写法 |
| --- | --- |
| npm 包名 | `@cairn/<pkg>` |
| CLI | `cairn run <workflow>`、`cairn db migrate` |
| 数据库 schema | `cairn`（migration 内用 `"__SCHEMA__"` 占位） |
| 环境变量前缀 | `CAIRN_` |
| pino service 字段 | `cairn-api` / `cairn-worker` |
| compose 服务名 | `cairn-api` / `cairn-worker` / `cairn-web` |
| 对象存储 bucket | `cairn-evidence` |
| HTTP 头 | `X-Cairn-Run-Id` |
| 数据库表前缀 | `target_*` / `browser_*` / `workflow_*` / `run_*` / `console_*` |

第三方依赖自带的环境变量（`MIDSCENE_*`、`DATABASE_URL`）保持原名不加前缀——由外部库读取，改名会失效。
