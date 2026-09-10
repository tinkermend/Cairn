import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// worker 的 tsconfig 带 types:["node"]，CJS 程序不允许 import.meta；vitest 运行时提供 __dirname
const ENGINE_DIR = __dirname
const FORBIDDEN_IMPORT =
  /(?:from|import|require)\s*\(?\s*['"][^'"]*(?:playwright|midscene|page-agent|@cairn\/storage)/i

describe('Engine 依赖边界', () => {
  it('源码与测试不引用浏览器或 AI SDK', () => {
    const files = readdirSync(ENGINE_DIR).filter((name) => name.endsWith('.ts'))
    const hits: string[] = []
    for (const file of files) {
      const text = readFileSync(join(ENGINE_DIR, file), 'utf8')
      if (FORBIDDEN_IMPORT.test(text)) hits.push(file)
    }
    expect(hits).toEqual([])
  })
})
