# 平台工程地基收口方案

日期：2026-09-10。状态：**已落地**；实现范围见第 5、6 节，验收见第 7 节。

范围：Monorepo / Contracts / Config / Logger / Error。  
目标不是另开基建史诗，而是把已经在用的约定收口到**够撑 Slice 1**（Target → Scenario → Run → Worker → Evidence）。

## 1. 为什么现在写，而不是现在拆包

仓库里这五块已经有骨架：

| 块 | 已有 | 缺口 |
| --- | --- | --- |
| Monorepo | pnpm + Turbo；`api` / `worker` / `web` 是进程，`db` / `shared` 是库 | 目录没有用 `apps/` 标出可部署单元；这不影响 Slice 1 |
| Contracts | `@cairn/shared` 用 Zod 持有 health / env / error / RBAC；`apiFetch` 用同一套 schema 解析 | 领域契约（Target / Scenario / Step / Run）尚未出现，应跟 Slice 1 一起长；**错误信封有约定，列表信封没有**——`{ items }` 不带分页 |
| Config | `dbEnvSchema` / `apiEnvSchema` 启动即校验 | 进程已在读的 `CAIRN_API_PORT`、`CAIRN_CORS_ORIGINS`、`CAIRN_WORKER_ID` 不在 schema 里；**生产环境拿开发默认 JWT 密钥与默认管理员口令也能起来**；`.env.example` 里还有尚未被进程读取的预留项 |
| Logger | api / worker 都接了 nestjs-pino；api 有 requestId | 请求关联 ID 被写成 `runId`，响应头叫 `x-cairn-run-id`；**pino-http 默认序列化器把整份请求头写进日志，`authorization` / `cookie` 明文落盘** |
| Error | `apiErrorSchema` + 全局过滤器 + `ApiRequestError` | 前端 QueryClient / `handle-server-error` 仍按 Axios + `title` 处理，和新契约不是一条路；过滤器只按状态码推 `code`，handler 无处给领域码 |

外部建议把库拆成 `contracts` / `config` / `logger` / `telemetry` / `testing`，并把进程搬进 `apps/`。方向可以以后再谈；**本方案明确不做目录搬家，不建空包。**

宪法要求结构化日志用 `requestId`、`runId`、`stepRunId`、`attemptId` 四条线串联。现在把 HTTP 请求 ID 记成 `runId`，Slice 1 一旦出现真正的 Run，历史日志和前端对账会整批作废。这是本方案必须先卡住的第一个洞。

第二个洞是凭证进日志。`LoggerModule` 没有配 `redact`，pino-http 的默认 `req` 序列化器把 `req.headers` 整份写出，实测能看到 `"authorization":"Bearer …"` 与 `"cookie":"…"`。RBAC 已经上线，这意味着每个已认证请求都在往结构化日志里写可重放的令牌，直接踩宪法 §15。日志一旦进了采集链路，回头洗的成本和现在加一行 `redact` 不是一个量级。

第三个洞是「必须覆盖」只写在文档里。`CAIRN_JWT_SECRET` 与 `CAIRN_BOOTSTRAP_ADMIN_PASSWORD` 都有开发默认值，漏配环境变量的后果不是少个功能，而是签名密钥与管理员口令双双已知。宪法 §18.18 要求这类约束由代码或 Schema 卡住，而不是靠自觉——所以它属于本轮的 Config 范围，不是"部署时注意一下"。

本方案与进行中的 RBAC 工作正交。落地时单独收口，不在同一变更里继续扩角色、权限或审计——审计接口的静默截断因此归到那一轮，见第 8 节。

## 2. 目标与非目标

### 目标

1. **冻结 HTTP 错误信封**，前后端只认 `@cairn/shared` 的 `apiErrorSchema`。
2. **分开 `requestId` 与 `runId`**。头、日志字段、错误体使用同一套语义。
3. **进程启动即校验自己真正读取的配置**；缺项或非法值不得带病启动。
4. **契约继续住在 `@cairn/shared`**；新增跨进程类型先写 Zod，再写 controller / client。
5. **把包边界和依赖方向变成检查脚本**，不是只写进文档。
6. **凭证不出日志**：结构化日志默认脱敏 `authorization` / `cookie`。
7. **该硬失败的地方硬失败**：生产模式拒绝开发默认密钥与默认管理员口令。
8. **顺手冻住会长的信封**：列表统一 `{ items, nextCursor? }`；错误 `code` 留出领域扩展点——但本轮不定义任何领域码。

