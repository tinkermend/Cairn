# 目标系统（接入目录）

日期：2026-09-10（v2，已并入同日审查意见）。状态：**已落地**。  
对应领域对象 Target / TargetAccount。第一块业务功能，不接 Session、不接登录探测、不接 Extension。

## 1. 名称

侧边栏、页面标题、权限文案统一用 **目标系统**。

| 场合 | 用词 | 不用 |
| --- | --- | --- |
| 菜单 / 页面 | 目标系统 | 系统管理、系统配置、系统目录 |
| 子资源 | 目标账号 | 用户、执行账号（可在说明里出现，不进菜单） |
| 路由 | `/targets`、`/targets/$targetId` | `/systems`、`/settings/systems` |
| 代码与表 | `Target` / `TargetAccount`；`targets` / `target_accounts` | `system`、`console_*` |

「系统管理」会和平台自身的用户、角色、设置撞名。目标系统是要仿真的**外部业务系统**，不是识途控制台。

「用户」继续只指控制台账号。目标系统里的登录身份叫目标账号，和宪法一致：控制台身份与 TargetAccount 彻底分离。

## 2. 为什么先做这一块

没有绑定 Target 的 Scenario 不得执行。当前控制台能管账号和角色，还没有「要仿真哪套外部系统」。先把系统和目标账号做成可管理对象，后面的 Scenario、Run、会话都有归属。

和会话有关，但会话是活的浏览器认证态。本期只做目录：系统是谁、从哪进、用哪个号、认证画像是什么。保存时不创建 BrowserSession。

## 3. 目标与非目标

### 目标

1. 能新建、查看、编辑、停用、删除目标系统。
2. 每个目标系统下能新建、编辑、停用、删除目标账号。
3. 目标账号密码只写不读，落成 `secretRef`；接口与页面永不回显明文。
4. 登记入口 URL、可选登录 URL、认证方式、验证码类型——只作声明，不据此自动登录。
5. 权限沿用已有 `target:read` / `target:write` / `target:delete`。
6. 变更写入现有审计表，审计页能看到。

### 非目标

- 不实现登录探测、CSS 选择器表单、字段驱动登录、验证码识别。
- 不实现录制插件、登录绑定上传、无头试填。插件与登录绑定**另开任务会话**，见第 9 节。
- 不创建 BrowserSession，不「检查并修复」，不自动续登。
- 不建 Scenario / Run / Engine。
- 不接 Vault / KMS；本期只有本地 `SecretProvider`。
- 不把 `workflow` 权限改名为 `scenario`。
- 不修审计 `.limit(200)` 静默截断（仍记在地基方案债里）。

## 4. 决策

### D1. 一个功能，两张业务表，一页列表 + 一页详情

Target 是系统身份，不等于 URL。URL 是属性。TargetAccount 从属于一个 Target。

信息架构：

- `/targets`：表格列出目标系统。本页唯一主操作是「新建目标系统」。
- `/targets/$targetId`：上半是系统资料，下半是该系统的目标账号表。本页唯一主操作是「添加目标账号」。编辑系统用次按钮或行内保存，不和「添加账号」抢主色。

不做成 PulseAI 那种单页堆系统、登录选择器、账号、断言的目录。

### D2. 验证码和认证方式只声明，不执行

| 字段 | 取值 | 本期含义 |
| --- | --- | --- |
| `authMethod` | `password` / `manual` | 账密可被以后的登录绑定使用；手工表示首次必须人登（SSO/扫码等） |
| `captchaMode` | `none` / `image` / `slider` / `sms` / `other` | 画像。`none` 以外都表示自动续登不可作为默认承诺 |

页面用中文选项。不出现用户名选择器、密码选择器、提交选择器。

### D3. 凭据只走 SecretProvider，本期在 API 落地本地实现

`secretRefSchema` 已冻：`{ provider, secretId }`，禁止夹带 `password`。

