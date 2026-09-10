# 目标系统补丁：首个账号与登录框定位

日期：2026-09-10。状态：**已落地**。  
补丁对象：[目标系统（接入目录）](2026-09-10-target-catalog.md)。目录本身已落地；本补丁只补「新建/编辑时能登记账密与登录框怎么找」，以及对照现页后必须顺手补齐的交互。

不接 Session、不打开浏览器试填、不接录制插件、不建启发式管理菜单。

## 1. 为什么要补

上一版把登录探测和选择器整段留给第 9 节，所以落地后的新建对话框只有系统资料。认证方式选了「账号密码」，却不能在同一张单子上写下第一个号，也不能写下用户已经知道的输入框 `id` / `name`。目录能建，但接入一个真实系统仍要再点一次详情、再猜一次框——这是产品缺口，不是实现漏写。

两件不同的事必须分开存：

| | 账号密码 | 登录框怎么找 |
|---|---|---|
| 属于谁 | **目标账号**（这个号是谁） | **目标系统**（这页上的框在哪） |
| 填什么 | 显示名、登录名、口令 | 用户名框 / 密码框 / 提交钮的定位 |
| 落点 | 已有 `target_accounts` + `secrets` | 本补丁：`targets.login_fields` |
| 空着 | 详情里以后再加账号 | 运行时按平台启发式猜，不在保存时开浏览器 |

用户自填的定位是这个系统自己的知识，进库。平台「常见字段」清单是算法，进代码，不进库，不做管理菜单。

## 2. 目标与非目标

### 目标

1. 认证方式为 `password` 时，新建目标系统可顺带创建一个目标账号；口令纪律与现账号接口相同（只写不读、进 SecretProvider）。
2. 新建/编辑目标系统可**可选**填写用户名框、密码框、提交钮的定位（`id` / `name` / CSS）。
3. 未填的字段表示「未指定」。保存时不猜测、不写回猜测结果。真正按清单去碰 DOM，留给登录绑定 / 试填。
4. 详情「系统资料」能看出哪些定位是用户指定的、哪些将按启发式猜测。
5. 对照现页补齐第 6 节的交互缺口（空态按钮、URL 可打开、编码说明、弹层重置、创建后进详情）。

### 非目标

- 不在保存时打开页面探测或验证登录。
- 不把猜到的选择器当成已确认 LoginBinding 写回。
- 不建「启发式规则」管理菜单，不把常见字段清单落库。
- 不接 Extension 点选上传。
- 不创建 BrowserSession，不做「检查并修复」。
- 不改验证码识别，不把 `captchaMode !== none` 的系统默许为可自动登。
- 不做列表搜索、筛选、分页（列表契约仍是 `{ items, nextCursor? }`，本期仍一次返回）。

## 3. 决策

### D1. 用户指定的定位挂在 Target，常见候选放 shared 代码

`login_fields` 只存用户显式写下的定位。形状：

```ts
{
  username?: { by: 'id' | 'name' | 'css', value: string }
  password?: { by: 'id' | 'name' | 'css', value: string }
  submit?:   { by: 'id' | 'name' | 'css', value: string }
}
```

- `id`：元素 `id`，值不含 `#`。
- `name`：表单控件 `name` 属性。
- `css`：完整 CSS 选择器（用户确定时才用，例如 `form#login input.user`）。
- `value`：`trim` 后 1–256 字符；空串视为未指定（该键省略）。
- 三个键都可独立省略。整份 `login_fields` 为 `null` 与 `{}` 语义相同：全部未指定。
- 请求体不接受 `provider` / `secretId` / 明文猜测结果 / `heuristicVersion` 回写。

平台启发式是常量，放 `@cairn/shared`：

- `LOGIN_HEURISTIC_VERSION`：整数，从 `1` 起。改清单必须加版本。
- `LOGIN_FIELD_HEURISTICS`：`username` / `password` / `submit` 各一组有序候选，形状与用户定位相同。
- 字面量只在 shared 一处。API / Worker / 以后的扩展都读这一份。
- 本期没有任何运行时消费方去碰 DOM；常量仍然落地并配单测，避免下一场再各写一份。

首版候选（实现时按此写进常量，可在单测里钉住条数与顺序）：

| 角色 | 顺序（先试先用） |
|---|---|
| username | `id=username`，`id=user`，`id=account`，`id=loginName`，`id=login-name`，`name=username`，`name=user`，`name=account`，`css=input[autocomplete="username"]`，`css=input[type="email"]` |
| password | `id=password`，`id=passwd`，`id=pwd`，`name=password`，`css=input[autocomplete="current-password"]`，`css=input[type="password"]` |
| submit | `css=button[type="submit"]`，`css=input[type="submit"]`，`id=login`，`id=submit`，`name=login` |

