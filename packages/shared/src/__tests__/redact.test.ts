import { describe, expect, it } from 'vitest'
import { REDACTED, redactJson } from '../redact.js'

describe('redactJson', () => {
  it('按值替换，长秘密优先', () => {
    expect(redactJson({ password: 'hunter2', note: 'use hunter2' }, ['hunter2'])).toEqual({
      password: REDACTED,
      note: `use ${REDACTED}`,
    })
    expect(redactJson('prefix-ab-long-secret-suffix', ['ab', 'ab-long-secret'])).toBe(
      `prefix-${REDACTED}-suffix`,
    )
  })

  it('不猜字段名：tokenCount 原样保留', () => {
    expect(redactJson({ tokenCount: 3, token: 'real-token' }, ['real-token'])).toEqual({
      tokenCount: 3,
      token: REDACTED,
    })
  })

  it('空秘密集不改写', () => {
    const payload = { password: 'visible' }
    expect(redactJson(payload, [])).toEqual(payload)
  })
})