### 非目标

- 不把 `packages/api|worker|web` 搬到 `apps/`。
- 不新建 `@cairn/contracts`、`@cairn/config`、`@cairn/logger`、`@cairn/telemetry`、`@cairn/testing`。
- 不引入 OpenTelemetry，不建完整 tracing / metrics 体系（路线图在 M5）。
- 不预写 Target / Scenario / Step / Run 空契约文件。
- 不编领域错误码大典（`SCENARIO_NOT_BOUND` 等跟第一个业务 API 一起加）。本轮只留出口子。
- 不引入 Nest `ConfigModule` 作为第二套配置源。已确认 `packages/api/src` 对 `@nestjs/config` 零引用，落地时直接删依赖。
- 不把 `MIDSCENE_*`、`DATABASE_URL` 纳入平台 schema。
- 不为尚未被进程读取的预留变量（S3、凭证主密钥、脚本根）做必填校验。
- 不实现游标查询本身。列表信封改形状，但审计接口 `.limit(200)` 的静默截断属于 RBAC 面，归下一轮。
- 不建 CI 与数据库集成测试基座。它不是本方案的范围，但必须排在 Slice 1 之前——理由见第 8 节。

## 3. 决策

### D1. 可部署单元与库继续共居 `packages/`

当前划分已经按进程切开，只是目录名没有用 `apps/`。依赖方向已经成立：

```text
web, api, worker  →  db, shared
api, worker       →  db
db                →  shared
shared            →  无仓内包
```

禁止：`shared` / `db` 依赖任一进程包；进程包之间互为库依赖（api 不 import worker，反之亦然）。

等 Extension 成为真实部署物，或团队开始分不清「能部署的东西」和「库」时，再单独提案搬 `apps/`。本轮不改仓库树。

但这条方向必须由脚本卡住，否则它的有效期只到下次有人 import 错为止。新增 `tools/check-deps.mjs`（对齐已有的 `tools/check-migrations.mjs` 风格）：读每个包的 `package.json`，把仓内依赖比对上面这张允许边表，越界即非零退出。挂到根 `package.json` 的 `check:deps`，与 `check:migrations` 并列。

### D2. `@cairn/shared` 就是契约包

跨模块、跨进程、持久化边界上的结构必须有运行时 Schema。本仓库里这个职责已经在 `@cairn/shared`，不要再开同义包。

约定：

- HTTP 成功体、错误体、登录 / RBAC DTO、进程 env schema 都在这里。
- 新增接口：**先合入 shared schema，再写 Nest handler 与 `apiFetch` 调用**。
- 文件继续按主题拆（`error.ts`、`env.ts`、`health.ts`、`rbac.ts`），不预建空的 `target.ts` / `run.ts`。
- Slice 1 的领域 schema 是下一份方案的事，不在本轮创建。
- 深层路径已经被 `packages/shared/package.json` 的 `exports`（只暴露 `"."`）挡住，这是既成事实，不是待办。**新增子路径导出等于开第二套公共 API，需要单独提案。**

### D3. 配置按「谁读谁校验」，预留项只写进 `.env.example`

平台自有变量一律 `CAIRN_` 前缀。第三方库自己读的变量保持原名，不进平台 schema。

校验粒度：

| Schema | 谁在启动时 parse | 本轮纳入 |
| --- | --- | --- |
| `dbEnvSchema` | api、worker、migrate、db 测试 | 维持现状 |
| `apiEnvSchema` | api | 补上已在读的端口与 CORS；新增 `CAIRN_ENV`、`CAIRN_LOG_LEVEL` |
| `workerEnvSchema`（新建） | worker | `CAIRN_WORKER_ID`、`CAIRN_ENV`、`CAIRN_LOG_LEVEL` |
| 不建 schema | — | `CAIRN_S3_*`、`CAIRN_CREDENTIAL_KEY`、`CAIRN_SCRIPT_ROOT`（尚无读取方） |
| 不进 shared | Vite 开发代理 | `CAIRN_API_ORIGIN` 只留在 `.env.example` 与 `vite.config.ts` |

默认值仍然保留——它们让本地和测试不必先配一屏环境变量。但「私有化交付必须覆盖」不能只是一句话：

