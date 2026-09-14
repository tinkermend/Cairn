# 数据库可替换性：现状审计与 PostgreSQL / MySQL / SQLite 适配方案

日期：2026-09-13。状态：**持久化适配与受控迁移已实现，三库契约验收通过；全仓独立失败见第 11 节**。

目标：数据库更换时，Scenario / Run / StepRun / Attempt / Evidence 的业务语义、HTTP 契约和执行逻辑保持一致，差异集中在基础设施实现中。

第 2—10 节保留开发前的源码审计与方案依据；本次实现、运行验证与剩余边界见第 11 节。本文不新增有效排期；交付顺序仍以[工程实施计划](../plan/识途开发路线与工程实施计划.md#5-当前交付顺序与验收样例)为准。

## 1. “无缝”的验收含义

需要分别交付三项能力：

1. **业务代码无感**：选择已支持的数据库后端后，API 业务服务、Execution Engine、Browser Runtime 和 Web 不因数据库种类改变业务实现。
2. **行为一致**：任务领取、状态提交、并发冲突、错误码、历史解释、凭据与证据关联通过同一套契约验收。
3. **存量数据可迁移**：已有实例可以经过预检、数据转换、校验和受控切换迁往另一数据库，失败时有明确恢复路径。

本方案先按“无需修改业务代码、支持受控停写迁移”理解无缝。它不自动保证不停机跨库切换或迁移正在执行的浏览器操作。若要求零停机，还需单独设计变更捕获、切换窗口和故障恢复，不能把它计入更换连接配置的效果。

支持范围要标明数据库版本、驱动、部署方式和并发能力。本文以现有 PostgreSQL 16+、MySQL 8.4 InnoDB 文档与 SQLite 官方文档分析差异；新后端的精确支持版本须在实现和 CI 中锁定。SQLite 可以有多个连接和同机进程，但写事务串行；相同业务正确性不代表相同吞吐量或支持同样的多机部署。[SQLite 事务](https://www.sqlite.org/lang_transaction.html)、[WAL 部署限制](https://www.sqlite.org/wal.html)

## 2. 当前需要优化的位置

| 优先级 | 位置 | 当前依赖 | 应达到的边界 |
| --- | --- | --- | --- |
| 高 | [db/client.ts](../../packages/db/src/client.ts)、[db/index.ts](../../packages/db/src/index.ts) | 公开 `NodePgDatabase`、`pg.Pool`、Drizzle 查询函数及全部表定义 | 对上层只公开业务持久化操作、普通数据契约和生命周期；驱动、ORM、表定义留在实现内 |
| 高 | API 的 [targets](../../packages/api/src/targets/targets.service.ts)、[rbac](../../packages/api/src/rbac/rbac.service.ts)、[auth](../../packages/api/src/auth/auth.service.ts) | Service 直接查询表、开启数据库事务、判断 PG 错误码 | 将持久化操作收进现有 `@cairn/db`；HTTP 鉴权、JWT、密码校验等继续归 API |
| 高 | [ExecutionEngine](../../packages/worker/src/engine/engine.ts)、[SessionManager](../../packages/worker/src/browser/session-manager.ts)、[placement-backoff](../../packages/worker/src/runtime/placement-backoff.ts) | 注入 PG 形态的 DbHandle，部分代码直接查询 Target / TargetAccount | 执行面只调用稳定的读取、领取、续租和提交操作，不接触 ORM 或数据库连接 |
| 高 | [leases](../../packages/db/src/leases/leases.ts)、[sessions](../../packages/db/src/sessions/sessions.ts)、[recover](../../packages/db/src/runs/recover.ts) | 行锁、`SKIP LOCKED`、数据库时间表达式、PG 查询结果形状 | 统一原子操作的结果与一致性要求，由各数据库实现锁定、时间与条件更新 |
| 高 | [runs](../../packages/db/src/runs/runs.ts)、[objects](../../packages/db/src/objects/objects.ts) | 状态迁移依赖 `.returning()`、跨多表事务 | 公开稳定的提交结果；保留完整事务边界，适配返回行和受影响行语义 |
| 高 | [schema](../../packages/db/src/schema)、[migrations](../../packages/db/migrations) | `pgSchema`、JSONB、UUID、TIMESTAMPTZ、BYTEA、部分唯一索引、PG DDL | 同一逻辑模型，各库有等价的类型映射、约束及迁移实现 |
| 中 | [runs/errors.ts](../../packages/db/src/runs/errors.ts)、API 错误处理 | 通过 `23505` / `23503` 及 PG 约束名推断领域冲突 | 数据库错误在持久化边界转换为稳定领域错误；调用方不判断厂商错误码 |
| 中 | [shared/env.ts](../../packages/shared/src/env.ts)、两端 DbModule、迁移 CLI | 配置只接受 PG 的 host / port / user / schema；所有进程创建 PG 连接池 | 按驱动判别配置、统一初始化/探活/关闭，启动时拒绝不兼容的配置或结构版本 |
| 中 | [db/migrate.ts](../../packages/db/src/migrate.ts)、[testing.ts](../../packages/db/src/testing.ts) | 迁移依赖 PG schema；默认假设 DDL 与迁移记录可同事务提交；测试通过 PG 建库隔离 | 各库独立升级策略与隔离测试设施；保留存量升级验证 |
| 需在 P7 前明确 | [实时通信与队列唤醒计划](2026-09-11-run-lease.md) | PG NOTIFY / SSE 尚未落地，设计采用 PG 通知 | 持久化事实查询与变化提示分离；PG NOTIFY 只作为一种提示实现 |
| 持续约束 | [check-deps](../../tools/check-deps.mjs)、[CI](../../.github/workflows/ci.yml) | 目前限制包依赖方向，尚不能阻止通过 `@cairn/db` 导入 ORM 表与查询函数 | 自动检查公共类型和生产源码的数据库依赖泄漏；兼容承诺由真实数据库测试证明 |

## 3. 先完善已有边界

保留 `@cairn/shared`、`@cairn/db`、API、Worker 的分层和现有 Drizzle。现有的 `createRunWithSnapshot`、`claimRun`、`finishAttempt`、`acquireSessionLease` 等函数已经提供了可收口的业务操作；优先沿用这些操作。

### 3.1 对上层公开业务操作

- `@cairn/db` 的生产入口最终不再导出 SQL、Drizzle 表、PG 连接池、`NodePgDatabase` 或由 PG 表推导出的公开行类型。
- 使用已存在的 DTO、RunGrant、SessionGrant、Snapshot 和 Zod 契约。缺少内部读取契约时增加普通数据类型，不让 `$inferSelect` 经公共返回值重新泄漏。
- `createDb` 可以保留名称，由配置创建对应持久化实现；`ping`、`close` 保持一致的生命周期，数据库相关业务操作不再要求调用者传 `handle.db` 或 `handle.pool`。
- API 与 Worker 各自在装配处获取持久化能力；两者共享契约，仍独立运行，Worker 不通过 API 写回事实。
- 数据库测试工具和原生连接放在测试专用入口，不能随生产主入口被业务模块使用。

第二种后端接入时，根据真实差异抽出共同的事务操作。现有领域校验、状态判定、快照摘要和错误码复用同一份逻辑；避免每个驱动各复制一套“取消是否优先”“副作用未知如何收口”的规则。SQL 和锁的差异可以保留在不同实现中。

### 3.2 事务按业务动作收口

只把 `.select()` 包进 Repository 还不够。当前的下列操作必须维持各自的原子性：

| 业务操作 | 必须一起成功或失败的内容 |
| --- | --- |
| 创建 Target 及首个 Account | Target、Secret 引用、Account、审计 |
| 追加 Scenario 版本 | 版本号分配、新版本、场景更新时间、审计 |
| 创建 Run | 冻结 Snapshot、Run、StepRun、幂等标识、审计 |
| 领取 Run | 判断 Worker 身份与容量、选择可执行任务、迁移状态、建立租约与 fencing |
| 完成 Attempt | 校验 Run/Session 所有权、处理取消、Attempt/StepRun/Run 状态、Context 和结构化 Evidence |
| 失联恢复 | 租约失效、在途 Attempt 处理、Run 恢复或待核查状态 |
| 关联对象证据 | 对象状态/归属检查与证据索引写入，与清理并发保持一致 |

公开 `finishAttempt(...)` 这样的完整操作，不让 Engine 依次调用几个各自提交的数据库函数。否则换库后代码看起来解耦了，事务边界反而被拆散。

数据库事务只覆盖数据库操作，不能跨 Playwright 执行、AI 请求或对象上传。数据库死锁、锁忙等可重试错误在适配内有界处理，只重试已证明安全的事务；提交结果不明时依靠幂等记录查证，不盲目重放外部业务副作用。

## 4. 三类必须保持等价的底层语义

### 4.1 领取、租约和条件唯一性

PostgreSQL 当前使用 `FOR UPDATE ... SKIP LOCKED`。MySQL InnoDB 也提供锁定读取和 `SKIP LOCKED`，但 SQL 形状、锁范围和隔离级别仍需要单独验证；SQLite 则可用短写事务（例如 `BEGIN IMMEDIATE`）与条件更新实现原子领取。[MySQL 锁定读取](https://dev.mysql.com/doc/refman/8.4/en/innodb-locking-reads.html)、[SQLite 事务](https://www.sqlite.org/lang_transaction.html)

三个实现必须返回相同的 RunGrant，并验证：同一 Run 不被冲突持有、过期持有者不能续写、容量与 Affinity 条件不被绕过。采用 SQLite 不等于删除 RunLease、SessionLease 或恢复检查。

现有数据库还用部分唯一索引保护三个关键约束：

- 每个 Run 只有一个 `ACTIVE` RunLease。
- 每个 BrowserSession 只有一个 `ACTIVE` SessionLease。
- 同一 Target + TargetAccount 的 `CREATING / OPEN / CLOSING / LOST` 会话占用同一独占键；只有 `CLOSED` 释放。

MySQL 8.4 的索引语法不能原样接收 PG 的 `CREATE UNIQUE INDEX ... WHERE ...`。可验证的适配方向是根据状态生成可空占用列，再建立唯一索引：占用时为固定值，释放时为 NULL；生成列及复合键的类型、NULL 与字符比较语义必须经过真库并发验证。MySQL 唯一索引允许多个 NULL，这为该映射提供了基础。此处是候选实现，尚未实测。[MySQL CREATE INDEX](https://dev.mysql.com/doc/refman/8.4/en/create-index.html)

不能将上述数据库约束替换成“先 SELECT，没查到再 INSERT”的无锁检查，也不能在迁移时把 `LOST` 一律当作已释放。

### 4.2 更新结果、错误和时间

- 当前 `finishAttempt` 用返回行数判断是否完成了 `RUNNING → 终态` 的条件更新，续租和对象提交也依赖返回结果。MySQL 8.4 的 UPDATE 语法不提供 PG 形态的 `RETURNING`；适配需要明确命中行与实际变更行的语义，需要取回记录时在同一事务和锁定范围内完成。[MySQL UPDATE](https://dev.mysql.com/doc/refman/8.4/en/update.html)
- 保留现有 `updated`、`created`、`cancelled`、领域错误码等业务结果，避免向上层返回各驱动的 `rows`、`rowCount` 或 `affectedRows`。
- 唯一冲突、外键冲突、租约失效、死锁/锁忙、不可用和提交结果不明要区分。依据操作上下文与可靠的约束标识转换领域错误，不能把所有唯一冲突都报成同一个业务重名。
- 租约的时间基准、采样时机、精度和过期比较属于持久化契约。`now()`、`make_interval` 等表达式留在驱动内；不能为了 SQL 通用而全部改用不同 Worker 的本机时钟。

### 4.3 数据编码与比较规则

| 数据 | 统一要求 |
| --- | --- |
| ID | 保留现有应用层 UUIDv7 和已有 ID；各库原生 UUID / 字符 / 二进制表示由适配层转换 |
| 时间 | 对外统一 UTC 和既有 DTO 格式；读取结果不依赖驱动返回 Date 还是字符串；迁移预检精度损失 |
| JSON | Zod 校验及逻辑内容一致；不依赖数据库 JSON 文本的字段顺序或序列化格式 |
| Snapshot 与幂等摘要 | 复用现有 `canonicalJson` 和摘要算法；导入后验证摘要，不能通过重写历史 Snapshot 或更新摘要掩盖差异 |
| Secret 密文 | 字节内容和 Secret ID 保持一致；BYTEA / BLOB 映射不能经过有损字符串转换 |
| 名称、账号、幂等键 | 明确大小写、重音、尾部空格和长度语义；不依赖数据库默认排序规则 |
| 排序与游标 | 明确 NULL 排序及稳定的排序键；同时间值有 ID 等唯一项作为次序补充 |
| 整数、布尔、NULL | 明确数值范围、0/1 映射，以及数据库 NULL 与 JSON null 的区别 |

已有 [ID 生成](../../packages/db/src/id.ts) 与 [快照摘要](../../packages/db/src/runs/digest.ts) 不依赖数据库生成能力，应直接复用。

字符串比较尤其容易产生“接口没改，业务变了”：MySQL 的默认字符集/排序规则与 PG、SQLite 的常见默认值不同，必须显式配置并验证。登录名已有规范化逻辑；不能把所有业务名称都改成小写来规避差异。[MySQL 字符集与排序规则](https://dev.mysql.com/doc/refman/8.4/en/charset-server.html)

现有 PG 表里有参与索引的 TEXT 字段。映射 MySQL 时应根据已有 Runtime Schema 的真实长度契约设计列及索引，并检查存量数据；不能静默截断，也不能用前缀唯一索引代替完整值的唯一性。

## 5. Schema、迁移和配置

Drizzle 可以继续使用，但它没有跨数据库通用的 table 对象。共享逻辑领域模型，分别维护 PG / MySQL / SQLite 的物理 Schema 与迁移，检查它们满足同一组约束。[Drizzle Schema](https://orm.drizzle.team/docs/sql-schema-declaration)

- 当前 PG 历史迁移和现有升级路径保留；新增后端建立自己的基线和后续迁移记录，不重写已经应用的 PG 历史 SQL。
- 数据库 Schema 版本与 RunSnapshot 的 Runtime Schema 版本分别管理，不能将数据库换型解释成历史 Run 自动升级。
- 外键、CHECK、唯一性和事务保护保留等价保障；SQLite 连接需要显式启用并检查外键等必要设置，不能仅凭表定义存在就认定约束生效。[SQLite 外键](https://www.sqlite.org/foreignkeys.html)
- 当前 `migrate.ts` 假设 DDL 与迁移记录同事务提交。MySQL 多种 DDL 会隐式提交，因此必须提供各库的迁移恢复策略：执行前检查、步骤完成状态校验、失败后恢复或明确阻止继续启动，不能复用该原子性承诺。[MySQL 隐式提交](https://dev.mysql.com/doc/refman/8.4/en/implicit-commit.html)
- 配置拟增加 `CAIRN_DB_DRIVER=postgres|mysql|sqlite`，默认 PG 兼容现有部署；连接参数按驱动验证。SQLite 使用文件路径，不要求伪造 host / user / password。
- API、Worker、迁移工具必须指向同一实例与兼容结构版本。未知驱动、未知版本、不可用存储应启动失败，不静默退回另一个后端。
- 初始化、探活、关闭通过统一生命周期装配。文件路径与权限、连接池和各库会话设置留在具体实现内。

## 6. 通知与数据库分离

当前运行进度仍为手动 GET 刷新，队列由 tick / 恢复扫描驱动；PG NOTIFY / SSE 尚未落地。现状不能被写成已经具备可替换的事件传输。

后续 P7 应保持：先持久化状态及事件，再发送可丢失的变化提示；API 收到提示后读取事实并通过 SSE 输出。数据库读取、事件游标和通知传输是不同职责。

PG NOTIFY 可继续作为 PG 后端的一种通知实现。同机 SQLite 可采用进程间提示；MySQL 多机模式需要确定可跨进程、跨主机的通知通道。进程内 EventEmitter 不能代替跨进程通知，客户端高频轮询也不能作为正常实时机制。

本文不提前引入新消息基础设施。通知通道选型与丢通知/重连恢复验证必须纳入对应后端的正式支持门槛；不能仅完成 SQL 适配就宣称整个实时平台无缝兼容 MySQL。

## 7. 存量数据迁移

数据库驱动兼容和存量迁移分别验收。迁移应走版本化的逻辑数据格式，复用现有校验与摘要；PG SQL dump 不能作为跨库数据格式。

建议的受控迁移流程：

1. **预检**：检查来源应用/结构版本、目标后端版本、字段容量与精度、重复键、外键关系、凭据访问条件和对象可达性；未知版本或不兼容数据明确失败。
2. **停止写入并收敛执行**：阻止新的业务写入和 Run 领取，等待运行结束或按已有策略取消/核查，收敛对象上传与清理，再停止 Worker 和其他写入者；遇到未知副作用保留待核查结论。
3. **生成一致导出**：保存逻辑数据、格式版本、来源版本、条目统计和摘要，保持 ID、关系、历史版本和 Snapshot。导出不改变源库，迁移产物按含凭据数据的敏感性保护。
4. **导入隔离的目标实例**：使用目标后端的 Schema，按依赖顺序写入并校验约束。失败目标不得对外服务；允许清理该迁移目标后重来，不能覆盖仍在使用的库。
5. **核对**：比对条目、主外键、快照摘要、幂等行为、证据指针和授权访问。Secret 密文需要匹配的密钥访问或受控重加密；不在报告或日志中导出明文。
6. **处理运行资源**：迁移历史记录不会转移活浏览器或旧 Worker 的执行权。源端必须先停止并完成资源收敛；未确认关闭的会话不能直接释放独占键，目标端不能重新激活旧 ACTIVE 租约。已有 Profile / 认证状态按受管会话策略单独处理。
7. **受控切换**：验证通过后让 API 和 Worker 一起使用目标实例；源库保持只读备份。目标开始接受新写入以后，不能无条件回切旧库造成新数据丢失，需停止写入并处理增量后再恢复。

对象存储后端不变时，保留对象键并验证访问即可；后端一起变化时，另行搬迁字节并核对摘要。现有 [ObjectStore](../../packages/storage/src/create-store.ts) 的 local / s3 能力继续复用。

## 8. 自动约束与验收

依赖边界应进入现有 `check-deps` / CI，而不是只写在约定中：

- API、Worker 生产业务源码不得直接导入数据库驱动、Drizzle、物理 Schema，或通过 `@cairn/db` 的重新导出绕过限制。
- 公共声明文件不能泄漏 `NodePgDatabase`、Pool、驱动事务类型和物理表行类型；测试专用入口单独管理。
- 未通过下列验收的驱动不能标记为支持。不同数据库使用同一组业务断言，底层测试设施负责真库/真文件的创建与清理；沿用已有 Vitest 和集成测试，不新建测试框架。

| 验收主题 | 最小必要验证 |
| --- | --- |
| 配置与升级 | 空库初始化、带存量数据升级、升级失败、驱动配置错误及关闭释放 |
| CRUD 与错误 | Target / Account / Scenario / 权限管理的成功、重名、外键阻止删除，错误码一致 |
| 数据编码 | Unicode、大小写、空格、边界长度、NULL、JSON、时间和二进制无损往返 |
| 版本与幂等 | 并发追加版本号唯一；相同幂等键同输入复用、异输入冲突 |
| Run 原子性 | Run + Snapshot + StepRun 同事务；finishAttempt 中途失败没有半份状态或重复 Evidence |
| 领取与容量 | 独立连接/进程并发领取无重复持有，Worker 身份、容量与 Affinity 条件一致 |
| 会话与 fencing | 同账号并发获取互斥；LOST 不放键；过期/旧持有者不能续写；崩溃后能恢复 |
| 取消与副作用 | 在途取消不接纳迟到成功；结果未知不被误写成安全完成；重试不重复外部副作用 |
| 证据 | 关联与清理并发、对象缺失、授权读取及摘要一致 |
| 通知 | 对应实时能力落地后，丢通知、断线、重启和补读仍回到持久事实；不靠客户端高频轮询 |
| 迁移 | 对承诺支持的三库验证六个方向的迁移烟测；包含历史 Run、版本、凭据引用与证据，以及失败保源、切换后的数据保护 |

PG / MySQL 的多 Worker 正确性和 SQLite 同机写入正确性分别验收；SQLite 不因为被列入兼容矩阵就获得多机共享文件的支持承诺。

## 9. 建议先处理的范围

最高优先级是**持久化公共边界、上层直接查询、事务操作与错误契约**。这一组先在 PG 上完成，可阻止新增业务继续扩大数据库耦合，并通过现有测试保证行为不变。

随后用第二种真实后端验证边界。SQLite 能尽早暴露文件数据库、无行锁和写串行差异，MySQL 能暴露 RETURNING、DDL、条件唯一性与比较规则差异；两者都属于目标，不因完成其中一个就宣称三库兼容。

三库 Schema / 操作实现、同契约测试、通知能力和存量迁移全部达到相应门槛后，才能交付完整的“可切换、可迁移”。只有接口收口时应明确标为“降低耦合”，不能标为“已支持 MySQL / SQLite”。

## 10. 规范需要同步的内容

当前[宪法](../../AGENTS.md)第 10、11、12、13 节对 PostgreSQL、PG 队列和 NOTIFY 有明确表述。正式开发前应随方案审查明确：

- 不变量是持久化事实、原子领取、所有权隔离、可恢复、历史可解释及证据一致性。
- PG 是现有部署实现；MySQL / SQLite 的支持版本、并发及部署限制写入技术基线和实现文档。
- 实时通信仍坚持 SSE 与可补读，数据库通知只承担变化提示。

文档调整应有针对性：已经发生的 PG 实现与验证记录保留，不全仓替换历史文字。用户已于 2026-09-13 批准按本方案开发并使用本机容器验证。完成后按宪法第 22 节记录 CHANGELOG。UUID 沿用应用层 UUIDv7；当前执行锁未依赖 Redis，保留数据库事务、租约与 fencing 的一致性保障。


## 11. 实现与验收记录

已实现原生 PG / MySQL / SQLite 持久化适配、生产业务入口收口、运行/租约事务复用、类型和约束映射、独立迁移基线、启动结构检查与受控逻辑迁移。工作区同期引入的场景草稿结构 0015 已纳入后端基线。

操作步骤、支持范围、时间精度与回切限制见[数据库配置与受控迁移](../../deploy/database-backends.md)。真实数据库验收复用现有用例，并补充独立进程领取与六方向迁移；最终测试数量以本次交付记录为准。P7 通知仍按原计划实施。

补充 UUID 核查：业务 ID 使用应用 UUIDv7；历史 PG `0002_rbac.sql` 的三条系统角色种子使用过数据库 UUIDv4，保留历史迁移。该实现已封装在 PG 初始化中，不形成业务层或新后端依赖。


2026-09-13 本机验收记录（真实 PG 16 容器、MySQL 8.4 容器与 SQLite 文件）：

| 检查 | 结果 |
| --- | --- |
| 数据库包全部测试 | 17 个文件、270 项通过；包含三库执行、会话、对象、证据及场景草稿契约 |
| 六方向迁移与独立进程领取复测 | 16 项通过；迁移包含历史 Run、版本、草稿、密文与证据，逐表回读一致 |
| API 全部测试 | 22 个文件、133 项通过 |
| Shared 全部运行测试 | 24 个文件、230 项通过 |
| Worker 本次影响范围回归 | 8 个文件、86 项通过：生命周期、领取回交、Engine、SessionManager、对象及证据 |
| Worker 完整测试 | 151 项通过、3 项跳过；1 个测试套件加载失败，见下文 |
| 构建 / 类型 | DB、API 构建和类型检查通过；管理入口与迁移工具已纳入正常构建 |
| CLI 迁移烟测 | SQLite 导出/导入成功；校验逻辑版本 0015、完整 22 张逻辑表 |
| 工程检查 | `pnpm check` 通过，含三库共 17 个迁移文件；冻结 lockfile 安装检查通过 |

完整 Worker 测试的失败来自同期新增的 `tests/harness/cairn-test-harness.spec.ts` 无法从仓库根解析 `@cairn/db/testing`，未计为通过。全仓类型检查也未通过：Shared 的 `compiler.test.ts` 两处定位夹具缺少 `framePath`；Worker 的 AI 适配层及新增 harness 有独立类型错误。上述失败不在本次数据库改造代码内，保留待对应任务处理，不能据此声称 CI 已全绿。

本轮同时修复了 PG 测试模板库的并行互删：每次套件调用生成独立模板名，只清理自己创建的模板。数据库与 API/Worker 并行回归已验证不会相互终止连接。

本次只使用隔离测试库与临时文件验证，现有开发业务库没有执行跨库搬迁。MySQL 测试容器保留在回环地址 3307，便于复跑。P7 SSE/通知与桌面运行时打包仍属于原有后续能力，不包含在本次支持声明中。


### 二次复查（2026-09-13）

复查发现并修复三处遗漏：

- SQLite 外键错误没有约束名，删除只被录制草稿引用的 Target 会泄漏原生错误。现在持有 Target 行锁，在同一事务内检查账号、场景和录制引用，返回明确的业务冲突；Scenario 删除也把运行引用检查放进持锁事务，关闭先检查后删除的并发窗口。
- 多个实例首次争抢同一个 Worker ID 时，主键已保证只有一个成功，但 PG 可能抛出原生唯一键错误。现在统一返回 `WORKER_ID_CONFLICT`，三库通过同一并发断言。
- 组合草稿版本创建和试跑 Run 的事务会触发 SQLite 嵌套事务限制。SQLite 现在使用同一连接上的 SAVEPOINT，支持内层失败独立回滚和外层失败整体回滚，与 PG / MySQL 保持一致。

最终复验：数据库 17 个文件、282 项全部通过；API 133 项通过；Worker 生命周期相关 14 项通过；DB 构建、类型检查与 `pnpm check` 通过。没有发现本次数据库改造范围内仍待处理的阻塞问题；上一轮记录的全仓独立问题不计为已修复。

已按用户要求停止 `cairn-portability-mysql`，Podman 确认 `running=false`、正常退出；保留容器及数据供后续复跑。

### 三次复查：CHECK 不得引用带 referential action 的外键列（2026-09-13）

由 Midscene 线在 MySQL 8.4 上撞到迁移被拦发现。MySQL 禁止 CHECK 引用参与 referential action 的外键列（`ER_CHECK_CONSTRAINT_CLAUSE_USING_FK_REFER_ACTION_COLUMN`，错误码 3823）；同一列上的普通外键加 CHECK 是允许的，本机 8.4 容器双向复现过。`console_audit_events.actor_console_account_id` 是 `ON DELETE SET NULL` 的外键列，`0016` 的形状约束引用了它，于是 MySQL 迁移只能改用 `resource_id` 表达同一形状，两库约束强度不一致。

进一步核查发现问题不止是"强度不一致"：在 PG 上这条约束会反噬删除——删掉登录成功过的控制台账号时，外键把 actor 置空，CHECK 立刻判定该行非法，整个 `DELETE` 失败（`23514`），而 MySQL 与 SQLite 能删。也就是说被复制到其他后端才是错的。

按"数据库无关性由应用层保证、不被具体方言绑死"的原则收敛：新增 PG `0021_audit_login_shape_portable.sql`，把形状约束改成三库都能表达的写法（形状由 `resource_id` 表达，不引用外键列）；actor 与 `resource_id` 的对应关系由写路径 `recordLoginAudit` 保证——两列取自同一个变量，结构上无法分叉。不引入触发器等后端专有 DDL。

新增 `audit-login-shape.test.ts` 用 `describe.each(DRIVERS)` 把两条业务断言钉在三库上：写入时 actor 与 `resource_id` 一致且成功必有账号、未知账号必无；删除登录过的账号在三库都成功，登录历史保留、actor 置空。修复前该文件在 PG 上失败、在 MySQL / SQLite 上通过，正好暴露原先的分叉。SQLite 仍没有表级 CHECK（既有表加表级约束需要整表重建），防御深度弱于另两库，但行为结论一致。

复验：数据库 22 个文件、346 项通过（含新增 6 项三库断言）；API 29 个文件、168 项通过；`pnpm check` 通过，含三库共 31 个迁移；MySQL 8.4 全新库跑满迁移并重复执行确认幂等。