- 新建/改密请求体可以有一次性 `password` 字段（只进 API，立刻交给 provider）。
- 持久化：`target_accounts` 只存 `secret_provider` + `secret_id`（可空：尚未设密）。
- 密文在 `secrets` 表。读账号 DTO 只给 `hasPassword: boolean`，没有密码字段。
- GET 日志、审计 summary、错误体不得出现口令。
- 业务代码不得 `select` 密文列拼进 HTTP。

本地实现：AES-256-GCM。Worker 本期不读密钥，接口形状按 `secretRef` 写，以后换 Vault 只换 provider 名，不改账号表。

**主密钥规格**（不写清就会在实现时各自决定，而密钥格式是最难回头改的一处）：

- `CAIRN_CREDENTIAL_KEY` 是 **base64 编码的 32 字节**密钥，唯一一种编码，不做 hex 兼容。
- schema 里解码并断言长度恰为 32；不合法即进程拒绝启动（与 JWT 同一套 `superRefine`）。
- 开发默认值以 shared 常量 `DEV_CREDENTIAL_KEY` 声明（同样是合法 base64），`CAIRN_ENV` 非 `development` 时取默认值即拒绝启动。默认值的**字面量只存在于 shared 一处**，schema 默认值与该检查共用；单测断言其解码长度为 32 字节。
- `.env.example` 里该项从「已预留但本轮不校验」移入「启动必校验」分组。

**密文格式**：`版本字节(1) ‖ IV(12) ‖ GCM tag(16) ‖ 密文`，IV 每次写入重新随机。首字节是格式版本，用于将来换算法或轮换密钥时区分库里的两种格式——没有它，线上同时存在两种密文时无法判定该用哪把钥匙。

**AAD**：固定为 `secrets.id` 那 36 个 ASCII 字节（即 `secretRef.secretId`），使一条密文无法被搬到另一行解密。绑行 id 而不是账号 id：轮换时会写入新行，行 id 天然跟着密文走，不必额外维护。

**读写纪律**：

- `secretRef` 一律服务端写入。请求体永不接受 `provider` / `secretId`，否则拥有 `target:write` 的人可以把任意 `secrets` 行挂到自己的账号上。`provider` 由实现写入 `LOCAL_SECRET_PROVIDER`。
- 轮换密码：同一事务内写新 `secrets` 行、更新账号指向、删除旧行。不得只改指针，留下孤儿密文。
- 清除凭据：本期必须可达——更新体接受显式 `clearPassword: true`（与 `password` 互斥，同时给出即 400），清除后视为未设密，旧 `secrets` 行同事务删除。没有这条路径，用户无法撤销一次误填的凭据。
- `authMethod = manual` 的 Target 允许存密码（SSO 场景仍可能要存备用账号），但本方案不定义任何自动使用凭据的路径，读取方由未来的登录绑定方案决定。

**落点与出口条件**：本期实现放 `packages/api/src/secrets/`，shared 只持有 `secretRefSchema` 与 provider 名常量——shared 被 web 依赖，不得引入 `node:crypto`。Worker 首次需要读凭据（登录绑定 / Run 执行）时，实现上移到独立库包，同步改 `tools/check-deps.mjs` 的允许边表；在此之前不得在 worker 侧复制第二份实现。

### D4. 编码是给人看的稳定标识，主键仍是 UUID

`targets.id` / `target_accounts.id` 用现有 `newId()`（UUIDv7）。  
`targets.code` 是 slug，库内唯一，创建后**不可改**（已被 Scenario / 会话引用时改码等于改身份）。  
`target_accounts.username` 在同一 Target 内唯一，可改。

### D5. 停用优先，删除要确认

- 停用的 Target 不能作为以后新建 Scenario / Run 的绑定对象（本期无这两类 API，只在资料上标明，详情页用橙色状态提示）。
- 删除 Target：其下仍有目标账号则拒绝（`409` / `TARGET_HAS_ACCOUNTS`），须先删账号。
- 删除目标账号：同时删除对应 secret；本期无 Session / Scenario 引用，不必再拦。
- 以后出现 Scenario 绑定或未释放 Session 时，再加拒绝，不在本期预建空检查。