**`CAIRN_ENV` 不是 `development` 时，schema 直接拒绝开发默认值。** 在 `apiEnvSchema` 上加 `superRefine`：`CAIRN_JWT_SECRET` 等于内置默认串、或 `CAIRN_BOOTSTRAP_ADMIN_PASSWORD` 等于 `cairn-admin` 时报错，进程起不来。这样"默认值方便本地"和"生产不得裸奔"由同一个 schema 同时成立，不依赖部署清单上的一行提醒。

`CAIRN_ENV` 只用于这类"环境相关的强度差异"，不承担业务分支；`NODE_ENV` 留给工具链，不参与平台判断，避免两套环境概念。

缺必填项或类型非法时，进程在 listen / 领任务之前退出。失败输出要能直接读懂：捕获 `ZodError`，按 `变量名: 原因` 逐行打印后 `exit(1)`，不要把 Nest 的依赖注入栈甩给运维；错误信息只打变量名与规则，不回显变量值。

### D4. 四条关联 ID 语义冻结，本轮只落地 `requestId`

| 字段 | 含义 | 本轮 |
| --- | --- | --- |
| `requestId` | 一次 HTTP 请求（或一次主动调用）的关联 ID | 头、错误体、api 日志必须一致 |
| `runId` | 一次 Scenario 执行 | **禁止**用 requestId 冒充；Slice 1 有 Run 后再写 |
| `stepRunId` | Run 中某个 Step 的一次逻辑执行 | 同上 |
| `attemptId` | StepRun 的一次实际尝试 | 同上 |

Worker 本轮只带 `service`。它还没有 Run，日志里出现 `runId` 一律视为缺陷。

禁止规则之外还要一条正向规则，否则 Slice 1 会重新吵一遍：**HTTP 请求创建 Run 时，创建那一刻的 `requestId` 必须随 Run 一起落库并出现在创建日志里。** 两个 ID 并存、各自表意，"点了哪个按钮 → 产生哪个 Run"才不会断在 API 与 Worker 之间。本轮没有 Run 表，所以只冻结规则，不写实现。

入站取值优先级：`x-cairn-request-id` → `x-request-id` → 自生成。每一层都要过形状校验（ASCII 子集 `[A-Za-z0-9._:-]`，最长 128），不合形状的头视为缺失并继续向下找——上游给的值会原样进响应头、错误体和每一行日志，长度与字符集不设限等于把日志体积交给调用方决定。第二项是给网关准备的——nginx / 入口层通常已经生成了自己的请求 ID，只认平台私有头意味着平台日志和入口日志永远拼不起来。这与「不接受旧头 `x-cairn-run-id` 别名」不冲突：那是清理自己的历史包袱，这是接住上游既有事实。出站响应头只写 `x-cairn-request-id` 一个。

### D5. HTTP 错误信封冻结，前端只认这一条路

`apiErrorSchema` 形状本轮不改：

```ts
{ code, message, requestId, issues? }
```

`code` 继续由 HTTP 状态映射（`UNAUTHENTICATED`、`NOT_FOUND` 等现有表）。5xx 不把堆栈、SQL、连接串写出网，真实原因只进服务端日志。

但要留出口子：**过滤器识别 `HttpException` body 里的 `code` 字段，给了就用，没给才回落状态码映射。** 现状是 `code` 纯由状态码推导，handler 根本没有地方给出领域码；等 Slice 1 需要 `SCENARIO_NOT_BOUND`、`LEASE_CONFLICT` 时，再回头改过滤器就变成动所有人共用的兜底路径。本轮加这三行，**但一个领域码都不定义**——推迟的是词表，不是机制。

前端正式后端调用继续走 `apiFetch`。QueryClient 全局错误处理改为识别 `ApiRequestError`，不再把 Axios + `response.data.title` 当成主路径。

### D6. 成功体与列表信封

错误信封冻住而成功体没有约定，是本方案原稿的不对称。补齐：

- 单个资源：**裸对象**，不加 `{ data: … }` 包装。已有的 health / me / login 就是这样，不改。
- 集合：统一 `{ items, nextCursor? }`。`nextCursor` 由服务端给，客户端只负责回传，不解释其内容。
- **服务端截断必须由 `nextCursor` 表达。** 静默截断是缺陷，不是实现细节——现在 `listAuditEvents()` 硬编码 `.limit(200)` 且信封里没有任何"还有更多"的位置，第 201 条事件从接口上不可达。

