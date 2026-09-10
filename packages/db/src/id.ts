import { v7 } from 'uuid'

/**
 * 主键生成器。全库唯一入口——不要在别处直接调 `randomUUID()`。
 *
 * 用 UUIDv7 而非 v4：v7 前 48 位是毫秒时间戳，B-tree 插入近似追加，
 * 避免 v4 全随机带来的页分裂与 WAL 放大；不可预测性与全局唯一性不变。
 * Node 24 与 PostgreSQL 16 都无原生 v7 生成器（PG 18 才有 `uuidv7()`），
 * 因此在应用侧生成——这本来也是必需的：worker 要在写库前就确定
 * 证据的 S3 key（`cairn-evidence/{runId}/{runNodeId}/…`）。
 */
export function newId(): string {
  return v7()
}