**目标账号停用的语义**：与 Target 停用同构——不可被未来的 Scenario / Run / 登录绑定选用，本期只做资料标记与橙色状态提示。没有后果的 `status` 字段只是装饰，所以必须写进契约说明，不能留给实现者猜。

**删除顺序固定**：先删账号行，再删其 `secrets` 行（理由见第 6 节的外键动作）。不得留下「账号已删、密文还在」的半成品。

### D6. 列表不静默截断

目标系统、某系统下的账号，本期一次返回 `{ items }`，不加 `limit` 充「分页」。

但两个响应 schema 现在就带**可选 `nextCursor`**（`nextCursorSchema` 已在 shared）：地基方案 D6 要求列表统一 `{ items, nextCursor? }`，本期不实现游标、前端不解释其内容即可。现在省这一个字段，将来是又一次改契约。

排序：`ORDER BY created_at, id`，保证重复请求顺序稳定、分页可续。

### D7. 新接口只使用 GET 与 POST

目标系统模块不使用 PUT / PATCH / DELETE。读用 GET，写、改、删一律 POST，动作用路径表达。

| 意图 | 方法与路径 |
| --- | --- |
| 创建 | `POST /targets`、`POST /targets/:targetId/accounts` |
| 更新 | `POST /targets/:targetId`、`POST /targets/:targetId/accounts/:accountId` |
| 删除 | `POST /targets/:targetId/delete`、`POST /targets/:targetId/accounts/:accountId/delete` |

状态码必须显式写，不能吃 Nest 默认值：Nest 的 `@Post` 默认返回 **201**，若不给更新与删除加 `@HttpCode`，`POST /targets/:targetId` 会以 201 Created 回应一次「更新」。本模块统一：

| 操作 | 状态码 |
| --- | --- |
| 创建 Target / 账号 | `201`（Nest 默认，不额外标注） |
| 更新 Target / 账号 | `200`（`@HttpCode(HttpStatus.OK)`） |
| 删除 Target / 账号 | `204`（`@HttpCode(HttpStatus.NO_CONTENT)`，对齐现有 `accounts.controller.ts` 的删除接口） |

更新不可改 `code`。设密仍放在创建/更新账号的 body 里，不另开 PATCH。

**领域码怎么进响应体**：现有 rbac 全部 `throw new NotFoundException('角色不存在')`（字符串体），过滤器只能回落状态码映射，所以领域码无处可出。本模块统一用对象体：`throw new NotFoundException({ code: 'TARGET_NOT_FOUND', message: '目标系统不存在' })`——不加 `domainException` helper，五个抛出点不值得引入一层抽象；重复的形状写在方案里就是约定，写成 helper 反而多一个要维护的出口。HTTP 测试里断言**字面量** `TARGET_CODE_CONFLICT` / `TARGET_HAS_ACCOUNTS`，否则这些码没有任何测试钉住。

**5xx 不带领域码**：过滤器对 `status >= 500` 无条件覆盖 `code` 与 `message`（`all-exceptions.filter.ts:57-67`），这是「5xx 不泄露细节」的既有保证，本方案不动它。因此本模块的 503 走状态码映射（`errorCodeForStatus(503)` → `SERVICE_UNAVAILABLE`），**不引入 `TARGET_SECRET_UNAVAILABLE`**。

已有 RBAC / 登录接口维持原方法，不在本方案里改；它们与宪法 §19 的冲突作为活跃债务登记在第 13 节。之后新业务 API 按本条写。

## 5. 形状

契约进 `@cairn/shared`（建议 `target.ts`），先合入 schema 再写 handler / `apiFetch`。

### Target

```ts
{
  id,                    // UUID
  code,                  // slug，创建后只读
  name,
  entryUrl,              // 须带 scheme
  loginUrl,              // 可空；空则运行时视为与 entryUrl 相同，不在库里复制一份
  authMethod,            // password | manual
  captchaMode,           // none | image | slider | sms | other
  status,                // active | disabled
  accountCount,
  createdAt, updatedAt   // UTC，带 Z
}
```