本轮只改信封形状（shared 的三个 `*ListResponseSchema` 增加可选 `nextCursor`），游标查询实现跟着 RBAC 收口那一轮做。理由是本方案第 1 节声明过与 RBAC 正交，不在这里动 `rbac.service.ts` 的查询。**但审计的静默截断在进入试点前必须修掉**，第 8 节记账。

Slice 1 的 Run / StepRun / Evidence 列表天然会长，都按这个信封写，不要每个接口自己发明一次。

### D7. 日志脱敏是常驻规则

`redact` 清单跟着新的敏感字段增长，只增不减。本轮定的基线：`req.headers.authorization`、`req.headers.cookie`、`res.headers["set-cookie"]`。

规则不是"记得别打日志"，而是**默认序列化器不可信**：任何新接入的日志中间件、新的 `customProps`、新的 error 序列化，都要先确认它不会把整份 headers / body / env 倒出来。宪法 §15 在这一层的落点就是这张清单。

## 4. 设计

### 4.1 Logger 与 requestId

响应头改名：

```text
x-cairn-request-id
```

`REQUEST_ID_HEADER` 同步修改。仓库外没有已发布客户端，**不接受旧头 `x-cairn-run-id` 作为别名**，避免两条线并存。

api 侧保持现有时序：pino-http 的 `genReqId` 先确定值，`RequestIdMiddleware` 把它镜像到响应头，错误过滤器写入 `apiErrorSchema.requestId`。三者必须是同一个字符串。

`genReqId` 的取值顺序按 D4 改为 `x-cairn-request-id` → `x-request-id` → `randomUUID()`；`RequestIdMiddleware` 的兜底分支同步。

pino `customProps` 改为显式字段 `requestId`，删除把 requestId 赋给 `runId` 的写法。`service` 继续区分 `cairn-api` / `cairn-worker`。`/health` 仍不打访问日志。

同一个 `LoggerModule.forRoot` 里补 `redact`（api 与 worker 都配，worker 现在没有 HTTP 入口，但配置要一致，免得将来接了忘记）：

```ts
redact: {
  paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
  censor: '[redacted]',
},
```

`level` 从 `CAIRN_LOG_LEVEL` 读，不再吃 pino 默认值——线上开一次 debug 不应该需要改代码重新发版。

**CORS 要放行这个响应头。** `enableCors` 现在只有 `origin` 和 `credentials`，浏览器在跨源下读不到自定义响应头；`apiFetch` 的兜底分支（错误体解析失败时从响应头取 requestId）会拿到 `unknown`——恰好是最需要它的场景。补 `exposedHeaders: [REQUEST_ID_HEADER]`。开发期走 Vite 代理是同源，测不出这个洞，所以要靠这条设计而不是靠联调发现。

`apiFetch` 若调用方未带 `x-cairn-request-id`，则自己生成并送出，便于浏览器与服务端日志对上。失败时仍以错误体里的 `requestId` 为准。

测试里用 `run-e2e-9` 这类字符串当 requestId **可以保留**——那是值，不是语义。要补的断言有三条：

1. **至少一处断言字面串 `'x-cairn-request-id'`**。现有测试全部通过 `REQUEST_ID_HEADER` 常量断言，改名之后测试自动全绿，等于头名这个对外契约没有被任何测试钉住。
2. 发旧头 `x-cairn-run-id` 时**不被采纳**，服务端另发新 ID。
3. 日志 / `customProps` 不得出现「requestId 充当 runId」；`authorization` 头不得出现在日志输出里。

### 4.2 Config

`apiEnvSchema` 增量（均有本地默认）：

| 变量 | 默认 | 约束 |
| --- | --- | --- |
| `CAIRN_API_PORT` | `3030` | 正整数端口 |
| `CAIRN_CORS_ORIGINS` | `http://localhost:5173` | schema 内按逗号拆成 origin 数组；至少一项，每项须带 scheme（或单独的 `*`）。拆分留在 `main.ts` 的话，`,` 这类取值能通过「非空字符串」却拆出空白名单 |
| `CAIRN_ENV` | `development` | 枚举 `development` / `staging` / `production`；非 development 时触发默认值拒绝 |
| `CAIRN_LOG_LEVEL` | `info` | pino 级别枚举 |

