# @cairn/db

Drizzle schema + migrations。`api` 与 `worker` 的共同依赖，不属于任何一方。

边界见[宪法「执行分层」](../../CLAUDE.md#执行分层)与[「数据库可移植」](../../CLAUDE.md#数据库可移植)；公开业务操作从 [src/index.ts](src/index.ts) 读取，后端支持与迁移限制见[数据库配置与受控迁移](../../deploy/database-backends.md)。
