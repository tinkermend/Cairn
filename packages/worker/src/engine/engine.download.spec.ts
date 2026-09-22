import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { openIsolatedDb, targets, type DbHandle } from '@cairn/db/testing'
import {
  asRunFileHandle,
  resolveEvidencePolicy,
  RUN_FILE_HANDLE_KIND,
  type BrowserCommand,
  type BrowserCommandResult,
  type DownloadStep,
  type RunGrant,
  type RunSnapshot,
  type SessionGrant,
} from '@cairn/shared'
import { BrowserStepExecutor } from './browser-executor.js'
import type { BrowserPort } from './ports.js'
import type { StepExecutionContext } from './step-executor.js'
import {
  cleanupRunFileWorkspace,
  ensureWorkspaceDirs,
  runFileWorkspaceDownloadDir,
} from './run-file-workspace.js'

const SCHEMA = `cairn_test_${Date.now().toString(36)}_engdown`

describe('BrowserStepExecutor - Download Step', () => {
  let handle: DbHandle
  let targetId: string
  const actorId = '00000000-0000-4000-8000-000000000001'
  const runId = '00000000-0000-4000-8000-000000000003'

  beforeAll(async () => {
    handle = await openIsolatedDb(SCHEMA)
    targetId = '00000000-0000-4000-8000-000000000002'
    await handle.db.insert(targets).values({
      id: targetId,
      code: 'download-test-target',
      name: 'Download Test Target',
      entryUrl: 'https://example.com',
      loginUrl: 'https://example.com/login',
      state: 'ACTIVE',
      createdByConsoleAccountId: actorId,
    })
  })

  afterAll(async () => {
    await cleanupRunFileWorkspace(runId)
    await handle.pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
  })

  function makeContext(step: DownloadStep): {
    ctx: StepExecutionContext
    sessionGrant: SessionGrant
  } {
    const sessionGrant: SessionGrant = {
      runId,
      sessionId: '00000000-0000-4000-8000-000000000004',
      leaseId: '00000000-0000-4000-8000-000000000005',
      generation: 1,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    }

    const grant: RunGrant = {
      runId,
      leaseId: '00000000-0000-4000-8000-000000000005',
      workerId: 'worker-1',
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    }

    const snapshot: RunSnapshot = {
      allowedOrigins: ['https://example.com'],
      steps: [step],
    } as any

    const ctx: StepExecutionContext = {
      runId,
      stepRunId: '00000000-0000-4000-8000-000000000006',
      attemptId: '00000000-0000-4000-8000-000000000007',
      targetId,
      step,
      input: step.input,
      context: {},
      signal: new AbortController().signal,
      clock: { now: () => 1000 },
      sessionGrant,
      grant,
      snapshot,
      evidencePolicy: resolveEvidencePolicy(),
    }

    return { ctx, sessionGrant }
  }

  it('completes download without target and outputs valid RunFileHandle', async () => {
    const { downloadDir } = await ensureWorkspaceDirs(runId)
    const filePath = join(downloadDir, 'report.pdf')
    await writeFile(filePath, Buffer.from('%PDF-1.4 test download content'))

    const step: DownloadStep = {
      id: '00000000-0000-4000-8000-000000000021',
      name: '等待下载完成',
      type: 'download',
      effectType: 'SIDE_EFFECT',
      input: {
        waitMs: 5000,
      },
    }

    const { ctx } = makeContext(step)
    const commandsSent: BrowserCommand[] = []
    const executor = new BrowserStepExecutor(handle, {
      acquire: async () => ({ ok: true, grant: ctx.sessionGrant! }),
      release: async () => undefined,
      execute: async (_grant, command) => {
        commandsSent.push(command)
        return {
          ok: true,
          output: {
            downloadPath: filePath,
            fileName: 'report.pdf',
          },
        }
      },
    })

    const outcome = await executor.execute(ctx)
    expect(outcome.kind).toBe('success')
    if (outcome.kind === 'success') {
      const handle = asRunFileHandle(outcome.output)
      expect(handle).toBeDefined()
      expect(handle!.kind).toBe(RUN_FILE_HANDLE_KIND)
      expect(handle!.scope).toBe('run')
      expect(handle!.runId).toBe(runId)
      expect(handle!.name).toBe('report.pdf')
      expect(handle!.mimeType).toBe('application/pdf')
      expect(handle!.byteSize).toBe(30)
      expect(handle!.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
    }
    expect(commandsSent.length).toBe(1)
    expect(commandsSent[0]!.type).toBe('download')
  })

  it('triggers download with target click and outputs RunFileHandle', async () => {
    const { downloadDir } = await ensureWorkspaceDirs(runId)
    const filePath = join(downloadDir, 'export.csv')
    await writeFile(filePath, Buffer.from('id,name\n1,alice\n2,bob'))

    const step: DownloadStep = {
      id: '00000000-0000-4000-8000-000000000022',
      name: '点击导出按钮下载',
      type: 'download',
      effectType: 'SIDE_EFFECT',
      input: {
        target: { candidates: [{ by: 'css', value: '#export-btn' }] },
        waitMs: 10000,
      },
    }

    const { ctx } = makeContext(step)
    const commandsSent: BrowserCommand[] = []
    const executor = new BrowserStepExecutor(handle, {
      acquire: async () => ({ ok: true, grant: ctx.sessionGrant! }),
      release: async () => undefined,
      execute: async (_grant, command) => {
        commandsSent.push(command)
        return {
          ok: true,
          output: {
            downloadPath: filePath,
            fileName: 'export.csv',
          },
        }
      },
    })

    const outcome = await executor.execute(ctx)
    expect(outcome.kind).toBe('success')
    if (outcome.kind === 'success') {
      const handle = asRunFileHandle(outcome.output)
      expect(handle).toBeDefined()
      expect(handle!.name).toBe('export.csv')
      expect(handle!.mimeType).toBe('text/csv')
    }
    expect(commandsSent[0]!.type).toBe('download')
    if (commandsSent[0]!.type === 'download') {
      expect(commandsSent[0]!.target).toBeDefined()
    }
  })

  it('rejects download when file size is less than minBytes', async () => {
    const { downloadDir } = await ensureWorkspaceDirs(runId)
    const filePath = join(downloadDir, 'tiny.txt')
    await writeFile(filePath, Buffer.from('small'))

    const step: DownloadStep = {
      id: '00000000-0000-4000-8000-000000000023',
      name: '校验最小字节',
      type: 'download',
      effectType: 'SIDE_EFFECT',
      input: {
        expect: {
          minBytes: 1024,
        },
      },
    }

    const { ctx } = makeContext(step)
    const executor = new BrowserStepExecutor(handle, {
      acquire: async () => ({ ok: true, grant: ctx.sessionGrant! }),
      release: async () => undefined,
      execute: async () => ({
        ok: true,
        output: {
          downloadPath: filePath,
          fileName: 'tiny.txt',
        },
      }),
    })

    const outcome = await executor.execute(ctx)
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') {
      expect(outcome.error.code).toBe('DOWNLOAD_REJECTED')
    }
  })

  it('rejects download when file name does not match fileNamePattern', async () => {
    const { downloadDir } = await ensureWorkspaceDirs(runId)
    const filePath = join(downloadDir, 'error-page.html')
    await writeFile(filePath, Buffer.from('<html>error</html>'))

    const step: DownloadStep = {
      id: '00000000-0000-4000-8000-000000000024',
      name: '校验文件名模式',
      type: 'download',
      effectType: 'SIDE_EFFECT',
      input: {
        expect: {
          fileNamePattern: '\\.pdf$',
        },
      },
    }

    const { ctx } = makeContext(step)
    const executor = new BrowserStepExecutor(handle, {
      acquire: async () => ({ ok: true, grant: ctx.sessionGrant! }),
      release: async () => undefined,
      execute: async () => ({
        ok: true,
        output: {
          downloadPath: filePath,
          fileName: 'error-page.html',
        },
      }),
    })

    const outcome = await executor.execute(ctx)
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') {
      expect(outcome.error.code).toBe('DOWNLOAD_REJECTED')
    }
  })

  it('fails if download times out in browser', async () => {
    const step: DownloadStep = {
      id: '00000000-0000-4000-8000-000000000025',
      name: '等待超时',
      type: 'download',
      effectType: 'SIDE_EFFECT',
      input: {
        waitMs: 3000,
      },
    }

    const { ctx } = makeContext(step)
    const executor = new BrowserStepExecutor(handle, {
      acquire: async () => ({ ok: true, grant: ctx.sessionGrant! }),
      release: async () => undefined,
      execute: async () => ({
        ok: false,
        error: {
          code: 'DOWNLOAD_TIMEOUT',
          category: 'TIMEOUT',
          retryable: true,
          safeMessage: '等待下载事件超时（3000ms）',
        },
      }),
    })

    const outcome = await executor.execute(ctx)
    expect(outcome.kind).toBe('failed')
    expect(outcome.timedOut).toBe(true)
    if (outcome.kind === 'failed') {
      expect(outcome.error.code).toBe('DOWNLOAD_TIMEOUT')
    }
  })

  it('fails if download fails in browser execution', async () => {
    const step: DownloadStep = {
      id: '00000000-0000-4000-8000-000000000026',
      name: '下载失败',
      type: 'download',
      effectType: 'SIDE_EFFECT',
      input: {
        waitMs: 3000,
      },
    }

    const { ctx } = makeContext(step)
    const executor = new BrowserStepExecutor(handle, {
      acquire: async () => ({ ok: true, grant: ctx.sessionGrant! }),
      release: async () => undefined,
      execute: async () => ({
        ok: false,
        error: {
          code: 'DOWNLOAD_FAILED',
          category: 'EXECUTOR',
          retryable: true,
          safeMessage: '下载流异常终止',
        },
      }),
    })

    const outcome = await executor.execute(ctx)
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') {
      expect(outcome.error.code).toBe('DOWNLOAD_FAILED')
    }
  })

  it('rejects download when file size exceeds 32MB limit', async () => {
    const { open } = await import('node:fs/promises')
    const { downloadDir } = await ensureWorkspaceDirs(runId)
    const filePath = join(downloadDir, 'large.zip')
    const fh = await open(filePath, 'w')
    await fh.truncate(33 * 1024 * 1024)
    await fh.close()

    const step: DownloadStep = {
      id: '00000000-0000-4000-8000-000000000027',
      name: '超大文件下载',
      type: 'download',
      effectType: 'SIDE_EFFECT',
      input: {},
    }

    const { ctx } = makeContext(step)
    const executor = new BrowserStepExecutor(handle, {
      acquire: async () => ({ ok: true, grant: ctx.sessionGrant! }),
      release: async () => undefined,
      execute: async () => ({
        ok: true,
        output: {
          downloadPath: filePath,
          fileName: 'large.zip',
        },
      }),
    })

    const outcome = await executor.execute(ctx)
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') {
      expect(outcome.error.code).toBe('DOWNLOAD_TOO_LARGE')
    }
  })

  it('sanitizes unsafe download filename into clean handle name', async () => {
    const { downloadDir } = await ensureWorkspaceDirs(runId)
    const filePath = join(downloadDir, '..unsafename.pdf')
    await writeFile(filePath, Buffer.from('data'))

    const step: DownloadStep = {
      id: '00000000-0000-4000-8000-000000000028',
      name: '文件名清洗测试',
      type: 'download',
      effectType: 'SIDE_EFFECT',
      input: {},
    }

    const { ctx } = makeContext(step)
    const executor = new BrowserStepExecutor(handle, {
      acquire: async () => ({ ok: true, grant: ctx.sessionGrant! }),
      release: async () => undefined,
      execute: async () => ({
        ok: true,
        output: {
          downloadPath: filePath,
        },
      }),
    })

    const outcome = await executor.execute(ctx)
    expect(outcome.kind).toBe('success')
    if (outcome.kind === 'success') {
      const h = asRunFileHandle(outcome.output)
      expect(h).toBeDefined()
      expect(h!.name).toBe('unsafename.pdf')
    }
  })

  it('cleans up run workspace upon cleanupRunFileWorkspace', async () => {
    const { existsSync } = await import('node:fs')
    const { downloadDir } = await ensureWorkspaceDirs(runId)
    expect(existsSync(downloadDir)).toBe(true)

    await cleanupRunFileWorkspace(runId)
    expect(existsSync(downloadDir)).toBe(false)
  })
})