`workerEnvSchema`：

| 变量 | 默认 | 约束 |
| --- | --- | --- |
| `CAIRN_WORKER_ID` | `local-worker` | 非空。多 Worker / Lease 落地前允许本地默认；正式部署必须每实例唯一，本轮不做唯一性检查 |
| `CAIRN_ENV`、`CAIRN_LOG_LEVEL` | 同上 | 与 api 共用定义，不各写一份 |

生产硬失败（D3）落在 `apiEnvSchema` 的 `superRefine` 上，而不是散在 `main.ts` 或 bootstrap 里——校验规则必须和默认值住在同一个文件，否则改了默认串没人记得改检查：

```ts
.superRefine((env, ctx) => {
  if (env.CAIRN_ENV === 'development') return
  // 默认串以常量形式声明一次，schema 默认值与此处检查共用
  if (env.CAIRN_JWT_SECRET === DEV_JWT_SECRET) ctx.addIssue(…)
  if (env.CAIRN_BOOTSTRAP_ADMIN_PASSWORD === DEV_ADMIN_PASSWORD) ctx.addIssue(…)
})
```

`packages/api/src/main.ts` 的端口与 CORS 改为读 `loadApiEnv()` 的结果，不再直接 `process.env`。  
`packages/worker/src/main.ts` 改为读 `loadWorkerEnv()`，不再把缺失 workerId 打成 `unset`。

`.env.example` 补上 `CAIRN_CORS_ORIGINS`、`CAIRN_API_ORIGIN`、`CAIRN_ENV`、`CAIRN_LOG_LEVEL`，并在 JWT / bootstrap 两项旁注明「`CAIRN_ENV` 非 development 时必须覆盖，否则进程拒绝启动」。分组注释：

- 平台自有、启动必校验
- 平台自有、已预留但本轮不校验
- 第三方原名

S3 / 凭证主密钥 / 脚本根保持预留注释，不写进 Zod。等 Evidence 或 SecretProvider 真正读取时，再在对应进程 schema 里必填。

### 4.3 Error 与前端收敛

保持服务端 `AllExceptionsFilter` 的两条原则：4xx 可以说清楚；5xx 只给 `requestId`。加上 D5 的扩展点：构造 payload 前先看 `HttpException` body 里有没有 `code`（字符串且非空），有就用它，没有才走 `errorCodeForStatus(status)`。5xx 分支照旧强制覆盖为 `INTERNAL_ERROR`——领域码不能成为泄露内部细节的新通道。

前端改动收在现有文件，不新开错误框架：

1. `handle-server-error.ts`：优先展示 `ApiRequestError.message`；开发态可附带 `requestId`。删除对 `AxiosError.response.data.title` 的主路径依赖。
2. `main.tsx` 的 QueryCache / mutation `onError`：`401` 走现有登出与跳转登录；判断条件改为 `ApiRequestError`（或同时兼容残留 Axios，避免未改完的模板代码把会话处理打穿）。`500` 用错误体 `message` toast，不再写死 `Internal Server Error!`。
3. 业务表单已在本地 catch `ApiRequestError` 的，不强制改文案；本轮不顺手做 i18n。

第 2 点的 Axios 兼容分支是本方案里唯一被容许的「两套真相」，因为模板残留代码还在跑。**它必须带退出条件**：RBAC 相关页面全部切到 `apiFetch` 之后，删掉 Axios 分支并从 `packages/web/package.json` 移除 `axios` 依赖。没有这句话，"临时兼容"会活得比方案久——这正是本方案对配置拒绝的形态。

`apiErrorSchema` 本身不扩字段。领域 `code` 不在本轮增加，只加读取它的能力。

### 4.4 Contracts 与 Monorepo 的落地形态

代码层面几乎没有「新建包」的工作。本轮只做：

- 在本方案和 `docs/spec/README.md` 里钉死包职责与依赖方向。
- 新增 `tools/check-deps.mjs` + 根 `package.json` 的 `check:deps`，把 D1 的允许边表变成会失败的检查。允许边直接写在脚本顶部，改边界就得改脚本，等于强制留下一次显式决定。
- shared 的导出保持从 `index.ts` 显式 re-export；`exports` 字段已经挡住深层路径，本轮不动它。
- 不改 `pnpm-workspace.yaml` / `turbo.json` 的包集合。

