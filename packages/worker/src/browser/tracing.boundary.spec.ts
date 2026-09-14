import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SESSION = readFileSync(join(__dirname, 'session-manager.ts'), 'utf8')

describe('Trace 开录边界', () => {
  it('startChunk 必须在 executeOnPage 之前', () => {
    const scope = SESSION.indexOf('async withManagedPage')
    const start = SESSION.indexOf('startChunk', scope)
    const action = SESSION.indexOf('fn(page)', scope)
    expect(scope).toBeGreaterThan(-1)
    expect(start).toBeGreaterThan(-1)
    expect(action).toBeGreaterThan(-1)
    expect(start).toBeLessThan(action)
    expect(SESSION.includes('executeOnPage(page')).toBe(true)
  })

  it('默认 off 是不开录：tracing.start 只在策略非 off 之后', () => {
    const offGuard = SESSION.indexOf("policy.trace === 'off'")
    const start = SESSION.indexOf('tracing.start({')
    expect(offGuard).toBeGreaterThan(-1)
    expect(start).toBeGreaterThan(offGuard)
  })
})
