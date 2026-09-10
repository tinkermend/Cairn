import { requireReachableDb } from '@cairn/db'

/**
 * api 的集成测试（targets）真连 PostgreSQL，库不可用时整个包失败，不跳过。
 * 复用 `@cairn/db` 的那份实现——判据只有一条，不各写一遍。
 */
export default async function globalSetup(): Promise<void> {
  await requireReachableDb()
}
