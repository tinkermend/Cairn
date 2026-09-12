import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

  it('on_failure 成功不上传截图和 Trace，并删除临时文件', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cairn-trace-'))
    const tracePath = join(dir, 'chunk.zip')
    await writeFile(tracePath, 'trace-bytes')
    const manager = {
      execute: vi.fn().mockResolvedValue({ ok: true, output: {}, tracePath }),
    } as unknown as BrowserSessionManager
    const objects = {
      putObjectEvidence: vi.fn(),
    } as unknown as ObjectService
    const port = createBrowserPort(manager, objects)
    const result = await port.execute(
      grant,
      { type: 'click', target: { framePath: [], candidates: [{ by: 'text', value: 'x' }] } },
      undefined,
      {
        runId: grant.sessionId,
        stepRunId: grant.leaseId,
        attemptId: grant.sessionId,
        screenshot: 'on_failure',
        trace: 'on_failure',
      },
    )
    expect(result.ok).toBe(true)
    expect(objects.putObjectEvidence).not.toHaveBeenCalled()
    await expect(import('node:fs/promises').then((fs) => fs.stat(tracePath))).rejects.toThrow()
  })

  it('失败且策略打开时上传 Trace；空字节记 capture_failed', async () => {
    const objects = {
      putObjectEvidence: vi.fn().mockResolvedValue({
        status: 'available',
        objectKey: 'runs/a/trace.zip',
        contentType: 'application/zip',
        byteSize: 4,
        digest: 'sha256:abc',
      }),
    } as unknown as ObjectService
    const manager = {
      execute: vi.fn().mockResolvedValue({ ...failed, screenshotBytes: undefined }),
    } as unknown as BrowserSessionManager
    const port = createBrowserPort(manager, objects)
    const result = await port.execute(
      grant,
      { type: 'click', target: { framePath: [], candidates: [{ by: 'text', value: 'x' }] } },
      undefined,
      { runId: grant.sessionId, stepRunId: grant.leaseId, attemptId: grant.sessionId },
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('ok')
    expect(result.screenshot?.missingReason).toBe('capture_failed')
  })

  it('失败且要留 Trace 时，空文件记 capture_failed，不改写成成功', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cairn-empty-trace-'))
    const tracePath = join(dir, 'empty.zip')
    await writeFile(tracePath, '')
    const objects = {
      putObjectEvidence: vi.fn(),
    } as unknown as ObjectService
    const manager = {
      execute: vi.fn().mockResolvedValue({ ...failed, tracePath }),
    } as unknown as BrowserSessionManager
    const port = createBrowserPort(manager, objects)
    const result = await port.execute(
      grant,
      { type: 'click', target: { framePath: [], candidates: [{ by: 'text', value: 'x' }] } },
      undefined,
      {
        runId: grant.sessionId,
        stepRunId: grant.leaseId,
        attemptId: grant.sessionId,
        screenshot: 'off',
        trace: 'on_failure',
      },
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('ok')
    expect(result.trace?.missingReason).toBe('capture_failed')
    expect(objects.putObjectEvidence).not.toHaveBeenCalled()
    await expect(import('node:fs/promises').then((fs) => fs.stat(tracePath))).rejects.toThrow()
  })
})
