import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SESSION = readFileSync(join(__dirname, 'session-manager.ts'), 'utf8')

describe('受管浏览器生产路径', () => {
  it('进入等待只走 enterRunWaitingForAuth，不调用未绑定 hold 旧入口', () => {
    expect(SESSION).toContain('enterRunWaitingForAuth')
    expect(SESSION).not.toMatch(/\bclaimAuthHold\b/)
    expect(SESSION).not.toMatch(/\bmarkRunWaitingForAuth\b/)
  })
})
