# 控制台审计拆分：操作记录与登录记录

日期：2026-09-13。状态：**已落地**。

范围：把现有「审计」从一张混排变更表，收成控制台治理下的两个只读列表——**操作记录**与**登录记录**；补上目前缺失的控制台登录落库（含 IP）。  
不新增里程碑，不调整 D0–D4。审查通过后再实施。交付顺序仍以[工程实施计划第 5 节](../plan/识途开发路线与工程实施计划.md#5-当前交付顺序与验收样例)为准。

依据：宪法 §12 / §15 / §18.18 / §19（控制面 GET/POST、凭证不进日志、约束由代码与 Schema 卡住）；现有 `console_audit_events`、`POST /api/auth/login`、[平台地基](2026-09-10-platform-foundation.md) 列表信封、[数据库可替换性](2026-09-13-database-portability.md)、[前端工作流](../design/front/ai-workflow.md)。

## 1. 为什么现在写

当前侧栏只有「审计」，页面四列：时间、操作者、动作码、摘要。表 `console_audit_events` 只记控制台变更（账号、角色、Target、Scenario、Run、录制草稿、会话处置）。`AuthService.login` **成功和失败都不写审计**，也没有 IP / User-Agent。

变更事件和登录事件回答的不是同一个问题，列也撑不住共用一张默认表：

| | 操作记录 | 登录记录 |
|---|---|---|
| 要回答的 | 谁对哪个对象做了什么 | 谁从哪来、用什么客户端、成没成 |
| 主体 | 几乎总有控制台账号 | 失败时常常没有账号 id |
| 写入时机 | 必须与业务事实同事务 | 成功与 `touchLocalIdentity` 同事务；失败没有可并列的业务事实 |
| 敏感点 | 摘要不得含口令、选择器原文 | IP、登录名、失败原因；对管理员可见，对外响应仍不可枚举账号 |

产品名继续叫**审计**，不叫「日志管理」。运行 Evidence、Playwright Trace、API / Worker 结构化日志是另一条线，不进本菜单。

## 2. 目标与非目标

### 目标

1. 侧栏保留单一「审计」入口；页内用两个表格页签切换 **操作记录** 与 **登录记录**。
2. 登录成功、失败、账号已停用都落库；带 IP、User-Agent、客户端（Web / 扩展）、尝试的登录名、结果与内部失败原因。
3. 操作列表只含变更事件；登录列表只含登录事件。历史变更行全部归入操作记录，不丢。
4. 权限拆开：`audit:read` 看操作，`audit:login` 看登录。默认只给 admin 登录记录。
5. 两个列表都用 `{ items, nextCursor }`，修掉现有 `.limit(200)` 静默截断。
6. HTTP 对外响应与审计行都不出现口令明文；失败登录的对外文案保持现状，不因本方案变得更容易枚举账号。

### 非目标

- 不做「日志管理」一级菜单，不做操作管理、系统日志、采集、导出、告警、地理位置、设备指纹、会话吊销列表。
- 不记 JWT 过期、`GET /me`、续期（当前没有 refresh）、登出（当前没有登出接口）、扩展里已登录态的探活。
- 不把 Run / Step / Evidence / Trace / pino 行写进这张表或这个菜单。
- 不做登录频率限制、验证码、锁定策略；失败行可被刷，只在第 8 节记账。
- 不要求本期所有历史操作行补 IP；不强制改 Worker 恢复等无 HTTP 上下文的写入链。
- 不改 TargetAccount 登录（那是目标系统账号，与控制台身份分离）。
- 不把本方案排进 D1–D4 Gate。

## 3. 决策

### D1. 信息架构：审计单入口，页内两表，不升级成日志产品

```text
用户
角色
审计                 /audit  （按权限重定向）
  页签 操作记录      /audit/operations
  页签 登录记录      /audit/logins
```

侧栏只保留一项「审计」，不展开子菜单。有 `audit:read` 或 `audit:login` 任一即显示。`/audit` 按权限重定向：有 `audit:read` 去操作记录，否则有 `audit:login` 去登录记录。首页「审计」卡片同样处理。

页内用 Tabs 切换两张独立表格，数据与权限仍按路由拆开。没有 `audit:login` 时不出现「登录记录」页签（不是禁用）。只有一项权限时不画孤单页签，标题仍是「审计」，说明跟当前表。

只读页没有主操作按钮。筛选是主要交互。成功用绿、失败用红；动作码保持次要。

### D2. 一张表、一个 category，不拆登录表

继续用 `console_audit_events`。新增列，旧行 `category = 'operation'`。登录与操作共享 id / 时间 / 操作者外键，列表按 category 过滤。

不拆第二张业务表：迁移、三库契约、`transfer` 和 actor join 只维护一份。登录专用字段在操作行为空。

### D3. 登录权限默认仅 admin

新增权限码 `audit:login`（目录内特殊 action，先例是 `session:dispose`）。

| 系统角色 | `audit:read` | `audit:login` |
|---|---|---|
| admin | 有（已有） | **新增** |
| operator | 有（已有） | 无 |
| viewer | 有（已有） | 无 |

登录名 + IP 是安全治理数据，不能因为 operator / viewer 已经能看变更记录就顺手放开。自定义角色须显式勾选。`admin` 随 `PERMISSIONS` 全目录获得该码；迁移按 [0009](../../packages/db/migrations/0009_session_dispose.sql) 的方式补种，否则存量库 admin 会 403。

`viewer` 权限仍全部以 `:read` 结尾的约定不变。

### D4. 客户端地址默认不信任转发头

进程默认 **不** 启用 `trust proxy`。`client_ip` 取套接字对端地址，忽略 `X-Forwarded-For` / `X-Real-IP` / `Forwarded`。

新增 API 配置 `CAIRN_TRUST_PROXY_HOPS`（整数，默认 `0`）：

- `0`：只用 `req.socket.remoteAddress`（或等价）。
- `n ≥ 1`：`app.set('trust proxy', n)`，使用框架解析后的 `req.ip`。

反代后的部署必须按可信跳数填写，方案与 `deploy/.env.example` 写明。取不到地址时存 `null`，界面写「未知」，不编造 `0.0.0.0`。`::ffff:x.x.x.x` 归一成 IPv4 文本。User-Agent 原文最多 512 字，超长截断。

客户端种类不信请求体：`Origin` 以 `chrome-extension://` 开头则为 `extension`，否则 `web`。扩展与 Web 共用 `POST /api/auth/login`，由此区分。

### D5. 对外失败原因合并，对内原因分开

HTTP 保持现有语义：

- 账号不存在或密码错误 → `401`「账号或密码不正确」
- 密码正确但账号停用 → `403`「账号已停用」
- 请求体校验失败 → `400`，**不写登录审计**（尚未构成一次认证尝试）

审计行内部 `failure_reason` 封闭枚举：`unknown_account` | `invalid_password` | `account_disabled`。管理员看登录记录时可以看到分项，用来查撞库或误停用；对外响应不得改成与内部原因一一对应（停用在输对密码后的 403 是既有行为，本期不改）。

继续走 `dummyVerify`，避免按校验耗时枚举账号。

### D6. 写入纪律按类别分开，不混用一条 `recordAudit`

| 类别 | 写入 | 失败时 |
|---|---|---|
| 操作 | 现有 `recordAudit`，与业务事实同事务；`category` 默认 `operation` | 整笔业务失败，不得先成事实再补审计 |
| 登录成功 | `touchLocalIdentity` 与登录行**同一事务**，提交后再签 JWT | 审计写入失败则登录失败（不发令牌） |
| 登录失败 | 独立插入，没有可并列的业务事实 | 插入失败只记结构化错误日志，HTTP 仍为 401/403，避免审计故障变成「登录突然成功」或改变错误码 |

口令、`authorization`、cookie 不得出现在 `summary`、新列或测试断言的期望原文里。登录摘要固定为「登录成功」或「登录失败」。尝试的登录名只进 `login_identifier`（trim + lower，最长 64，与现有 `accountLoginSchema` 一致）。

`recordAudit` 可增加可选 `client?: { ip, userAgent, kind }`，供控制面后续补操作行的来源。本期**不**把「每条操作都有 IP」列为验收 Gate；Worker 恢复、无 Request 的路径继续留空。

## 4. 当前实现与必要增量

| 当前代码 | 已有 | 本轮 |
|---|---|---|
| `packages/db/src/schema/audit.ts`、`0003_audit.sql` | 变更事件六列 | 加 category 与登录列；三库迁移 |
| `packages/db/src/audit/record.ts`、`RbacStore.insertAudit` | 只写操作 | 默认 `operation`；可选 client |
| `packages/api/src/auth/auth.service.ts` | 验密、停用、JWT，无审计 | 成功/失败/停用写登录行 |
| `GET /api/console/audit`、`listAuditEvents` | 全表最新 200 条，无游标 | 只返回操作；游标分页；另开登录列表 |
| `PERMISSIONS` / `0002` / `0009` | 仅 `audit:read`，三角色都有 | 增 `audit:login`，只补种 admin |
| Web `/audit`、侧栏、首页卡片 | 单页单表 | 侧栏单入口 + 两路由页签 + 重定向 + 分子权限 |
| `main.ts` | 无 trust proxy | 按 `CAIRN_TRUST_PROXY_HOPS` 设置 |

## 5. 数据与契约

### 5.1 表增量

`console_audit_events` 增加：

| 列 | 约束 | 含义 |
|---|---|---|
| `category` | `TEXT NOT NULL DEFAULT 'operation'` | `operation` \| `login` |
| `client_ip` | `TEXT` 可空 | 归一后的客户端地址 |
| `user_agent` | `TEXT` 可空 | 截断后的 UA |
| `client_kind` | `TEXT` 可空 | `web` \| `extension` |
| `login_identifier` | `TEXT` 可空 | 尝试的登录名（已规范化） |
| `outcome` | `TEXT` 可空 | 仅登录：`success` \| `failure` |
| `failure_reason` | `TEXT` 可空 | 仅失败登录：第 3 节枚举 |

存量行不改写，只靠默认 `operation`。

不变量（写路径 + Zod 必卡；PostgreSQL / MySQL 加 CHECK；SQLite 以写路径与契约测试为准）：

- `category = 'operation'` → `outcome`、`failure_reason`、`login_identifier` 均为空；`action` 不得为 `auth.login`
- `category = 'login'` → `action = 'auth.login'`，`resource = 'auth'`，`outcome` 必填，`login_identifier` 必填
- `outcome = 'success'` → `failure_reason` 空，`actor_console_account_id` 与 `resource_id` 为该账号
- `outcome = 'failure'` → `failure_reason` 必填；`unknown_account` 时 actor / resource_id 为空；`invalid_password` / `account_disabled` 时 actor 与 resource_id 指向该账号

索引：`(category, created_at DESC)`；登录列表再加 `(category, outcome, created_at DESC)`。`login_identifier` 等值筛选若走索引，须列入 `indexedTextLimits`（64）。

迁移：

- PostgreSQL：`0016_audit_login.sql`（ALTER + CHECK + 索引 + 给 admin 补 `audit:login`）
- MySQL / SQLite：各自目录下一条增量，语义等同；基线 `0001` 不改写

### 5.2 动作与 DTO

`AUDIT_ACTIONS` 增加 `auth.login`。操作列表的 action 筛选只提供既有变更动作。

共享 Zod 分两个列表项，不把登录列塞进操作 DTO：

```text
OperationAuditEvent
  id, action, resource, resourceId, summary,
  actor: { id, displayName, email } | null,
  clientIp?, userAgent?, clientKind?,
  createdAt

LoginAuditEvent
  id, loginIdentifier, outcome, failureReason?,
  actor: { id, displayName, email } | null,
  clientIp, userAgent?, clientKind,
  createdAt
```

`clientIp` 在登录 DTO 允许 `null`（解析失败），界面显示「未知」。列表信封均为 `{ items, nextCursor? }`。

### 5.3 HTTP

只使用 GET。查询参数一律可选。

| 方法 | 路径 | 权限 | 作用 |
|---|---|---|---|
| GET | `/api/console/audit/operations` | `audit:read` | 操作记录 |
| GET | `/api/console/audit/logins` | `audit:login` | 登录记录 |
| GET | `/api/console/audit` | `audit:read` | **兼容别名**，与 operations 相同 |

静态子路径必须注册在任何 `:id` 之前（本期无详情 id）。

公共查询：`cursor`、`limit`（默认 50，最大 200）、`from`、`to`（ISO 8601；含起不含止；`from ≥ to` 为 400）。

操作另加：`action`（须为变更类 `AUDIT_ACTIONS`）、`actorId`。  
登录另加：`outcome`、`actorId`、`identifier`（与库中规范化值等值匹配，不做前后模糊）、`clientKind`。

游标由服务端生成、客户端原样回传，不解释。排序：`created_at DESC, id DESC`。截断必须带 `nextCursor`，禁止再静默 `limit(200)`。

无权限 403，未认证 401。

## 6. 界面

任务：追查「谁改了平台」或「谁从哪登录」。主操作：无。布局：标题「审计」→ **同一张卡片**（有两项权限时页签在卡片顶栏，接着是筛选工具栏、表格、分页）。对齐目标系统列表把筛选收进表头栏的做法，没有新建、没有行选择抽屉。页签是内容导航，不进标题动作区，也不作为页面背景上的独立一层。

**操作记录**列：时间、操作者（名 + 登录名）、动作（中文标签，原文 `code` 次要）、摘要。空态：「还没有操作记录」。

**登录记录**列：时间、账户（尝试的登录标识，已解析到账号时可附显示名）、结果（成功 / 失败徽章）、失败原因（内部枚举的中文；成功行空白）、IP、客户端（控制台 / 扩展）、User-Agent（过长截断，悬停 / 聚焦 Tooltip 给全文）。空态：「还没有登录记录」。筛选里的账户对应 `login_identifier`；时间用 Range Picker，不用并排两个原生日期框。

两表都用服务端游标分页：默认每页 20 行，可选 10 / 20 / 50；上一页 / 下一页；筛选或改页大小回到第一页。不使用「加载更多」累加。

筛选空结果与「库里没有任何行」分开文案，且都留在同一张卡片里。窄屏表格在容器内横滑，页面不整体撑出横向滚动。

动作中文标签放 `@cairn/shared`（或与现有 labels 同层），Web 不硬编码一份。失败原因中文：

| 码 | 文案 |
|---|---|
| `unknown_account` | 账号不存在 |
| `invalid_password` | 密码不正确 |
| `account_disabled` | 账号已停用 |

实施时走[前端工作流](../design/front/ai-workflow.md)与[前端验收 skill](../../.agents/skills/shitu-frontend-acceptance/SKILL.md)（新页面 + 导航，按页面级验收）。不另做 HTML 原型。

涉及文件（实施时，不是现在改）：

| 位置 | 作用 |
|---|---|
| `packages/shared/src/rbac.ts` 及测试 | 权限、动作、DTO、筛选 schema |
| `packages/shared/src/env.ts`、`.env.example`、`deploy/.env.example` | `CAIRN_TRUST_PROXY_HOPS` |
| `packages/db` schema / `record.ts` / `RbacStore` 列表 / 三库迁移 / 契约测试 | 列、写入、查询 |
| `packages/api` auth、audit controller、cors/trust proxy、HTTP 测试 | 登录落库与两个 GET |
| `packages/web` 侧栏、路由、首页、`features/audit/*`、`rbac-api` | 两页与权限显隐 |

## 7. 验收

审查通过并落地后，至少卡住：

1. 成功登录：事务内有 `category=login`、`outcome=success`、规范化登录名、IP（测试可注入）、`client_kind`；响应仍无审计字段以外的新秘密；口令不出现在行内。
2. 错误密码 / 未知账号：401 文案不变；各写失败行；未知账号无 actor；错误密码有 actor；两行都无口令。
3. 停用账号且密码正确：403；`failure_reason=account_disabled`。
4. 扩展 Origin 的成功登录：`client_kind=extension`。
5. 操作列表不含登录行；登录列表不含历史变更行；旧 `GET /console/audit` 与 operations 一致。
6. 超过一页时有 `nextCursor`，回传可取下一页；不得再静默截断。
7. `audit:read` 不能读 logins（403）；`audit:login` 不能读 operations（403）。viewer / operator 默认无登录页签。
8. 存量变更行出现在操作记录，`category` 为 `operation`。
9. 请求体校验失败不写登录行。
10. `CAIRN_TRUST_PROXY_HOPS=0` 时，伪造的 `X-Forwarded-For` 不得成为 `client_ip`。
11. 三库迁移后 schema 与 Drizzle 定义一致；admin 补种 `audit:login` 幂等。
12. Web：侧栏单入口、页内页签、两路由、`/audit` 重定向、无权入口与无权页签隐藏；操作与登录表在代表宽度下可完成筛选与空/错/有数据三态。

## 8. 现在不做（记账）

- 登录失败限流、锁定、验证码、保留期与清理。
- 操作行补齐 IP 的全调用链改造；操作详情抽屉、导出、按 IP 反查。
- 登出 / 令牌吊销 / 刷新令牌事件。
- 把登录记录再拆给「只看自己的登录」。
- 地理位置、ASN、User-Agent 解析成浏览器/操作系统。
- 系统日志、Evidence、Trace 并入本菜单。
- 自定义角色的权限文案国际化（目录标签仍按现有英文风格，页面中文另表）。

## 9. 审查结论

已审过并落地：审计侧栏单入口，页内用操作记录 / 登录记录两个表格页签；登录成功、失败与停用入账；`audit:login` 默认仅 admin。
