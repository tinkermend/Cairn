# tools

仓库级脚本（CI 检查、代码生成）。与脚本步骤沙箱 `automation/scripts/` 分开。

| 脚本 | 命令 | 卡住什么 |
| --- | --- | --- |
| `check-migrations.mjs` | `pnpm check:migrations` | 迁移文件名规范、前缀唯一、序号连续；`transfer.ts` 必须用目录派生的 `logicalVersion`；含领号自测 |
| `allocate-migration.mjs` | `pnpm db:new-migration <name>` | 锁内领取 PostgreSQL / MySQL 下一号并立刻落盘，避免并发任务扫到同一最大号 |
| `check-deps.mjs` | `pnpm check:deps` | 包边界与依赖方向：package.json 声明的仓内依赖，以及绕开声明的跨包相对路径 import；允许边表在脚本顶部，改边界必须改脚本 |
| `check-stack.mjs` | `pnpm check:stack` | 本机 api / worker / web 进程探活；不启动进程，也不进 CI |
| `use-env.mjs` | `pnpm env:use local\|remote`、`pnpm env:status` | 开发连接画像：`.env.local` / `.env.remote` 与 `.env.example` 键集必须对齐；`.env` 只是当前生效指针 |
| `probe-demonstration-files.mjs` | `node tools/probe-demonstration-files.mjs` | 本机 Web／API／对象存储的 JSON、YAML 文件导入、图片审查、参数／成功条件回填与单步重教；含 390px 窄屏检查 |

`pnpm check` 含依赖、迁移、架构不变量和探活判定单测，并挂在 `pnpm test` 前面；`.github/workflows/ci.yml` 在 push 与 PR 上按同一顺序执行（install → build → check → lint → typecheck → migrate → test）。`pnpm check:stack` 探本机正在跑的进程，不进 CI。

## 本机进程探活

宣称本机服务可用或开发完成前跑 `pnpm check:stack`。它只回答 api / worker / web **现在能不能被连上**：

| 级 | 检查 | 失败含义 |
| --- | --- | --- |
| S1 | 端口是否在听 | 进程没起来或已崩溃 |
| S2 | `GET /health` 契约与数据库；Worker 节点健康 `loopAlive` | 控制面在听但库不可用，或 Worker 只在听但事件循环已停 |
| S3 | Web 页面 + 经 Web 代理的 `/health` | 页面在，前后端没接通 |

范围：`all`（默认）、`backend`、`api`、`worker`、`web`。`web` 仍会探 api。`--strict` 把控制面降级也判失败。不启动进程；开发热重载用 `pnpm dev`，构建产物用 `pnpm start`。

`STACK_OK` 不是功能验收，更不是核心生命周期验收。判定细节见 `.cursor/skills/shitu-stack-acceptance/SKILL.md`。

示教文件探针使用自行创建的合成 Target／Scenario，不访问外部业务系统；会留下带“探针”名称的录制与场景用于检查。默认访问本机 API `3030`、Web `5173`，账号由 `CAIRN_PROBE_EMAIL`／`CAIRN_PROBE_PASSWORD` 覆盖（沿用本机开发账号默认值），地址由 `CAIRN_PROBE_API`／`CAIRN_PROBE_WEB` 覆盖。截图保存至 `.run/demonstration-phase-one/`。运行前先执行 `pnpm check:stack web`；该探针不调用真实模型，不代替业务收益试点。

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

### 通知一期真实闭环探针

`node tools/probe-notifications.mjs` 使用已构建的 shared／db／API／worker 包，启动隔离数据库、真实 Nest API、Vite（默认 5197，可用 `CAIRN_NOTIFICATION_PROBE_WEB_PORT` 覆盖）和仅监听回环地址的 TLS SMTP／HTTPS 接收器。它不会使用运行中应用的业务数据或真实收件人。运行前确认数据库可达、Node 支持 `tls.setDefaultCACertificates`，并已安装项目的 Playwright Chromium。

探针通过页面保存渠道、测试发送和场景订阅，核对逐收件人部分成功、DATA 后断连、人工重复风险确认、稳定消息编号、真实 Webhook HMAC、权限及 SSE 撤权；同时检查桌面、390px 和键盘路径。结果与截图写入 `.run/notifications-phase-one/`。运行证据等待使用前移 61 秒的测试时钟，不以此声称验证真实业务邮箱入箱。

两库通知契约与转储回归：`CAIRN_DB_CONTRACT_DRIVERS=postgres,mysql pnpm --filter @cairn/db exec vitest run src/__tests__/notifications.test.ts src/__tests__/notification-transfer.test.ts src/__tests__/monitoring-alerts.test.ts`。双向转储测试需要两种真实数据库；常规仅 PostgreSQL 命令不把跳过的 MySQL 转储项计作通过。
