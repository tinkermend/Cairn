import { requireReachableDb, setupTestTemplateDatabase, teardownTestTemplateDatabase } from './src/testing.js'

/**
 * 集成测试的库前置条件在建任何用例之前就成立，否则整个包失败。
 * 在 globalSetup 中预热模板库并跑全量迁移，使后续每个用例只需亚秒级克隆，不必重复 migration。
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  await requireReachableDb()
  await setupTestTemplateDatabase()
  return async () => {
    await teardownTestTemplateDatabase()
  }
}
