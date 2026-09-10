import { requireReachableDb } from './src/testing.js'

/**
 * 集成测试的库前置条件在建任何用例之前就成立，否则整个包失败。
 *
 * 放在 globalSetup 而不是让每个测试文件各自 `skipIf` 解释一遍「配置看起来有没有」：
 * 判据只有一条——库能不能连上。未来新增的集成测试不需要记得加门槛。
 */
export default async function globalSetup(): Promise<void> {
  await requireReachableDb()
}