## 5. 实施顺序

审查通过后按这个顺序改，便于单独回滚：

1. **shared**：重命名请求头；`apiEnvSchema` 增量（端口 / CORS / `CAIRN_ENV` / `CAIRN_LOG_LEVEL` + 生产默认值 `superRefine`）；新增 `workerEnvSchema`；三个 `*ListResponseSchema` 补可选 `nextCursor`；补单测。
2. **api**：pino `customProps` + `redact` + `level`；`genReqId` 取值顺序；`main.ts` 改走 `loadApiEnv()`（端口、CORS、`exposedHeaders`）；过滤器加 `code` 扩展点；更新 `http-contract.spec` / `app.spec`（含字面头名与脱敏断言）。
3. **worker**：`loadWorkerEnv()`；LoggerModule 对齐 `redact` / `level`；启动日志打已解析的 workerId。
4. **web**：`apiFetch` 发送请求头；QueryClient / `handle-server-error` 对齐 `ApiRequestError`。
5. **工具与文档**：`tools/check-deps.mjs` + `check:deps`；删 `@nestjs/config` 依赖；`.env.example`；本目录状态更新。

第 2 步里的四件事（脱敏、CORS、取值顺序、`code` 扩展点）都落在 `app.module.ts`、`main.ts`、`all-exceptions.filter.ts` 这三个文件上，合成一次改动，不拆成四个 commit 反复动同一份文件。

仍然是一次性收口，不是独立里程碑；比原稿多约半天。

## 6. 主要改动面

| 文件 | 动作 |
| --- | --- |
| `packages/shared/src/error.ts` | `REQUEST_ID_HEADER` → `x-cairn-request-id`；注释去掉「与 pino 的 runId 同源」；新增上游头常量 `x-request-id` |
| `packages/shared/src/env.ts` | api schema 增量（端口 / CORS / `CAIRN_ENV` / `CAIRN_LOG_LEVEL`）；开发默认串提为常量；生产 `superRefine`；新增 worker schema |
| `packages/shared/src/rbac.ts` | 三个 `*ListResponseSchema` 增加可选 `nextCursor`（仅信封，不动查询） |
| `packages/shared/src/__tests__/error.test.ts` | 字面头名断言；旧头不被采纳 |
| `packages/shared/src/__tests__/env.test.ts` | 端口 / CORS / workerId 默认与非法值；`CAIRN_ENV=production` + 默认密钥必须 parse 失败 |
| `packages/api/src/app.module.ts` | `customProps.requestId`；`redact`；`level` 来自 env；`genReqId` 取值顺序 |
| `packages/api/src/main.ts` | 端口、CORS、`exposedHeaders` 来自 `loadApiEnv()`；env 解析失败时打印可读原因并 `exit(1)` |
| `packages/api/src/common/all-exceptions.filter.ts` | 认 `HttpException` body 里的 `code`，5xx 仍强制 `INTERNAL_ERROR` |
| `packages/api/src/app.spec.ts`、`common/http-contract.spec.ts` | 新头名（含一处字面串）；`authorization` 不出现在日志 |
| `packages/api/package.json` | 删 `@nestjs/config`（已确认零引用） |
| `packages/worker/src/config/env.ts`、`main.ts`、`worker.module.ts` | 新增 `loadWorkerEnv()`；启动日志用已解析的 workerId；LoggerModule 对齐 `redact` / `level`。**注意：worker 日志里本来就没有假 `runId`，这里没有要删的字段** |
| `packages/web/src/lib/api-client.ts` | 发送 `x-cairn-request-id` |
| `packages/web/src/lib/handle-server-error.ts` 及测试 | 认 `ApiRequestError` |
| `packages/web/src/main.tsx` | QueryClient 错误分支 |
| `tools/check-deps.mjs`、根 `package.json` | 新增依赖方向检查与 `check:deps` |
| `.env.example` | 补 CORS / API origin / `CAIRN_ENV` / `CAIRN_LOG_LEVEL`，分组注释与覆盖提示 |

## 7. 验收