`code`：`^[a-z][a-z0-9-]{1,62}$`（至少 2 字符——单字符 slug 是显式拒绝，不是正则写漏）。  
`entryUrl` / `loginUrl`：`http://` 或 `https://`，最长 2048，`trim` 前后空白后校验。

URL 的两条细则：**拒绝内嵌凭据**（`https://user:pass@host`）——这两个字段会进日志与未来的证据，凭据不能从这里绕进日志；**保留 fragment**（`http://host/#/login` 是真实存在的入口形态，删掉会让登记信息失真）。

### TargetAccount

```ts
{
  id,
  targetId,
  displayName,
  username,
  hasPassword,           // 无 password
  status,                // active | disabled
  createdAt, updatedAt
}
```

创建/设密 body 可含 `password`（1–256 字符，不做控制台那套 8 字符复杂度——这是目标系统口令，规则由对方定）。更新账号时 `password` 省略表示不改密；空串非法。

**清除凭据**：更新体可含 `clearPassword: true`，与 `password` 互斥（同时给出即 400）。没有这条路径，用户无法撤销一次误填的凭据，只能靠删账号。

**请求体一律 `strictObject`**（对齐 `secret-ref.ts` 已立的先例）：「多写的字段必须失败，而不是被静默丢掉」。具体到本模块，更新体带 `code`、或带 `provider` / `secretId`，必须是 400，不能静默忽略——静默忽略等于让客户端以为改成功了。

`username`：同一 Target 内唯一，**大小写敏感**（PG 默认语义），`Alice` 与 `alice` 可并存。这是本期明确选择：登录名是否大小写敏感由目标系统的规则决定，平台不做无依据的归一。将来若收紧，改成 `lower(username)` 唯一索引，属于迁移 + 冲突检查，不在本期。

### 领域错误码

4xx 的领域码由 handler 以对象体给出（见 D7）；5xx 一律走状态码映射，不带领域码。

| code | HTTP | 何时 |
| --- | --- | --- |
| `TARGET_NOT_FOUND` | 404 | 系统或账号所属系统不存在 |
| `TARGET_ACCOUNT_NOT_FOUND` | 404 | 账号不存在或不属于该系统 |
| `TARGET_CODE_CONFLICT` | 409 | code 重复 |
| `TARGET_ACCOUNT_CONFLICT` | 409 | 同系统 username 重复 |
| `TARGET_HAS_ACCOUNTS` | 409 | 删除系统时仍有账号 |

主密钥缺失或密文解密失败返回 503，`code` 是状态码映射出的 `SERVICE_UNAVAILABLE`——过滤器对 5xx 强制覆盖 `code` 与 `message`，这是既有的「5xx 不泄露细节」保证，本模块不开口子。真实原因（哪个账号、哪种失败）只进服务端日志。

唯一约束冲突（PG `23505`）必须显式映射到上表的两个 409：不能只靠「先查一次再写」，并发下两个请求会同时通过检查，最终由数据库报错——那条路径不映射就会变成 500。

## 6. 持久化

新迁移 `0004_targets.sql`（幂等、`__SCHEMA__` 占位）。Drizzle 视图同步，集成测试在有库时做 schema-parity。

```text
targets
  id, code UNIQUE, name,
  entry_url, login_url NULL,
  auth_method, captcha_mode, status,
  created_at, updated_at

secrets
  id, provider TEXT, ciphertext BYTEA, created_at, updated_at

target_accounts
  id, target_id → targets ON DELETE RESTRICT,
  display_name, username,
  secret_provider NULL, secret_id NULL → secrets ON DELETE RESTRICT,
  status, created_at, updated_at
  UNIQUE (target_id, username)
```

CHECK：`status ∈ (active, disabled)`；`auth_method` / `captcha_mode` 封闭枚举；`secret_id` 与 `secret_provider` 同有或同无。

