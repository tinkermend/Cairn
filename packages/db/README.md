# @cairn/db

Drizzle schema + migrations。`api` 与 `worker` 的共同依赖，不属于任何一方。

领域边界见[领域与数据架构](../../docs/arch/02_识途核心领域模型与数据架构设计_v1.0.md)；公开业务操作从 [src/index.ts](src/index.ts) 读取，后端支持与迁移限制见[数据库配置与受控迁移](../../deploy/database-backends.md)。
