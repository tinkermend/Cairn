import { requireReachableDb, setupTestTemplateDatabase, teardownTestTemplateDatabase } from '@cairn/db/testing'

/**
 * api 的集成测试真连 PostgreSQL，库不可用时整个包失败，不跳过。
 * 在 globalSetup 中预热模板库并跑全量迁移，使后续每个用例只需亚秒级克隆。
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  await requireReachableDb()
  await setupTestTemplateDatabase()
  return async () => {
    await teardownTestTemplateDatabase()
  }
}
