import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SESSION = readFileSync(join(__dirname, 'session-manager.ts'), 'utf8')

describe('Trace 开录边界', () => {
  it('startChunk 必须在 executeOnPage 之前', () => {
    const execute = SESSION.indexOf('async execute(')
    const start = SESSION.indexOf('startChunk', execute)
    const action = SESSION.indexOf('executeOnPage(page', execute)
    expect(execute).toBeGreaterThan(-1)
    expect(start).toBeGreaterThan(-1)
    expect(action).toBeGreaterThan(-1)
    expect(start).toBeLessThan(action)
  })

  it('默认 off 是不开录：tracing.start 只在策略非 off 之后', () => {
    const offGuard = SESSION.indexOf("policy.trace === 'off'")
    const start = SESSION.indexOf('tracing.start({')
    expect(offGuard).toBeGreaterThan(-1)
    expect(start).toBeGreaterThan(offGuard)
  })
})
