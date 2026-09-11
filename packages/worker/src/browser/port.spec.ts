import { describe, expect, it, vi } from 'vitest'
import type { BrowserCommandResult, SessionGrant } from '@cairn/shared'
import { createBrowserPort } from './port'
import type { BrowserSessionManager } from './session-manager'
import type { ObjectService } from '../objects/object.service'

const grant: SessionGrant = {
  sessionId: '00000000-0000-4000-8000-000000000001',
  leaseId: '00000000-0000-4000-8000-000000000002',
  generation: 1,
  sessionFencingToken: 1,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
}

const failed: BrowserCommandResult & { screenshotBytes?: Buffer } = {
  ok: false,
  error: {
    code: 'TARGET_NOT_FOUND',
    category: 'EXECUTOR',
    retryable: true,
    safeMessage: '未找到',
  },
}

describe('createBrowserPort 失败截图', () => {
  it('对象存储不可用时记 missingReason，不把失败改成成功', async () => {
    const manager = {
      acquire: vi.fn(),
      release: vi.fn(),
      execute: vi.fn().mockResolvedValue({ ...failed, screenshotBytes: Buffer.from('png') }),
    } as unknown as BrowserSessionManager
    const port = createBrowserPort(manager)
    const result = await port.execute(grant, { type: 'click', target: { framePath: [], candidates: [{ by: 'text', value: 'x' }] } }, undefined, {
      runId: grant.sessionId,
      stepRunId: grant.leaseId,
      attemptId: grant.sessionId,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('ok')
    expect(result.screenshot?.missingReason).toBeTruthy()
  })

  it('对象存储可用时写指针', async () => {
    const manager = {
      execute: vi.fn().mockResolvedValue({ ...failed, screenshotBytes: Buffer.from('png') }),
    } as unknown as BrowserSessionManager
    const objects = {
      putObjectEvidence: vi.fn().mockResolvedValue({
        objectKey: 'runs/a/screenshot.png',
        contentType: 'image/png',
        byteSize: 3,
        digest: 'sha256:abc',
      }),
    } as unknown as ObjectService
    const port = createBrowserPort(manager, objects)
    const result = await port.execute(
      grant,
      { type: 'click', target: { framePath: [], candidates: [{ by: 'text', value: 'x' }] } },
      undefined,
      { runId: grant.sessionId, stepRunId: grant.leaseId, attemptId: grant.sessionId },
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('ok')
    expect(result.screenshot?.objectKey).toBe('runs/a/screenshot.png')
    expect(result.screenshot?.missingReason).toBeUndefined()
  })
})