`input[type="text"]` 不进首版：太宽，容易点到搜索框。中文按钮文案（「登录」）也不进首版：那是探测阶段的文本策略，不是可持久化的 `id/name/css`。

以后若要运营热更新，在代码默认值上加覆盖表，不先做管理页。

### D2. 首个账号只在创建时顺带写入，仍然是 TargetAccount

创建体可带可选 `account`，形状复用现有 `createTargetAccountBodySchema`（`displayName`、`username`、`password?`、`status?`）。

- 只允许 **POST /targets** 带 `account`。更新系统（`POST /targets/:id`）不夹带账号，避免一张单子改系统和改号。
- `account` 省略：只建系统，和现在一样。
- `authMethod = manual` 仍允许带 `account`（备用号），界面默认收起账号区，打开后可填。
- 同一事务：插 `targets` →（若有）插 `secrets` + `target_accounts` → 写 `target.create` 与（若有）`target_account.create` / `target_account.password`。任一步失败整单回滚。
- 口令纪律不变：响应无 `password`，日志与审计无明文。

### D3. 未指定 ≠ 已猜中

详情展示三态，文案用中文：

| 状态 | 何时 | 页面怎么写 |
|---|---|---|
| 已指定 | 该键有 `by` + `value` | 例如「元素 id：`username`」 |
| 将按启发式猜测 | 该键省略 | 「未指定，运行时按平台常见字段猜测」 |
| 不适用于当前认证 | `authMethod = manual` 且用户未填定位 | 定位区仍可展开填写，默认提示「仅手工登录时定位仅作备用」 |

禁止把启发式清单展开成可编辑表格冒充「已保存的选择器」。

`loginHeuristicVersion` 不写进 Target 行。将来登录绑定 / Run Snapshot 冻结「当时用了哪一版清单」；目录阶段没有执行，写版本只会假装已经猜过。

### D4. 界面仍是一页一个主操作，复杂项渐进展开

- 列表主操作仍是「新建目标系统」。
- 详情主操作仍是「添加目标账号」。定位的编辑走「编辑」次按钮，不和添加账号抢主色。
- 新建/编辑 Dialog 加宽到 `max-w-xl`。分区顺序：系统资料 →（认证为账密时默认展开）第一个目标账号 →「登录框定位（可选）」默认收起。
- 账号区：显示名、登录名、密码。创建时密码建议填写，但契约仍允许暂不设密。
- 定位区：三行（用户名框、密码框、提交），每行 `by` 下拉 + 值输入。`by` 中文：元素 id / name 属性 / CSS 选择器。占位：`username`、`password`、`login`。
- 辅助说明：「知道输入框的 id 或 name 就填；留空则以后试填时按常见字段猜测。保存不会打开目标页面。」
- 有验证码且不是 `none` 时，定位区上方沿用现有橙色提示：自动续登不能当默认承诺。

## 4. 形状与持久化

`targets` 新增可空 JSONB 列 `login_fields`。迁移 `0005_target_login_fields.sql`，幂等、`__SCHEMA__` 占位。CHECK：`login_fields IS NULL OR jsonb_typeof(login_fields) = 'object'`。不在库里展开启发式清单。

Drizzle 与 schema-parity 同步（全库表清单列断言补 `login_fields`）。

DTO：`targetSchema` 增加

```ts
loginFields: z.object({
  username: loginLocatorSchema.optional(),
  password: loginLocatorSchema.optional(),
  submit: loginLocatorSchema.optional(),
}).nullable()
```

创建体 `strictObject` 增加：

- `loginFields`：同上，可选；空对象与省略等价，服务端存 `null`。
- `account`：可选。更新体只加 `loginFields`，**禁止** `account`、`code`。

GET 列表与详情都带 `loginFields`，便于详情展示；列表不必为它加新列。

审计：改定位记 `target.update`，summary 只写「更新了登录框定位」，不写选择器原文（选择器会进页面 DOM，但不必进审计摘要）。带账号的创建仍是两条（或三条）已有 action。

## 5. API

现有路径与权限不变。只扩体现有 POST 创建/更新。

| 变化 | 说明 |
|---|---|
| `POST /targets` | 可带 `loginFields`、`account`；仍 201；成功体是 Target（含 `loginFields`、`accountCount`） |
| `POST /targets/:id` | 可带 `loginFields`；仍 200；带 `account` → 400 |
| 其余 GET / 删除 | 无路径变化 |

校验失败仍走 ZodValidationPipe → 400 `BAD_REQUEST`。`by` 非法、`value` 超长、更新体夹带 `account`，都是 400。

## 6. 对照现页：还要补齐什么

下列是打开 `/targets` 与详情后已经能看到的缺口。本补丁只收**不依赖 Session / 探测**、且不做会明显改变信息架构的项。