1. 未带请求头时，响应头、错误体 `requestId`、api 日志字段三者相同；字段名是 `requestId`，不是 `runId`。
2. 带上 `x-cairn-request-id: <id>` 时三者沿用该值；只带 `x-request-id` 时同样沿用；带旧头 `x-cairn-run-id` **不会**被当成 requestId。至少一条测试断言字面串 `'x-cairn-request-id'`。
3. **已认证请求的日志里 `authorization` 与 `cookie` 是 `[redacted]`**，不含可重放的令牌。
4. `CAIRN_ENV=production` 且沿用默认 `CAIRN_JWT_SECRET` 或默认管理员口令时，api **拒绝启动**，且报错只说变量名与规则、不回显值。
5. worker 启动日志带上已解析的 `CAIRN_WORKER_ID`；结构化字段里没有 `runId`。
6. `CAIRN_API_PORT=not-a-port` 或空的 `CAIRN_DB_PASSWORD` 时，对应进程在就绪前退出，输出是逐行的变量名与原因，不是依赖注入栈。
7. 未匹配路由、未认证、校验失败、未处理异常四类响应都能通过 `apiErrorSchema.parse`；5xx 正文不含连接串或堆栈；handler 给出的 `code` 能透传，5xx 仍被强制为 `INTERNAL_ERROR`。
8. 跨源请求下浏览器能读到 `x-cairn-request-id`（`exposedHeaders` 生效）。
9. 前端 `apiFetch` 失败抛出 `ApiRequestError`；QueryClient 对 401 仍会清会话。
10. `pnpm check:deps` 通过；把 `@cairn/shared` 改成依赖 `@cairn/api`、或在包内写一条跨包相对路径 import 时，该命令**失败**。
11. `pnpm test`（已含 `pnpm check`）与 `pnpm lint` 全绿。
12. 仓库树未新增 package，未出现 `apps/` 搬家。

## 8. 刻意留给后续方案的事

- Slice 1 领域契约：Target / TargetAccount / Scenario / Step / Run / Evidence。
- 真正的 `runId` / `stepRunId` / `attemptId` 写入 Worker 与 Execution Engine 日志，以及 Run 创建时对 `requestId` 的记录（D4 正向规则的实现）。
- 领域错误码词表（机制在本轮已就位）。
- 游标查询实现；**审计接口 `.limit(200)` 的静默截断必须在进入试点前修掉**，跟 RBAC 收口一起做。
- 前端 Axios 分支与依赖的删除（触发条件见 4.3）。
- S3、SecretProvider、脚本沙箱的 env schema。
- OpenTelemetry。
- `apps/` vs `packages/` 目录调整。
- Extension 作为一等部署物入仓。

### 唯一一件不能跟着往后排的

**CI 与数据库集成测试基座，必须排在 Slice 1 之前，且要单独立项。**

仓库现在没有任何 CI，而 `packages/db/src/__tests__/` 下四组集成测试全是 `describe.skipIf(!parsed.success)`——没有 `.env` 就静默跳过而不是失败。于是本方案验收第 11 条"既有单测通过"目前只是一句口头承诺。

往前看更要命：Slice 1 的正确性核心是 `FOR UPDATE SKIP LOCKED` 原子领取、RunLease / Fencing、状态机迁移，**这些东西没有一条能用不连库的单测证明**。没有一个"缺库就失败"的 CI，宪法第 12 节那句"避免同一任务被多个 Worker 同时成功持有"就只能靠人肉自觉。

本方案不做它（不建 `@cairn/testing` 包的判断不变，这是 CI 编排问题，不是分包问题），但它不能被归进"以后再说"那一堆。复查时把两个检查脚本挂进了 `pnpm test`（见第 10 节第 4 条），那只是让本地一次命令能卡住边界，不改变"集成测试在没有库时静默跳过"这个事实。

---

这些不在本方案实施范围。本方案通过的标志是：HTTP 信封（错误与列表）和关联 ID 语义冻住，凭证不进日志，配置在生产裸奔时启动即失败，依赖方向由脚本卡住，目录保持不动。

---

## 9. 落地记录（2026-09-10）

按第 5 节顺序实施，验收第 7 节 12 条逐条有证据。以下是与方案的差异，均已在代码注释中说明理由：