`secret_id` 的外键动作必须是 `RESTRICT`，不能写 `SET NULL`：PG 的引用动作会触发子表的 CHECK 求值，`SET NULL` 只清空 `secret_id` 而 `secret_provider` 仍非空，正好撞上「同有或同无」约束，删除直接失败（PG 16 实测：报 `new row for relation "target_accounts" violates check constraint "secret_ref_pair"`，并标出这是外键内部 `UPDATE … SET secret_id = NULL` 触发的）。RESTRICT 也顺带保证不会出现「账号还指着已删除的密文」，代价是必须先删账号行——上一条的事务顺序就是为此而定。

删除账号的事务顺序固定：**先删账号行，再删 `secrets` 行**（顺序反了会被 RESTRICT 拦住）。不得留下「账号已删、密文还在」或「secret 已删、账号仍指着」的半成品。

索引：`target_accounts (target_id)`（详情页按系统列账号）；`UNIQUE (target_id, username)` 与 `targets (code)` 均为唯一索引。

## 7. API

沿用现有鉴权、`apiErrorSchema`、裸对象成功体。前缀 `/targets`，挂在 api 新模块，不塞进 `rbac.service`。只注册 GET / POST。

| 方法 | 路径 | 权限 | 成功状态码 | 说明 |
| --- | --- | --- | --- | --- |
| GET | `/targets` | `target:read` | 200 | `{ items, nextCursor? }` |
| POST | `/targets` | `target:write` | 201 | 创建 |
| GET | `/targets/:targetId` | `target:read` | 200 | 只返回 Target |
| POST | `/targets/:targetId` | `target:write` | 200 | 更新；不可改 `code` |
| POST | `/targets/:targetId/delete` | `target:delete` | 204 | 无账号才成功 |
| GET | `/targets/:targetId/accounts` | `target:read` | 200 | `{ items, nextCursor? }` |
| POST | `/targets/:targetId/accounts` | `target:write` | 201 | 创建；可带 password |
| POST | `/targets/:targetId/accounts/:accountId` | `target:write` | 200 | 更新；可带 password 轮换或 clearPassword |
| POST | `/targets/:targetId/accounts/:accountId/delete` | `target:delete` | 204 | 删账号与 secret |

详情推荐：`GET /targets/:id` 只返回 Target；账号用子资源列表。前端详情页打两次查询（`['target', id]` 与 `['target', id, 'accounts']`），契约更干净；删除账号后要失效前者的 `accountCount` 与后者的列表。

审计 action（扩 `AUDIT_ACTIONS`，写入现有 `console_audit_events`）：

`target.create` / `target.update` / `target.delete` / `target_account.create` / `target_account.update` / `target_account.delete` / `target_account.password`

summary 只含名称、code、username，不含口令。设密记 `target_account.password`，不记新旧值。

**审计必须与业务写在同一事务里**。现有 `rbac.service.ts` 的 `recordAudit` 直写 `this.db`，不在调用方事务内：create / update 的事务回滚后审计行可能残留，提交后崩溃则丢审计。本模块不沿用这种写法——在 `this.db.transaction(async (tx) => { …; await tx.insert(consoleAuditEvents).values({ … }) })` 内直接写（db 包已导出该 schema），不依赖 `rbac.service` 的私有方法，也不为它加一层 helper。

## 8. 界面

遵循 `docs/design/front/`：白卡片、浅灰页底、一页一个主操作、表格管批量、状态用徽章（启用绿、停用灰、验证码非 none 用橙作「自动续登受限」提示，不要用红）。

