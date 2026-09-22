import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  commitTargetFixtureUpload,
  consoleAccounts,
  grantAdminScope,
  openIsolatedDb,
  reserveTargetFixtureUpload,
  targets,
  type DbHandle,
} from '@cairn/db/testing'
import {
  resolveEvidencePolicy,
  RUN_FILE_HANDLE_KIND,
  type BrowserCommand,
  type BrowserCommandResult,
  type RunFileHandle,
  type RunGrant,
  type RunSnapshot,
  type SessionGrant,
  type UploadStep,
} from '@cairn/shared'
import { BrowserStepExecutor } from './browser-executor.js'
import type { BrowserPort } from './ports.js'
import type { StepExecutionContext } from './step-executor.js'

const SCHEMA = `cairn_test_${Date.now().toString(36)}_engup`

describe('BrowserStepExecutor - Upload Step', () => {
  let handle: DbHandle
  let targetId: string
  const actorId = '00000000-0000-4000-8000-000000000001'

  beforeAll(async () => {
    handle = await openIsolatedDb(SCHEMA)
    targetId = '00000000-0000-4000-8000-000000000002'
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: '测试操作员',
      email: 'actor@example.com',
      status: 'active',
    })
    await grantAdminScope(handle.db, actorId)
    await handle.db.insert(targets).values({
      id: targetId,
      code: 'upload-test-target',
      name: 'Upload Test Target',
      entryUrl: 'https://example.com',
      loginUrl: 'https://example.com/login',
      state: 'ACTIVE',
      createdByConsoleAccountId: actorId,
    })
  })

  afterAll(async () => {
    await handle.pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
  })

  async function createTestFixture(input: {
    targetId: string
    name: string
    contentType?: string
    byteSize?: number
    digest?: string
  }) {
    const validDigest = input.digest ?? `sha256:${'a'.repeat(64)}`
    const reserved = await reserveTargetFixtureUpload(
      handle.db,
      {
        targetId: input.targetId,
        name: input.name,
        contentType: input.contentType ?? 'application/pdf',
        byteSize: input.byteSize ?? 1024,
        digest: validDigest,
      },
      actorId,
    )
    await commitTargetFixtureUpload(
      handle.db,
      {
        fixtureId: reserved.fixtureId,
        generationId: reserved.generationId,
        byteSize: input.byteSize ?? 1024,
        digest: validDigest,
      },
      actorId,
    )
    return { id: reserved.fixtureId, ...input, digest: validDigest }
  }

  function makeContext(step: UploadStep, context: Record<string, any> = {}): {
    ctx: StepExecutionContext
    commandsSent: BrowserCommand[]
  } {
    const commandsSent: BrowserCommand[] = []
    const mockBrowser: BrowserPort = {
      acquire: async () => ({ ok: true, grant: sessionGrant }),
      release: async () => undefined,
      execute: async (_grant, command): Promise<BrowserCommandResult> => {
        commandsSent.push(command)
        return {
          ok: true,
          output: {
            files: (command as any).files?.map((f: any) => ({
              name: f.name,
              byteSize: f.byteSize,
              mimeType: f.mimeType,
              digest: f.digest,
            })),
            method: 'dom_direct',
            uploadedAt: new Date().toISOString(),
          },
        }
      },
    }

    const sessionGrant: SessionGrant = {
      runId: '00000000-0000-4000-8000-000000000003',
      sessionId: '00000000-0000-4000-8000-000000000004',
      leaseId: '00000000-0000-4000-8000-000000000005',
      generation: 1,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    }

    const grant: RunGrant = {
      runId: '00000000-0000-4000-8000-000000000003',
      leaseId: '00000000-0000-4000-8000-000000000005',
      workerId: 'worker-1',
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    }

    const snapshot: RunSnapshot = {
      allowedOrigins: ['https://example.com'],
      steps: [step],
    } as any

    const ctx: StepExecutionContext = {
      runId: '00000000-0000-4000-8000-000000000003',
      stepRunId: '00000000-0000-4000-8000-000000000006',
      attemptId: '00000000-0000-4000-8000-000000000007',
      targetId,
      step,
      input: step.input,
      context,
      signal: new AbortController().signal,
      clock: { now: () => 1000 },
      sessionGrant,
      grant,
      snapshot,
      evidencePolicy: resolveEvidencePolicy(),
    }

    return { ctx, commandsSent }
  }

  it('resolves asset fixture file upload command', async () => {
    const fixture = await createTestFixture({
      targetId,
      name: 'report.pdf',
      contentType: 'application/pdf',
      byteSize: 1024,
      digest: `sha256:${'a'.repeat(64)}`,
    })

    const step: UploadStep = {
      id: '00000000-0000-4000-8000-000000000011',
      name: '上传夹具文件',
      type: 'upload',
      effectType: 'SIDE_EFFECT',
      input: {
        target: { candidates: [{ by: 'css', value: '#file-input' }] },
        files: [
          {
            source: 'asset',
            fixtureId: fixture.id,
            digest: `sha256:${'a'.repeat(64)}`,
            name: 'renamed.pdf',
          },
        ],
      },
    }

    const { ctx, commandsSent } = makeContext(step)
    const executor = new BrowserStepExecutor(handle, {
      acquire: async () => ({ ok: true, grant: ctx.sessionGrant! }),
      release: async () => undefined,
      execute: async (_grant, command) => {
        commandsSent.push(command)
        return { ok: true, output: {} }
      },
    })

    const outcome = await executor.execute(ctx)
    expect(outcome.kind).toBe('success')
    expect(commandsSent.length).toBe(1)
    const cmd = commandsSent[0]!
    expect(cmd.type).toBe('upload')
    if (cmd.type === 'upload') {
      expect(cmd.files[0]!.name).toBe('renamed.pdf')
      expect(cmd.files[0]!.mimeType).toBe('application/pdf')
      expect(cmd.files[0]!.byteSize).toBe(1024)
      expect(cmd.files[0]!.digest).toBe(`sha256:${'a'.repeat(64)}`)
    }
  })

  it('fails if fixture is not found', async () => {
    const step: UploadStep = {
      id: '00000000-0000-4000-8000-000000000012',
      name: '上传不存在的夹具',
      type: 'upload',
      effectType: 'SIDE_EFFECT',
      input: {
        target: { candidates: [{ by: 'css', value: '#file-input' }] },
        files: [
          {
            source: 'asset',
            fixtureId: '00000000-0000-4000-8000-999999999999',
            digest: `sha256:${'9'.repeat(64)}`,
          },
        ],
      },
    }

    const { ctx } = makeContext(step)
    const executor = new BrowserStepExecutor(handle, {
      acquire: async () => ({ ok: true, grant: ctx.sessionGrant! }),
      release: async () => undefined,
      execute: async () => ({ ok: true, output: {} }),
    })

    const outcome = await executor.execute(ctx)
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') {
      expect(outcome.error.code).toBe('FIXTURE_NOT_FOUND')
    }
  })

  it('fails if fixture digest does not match step definition', async () => {
    const fixture = await createTestFixture({
      targetId,
      name: 'checksum.bin',
      contentType: 'application/octet-stream',
      byteSize: 10,
      digest: `sha256:${'a'.repeat(64)}`,
    })

    const step: UploadStep = {
      id: '00000000-0000-4000-8000-000000000013',
      name: '摘要不匹配夹具',
      type: 'upload',
      effectType: 'SIDE_EFFECT',
      input: {
        target: { candidates: [{ by: 'css', value: '#file-input' }] },
        files: [
          {
            source: 'asset',
            fixtureId: fixture.id,
            digest: `sha256:${'b'.repeat(64)}`,
          },
        ],
      },
    }

    const { ctx } = makeContext(step)
    const executor = new BrowserStepExecutor(handle, {
      acquire: async () => ({ ok: true, grant: ctx.sessionGrant! }),
      release: async () => undefined,
      execute: async () => ({ ok: true, output: {} }),
    })

    const outcome = await executor.execute(ctx)
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') {
      expect(outcome.error.code).toBe('FIXTURE_DIGEST_MISMATCH')
    }
  })

  it('resolves context file upload command from context variable handle', async () => {
    const step: UploadStep = {
      id: '00000000-0000-4000-8000-000000000014',
      name: '上传上下文生成的文件',
      type: 'upload',
      effectType: 'SIDE_EFFECT',
      input: {
        target: { candidates: [{ by: 'css', value: '#file-input' }] },
        files: [
          {
            source: 'context',
            from: 'generatedReport',
          },
        ],
      },
    }

    const sampleHandle: RunFileHandle = {
      kind: RUN_FILE_HANDLE_KIND,
      scope: 'run',
      runId: '00000000-0000-4000-8000-000000000003',
      objectKey: 'v1/runs/00000000-0000-4000-8000-000000000003/sample-obj',
      name: 'invoice_123.pdf',
      mimeType: 'application/pdf',
      byteSize: 2048,
      digest: `sha256:${'c'.repeat(64)}`,
      createdAt: new Date().toISOString(),
    }

    const { ctx, commandsSent } = makeContext(step, {
      generatedReport: sampleHandle,
    })

    const executor = new BrowserStepExecutor(handle, {
      acquire: async () => ({ ok: true, grant: ctx.sessionGrant! }),
      release: async () => undefined,
      execute: async (_grant, command) => {
        commandsSent.push(command)
        return { ok: true, output: {} }
      },
    })

    const outcome = await executor.execute(ctx)
    expect(outcome.kind).toBe('success')
    expect(commandsSent.length).toBe(1)
    const cmd = commandsSent[0]!
    if (cmd.type === 'upload') {
      expect(cmd.files[0]!.name).toBe('invoice_123.pdf')
      expect(cmd.files[0]!.mimeType).toBe('application/pdf')
      expect(cmd.files[0]!.byteSize).toBe(2048)
      expect(cmd.files[0]!.digest).toBe(`sha256:${'c'.repeat(64)}`)
    }
  })

  it('fails if context value is not a valid RunFileHandle', async () => {
    const step: UploadStep = {
      id: '00000000-0000-4000-8000-000000000015',
      name: '非法句柄',
      type: 'upload',
      effectType: 'SIDE_EFFECT',
      input: {
        target: { candidates: [{ by: 'css', value: '#file-input' }] },
        files: [
          {
            source: 'context',
            from: 'invalidFile',
          },
        ],
      },
    }

    const { ctx } = makeContext(step, {
      invalidFile: { name: 'raw.txt', notAHandle: true },
    })
    const executor = new BrowserStepExecutor(handle, {
      acquire: async () => ({ ok: true, grant: ctx.sessionGrant! }),
      release: async () => undefined,
      execute: async () => ({ ok: true, output: {} }),
    })

    const outcome = await executor.execute(ctx)
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') {
      expect(outcome.error.code).toBe('FILE_HANDLE_INVALID')
    }
  })

  it('fails if context handle belongs to another run', async () => {
    const step: UploadStep = {
      id: '00000000-0000-4000-8000-000000000016',
      name: '跨 Run 句柄',
      type: 'upload',
      effectType: 'SIDE_EFFECT',
      input: {
        target: { candidates: [{ by: 'css', value: '#file-input' }] },
        files: [
          {
            source: 'context',
            from: 'foreignFile',
          },
        ],
      },
    }

    const foreignHandle: RunFileHandle = {
      kind: RUN_FILE_HANDLE_KIND,
      scope: 'run',
      runId: '00000000-0000-4000-8000-888888888888', // different from ctx.runId
      objectKey: 'v1/runs/00000000-0000-4000-8000-888888888888/sample-obj',
      name: 'secret.pdf',
      mimeType: 'application/pdf',
      byteSize: 100,
      digest: `sha256:${'d'.repeat(64)}`,
      createdAt: new Date().toISOString(),
    }

    const { ctx } = makeContext(step, {
      foreignFile: foreignHandle,
    })
    const executor = new BrowserStepExecutor(handle, {
      acquire: async () => ({ ok: true, grant: ctx.sessionGrant! }),
      release: async () => undefined,
      execute: async () => ({ ok: true, output: {} }),
    })

    const outcome = await executor.execute(ctx)
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') {
      expect(outcome.error.code).toBe('FILE_HANDLE_FOREIGN_RUN')
    }
  })

  it('fails if context key does not exist', async () => {
    const step: UploadStep = {
      id: '00000000-0000-4000-8000-000000000017',
      name: '上传缺失上下文',
      type: 'upload',
      effectType: 'SIDE_EFFECT',
      input: {
        target: { candidates: [{ by: 'css', value: '#file-input' }] },
        files: [
          {
            source: 'context',
            from: 'nonExistentKey',
          },
        ],
      },
    }

    const { ctx } = makeContext(step, {})
    const executor = new BrowserStepExecutor(handle, {
      acquire: async () => ({ ok: true, grant: ctx.sessionGrant! }),
      release: async () => undefined,
      execute: async () => ({ ok: true, output: {} }),
    })

    const outcome = await executor.execute(ctx)
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') {
      expect(outcome.error.code).toBe('UNRESOLVED_REF')
    }
  })

  it('rejects uploads exceeding 64MB total size', async () => {
    const fixture = await createTestFixture({
      targetId,
      name: 'huge.iso',
      contentType: 'application/octet-stream',
      byteSize: 65 * 1024 * 1024,
      digest: `sha256:${'e'.repeat(64)}`,
    })

    const step: UploadStep = {
      id: '00000000-0000-4000-8000-000000000018',
      name: '上传超大文件',
      type: 'upload',
      effectType: 'SIDE_EFFECT',
      input: {
        target: { candidates: [{ by: 'css', value: '#file-input' }] },
        files: [
          {
            source: 'asset',
            fixtureId: fixture.id,
            digest: `sha256:${'e'.repeat(64)}`,
          },
        ],
      },
    }

    const { ctx } = makeContext(step)
    const executor = new BrowserStepExecutor(handle, {
      acquire: async () => ({ ok: true, grant: ctx.sessionGrant! }),
      release: async () => undefined,
      execute: async () => ({ ok: true, output: {} }),
    })

    const outcome = await executor.execute(ctx)
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') {
      expect(outcome.error.code).toBe('UPLOAD_PAYLOAD_TOO_LARGE')
    }
  })

  it('DC-10: resolves and downloads remote image URL from context variable before upload', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(Buffer.from('fake-image-png-binary-data'), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }) as any,
    )

    const step: UploadStep = {
      id: '00000000-0000-4000-8000-000000000019',
      name: '动态 URL 图片上传',
      type: 'upload',
      effectType: 'SIDE_EFFECT',
      input: {
        target: { candidates: [{ by: 'css', value: '#avatar-input' }] },
        files: [
          {
            source: 'context',
            from: 'remoteImageUrl',
          },
        ],
      },
    }

    const { ctx } = makeContext(step, {
      remoteImageUrl: 'https://cdn.example.com/assets/avatar.png',
    })

    const commandsSent: BrowserSurfaceCommand[] = []
    const executor = new BrowserStepExecutor(handle, {
      acquire: async () => ({ ok: true, grant: ctx.sessionGrant! }),
      release: async () => undefined,
      execute: async (_grant, cmd) => {
        commandsSent.push(cmd)
        return { ok: true, output: {} }
      },
    })

    const outcome = await executor.execute(ctx)
    expect(fetchSpy).toHaveBeenCalledWith('https://cdn.example.com/assets/avatar.png', expect.anything())
    expect(outcome.kind).toBe('success')
    expect(commandsSent.length).toBe(1)
    const cmd = commandsSent[0]!
    expect(cmd.type).toBe('upload')
    if (cmd.type === 'upload') {
      expect(cmd.files[0]!.name).toBe('avatar.png')
      expect(cmd.files[0]!.mimeType).toBe('image/png')
      expect(cmd.files[0]!.byteSize).toBe(Buffer.from('fake-image-png-binary-data').byteLength)
    }

    fetchSpy.mockRestore()
  })
})

