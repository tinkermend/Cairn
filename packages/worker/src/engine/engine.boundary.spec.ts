import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ENGINE_DIR = __dirname
const FORBIDDEN_IMPORT =
  /(?:from|import|require)\s*\(?\s*['"][^'"]*(?:playwright|midscene|page-agent|@midscene\/|@page-agent\/|@cairn\/storage)/i
/** Engine 只能通过注入的 BrowserPort 使用会话，不得直接引用 ../browser。 */
const FORBIDDEN_BROWSER_DIR = /(?:from|import|require)\s*\(?\s*['"][^'"]*\.\.\/browser/

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      yield* walk(full)
      continue
    }
    if (name.endsWith('.ts')) yield full
  }
}

describe('Engine 依赖边界', () => {
  it('递归检查源码与测试不引用浏览器或 AI SDK', () => {
    const hits: string[] = []
    for (const file of walk(ENGINE_DIR)) {
      const text = readFileSync(file, 'utf8')
      if (FORBIDDEN_IMPORT.test(text) || FORBIDDEN_BROWSER_DIR.test(text)) hits.push(file.slice(ENGINE_DIR.length + 1))
    }
    expect(hits).toEqual([])
  })
})