- 侧栏「工作台」在首页与用户之间插入「目标系统」，`permission: target:read`。
- 首页增加一张入口卡，文案与侧栏一致；`features/home/index.tsx` 里 `modules` 的 `to` 联合类型同步加 `'/targets'`。
- 路由按现有约定落在 `routes/_authenticated/`：列表 `targets/index.tsx`，详情 `targets/$targetId/index.tsx`（目录式，与 `users/`、`roles/`、`audit/` 一致）。`routeTree.gen.ts` 是生成物，随构建更新，不手改。
- 列表列：名称、编码、入口、认证、验证码、账号数、状态、更新时间。行点击进详情。
- 新建/编辑系统用 Dialog 或详情页表单，字段即第 5 节；`code` 仅创建时可填。
- 目标账号表：显示名、登录名、凭据（已保存 / 未设置）、状态。添加/编辑 Dialog 里密码是 PasswordInput，编辑时占位「不修改则留空」，另有「清除已保存凭据」的显式操作。
- 删除用现有 ConfirmDialog，写清后果。
- 空态：还没有目标系统 / 该系统还没有目标账号。
- 只读角色看不见主按钮，路由无 `target:read` 进 403。
- **权限矩阵中文标签同步**：`features/rbac/components/permission-matrix.tsx` 里 `target: 'Target'` 与 `'查看 Target'` / `'创建和更新 Target'` / `'删除 Target'` 改成本方案的措辞。不改就会出现「菜单叫目标系统、权限矩阵叫 Target」。
- 审计页描述文案同步（`features/audit/index.tsx` 现为「身份与权限变更记录」，纳入 Target 变更后不再准确）。

本期不画「探测登录页」「打开录制」入口，避免半残能力上菜单。

## 9. 刻意留给后续会话的：登录绑定与插件

已讨论、**不在本方案实现**的约定，供下一场单独开：

1. 默认按常规登录页探测账号/密码框，**验证登录成功**后才写入登录绑定。
2. 找不到框，或验证失败 1～2 次，请用户用录制插件点选用户名、密码、登录按钮，上传**同一份** LoginBinding。
3. 插件只传定位描述，不传页面里敲的密码，不传 Cookie。
4. 正式 Run 不依赖插件仍开着。
5. 已声明图形/短信/滑块验证码时，自动猜填不能当默认承诺。

那一场再写登录绑定方案。本方案合入后即可开发目录本身。

用户手填的登录框定位（`id` / `name` / CSS）已前移到 [目标系统补丁：首个账号与登录框定位](2026-09-10-target-login-fields.md)。探测、验证成功后写死绑定、插件点选仍按本条，不在目录补丁里做。

## 10. 实施顺序

审查通过后按此改，便于单独回滚：

1. **shared**：`target.ts` schema、错误码常量、审计 action，并在 `src/index.ts` re-export（`exports` 只暴露 `"."`，不 re-export 等于前端拿不到契约）；`apiEnvSchema` 纳入 `CAIRN_CREDENTIAL_KEY`（base64 / 32 字节）与 `DEV_CREDENTIAL_KEY` 生产拒绝；单测。
2. **db**：`0004_targets.sql` + Drizzle；parity 测试（含既有「全库表清单」断言的更新与三张表的列断言）。
3. **api**：LocalSecretProvider、targets 模块（含领域码对象体与 23505 映射）、HTTP 测试（含：响应无 password、日志无口令、删系统有账号 409、更新 200 / 删除 204、strict 体拒绝 `code`）。
4. **web**：路由、列表、详情、表单、侧栏与首页入口、权限矩阵中文标签、审计页描述文案。
5. 本目录状态改为已落地；第 13 节的债务在 `docs/spec/README.md` 留痕。

不新建 package，不搬 `apps/`。

## 11. 验收