### 本补丁要做

1. **新建可带首个账号与可选定位**（第 3 节）。这是本补丁的主因。
2. **详情展示定位三态**，编辑走现有「编辑」。
3. **空态带同一主操作**。列表「还没有目标系统」、详情「该系统还没有目标账号」目前只有说明，没有按钮；有写权限时 EmptyState 放与页头相同的主按钮，避免空页只能去找右上角。
4. **入口 / 登录 URL 可打开**。详情里现在是纯文本。改为可点击外链（`target=_blank`、`rel=noopener noreferrer`），方便对照 HMI。列表入口仍截断，hover 出全文即可。
5. **编码规则写在控件下**。创建时提示「小写字母开头的 slug，2–63 字符，创建后不可改」。现在只靠提交后的 400。
6. **弹层关闭后重置**。取消或成功后清掉上次填写，避免下次打开残留。
7. **创建成功后进入详情**。带或不带首个账号都跳 `/targets/$targetId`。刚建完系统，下一件最可能的事是看资料或再加号，不该只停在列表。
8. **有写权限的空账号区**，空态按钮与页头「添加目标账号」同一动作。

### 看到了、本补丁不做

| 缺口 | 为何不做 |
|---|---|
| 列表搜索 / 按状态筛选 | 本期无分页压力；加搜索会改列表契约预期 |
| 整行点击进详情 | 名称已是链接；整行点击会和行内「删除」抢手势 |
| 列表上直接停用 | 停用有后果说明，放在编辑里更清楚 |
| 列表加「定位」列 | 加宽表格，详情才是读定位的地方 |
| 验证码「其他」的自由说明 | 没提出口径，避免半残备注字段 |
| 打开入口后自动探测 | 第 2 节非目标 |
| 启发式管理菜单 | D1 |

上一版会话留下的债务（RBAC 非 GET/POST、审计 200 截断、viewer 能看登录名）本补丁仍不修。

## 7. 实施顺序

1. **shared**：`loginLocatorSchema`、`targetLoginFieldsSchema`、`LOGIN_HEURISTIC_VERSION`、`LOGIN_FIELD_HEURISTICS`；扩展 create/update/target DTO；创建体可选 `account`；单测（空对象归一、更新拒 `account`、启发式版本与条数）。
2. **db**：`0005_target_login_fields.sql` + Drizzle + parity。
3. **api**：创建事务带账号；更新写 `login_fields`；HTTP 测试钉住：创建带账号后 GET 无 password、`accountCount = 1`、更新带 `account` 400、`loginFields` 往返。
4. **web**：新建/编辑分区、详情三态、空态按钮、URL 外链、编码说明、关闭重置、创建后进详情。
5. 本补丁状态改为已落地；目录方案第 9 节加一句：用户手填定位已在目录补丁落地，探测与验证仍待登录绑定方案。

## 8. 验收

1. 只填系统资料仍能创建；`loginFields` 为 `null`，`accountCount` 为 0。
2. 创建时带账号和密码：详情有该账号、`hasPassword: true`、任何响应与审计无明文口令。
3. 创建时只填用户名框 `id=username`：详情显示「元素 id：username」；密码框与提交显示「将按启发式猜测」。
4. 更新系统带 `account` → 400。
5. `LOGIN_FIELD_HEURISTICS` 与第 3 节表格一致，版本为 1；shared 被 web 依赖，文件内无 `node:crypto`。
6. 空列表 / 空账号在有写权限时能直接点主操作。
7. 详情入口 URL、登录 URL 可在新标签打开；编码说明在创建框可见。
8. 关闭新建弹层再打开，字段是空的。
9. 创建成功落到详情，不停在列表空态。
10. 页面仍无「探测登录」「打开录制」「启发式管理」。
11. `pnpm test` 与 `pnpm lint` 通过；`pnpm check:deps` 不破。

## 9. 主要改动面

| 区域 | 动作 |
|---|---|
| `packages/shared/src/target.ts`、启发式常量、`src/index.ts` | 契约与清单 |
| `packages/db/migrations/0005_target_login_fields.sql`、`schema/targets.ts` | `login_fields` |
| `packages/api/src/targets/` | 创建带账号、读写定位 |
| `packages/web/src/features/targets/` | 表单分区、详情、空态、外链 |
| [目标系统目录 §9](2026-09-10-target-catalog.md) | 注明手填定位已前移 |

## 10. 与目录方案第 9 节的边界

手填定位是 LoginBinding 的**人工输入面**，不是探测结果。

仍然留给登录绑定方案的：打开登录页、按启发式或手填定位试填、验证成功后才把「已确认绑定」写死、失败 1～2 次后请插件点选、插件只传定位不传密码和 Cookie。本补丁只让目录不再把「用户已经知道的 id」挡在门外。
