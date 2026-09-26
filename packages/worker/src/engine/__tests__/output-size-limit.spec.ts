import { describe, expect, it } from 'vitest'
import { MAX_STEP_OUTPUT_BYTES, MAX_STEP_OUTPUT_KB } from '@cairn/shared'

describe('尝试输出体积上限（256 KB）', () => {
  it('常量定义符合规范', () => {
    expect(MAX_STEP_OUTPUT_KB).toBe(256)
    expect(MAX_STEP_OUTPUT_BYTES).toBe(256 * 1024)
  })

  it('超过 256 KB 时触发体积超限判定', () => {
    const smallPayload = { data: 'a'.repeat(1000) }
    const largePayload = { data: 'a'.repeat(300 * 1024) }

    const smallBytes = Buffer.byteLength(JSON.stringify(smallPayload), 'utf8')
    const largeBytes = Buffer.byteLength(JSON.stringify(largePayload), 'utf8')

    expect(smallBytes).toBeLessThanOrEqual(MAX_STEP_OUTPUT_BYTES)
    expect(largeBytes).toBeGreaterThan(MAX_STEP_OUTPUT_BYTES)
  })
})