1. 无 `target:read` 看不见菜单，直链进 403；无写权限不能新建。
2. 创建目标系统后列表与详情一致；`code` 重复 409 且 `code` 字面量为 `TARGET_CODE_CONFLICT`；`code` 只给 1 个字符 400。
3. 非法 URL：无 scheme、含内嵌凭据（`https://u:p@host`）均 400 `BAD_REQUEST`——本模块不引入 422，校验失败走 `ZodValidationPipe` 的既有形态。
4. 同一系统两个相同 `username` 409 `TARGET_ACCOUNT_CONFLICT`；不同系统可以同名；并发提交同名时由 `23505` 映射得到同一个 409，不是 500。
5. 创建带密码的目标账号后，GET 只有 `hasPassword: true`，body / 日志 / 审计无明文。
6. `POST` 更新账号（不是 PATCH）省略 `password` 不改密；再 POST 带新密码仍不回显，且旧 `secrets` 行已删除（查库计数，不留孤儿）。
7. `clearPassword: true` 清除后 `hasPassword: false` 且 `secrets` 行消失；`password` 与 `clearPassword` 同时给出 400；更新体带 `code` 或 `provider` 400。
8. 更新返回 200、删除返回 204（不是 Nest 的 201 默认值）。
9. 系统下还有账号时 `POST .../delete` 失败（409 `TARGET_HAS_ACCOUNTS`）；删光账号后再删系统，对应 secret 行不残留。
10. 审计行与业务写在同一事务：写操作失败时 `console_audit_events` 无残留。
11. 停用后资料显示停用，记录仍在，不是删除；账号停用同理。
12. 上述变更能在审计页按新 action 看到。
13. `CAIRN_ENV=production` 且沿用开发默认 `CAIRN_CREDENTIAL_KEY` 时 api 拒绝启动；`CAIRN_CREDENTIAL_KEY` 不是合法 base64 或解码后不是 32 字节时同样拒绝启动，报错只说变量名与规则。
14. 权限矩阵页显示「目标系统」措辞，不出现裸 `Target`。
15. `pnpm test` 与 `pnpm lint` 通过；`pnpm check:deps` 不破。
16. 页面无选择器字段、无会话按钮、无插件入口。

## 12. 主要改动面（落地时）

| 区域 | 动作 |
| --- | --- |
| `packages/shared/src/target.ts`、`src/index.ts` | 新建契约并 re-export |
| `packages/shared/src/env.ts` | `CAIRN_CREDENTIAL_KEY`（base64 / 32 字节）+ `DEV_CREDENTIAL_KEY` 生产拒绝 |
| `packages/shared/src/rbac.ts` | 新增审计 action 常量 |
| `packages/db/migrations/0004_targets.sql`、`schema/` | 三张表 + 索引 + CHECK |
| `packages/db/src/__tests__/schema-parity.test.ts` | 更新全库表清单断言；补三张表的列断言 |
| `packages/api/src/targets/`、`src/secrets/` | 模块与本地加密 |
| `packages/api/src/common/` | 领域码以对象体给出（或加 `domainException` helper） |
| `packages/web/src/features/targets/`、`routes/_authenticated/targets/` | 列表、详情、表单 |
| `packages/web/src/components/layout/data/sidebar-data.ts` | 侧栏入口 |
| `packages/web/src/features/home/index.tsx` | 入口卡 + `to` 联合类型 |
| `packages/web/src/features/rbac/components/permission-matrix.tsx` | `target` 中文标签改为「目标系统」 |
| `packages/web/src/features/audit/index.tsx` | 描述文案不再只说身份与权限 |
| `.env.example` | `CAIRN_CREDENTIAL_KEY` 从「预留不校验」移入「启动必校验」分组 |

对照设计规范改 UI，不另开视觉方案。

## 13. 债务与本方案之外的事实

本方案不解决下列问题，但必须显式登记——不登记等于让它们变成没人负责的既成事实。

1. **宪法 §19 当前是破的。** 现有 `accounts.controller.ts` / `rbac.controller.ts` 用 `@Patch` / `@Put` / `@Delete`，而宪法第 19 条要求平台 API 对外只允许 GET 与 POST。本方案的新接口按 GET/POST 写，但**不**顺手改已有 RBAC 端点（正交，且会同时动前端 `rbac-api.ts` 与测试）。触发条件：**与目标目录同批，或试点开始前**，把三组端点迁到 `POST …/delete`、`POST …/roles` 这类形态，并同步前端的 `PATCH` / `PUT` / `DELETE` 调用。在此之前它是一条活跃违宪项，写进 `docs/spec/README.md` 的债务清单。
2. **审计 `.limit(200)` 静默截断**仍未修，归 RBAC 收口那一轮（地基方案 §8 已记账）。目标目录写入的审计事件会一起被截断。
3. **viewer 系统角色自带 `target:read`**（`0002_rbac.sql:132`）。本期接受这个后果：只读角色能看到目标账号的登录名与「是否已设密」。若认为登录名本身敏感，就是权限模型要细分（另立 `target_account:read` 之类），超出本期。
