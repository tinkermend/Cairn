# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 技术栈

已定选型。**改动前先读末尾的「已否决方案」**——那里记录了为什么不选更流行的替代品。
版本只记大版本，补丁号以 `pnpm-lock.yaml` 为准。

### 全栈

TypeScript · Node 24 · pnpm + Turborepo · Vitest

全栈 TS 不是偏好，是约束：Midscene 只有 TypeScript 绑定，Playwright 的 CDP 底层能力也只在 JS 生态完整。执行面锁死在 TS，控制面同语言才能让三层共享同一份领域模型。

### 项目前提（决定了下面多数选择）

| 前提 | 后果 |
| --- | --- |
| **代码主要由 AI 编写** | 结构必须由框架和工具**机械强制**，不能靠人的自律跨会话维持 |
| **私有化部署给客户** | 需可文档化的 HTTP API（否决 tRPC）；Docker Compose 打包；离线安装，运行期不依赖任何 CDN；凭据加密需可接 KMS/Vault |
| **认证自建、预留 SSO** | 现在不装 passport，但数据模型第一天就分开 identity 与 account |

### 结构约束

**dependency-cruiser** —— 在 CI 里机械校验包依赖方向，禁止 `worker → api`、禁止 `shared` 反向依赖任何包、禁止跨包深路径 import。

这一条因「代码主要由 AI 编写」而从可选变成必需：前一代平台死于 1,079 行单文件路由，那是靠纪律维持结构失败的典型；AI 逐会话生成代码时没有跨会话记忆，约定写在文档里不会被执行，写成 CI 检查才会。

### packages/shared

**zod 4** —— 领域类型与校验的唯一契约源，零框架依赖。

api 用它校验入参，web 用 `@hookform/resolvers` 的 `zodResolver` 校验表单，**是同一批 schema 对象**，构造上不可能漂移。

### packages/db

**Drizzle ORM + drizzle-kit** · **pg**（node-postgres）· PostgreSQL 16

选 Drizzle 是因为本项目的 Postgres 不只是记录存储，它同时是队列、锁与消息总线——`FOR UPDATE SKIP LOCKED`、`LISTEN/NOTIFY`、partial unique index 做租约互斥。Drizzle 是 SQL 形状的，写这些是自然的。

驱动选 `pg` 而非 postgres.js：`LISTEN/NOTIFY` 长连接场景更成熟。

### packages/api

**NestJS 12**（platform-express）· @nestjs/config · @nestjs/jwt · @nestjs/swagger · @nestjs/schedule · **nestjs-pino + pino 10** · SSE 用 Nest 内置 `@Sse()`

**ZodValidationPipe 自己写**，不装 `nestjs-zod`——后者 peer 只到 `@nestjs/common ^11`，且会把 `@nestjs/swagger` 拉成 peer。这个 Pipe 本身是调 `schema.parse()` 的三十行代码，自己拥有它就不必在每个 Nest 大版本上等它跟进。

**Drizzle 的 Nest 模块也自己写**：现有第三方集成均已停更（`@knaadh/nestjs-drizzle-postgres` 2024-11、`nestjs-drizzle` 2025-03），官方无 `@nestjs/drizzle`，而所需不过是一个创建 client 的 provider。

**认证：`@nestjs/jwt` + 自写 Guard，现在不装 passport。** 但用户模型第一天就要拆成两层——`console_accounts`（主体：角色、权限、审计归属）与 `console_identities`（身份来源：`provider` + `subject`，本地密码只是 `provider='local'` 的一种）。日后接客户 SSO 时是新增 identity 行，不动 account 表。

届时用 **`openid-client`**（v6，活跃）而非 passport strategy 系列——passport 核心已趋于停滞（0.7.0，2025-12）。Guard 要围绕「认证策略」这个接缝设计，让 OIDC 能插进来而不用重写授权逻辑。

### packages/worker

**NestJS 12 独立应用**（`NestFactory.createApplicationContext`，不启 HTTP 服务器）· **Playwright** · **@midscene/web** · **@aws-sdk/client-s3 v3**

worker 用 Nest 而非裸 Node，理由是两条具体的：与 api 共用同一套 db / config / logger / lease 模块；以及 `OnApplicationShutdown` —— worker 持有浏览器租约，SIGTERM 时必须释放，否则该账号被锁到 TTL 过期。

### packages/web

**React 19** · **Vite 8** · TanStack **Router / Query / Table** · **@xyflow/react 12**（编排画布）· shadcn/Radix + **Tailwind 4** · **Zustand 5** · react-hook-form + @hookform/resolvers

脚手架源自 `satnaing/shadcn-admin`，改动记录见 `packages/web/README.md`。

### 前后端契约

两层，都不引入第三方契约库：

| 层 | 机制 |
| --- | --- |
| 校验 | `@cairn/shared` 的 zod schema，api 与 web 共用同一批对象 |
| 客户端类型 | `@nestjs/swagger` 产出 OpenAPI → **orval** 生成类型化 TanStack Query hooks |

### 基础设施

PostgreSQL 16（数据 + 队列 + 租约 + `LISTEN/NOTIFY`）· S3 兼容对象存储（证据与报告）· Docker Compose

### 已否决方案

| 否决 | 理由 |
| --- | --- |
| **tRPC** | 它优化的是前后端接缝，而本系统更大的接缝是 worker↔db 与领域模型；且只服务 TS 客户端，私有化交付常被要求提供可文档化的 HTTP API |
| **Fastify / Hono** | 纯 HTTP 层工具。worker 不是 HTTP 服务器，从它们身上一无所得。且它们不强制结构——在 AI 主导编写的项目里，这是缺点不是优点 |
| **ts-rest** | npm 最后发布 2025-06，已停更。契约库停更即负债 |
| **Prisma / TypeORM** | Prisma 的 raw SQL 逃生舱笨重、迁移引擎与手写 SQL 打架，队列设计直接否掉它；TypeORM 为遗产 |
| **社区 NestJS 样板** | 高星样板全部绑 TypeORM/Prisma，而样板的价值大头正是 ORM 层，换掉后所剩无几。用官方 `nest new` |
| **Vue / vue-vben-admin** | `@xyflow/react` 官方只出 React 与 Svelte 版，Vue 侧仅第三方移植，不能把最核心的画布押在移植版上 |
| **ant-design-pro** | 绑 UmiJS，与 TanStack Router/Query 同位竞争；ProForm 用 async-validator，zod 校验规则要写第二遍 |
| **Redis / BullMQ** | 目标量级是每天数百个浏览器任务。PG 的 `SKIP LOCKED` 足够，且取任务与写租约在同一事务内，不存在裂脑状态 |
| **Temporal** | 浏览器状态本身不 durable，「重放到第 N 步」无论如何要自己实现，付出集群运维成本却拿不到它的核心价值 |
| **Next.js / SSR** | 内部控制台，SSR 零收益 |
| **Bun / Deno** | 执行面可靠性即产品，Playwright/CDP 的边缘问题不值得在此冒险 |
| **独立 OCR** | 模型已在 VL grounding 模式，自带带空间关系的文字理解；核心痛点是无文字的小图标，OCR 对此零帮助 |

> **NestJS 12 于 2026-08-27 发布**，比较新。第一方包已全部跟进，唯一发现的第三方缺口 `nestjs-zod` 我们本就不用。若遇到 12 的回归，退回 11 目前只是改版本号。

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
