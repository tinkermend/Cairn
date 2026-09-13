# 控制台产品角色与能力地图

日期：2026-09-13。状态：**已落地**。

范围：把现有「账号级能力 RBAC」收成可被管理员理解的产品骨架——**谁能看见哪组菜单，谁能登记目标 / 编写场景，谁能对着目标系统发起运行**。  
不新增里程碑，不调整 D0–D4。审查通过后再实施。交付顺序仍以[工程实施计划第 5 节](../plan/识途开发路线与工程实施计划.md#5-当前交付顺序与验收样例)为准。

依据：宪法 §15 / §17 / §18.14 / §24（控制台身份与 TargetAccount 分离、前端原则、约束由代码卡住、菜单与主操作层次）；现有 `@cairn/shared` 权限目录、`PermissionsGuard`、侧栏 `permission` 注解、[目标系统目录](2026-09-10-target-catalog.md)、[审计拆分](2026-09-13-console-audit-operations-and-logins.md)、[Midscene 接入](2026-09-13-midscene-runtime-integration.md) 的 `ai:execute`、[前端工作流](../design/front/ai-workflow.md)。

本方案**不**引入 Workspace / 项目 / 多租户，也不做库内「菜单管理」。那些是另一根骨头；本页只把已经存在的权限码按产品角色切开，并让角色页能预览后果。

## 1. 为什么现在写

权限机械链路已经接通：封闭目录、系统角色、自定义矩阵、侧栏 / 路由 / 按钮显隐、API Guard。缺的是产品语义。

当前三个系统角色按 IAM 来，不按「编写 / 执行 / 只读」来：

| 现状 | 后果 |
|---|---|
| `viewer` 默认有 `account:read` / `role:read` / `audit:read` | 只读用户看见用户、角色、审计 |
| `operator` 几乎能改目标、删场景、开跑，还能看 IAM | 「运维」= 全能业务员，无法只给「能跑不能改」 |
| 权限文案是「查看工作流 / 启动 Run」 | 管理员无法从角色页读出「能不能对着目标系统执行」 |
| 菜单「工作台」混放业务与治理 | 只要给了 `*:read`，治理入口就跟着出现 |
| `POST /runs` 只守 `run:execute` | 自定义角色可以「能开跑、但不能看目标」；组合能力没有被写成规则 |
| 新建账号默认 `operator` | 每个新人都是全能业务角色 |

「对着目标系统创建任务并执行」在代码里是分散的码：`target:*`、`workflow:*`、`run:*`。骨架要做的是：用四个产品角色给出默认答案，用一份能力地图把码翻译成菜单和主操作，开跑时显式要求「看得到目标」。

## 2. 目标与非目标

### 目标

1. 系统角色改为四个产品角色：**管理员 / 编写者 / 执行者 / 只读**。稳定 key 为 `admin` / `author` / `operator` / `viewer`。
2. 侧栏分成 **工作台**（业务）与 **治理**（用户 / 角色 / 审计）。治理入口只随治理权限出现。
3. 权限目录与矩阵改用中文产品用语；码不变，`workflow` **不**改名为 `scenario`。
4. 角色创建 / 查看 / 编辑页展示只读 **能力预览**：将出现的菜单、可执行的主操作。预览由代码计算，不入库。
5. 「对目标系统发起运行」成为显式组合：`run:execute` ∧ `target:read` ∧ `workflow:read`。试跑另加 `workflow:write`。
6. 新建控制台账号默认角色改为 `author`。存量 `operator` 账号**不**自动改成编写者。
7. 系统角色权限集与库行继续由现有对账测试卡住，禁止「代码有、库里没有」。

### 非目标

- 不做 Workspace、项目、队、资源级 ACL、按 Target 授权。
- 不做菜单表、菜单树 CRUD、角色勾选菜单节点。菜单仍由代码声明。
- 不把 `workflow` 权限码重命名，不新增 `recording:*`、`evidence:*`、`run:trial`。
- 不拆 Worker 池，不改 JWT 形状，不改 Secret / 对象键。
- 不改 TargetAccount 与控制台身份的分离。
- 不做按钮级策略引擎、条件授权、数据范围（「只能看自己创建的」）。
- 不把本方案排进 D0–D4 Gate。

## 3. 决策

### D1. 四个产品角色，key 稳定，中文名给用户看

`operator` / `viewer` 的 key 不改，避免账号绑定、测试夹具和外部脚本断裂。新增系统角色 key=`author`。展示名与说明改为中文，迁移回写存量系统角色行。

| key | 展示名 | 一句话 | 工作台 | 治理 |
|---|---|---|---|---|
| `admin` | 管理员 | 治理 + 全部业务能力 | 全部 | 全部 |
| `author` | 编写者 | 登记目标、编写场景、试跑，**也能创建正式 Run** | 目标 / 场景 / 录制 / 运行 | 无 |
| `operator` | 执行者 | 选目标账号、发起 / 取消 / 核查运行 | 目标（只读）/ 场景（只读）/ 运行 | 无 |
| `viewer` | 只读 | 看定义与证据 | 目标 / 场景 / 运行 | 无 |

**编写者的授权范围要说清**：本期不发明 `run:trial`，试跑与正式运行共用 `run:execute`，因此编写者能对任意已发布场景创建正式 Run，不只是工作区试跑。这是本次接受的范围，不是遗漏；要更细的分权得等 `run:trial`（第 8 节记账）。

账号可以绑多个角色，权限取并集。执行者需要临时改场景时补挂 `author`，不为此再造第五个系统角色。

`DEFAULT_ACCOUNT_ROLE_KEY` 从 `operator` 改为 `author`。当前阶段先验证编写闭环；执行者是明确授予的运行岗位，不是默认赠品。

存量处理：

- 已有 `operator` 账号变成执行者（失去目标 / 场景写、失去 IAM 读、失去审计）。**不**自动补 `author`。
- 已有 `viewer` 失去用户 / 角色 / 审计入口，并失去 `session:read`。
- `admin` 与 bootstrap 管理员不变。
- 若库里已有 `key=author` 且 `kind=custom`，迁移必须失败并说明，禁止把自定义角色提升成系统角色。

这是一次**静默降权**：升级后原 operator 用户会发现「新建目标系统」「保存场景」消失。补救动作只有一条——管理员给他补挂编写者角色。实施时在 CHANGELOG 与 [部署说明](../../deploy/README.md) 各留一句，不要让现场以为是 Bug。

### D2. 系统角色权限集（产品默认，不是讨价还价清单）

权限码沿用现目录。`admin` 仍等于整个 `PERMISSIONS`。其余三角色如下（有 = ●）。

| 权限 | 编写者 | 执行者 | 只读 |
|---|---|---|---|
| `target:read` | ● | ● | ● |
| `target:write` | ● | | |
| `target:delete` | ● | | |
| `workflow:read` | ● | ● | ● |
| `workflow:write` | ● | | |
| `workflow:delete` | ● | | |
| `run:read` | ● | ● | ● |
| `run:execute` | ● | ● | |
| `run:cancel` | ● | ● | |
| `run:review` | ● | ● | |
| `ai:execute` | ● | ● | |
| `session:read` | ● | ● | |
| `session:dispose` | | ● | |
| `settings:read` | ● | ● | ● |
| `settings:write` | | | |
| `account:*` / `role:*` | | | |
| `audit:read` / `audit:login` | | | |

说明：

1. **编写者带 `run:execute`**，否则工作区试跑和手工验证编不下去，代价是 D1 说明的正式 Run 范围。调度（D4）仍走 `run:execute`；若以后要「编写者不能碰调度」，另案加码，不在本次预埋空权限。
2. **`ai:execute` 默认给编写者与执行者。** 这覆盖 [Midscene 接入](2026-09-13-midscene-runtime-integration.md) 里「operator 默认不含 `ai:execute`」的默认：执行者必须能跑已发布的混编场景，否则产品角色是空的。成本控制仍在：只读没有、自定义角色须显式勾选、无模型配置仍不能跑 AI。`0017_ai_execute.sql` 只补了 admin，本次迁移按新表补种。
3. **两个 `session:*` 码当前在界面上不可达，分配只对 API 生效。** 控制台没有任何页面调用 `/browser-sessions`：运行详情显示的 placement 来自 Run 自己的 DTO（`features/runs/detail.tsx` 读 `run.placement`），不查会话接口。所以本表把 `session:read` 给编写 / 执行、`session:dispose` 只给执行者与管理员，属于为将来的会话面预留，**不得**在能力预览里描述成「可以查看浏览器会话」这类菜单能力。只读失去该码不影响任何现有页面。
4. **治理权限只留在管理员**（以及显式勾了这些码的自定义角色）。执行者、只读、编写者默认看不见用户 / 角色 / 审计。
5. `settings:read` 继续给四个系统角色。侧栏「设置」与 `/settings` 路由**继续**以该码为门（现状：`routes/_authenticated/settings/route.tsx` 无此码即跳 403），本方案不改这个门，也不把设置改成「登录即可」。`settings:write` 仍只在目录里，无正式设置 API，仅 admin 持有。

`SYSTEM_ROLE_DEFINITIONS` 与三库系统角色权限行必须逐码相等。现有 `rbac-model` 对账测试改为四个 key；失败即禁止合并。

本决策会推翻 `packages/shared/src/__tests__/rbac.test.ts` 里两条现有断言，实施时必须显式改写，不能当成「测试挂了改回去」：

| 现断言 | 本方案 |
|---|---|
| `SYSTEM_ROLE_DEFINITIONS.operator.permissions` 不含 `ai:execute` | 执行者默认持有 `ai:execute` |
| `DEFAULT_ACCOUNT_ROLE_KEY` 为 `operator` | 改为 `author` |

同文件断言「viewer 全部以 `:read` 结尾」仍然成立（只读集合是 `target:read` / `workflow:read` / `run:read` / `settings:read`），不必改。

### D3. 菜单继续代码声明，按业务 / 治理分组

不建菜单表。改 `sidebar-data.ts` 的分组与显隐注解：

```text
工作台
  首页                         （登录即可，不挂权限）
  目标系统     target:read
  场景         workflow:read
  录制草稿     workflow:write    ← 从 read 收紧，见 D4
  运行         run:read

治理
  用户         account:read
  角色         role:read
  审计         audit:read ∨ audit:login   ← 侧栏单入口；页内页签再按权限拆表

其他
  设置         settings:read     （不变；子项仍是个人资料 / 账号 / 外观）
```

规则：

- 一组里没有任何可见项则整组不渲染（现有 `NavGroup` 已如此）。
- 「审计」不展开子菜单，挂 `anyOf: audit:read | audit:login`；页内再用操作记录 / 登录记录页签。
- 命令面板与首页模块卡跟同一套显隐，禁止再抄一份互斥清单。
- 首页不出现「用户 / 角色 / 审计」给无治理权限的人——现有卡片已挂权限，角色一改即生效；补测即可。
- **本方案只改分组，不改任何一项的权限门，除了录制草稿（D4）。** 设置继续挂 `settings:read`，与现有路由守卫一致；「首页」是唯一不挂权限的入口。

窄屏与桌面同一信息架构，不另做一套治理抽屉。

### D4. 录制草稿是编写面，不是执行面

录制是 Authoring Method，正式运行不依赖它。执行者与只读默认不应进入录制收件箱。

| 面 | 权限 |
|---|---|
| 菜单、路由 `beforeLoad`、列表 / 详情 GET、上传 POST | `workflow:write` |

现网 `workflow:read` 即可进录制页（`recordings.controller.ts` 的两个 GET）的行为废止。有 `workflow:read` 而无 `write` 的人猜 URL，应被前端挡、API 403。上传 POST 本就要求 `workflow:write`，收紧后四个入口同门。

**录制器扩展的连带影响必须一起处理。** 扩展只用三个接口：`GET /api/me`、`GET /api/targets`、`POST /api/recordings`，因此它实际要求 `target:read` + `workflow:write`。执行者与只读能通过登录门禁，但一上传就 403，现在只会显示通用请求失败。本期在扩展登录后或上传失败时给一条可读提示（大意「当前账号没有录制上传权限，请联系管理员分配编写者角色」），不新增扩展权限接口、不在扩展里做菜单级权限。扩展列表类接口本来不存在，不受本次收紧影响。

### D5. 一份能力地图，角色页做预览，不当第二套权限源

在 `@cairn/shared` 增加封闭的 `CONSOLE_CAPABILITIES`。每条是「若干权限 AND → 一条用户能懂的能力」。鉴权仍只认权限码；预览与测试读这张表。

能力分两类：`menu`、`action`。侧栏每个带 `permission` 的项必须能在表里找到 `allOf` 完全相同的 `menu` 能力，CI 对账，防止侧栏与预览漂移。**唯一例外是「首页」**：它不挂权限，在表里标为登录即可，对账时跳过。「设置」不是例外，它挂 `settings:read`。

最低集合（实施时可按同语义加减，但不得在无测试的情况下删「对目标系统发起运行」）：

| id | 类 | 文案 | allOf |
|---|---|---|---|
| `menu.home` | menu | 首页 | （登录即可，预览里对任何已登录角色常显） |
| `menu.targets` | menu | 目标系统 | `target:read` |
| `menu.scenarios` | menu | 场景 | `workflow:read` |
| `menu.recordings` | menu | 录制草稿 | `workflow:write` |
| `menu.runs` | menu | 运行 | `run:read` |
| `menu.users` | menu | 用户 | `account:read` |
| `menu.roles` | menu | 角色 | `role:read` |
| `menu.audit` | menu | 审计 | `audit:read` ∨ `audit:login` |
| `menu.settings` | menu | 设置 | `settings:read` |
| `action.target.write` | action | 登记和维护目标系统 | `target:write` |
| `action.target.delete` | action | 删除目标系统 | `target:delete` |
| `action.scenario.write` | action | 创建和编辑场景 | `workflow:write` |
| `action.scenario.delete` | action | 删除场景 | `workflow:delete` |
| `action.recording.upload` | action | 上传录制草稿 | `workflow:write` |
| `action.run.execute` | action | 对目标系统发起运行 | `run:execute`、`target:read`、`workflow:read` |
| `action.run.trial` | action | 在工作区试跑 | `workflow:write`、`run:execute`、`target:read` |
| `action.run.cancel` | action | 取消运行 | `run:cancel` |
| `action.run.review` | action | 核查暂停的运行 | `run:review` |
| `action.ai.execute` | action | 执行含 AI 步骤的运行 | `ai:execute` |
| `action.session.dispose` | action | 处置卡死的浏览器会话 | `session:dispose` |
| `action.account.write` | action | 管理控制台账号 | `account:write` |
| `action.role.write` | action | 管理自定义角色 | `role:write` |

导出 `previewCapabilities(permissions)`：返回按组排好的菜单文案 + 主操作文案。角色对话框在权限矩阵下方展示；勾选变化即时更新。系统角色只读查看时同样展示，帮助管理员解释「执行者到底能干什么」。

预览是辅助信息：灰色次要层级，不跟「保存」抢主操作。空组写「无」，不要假装还有隐藏菜单。

矩阵不再维护第二份中文表。今天有两份：shared 的 `PERMISSION_LABELS` / `RESOURCE_LABELS`（英文，喂 `GET /rbac/permissions`）与 `permission-matrix.tsx` 的 `PERMISSION_LABELS_ZH` / `RESOURCE_LABELS_ZH`（中文，已含 `ai`，无漂移）。本期把中文收进 shared、删掉 Web 那两份。

**这会改到对外响应**：`GET /rbac/permissions` 的 `label` 从英文变中文，断言英文标签的接口测试要一起改。这不是纯前端文案调整，评审时按契约变更看。权限码仍以等宽次要文字显示。建议文案：

| 码 | 标签 |
|---|---|
| `workflow:*` 资源名 | 场景 |
| `workflow:read` | 查看场景 |
| `workflow:write` | 创建和编辑场景 |
| `workflow:delete` | 删除场景 |
| `run:read` | 查看运行 |
| `run:execute` | 发起运行 |
| `run:cancel` | 取消运行 |
| `run:review` | 核查暂停的运行 |
| `target:read` | 查看目标系统 |
| `target:write` | 登记和维护目标系统 |
| `target:delete` | 删除目标系统 |
| `ai:execute` | 执行含 AI 步骤的运行 |
| 其余 | 沿用现矩阵中文，补上 `ai` 资源名「浏览器 AI」 |

### D6. 开跑必须「看得到目标」，不是只持有 execute

组合能力要落到 API，不能只写在预览里。

| 接口 | 现权限 | 本期 |
|---|---|---|
| `POST /runs` | `run:execute` | `run:execute` + `target:read` + `workflow:read` |
| 场景试跑 POST | `workflow:write` + `run:execute` | 再加 `target:read` |
| `GET /runs`、证据、取消、核查、恢复认证 | 不变 | 不变 |
| 目标 / 场景的 list/get | 不变 | 不变 |

前端创建运行对话框：无 `target:read` 时打不开主操作（现 `Can` 只看 `run:execute`，改为组合判断，与预览同一函数）。场景下拉依赖 `workflow:read`；目标账号下拉依赖该目标的 `target:read`（今日即 list accounts 的门）。仍**不**按创建者过滤行。

有 `run:execute` 但缺 `target:read` 的自定义角色：按钮隐藏，POST 403，预览不出现「对目标系统发起运行」。

含 AI 步骤的 Run 继续另守 `ai:execute`（Midscene 方案已落地）。本方案只改默认谁持有该码，不改检查点。

### D7. 不把角色当菜单，不把菜单当角色

禁止出现「给角色勾 /targets」。管理员改的是权限码；菜单与主操作是派生结果。自定义角色仍然只能从封闭目录勾选。不能授予自己没有的权限（现 `assertCanGrant` 保持）。

系统角色仍然不可删、不可改权限集。改产品默认只走代码 + 迁移，不走控制台。

## 4. 数据与迁移

不改表结构。三份增量迁移，文件名钉死，全文幂等：

| 方言 | 文件 |
|---|---|
| PostgreSQL | `packages/db/migrations/0018_product_roles.sql` |
| MySQL | `packages/db/migrations/mysql/0004_product_roles.sql` |
| SQLite | `packages/db/migrations/sqlite/0004_product_roles.sql` |

各做四件事：

1. 插入 `author` 系统角色。若 `key=author` 已存在且 `kind<>'system'`，失败。
2. 更新四个系统角色的 `name` / `description` 为 D1 中文。
3. 删除四个系统角色的全部权限行，再按 D2 重插。自定义角色一行不动。
4. 不改 `console_account_roles`（存量 operator 仍是 operator）。

**第 3 步只能硬编码。** 迁移是静态 SQL，读不到 `SYSTEM_ROLE_DEFINITIONS`；`0002_rbac.sql` 就是把权限对逐行写进 `VALUES` 的，本次沿用同一写法，`admin` 要把整个目录（含 `audit:login`、`ai:execute`）重新列全。防漂移**不靠迁移自觉**，靠 `packages/db/src/__tests__/rbac-model.test.ts` 的逐码对账：库里的四个系统角色权限集排序后必须与 shared 常量全等，不等即失败。以后新增权限码仍按 `0016` / `0017` 的方式追加补种迁移。

`0002_rbac.sql` 历史 seed 不改写。新库走「旧 seed + 本迁移」，与现有 `audit:login` / `ai:execute` 补种方式一致。

## 5. API 与契约

对外路径、方法、信封不变。变化只在：

- `GET /rbac/permissions` 的 `label` / `resource` 中文。
- `GET /rbac/roles` 系统角色多一行 `author`，名称中文，权限集按 D2。
- `POST /console/accounts` 省略 `roleIds` 时绑定 `author`。
- `POST /runs` 与试跑的 `@RequirePermissions` 按 D6。
- 录制 GET 改为 `workflow:write`。

`GET /me` 仍回解析后的权限并集。前端只认权限，不认角色名。

Web 用户筛选里的系统角色选项随 `SYSTEM_ROLE_KEYS` 增加编写者。**注意这不是可选项，漏了会编译不过**：`packages/web/src/features/users/data/data.ts` 的 `ROLE_ICONS` 用 `as const` 写死 `admin` / `operator` / `viewer` 三键并按 key 取值，新增 `author` 必须同时补图标；`packages/web/src/features/rbac/data/roles.ts` 同样遍历 `SYSTEM_ROLE_KEYS` 生成样本行。图标从已装的 lucide 里选（例如已用于场景的 `ListChecks` 之外另择一个），不引新图标库。

## 6. 界面

任务：管理员要能回答「这个人登录之后看见什么、能不能编、能不能对着目标开跑」。主操作：角色页仍是「创建角色」；对话框内仍是「保存」。能力预览不是按钮。

布局：沿用现有角色列表 + 对话框，不新做 HTML 原型。矩阵下增加预览块：

- 标题「能力预览」，说明「按当前勾选计算，保存后生效」。
- 先菜单（工作台 / 治理 / 其他），后主操作。
- 系统角色查看态同样展示。

侧栏分组变更按 D3。执行者登录后应只见：首页、目标系统、场景、运行、设置。不应见：录制草稿、用户、角色、审计。

实施走[前端工作流](../design/front/ai-workflow.md)与[前端验收 skill](../../.agents/skills/shitu-frontend-acceptance/SKILL.md)。导航与角色对话框属**页面或底座**级：至少用管理员、编写者、执行者、只读各走一遍侧栏与一个业务主操作（编写者创建场景或试跑、执行者创建运行、只读确认无主操作）。代表宽度看桌面；窄屏确认治理组消失后工作台不塌。

涉及文件（实施时，不是现在改）：

| 位置 | 作用 |
|---|---|
| `packages/shared/src/rbac.ts` | 四角色、`DEFAULT_ACCOUNT_ROLE_KEY`、中文标签、`CONSOLE_CAPABILITIES`、`previewCapabilities` |
| `packages/shared/src/__tests__/rbac.test.ts` | 改写 D2 点名的两条断言，补能力地图单测 |
| `packages/db/migrations/0018_product_roles.sql` + `mysql/0004` + `sqlite/0004` | 角色行、名称、权限行（硬编码） |
| `packages/db/src/__tests__/rbac-model.test.ts` | 四个 key 的逐码对账 |
| `packages/api` runs / scenarios / recordings controller 与 HTTP 测试 | 组合权限与录制门禁 |
| `packages/api/src/rbac/*.spec.ts` | 目录 `label` 转中文后的断言 |
| `packages/web/src/components/layout/data/sidebar-data.ts` 及其测试 | 业务 / 治理分组、录制改 `workflow:write` |
| `packages/web/src/features/home/index.tsx`、`components/command-menu.tsx` | 与侧栏同一套显隐 |
| `packages/web/src/features/rbac/components/permission-matrix.tsx`、`roles-action-dialog.tsx` | 删中文副本、加能力预览 |
| `packages/web/src/features/users/data/data.ts`、`features/rbac/data/roles.ts` | `author` 图标与样本行，否则类型报错 |
| `packages/web/src/features/runs/*`、`features/scenarios/detail.tsx` | 开跑入口改组合判断 |
| `packages/extension/playwright-crx/src/cairn/*` | 上传 403 的可读提示（D4） |
| CHANGELOG、`deploy/README.md` | 记存量 operator 降权与补挂编写者 |
| [Midscene 方案](2026-09-13-midscene-runtime-integration.md) 正文不改 | 本方案 D2 覆盖其 operator 默认，改动理由记在 CHANGELOG |

## 7. 验收

审查通过并落地后，至少卡住：

1. 迁移后库中四个系统角色 key 为 `admin` / `author` / `operator` / `viewer`，权限集与 `SYSTEM_ROLE_DEFINITIONS` 排序后全等；admin 仍覆盖整个目录。
2. 新建账号不传角色时绑定 `author`；显式传 `operator` 仍可。
3. 存量 `operator` 账号权限变为执行者集合，没有被自动加上 `author`。
4. `author` 已存在且为 custom 时迁移失败。
5. 执行者：`POST /scenarios` 403；`POST /runs` 在同时具备读目标 / 读场景时 200 或业务错误（不是 403）；`GET /recordings` 403；`GET /console/accounts` 403；`GET /console/audit/operations` 403。
6. 编写者：可写目标与场景、可试跑、可创建正式 Run（D1 的范围）；`GET /console/accounts` 403；无 `session:dispose`。
7. 只读：目标 / 场景 / 运行 GET 通过；一切写与 `POST /runs` 403；治理接口 403；录制 403；`/settings` 仍可进（持有 `settings:read`）。
8. 仅有 `run:execute`、没有 `target:read` 的自定义角色：`POST /runs` 403；预览无「对目标系统发起运行」。
9. `previewCapabilities` 对四个系统角色的菜单集合，与侧栏 `visibleByPermission` 结果一致；对账跳过「首页」这一个无权限项，「设置」按 `settings:read` 参与比对。
10. 侧栏不再把用户 / 角色放进「工作台」；无治理权限时不出现「治理」组。
11. 权限目录与矩阵出现「场景」「浏览器 AI」，不再把 `workflow` 写成「工作流」给管理员看；码仍是 `workflow:*`。`GET /rbac/permissions` 返回中文 `label`，相关接口测试同步。
12. 三库迁移后 schema 对账通过；Web 四角色侧栏与主操作显隐有自动化测试。浏览器验收记录管理员 / 编写者 / 执行者 / 只读各一条路径。
13. 扩展：以执行者账号登录后上传录制得到可读的权限提示，不是通用请求失败；编写者账号上传仍成功。

## 8. 现在不做（记账）

- Workspace / 项目隔离、JWT 带空间、按空间过滤 list。
- 单资源授权（「只能跑 Target A」）、「只能看自己创建的」。
- `workflow` → `scenario` 权限重命名。
- 试跑与正式运行 / 调度分权。
- 菜单国际化、自定义角色文案多语言。
- 设置中的组织级 `settings:write` API。
- 给执行者单独的「运行中心」信息架构（现运行列表继续用）。
- 自动把历史 operator 升为 author+operator 以保持旧行为。
- 浏览器会话的列表 / 处置界面。`session:read`、`session:dispose` 本期仍只作用于 API（D2 说明 3）。
- 扩展内的角色感知界面（只做上传失败提示，不做能力预览）。

## 9. 实施顺序（审查通过后）

1. shared：四角色、标签、能力地图与单测（含 D2 点名的两条断言改写）。
2. 三库迁移与 `rbac-model` 逐码对账。
3. API Guard、录制门禁、目录中文 `label` 与 HTTP 测试。
4. 侧栏分组、录制路由、开跑组合判断、角色能力预览、`author` 图标与样本行。
5. 扩展上传的权限提示。
6. CHANGELOG 与部署说明记存量 operator 降权；本目录状态改为已落地。

## 10. 审查结论

已落地（2026-09-13）。审查修订（同日自审十处）已按原文实施：四角色与中文目录、硬编码三库迁移 + `rbac-model` 逐码对账、开跑组合闸门、录制收进编写面、角色页能力预览、扩展上传 403 提示、CHANGELOG / 部署说明记录存量 operator 降权。Workspace、菜单表、`run:trial` 仍不在本期。

自审记录（2026-09-13，同日）：对照代码复核后修订十处——设置页继续以 `settings:read` 为门（原稿写成「登录即可」与现有路由守卫矛盾）；迁移改为硬编码 SQL 并钉死三份文件名，防漂移交给对账测试；纠正 `session:*` 的理由（控制台无任何页面调用会话接口，placement 来自 Run DTO）；点名将被推翻的两条 shared 断言；点名 `ROLE_ICONS` 等会因新增 `author` 编译失败的位置；声明目录 `label` 中文化属对外契约变更；补录制收紧对扩展的连带影响与提示要求；把编写者可创建正式 Run 写进角色表；限定能力地图对账的唯一例外是「首页」；补存量 operator 降权的补救动作与文档落点。
