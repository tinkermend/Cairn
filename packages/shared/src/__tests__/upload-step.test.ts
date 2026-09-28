import { describe, expect, it } from 'vitest'
import {
  stepSchema,
  browserCommandSchema,
  asRunFileHandle,
  runFileHandleSchema,
  fixtureObjectKeyFor,
  type DownloadStep,
  type UploadStep,
  type BrowserCommand,
} from '../index.js'

describe('Browser File Transfer (Download / Upload / Handle) Schemas', () => {
  const baseTarget = {
    framePath: [], candidates: [{ by: 'css' as const, value: '#uploader' }],
  }

  const validSha256 = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

  it('validates run file handle schema and helper', () => {
    const runHandle = {
      kind: 'cairn.file/v1',
      scope: 'run',
      runId: '00000000-0000-4000-8000-000000000001',
      objectKey: 'v1/runs/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002',
      name: 'report.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      byteSize: 1024,
      digest: validSha256,
      createdAt: new Date().toISOString(),
    }
    expect(asRunFileHandle(runHandle)).toBeTruthy()
    expect(runFileHandleSchema.safeParse(runHandle).success).toBe(true)

    // Rejects run handle without runId
    const missingRunId = { ...runHandle, runId: undefined }
    expect(runFileHandleSchema.safeParse(missingRunId).success).toBe(false)

    // Rejects fixture handle without fixtureId
    const fixtureHandle = {
      ...runHandle,
      scope: 'fixture',
      runId: undefined,
      fixtureId: '00000000-0000-4000-8000-000000000003',
      objectKey: fixtureObjectKeyFor('00000000-0000-4000-8000-000000000003'),
    }
    expect(asRunFileHandle(fixtureHandle)).toBeTruthy()
    expect(runFileHandleSchema.safeParse(fixtureHandle).success).toBe(true)
  })

  it('validates download step schema', () => {
    const raw = {
      id: '00000000-0000-4000-8000-000000000010',
      name: '下载销售报表',
      type: 'download',
      effectType: 'SIDE_EFFECT',
      outputKey: 'salesReport',
      input: {
        target: baseTarget,
        waitMs: 30_000,
        expect: {
          fileNamePattern: '^sales_.*\\.xlsx$',
          minBytes: 100,
        },
      },
    }

    const parsed = stepSchema.safeParse(raw)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.type).toBe('download')
      const step = parsed.data as DownloadStep
      expect(step.input.expect?.minBytes).toBe(100)
    }
  })

  it('validates upload step with asset and context sources, rejects inline source', () => {
    const raw = {
      id: '00000000-0000-4000-8000-000000000020',
      name: '上传发票与导出报表',
      type: 'upload',
      effectType: 'SIDE_EFFECT',
      input: {
        target: baseTarget,
        files: [
          {
            source: 'asset',
            fixtureId: '00000000-0000-4000-8000-000000000002',
            digest: validSha256,
            name: 'custom_name.pdf',
          },
          {
            source: 'context',
            from: 'salesReport',
            fromField: 'file',
          },
        ],
      },
    }

    const parsed = stepSchema.safeParse(raw)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.type).toBe('upload')
      const step = parsed.data as UploadStep
      expect(step.input.files).toHaveLength(2)
      expect(step.input.files[0]?.source).toBe('asset')
      expect(step.input.files[1]?.source).toBe('context')
    }

    // Rejects inline source
    const rawInline = {
      id: '00000000-0000-4000-8000-000000000021',
      name: '非法内联',
      type: 'upload',
      effectType: 'SIDE_EFFECT',
      input: {
        target: baseTarget,
        files: [
          {
            source: 'inline',
            name: 'a.txt',
            mimeType: 'text/plain',
            contentBase64: 'SGVsbG8=',
          },
        ],
      },
    }
    expect(stepSchema.safeParse(rawInline).success).toBe(false)
  })

  it('validates browserCommandSchema for download and upload', () => {
    const downloadCmd: BrowserCommand = {
      type: 'download',
      target: baseTarget,
      waitMs: 30_000,
      saveDir: '/tmp/cairn-runfiles-test',
      expect: {
        fileNamePattern: '\\.xlsx$',
      },
    }
    expect(browserCommandSchema.safeParse(downloadCmd).success).toBe(true)

    const uploadCmd: BrowserCommand = {
      type: 'upload',
      target: baseTarget,
      files: [
        {
          localPath: '/tmp/cairn-runfiles-test/invoice.pdf',
          name: 'invoice.pdf',
          mimeType: 'application/pdf',
          digest: validSha256,
          byteSize: 2048,
        },
      ],
    }
    expect(browserCommandSchema.safeParse(uploadCmd).success).toBe(true)
  })
})
