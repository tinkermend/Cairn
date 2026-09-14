# 数据库配置与受控迁移

数据库业务入口是 `@cairn/db`。API 与 Worker 只传递不透明的数据库句柄并调用业务操作；原生连接、Drizzle 表与 SQL 均留在包内。迁移/预检从 `@cairn/db/admin` 进入，测试夹具从 `@cairn/db/testing` 进入。`pnpm check:deps` 与类型检查约束这些边界。

## 支持范围

| 后端 | 当前验收范围 | 执行所有权 |
| --- | --- | --- |
| PostgreSQL 16+ | 服务端部署，独立进程、多 Worker；保留原有历史迁移 | 短事务、行锁、SKIP LOCKED、条件唯一索引、fencing |
| MySQL 8.4（8.x，InnoDB） | 服务端部署，独立进程、多 Worker | READ COMMITTED 短事务、行锁、SKIP LOCKED；生成占用列 + 唯一索引 |
| SQLite 3.45+，Node 24 内置驱动 | 本机文件、同机 API/Worker；适合未来桌面部署 | WAL、每连接启用外键、BEGIN IMMEDIATE 短写事务、有界锁忙等待、条件唯一索引、fencing |

SQLite 仍然只有一个写事务同时执行。不得把数据库文件放在多机共享网络文件系统上，也不承诺与服务端数据库相同的写入吞吐。事务各持有独立连接，异步等待期间不会把另一请求的写入混进当前事务。

运行观察的变化提示按 `CAIRN_CHANGE_HINT` 装配：PostgreSQL 默认 LISTEN/NOTIFY；MySQL / SQLite 只有配置了 `CAIRN_REDIS_URL` 才启用 Redis Pub/Sub，否则 `ready.realtime = false`，页面需手动刷新。Redis 只做提示扇出，不能替代 Run 状态、租约或对象存储。对象存储继续使用已有 Local / S3 适配。

业务 ID 继续由应用 `uuid.v7()` 生成，换库不重建 ID。旧 PG `0002_rbac.sql` 为三个系统角色使用过 `gen_random_uuid()`（v4）；这是保留的历史初始化实现，角色身份以 key 判断。新后端基线使用固定的合法种子 ID，跨库导入保留来源角色 ID。运行、租约与业务实体不需要数据库 UUID 生成函数。

执行锁没有引入 Redis。RunLease、SessionLease、数据库约束与 fencing 仍是所有权依据；对象存储与通知通道都不能替代它们。

## 配置和启动

默认 `CAIRN_DB_DRIVER=postgres`，兼容已有 PG 配置。MySQL 示例：

```dotenv
CAIRN_DB_DRIVER=mysql
CAIRN_DB_HOST=127.0.0.1
CAIRN_DB_PORT=3306
CAIRN_DB_NAME=cairn
CAIRN_DB_USER=cairn
CAIRN_DB_PASSWORD=<部署口令>
```

SQLite 示例：

```dotenv
CAIRN_DB_DRIVER=sqlite
CAIRN_DB_FILE=/absolute/path/to/cairn.sqlite
```

SQLite 不要求 host/user/password，也不接受 `:memory:`。PG 的 `CAIRN_DB_SCHEMA` 会同时用于迁移与运行时表名。MySQL 会话固定 UTC，字符串比较显式采用 `utf8mb4_0900_bin`，不依赖服务器默认排序规则。API、Worker、迁移命令必须使用同一配置。

编译后用对应配置执行迁移，再启动进程：

```sh
pnpm --filter @cairn/shared build
pnpm --filter @cairn/db build
node --env-file=.env.sqlite packages/db/dist/bin/migrate-cli.js
```

API/Worker 启动会检查后端版本与迁移记录。缺失、未知、未完成的结构版本均拒绝启动，不自动回落 PG。MySQL / SQLite 基线对应逻辑结构 0015，`0002_audit_login` 升到 0016；后续结构变化应新增各后端迁移并更新契约/迁移验收，不能修改已发布迁移。

MySQL DDL 会隐式提交。迁移执行前持久化 `running` 标记；中断或失败后保持阻断，不能把部分 DDL 当作完成后重试。对新建空目标，销毁该隔离目标并重建；对存量实例，先恢复已验证备份，再排查并重跑。不得仅手改标记为 `complete`。