1. **`dbEnvSchema` 同样归一空值**。方案只提 api schema，但 `.env.example` 里 `CAIRN_DB_HOST=` 这类占位若不归一，本地照抄示例就会因空串而启动失败——正是最难查的形态。migrate CLI 与 db 集成测试共用同一 schema，一并受益。空值仍然必填失败（`min(1)`），只是报错从「太短」变成「未设置」。
2. **配置收成唯一读取路径**。方案第 6 节写 `main.ts` 改读 `loadApiEnv()`；落地时 `loadApiEnv` / `loadDbEnv` 与新的 `resolveApiEnv` 并存等于「schema 校验过的」和「实际用的」两份值，因此删掉裸 parse 辅助函数，统一走 `config` 惰性代理与 `resolveApiEnv` / `resolveDbEnv`（worker 侧同名）。`auth.module` / `auth.service` / `bootstrap.service` 一并从各处自行 parse 改为读同一份结果。
3. **`apiFetch` 不再直接用 `crypto.randomUUID`**。它只在安全上下文可用，而私有化交付里控制台常跑在 LAN 明文 HTTP 上，那里它是 `undefined`——每个请求会在发出前就抛错，比拿不到关联 ID 严重得多。改为可用时用 `randomUUID`、否则回落 `getRandomValues`，与 `exposedHeaders` 属同一类"开发期同源测不出"的洞。
4. **脱敏与头名断言落在新文件 `packages/api/src/common/logger-redaction.spec.ts`**。方案把它们记在 `http-contract.spec`，但那个 spec 用的是不含 pino 的隔离模块，起不了真实序列化链路；只断言配置字符串等于某几个常量证明不了 `req.headers` 真被盖住，所以起真实 pino-http 中间件写流再断言。`res.headers["set-cookie"]` 也补了覆盖——方括号引号写法本身容易写错。
5. **`docs/spec/README.md` 增加「包职责与依赖方向」一节**，落实 4.4 第一条；`tools/README.md` 登记两个检查脚本。
6. **Axios 分支与依赖直接删除**，未走 4.3 的临时兼容路径：落地时 RBAC 页面已全部走 `apiFetch`，全仓 grep 无残留调用方，兼容分支没有存在理由。
7. **api 的 `/health` 不打访问日志已实测**（起真实 api 请求 `/health`，日志无对应行）；已认证请求的 `authorization` / `cookie` 实测为 `[redacted]`。

已知未做（仍按第 8 节排队）：领域契约与错误码词表、游标查询实现（审计 `.limit(200)` 静默截断待随 RBAC 收口）、S3 / SecretProvider / 脚本沙箱 env schema、OpenTelemetry、`apps/` 搬家、CI 与数据库集成测试基座。

## 10. 复查修正（2026-09-10）

12 条验收逐条起真实进程复验后，补了五处。前两处改了对外行为，记在这里而不是只留在提交信息里：

1. **`CAIRN_CORS_ORIGINS` 的拆分与校验移进 schema，类型从 `string` 变为 `string[]`。** 复验发现 `CAIRN_CORS_ORIGINS=,` 能正常启动，但响应里一个 `Access-Control-Allow-Origin` 都没有——控制台的每个跨源调用都被浏览器拦掉，而启动日志干干净净。根因是校验落在「非空字符串」上，真正决定行为的拆分却在 `main.ts` 里，正是本节第 2 条自己立的「唯一读取路径」规矩的反例。同时要求每项带 scheme：漏写 scheme 的白名单永远匹配不上，症状同样只在浏览器侧出现。
2. **入站 requestId 加形状白名单**（`[A-Za-z0-9._:-]{1,128}`，不合规则视为缺失并继续向下找）。复验用 300 字符的 `x-request-id` 打进去，值原样出现在响应头里，也会进每一行日志。CRLF 注入由 Node 的 HTTP 解析器挡着，但长度不设限意味着日志体积由调用方决定。
3. **`check-deps.mjs` 补上跨包相对路径扫描。** 原脚本只看 package.json 声明，`import '../../worker/src/x'` 不出现在任何声明里。这种写法目前被 tsc 的 `rootDir` 顺带挡着——但那是编译配置的副作用，副作用会在下次调 tsconfig 时消失，约束不该建在它上面。
4. **两个检查脚本合并成 `pnpm check` 并挂进 `pnpm test`。** 在 CI 立项之前，只挂在根 `package.json` 上的检查，有效期取决于有没有人记得敲。这是第 8 节 CI 缺口的过渡措施，不是替代。
5. **修掉 web 既有的两处 lint 错误**（`settings/account`、`settings/profile` 的 type-only import）。不是本轮引入的，但验收口径里只有单测，lint 红着就没人管；`pnpm lint` 现已全绿。
