import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { dumpTestFailureArtifacts, sanitizeContext } from './failure-artifacts.js'

describe('failure-artifacts', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cairn-failure-artifacts-test-'))
  })

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true })
  })

  it('sanitizeContext 脱敏敏感凭据', () => {
    const context = {
      orderId: 'ORD-123',
      user: {
        username: 'admin',
        password: 'superSecretPassword!123',
        apiToken: 'tok_live_9999999999999999999999',
      },
      secretId: 'sec-001',
      ciphertext: 'enc:AES256:abcd...',
    }

    const sanitized = sanitizeContext(context) as any
    expect(sanitized.orderId).toBe('ORD-123')
    expect(sanitized.user.username).toBe('admin')
    expect(sanitized.user.password).toBe('***REDACTED***')
    expect(sanitized.user.apiToken).toBe('***REDACTED***')
    expect(sanitized.ciphertext).toBe('***REDACTED***')
  })

  it('dumpTestFailureArtifacts 正常输出 context.json 与 error.log', async () => {
    const res = await dumpTestFailureArtifacts({
      testName: '采购单提交断言失败',
      outputDir: tempDir,
      error: new Error('Expected button to be visible'),
      context: {
        stepIndex: 3,
        stepType: 'click',
        accountPassword: 'myPassword123',
      },
    })

    expect(existsSync(res.artifactDir)).toBe(true)
    expect(res.contextPath && existsSync(res.contextPath)).toBe(true)
    expect(res.errorPath && existsSync(res.errorPath)).toBe(true)

    const contextContent = JSON.parse(readFileSync(res.contextPath!, 'utf8'))
    expect(contextContent.stepIndex).toBe(3)
    expect(contextContent.accountPassword).toBe('***REDACTED***')

    const errorContent = readFileSync(res.errorPath!, 'utf8')
    expect(errorContent).toContain('Expected button to be visible')
  })
})