## 存量迁移

这里的“可迁移”指受控停止写入后的逻辑迁移，不是在线零停机切换。

1. 停止新的业务写入/领取，收敛已有 Run、上传与清理，再停止 API、Worker、调度及其它写入者。
2. 活跃 Run、ACTIVE 租约、未关闭浏览器会话（包括 LOST）、未完成上传/证据会阻止导出。需要人工核查的副作用保留 NEEDS_REVIEW，不凭迁移释放会话键。
3. 准备已迁移的空目标库。导入拒绝已有业务记录的目标；不向正在使用的库合并数据。
4. 源与目标使用相同的凭据主密钥，或者另行完成受控重加密。数据库迁移保留密文字节，不导出凭证明文。
5. 对象存储沿用原后端时，两个配置必须能读取相同对象。工具逐个读取 available 对象并校验大小和 SHA-256；对象存储同时迁移时，应先另行搬运并校验对象字节。
6. 执行导出、导入，核对计数、摘要及业务访问后，再一起切换 API/Worker 配置。源码/进程升级不得让旧浏览器和旧 Worker 重新获得执行权。

```sh
node tools/database-transfer.mjs export --env .env.source --file backup.json --writers-stopped
node tools/database-transfer.mjs import --env .env.target --file backup.json --writers-stopped
```

工具使用指定文件覆盖同名环境变量；不会执行文件中的 shell 表达式。导出文件包含密码哈希和密文，权限为 `0600`，已存在的文件不会被覆盖。不要提交迁移文件到 Git。

PostgreSQL 可能有微秒时间，而现有应用 `Date` 与新后端统一到毫秒。预检会报告超出毫秒的单元格数量并默认阻止导出。确认接受这一精度收敛时，导入与导出均显式添加 `--allow-millisecond-precision-loss`；数量进入导出记录。历史 Snapshot 内容及其摘要不因此改写。

版本化归档校验表/列集合、字段编码、UUID、整数范围、目标列容量、快照摘要和对象可达性。导入、外键/唯一约束校验及逻辑回读比对在同一数据库事务内完成，失败会回滚整批记录。源库只读，失败不会清理源数据。导出保存 ID、关系、场景版本、Run Snapshot、证据引用及密文。

目标开始接收新写入以后，不能直接切回旧库；必须再次停止写入并处理增量，避免丢失新数据。保留源库及对象的备份，确认迁移成功后再按既有保留策略处理。

## 测试

`pnpm --filter @cairn/db test` 需要真实 PG、MySQL 和本机 SQLite 文件，缺失必失败。PG 沿用现有 `.env`；MySQL 测试默认连 `127.0.0.1:3307`，可通过以下变量覆盖：

- `CAIRN_TEST_MYSQL_HOST`、`CAIRN_TEST_MYSQL_PORT`、`CAIRN_TEST_MYSQL_USER`；
- `CAIRN_TEST_MYSQL_PASSWORD`，或 `CAIRN_TEST_MYSQL_ENV_FILE` 指向包含 `MYSQL_ROOT_PASSWORD` 的文件；
- `CAIRN_TEST_MYSQL_DATABASE`：用于建隔离库的管理连接，默认 `cairn_portability`。

本机本次使用容器 `cairn-portability-mysql`（MySQL 8.4），仅映射回环地址 3307。其测试密码文件位于被忽略的 `.run/database-portability/mysql.env`。每个用例组创建并清理独立数据库/临时文件，不迁移开发业务库。CI 启动 PG 16 / MySQL 8.4 服务，运行同一套契约。

现有执行、会话、对象、证据测试复用于三库；补充测试通过独立 Node 进程争抢任务，检查容量、旧 token、超时与 Worker 身份，并验证三库六个方向的迁移、失败回滚和源库保留。PG 原有结构升级与索引/触发器测试继续保留。


本机测试容器已在 2026-09-13 复查完成后停止（保留数据）。需要重新运行三库测试时，先执行 `podman start cairn-portability-mysql`，等待 MySQL 就绪；测试完成后可执行 `podman stop cairn-portability-mysql`。最终复查结果见[方案验收记录](../docs/spec/2026-09-13-database-portability.md#二次复查2026-09-13)。
