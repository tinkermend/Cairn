# tools

仓库级脚本（CI 检查、代码生成）。与脚本步骤沙箱 `automation/scripts/` 分开。

| 脚本 | 命令 | 卡住什么 |
| --- | --- | --- |
| `check-migrations.mjs` | `pnpm check:migrations` | 迁移文件名规范、前缀唯一、序号连续；`transfer.ts` 必须用目录派生的 `logicalVersion`；含领号自测 |
| `allocate-migration.mjs` | `pnpm db:new-migration <name>` | 锁内领取 PostgreSQL / MySQL 下一号并立刻落盘，避免并发任务扫到同一最大号 |
| `check-deps.mjs` | `pnpm check:deps` | 包边界与依赖方向：package.json 声明的仓内依赖，以及绕开声明的跨包相对路径 import；允许边表在脚本顶部，改边界必须改脚本 |
| `use-env.mjs` | `pnpm env:use local\|remote`、`pnpm env:status` | 开发连接画像：`.env.local` / `.env.remote` 与 `.env.example` 键集必须对齐；`.env` 只是当前生效指针 |

两个检查合并为 `pnpm check`，并挂在 `pnpm test` 前面；`.github/workflows/ci.yml` 在 push 与 PR 上按同一顺序执行（install → build → check → lint → typecheck → migrate → test）。

## 领取迁移号

PostgreSQL / MySQL 的前缀必须连续且唯一。不要先扫目录再手写 `0035_foo.sql`：两个并发任务会领到同一个号。`pnpm db:new-migration map_widgets` 在锁内同时写下两份占位 SQL，占号就是文件本身。同机多个 worktree 走 git common dir 上的锁。

导出 `logicalVersion` 跟仓库当前最新 PG 前缀，不必再改 `transfer.ts`。方案里只写意图名；跨克隆合入时若仍撞号，按当时目录重领，不要预占未落地的序号。

放弃本次增量且它仍是各目录最后一份时，删掉两份文件再让别人领号。中间抽走会留下缺号，检查会失败。

## 开发连接画像

本机 Postgres 和远程开发机是两套连接，不是 `CAIRN_ENV` 的业务分支。约定：

| 文件 | 角色 |
| --- | --- |
| `.env.example` | 入库模板，键集的唯一事实源 |
| `.env.local` | 本机库 + 本地对象存储（不入库） |
| `.env.remote` | 远程库 + 远程对象存储（不入库） |
| `.env` | 当前生效文件；api / worker / 迁移 / 集成测试只读它 |

`pnpm env:use local` 把 `.env` 指到 `.env.local`（符号链接）。改连接改画像文件，不要直接改 `.env`。`pnpm env:status` 只打印 host / driver，不回显口令。

本机 PostgreSQL / MinIO 由 `pnpm infra:up` 启动，说明见 [`deploy/README.md`](../deploy/README.md)。

## 集成测试与数据库

`packages/db` 与 `packages/api` 的集成测试真连 PostgreSQL，且**不接受跳过**：两个包的 vitest `globalSetup` 调用 `@cairn/db` 的 `requireReachableDb()`（实现在 `packages/db/src/testing.ts`），库不可达或配置不完整时整个包失败。

判据是「库能不能连上」，不是「环境变量在不在」——后者在干净检出、CI 漏配或临时离线时会整包变绿而一条都没跑（实测 db 包 `3 passed | 4 skipped`、退出码 0）。新增集成测试自动受这条闸门保护，不需要自己写 `skipIf`。

集成测试跑在**真实库**上：`db` 的模型与 parity 测试各自建独立 schema（`cairn_test_*`）并在结束时删除；api 的集成测试写入开发 schema，用唯一前缀命名并在 `afterAll` 清理。
