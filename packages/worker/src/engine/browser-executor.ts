import { createHash } from 'node:crypto'
import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { loadTargetForExecution, resolveFixtureForRun, type DbHandle } from '@cairn/db'
import {
  asRunFileHandle,
  BROWSER_STEP_TYPES,
  originsFromTargetUrls,
  readContextValue,
  retainUntilFor,
  RUN_FILE_HANDLE_KIND,
  type BrowserCommand,
  type BrowserCommandResult,
  type DownloadStep,
  type ExecutionError,
  type JsonValue,
  type ResolvedUploadFile,
  type RunFileHandle,
  type RunSnapshot,
  type Step,
  type TargetDescriptor,
  type UploadStep,
  type EvidenceMetadata,
  safeDownloadFileName,
} from '@cairn/shared'
import { MapConsumptionService } from '../map/consumption.service.js'
import type { ObjectService } from '../objects/object.service.js'
import type { AiPort, BrowserPort } from './ports.js'
import { persistResolutionDecision, resolutionError, runResolutionLadder } from './resolution-ladder.js'
import {
  ensureWorkspaceDirs,
  runFileWorkspaceDir,
  runFileWorkspaceDownloadDir,
} from './run-file-workspace.js'
import {
  UPLOAD_MAX_BYTES,
  authorizeFixtureHandle,
  authorizeRunHandle,
  mapFixtureResolveError,
  materializeAuthorizedObject,
  uploadFailure,
} from './upload-object.js'
import type {
  StepExecutionContext,
  StepExecutionOutcome,
  StepExecutor,
} from './step-executor.js'

const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

function guessMimeType(fileName: string): string {
  const ext = fileName.toLowerCase().slice(fileName.lastIndexOf('.'))
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

export class BrowserStepExecutor implements StepExecutor {
  readonly supportedTypes: readonly string[] = [...BROWSER_STEP_TYPES]

  constructor(
    private readonly handle: DbHandle,
    private readonly browser?: BrowserPort,
    private readonly ai?: AiPort,
    private readonly consumption = new MapConsumptionService(handle, browser),
    private readonly objects?: ObjectService,
  ) {}

  async execute(ctx: StepExecutionContext): Promise<StepExecutionOutcome> {
    const { step, input, signal, sessionGrant, targetId, runId, stepRunId, attemptId, evidencePolicy } = ctx

    if (!this.browser || !sessionGrant) {
      return {
        kind: 'failed',
        error: {
          code: 'BROWSER_UNAVAILABLE',
          category: 'INFRASTRUCTURE',
          retryable: true,
          safeMessage: '浏览器步骤没有可用会话',
        },
        timedOut: false,
        aborted: false,
      }
    }

    if (step.type === 'wait' && step.input.kind === 'semantic') {
      const persisted = await persistResolutionDecision(this.handle, ctx, {
        effectivePolicy: ctx.snapshot.resolution?.protocol === 'snapshot.resolution@1'
          ? (ctx.snapshot.resolution.steps[step.id] ?? 'deterministic_only') : 'deterministic_only',
        rungs: [],
        decision: 'failed',
        reasonCode: 'WAIT_KIND_UNAVAILABLE',
        evidenceRefs: [],
      })
      return {
        kind: 'failed',
        error: persisted.ok
          ? resolutionError('WAIT_KIND_UNAVAILABLE', '语义等待尚未交付，当前部署不能执行')
          : persisted.error,
        timedOut: false,
        aborted: false,
      }
    }

    const commandOutcome = await this.toBrowserCommand(step, input, targetId, ctx.snapshot, ctx)
    if (!commandOutcome.ok) {
      return {
        kind: 'failed',
        error: commandOutcome.error,
        timedOut: false,
        aborted: false,
      }
    }

    const evidence = {
      runId,
      stepRunId,
      attemptId,
      screenshot: evidencePolicy.screenshot,
      trace: evidencePolicy.trace,
      screenshotRetainUntil: retainUntilFor('screenshot', evidencePolicy).toISOString(),
      traceRetainUntil: retainUntilFor('trace', evidencePolicy).toISOString(),
      commandType: commandOutcome.command.type,
      screenshotViewport: evidencePolicy.screenshotViewport,
      sensitiveSelectors: ctx.snapshot.targetAuth?.sensitiveSelectors ?? [],
    }

    if (step.type === 'download') {
      const rawResult = await this.browser.execute(
        sessionGrant,
        commandOutcome.command,
        signal,
        { ...evidence, commandType: 'download' },
      )

      if (!rawResult.ok) {
        return {
          kind: 'failed',
          error: rawResult.error,
          timedOut: rawResult.error.category === 'TIMEOUT',
          aborted: rawResult.error.code === 'CANCELLED',
          diagnostics: rawResult.diagnostics,
          screenshot: rawResult.screenshot,
          trace: rawResult.trace,
        }
      }

      return this.handleDownloadOutcome(ctx, step, rawResult)
    }

    if (step.type === 'probe') {
      const rawResult = await this.browser.execute(
        sessionGrant,
        commandOutcome.command,
        signal,
        { ...evidence, commandType: 'probe' },
      )

      if (!rawResult.ok) {
        return {
          kind: 'failed',
          error: rawResult.error,
          timedOut: rawResult.error.category === 'TIMEOUT',
          aborted: rawResult.error.code === 'CANCELLED',
          diagnostics: rawResult.diagnostics,
          screenshot: rawResult.screenshot,
          trace: rawResult.trace,
        }
      }

      return {
        kind: 'success',
        output: rawResult.output,
        screenshot: rawResult.screenshot,
        trace: rawResult.trace,
      }
    }

    return runResolutionLadder({
      handle: this.handle,
      ctx,
      step,
      command: commandOutcome.command,
      browser: this.browser,
      ai: this.ai,
      consumption: this.consumption,
      execute: (command) => this.browser!.execute(sessionGrant, command, signal, { ...evidence, commandType: command.type }),
    })
  }

  private async handleDownloadOutcome(
    ctx: StepExecutionContext,
    step: DownloadStep,
    rawResult: BrowserCommandResult & { downloadPath?: string },
  ): Promise<StepExecutionOutcome> {
    const downloadPath = rawResult.downloadPath ?? (rawResult.output as any)?.downloadPath
    if (!downloadPath) {
      return {
        kind: 'failed',
        error: {
          code: 'DOWNLOAD_FAILED',
          category: 'EXECUTOR',
          retryable: true,
          safeMessage: '下载完成但未获取到本地落盘路径',
        },
        diagnostics: rawResult.diagnostics,
        screenshot: rawResult.screenshot,
        trace: rawResult.trace,
        timedOut: false,
        aborted: false,
      }
    }

    try {
      const fileStat = await stat(downloadPath)
      const rawFileName = basename(downloadPath).replace(/^[a-f0-9-]+-/, '')
      const fileName = safeDownloadFileName(rawFileName)

      // 1. expect 校验
      const input = ctx.input
      const expect =
        input && typeof input === 'object' && !Array.isArray(input) && 'expect' in input && (input as any).expect !== undefined
          ? (input as any).expect
          : step.input.expect
      if (expect) {
        const { fileNamePattern, minBytes } = expect
        if (minBytes !== undefined && fileStat.size < minBytes) {
          await rm(downloadPath, { force: true }).catch(() => undefined)
          return {
            kind: 'failed',
            error: {
              code: 'DOWNLOAD_REJECTED',
              category: 'VALIDATION',
              retryable: false,
              safeMessage: `下载文件大小 ${fileStat.size} 字节低于期望的 ${minBytes} 字节`,
            },
            diagnostics: rawResult.diagnostics,
            screenshot: rawResult.screenshot,
            trace: rawResult.trace,
            timedOut: false,
            aborted: false,
          }
        }
        if (fileNamePattern) {
          const regex = new RegExp(fileNamePattern)
          if (!regex.test(fileName)) {
            await rm(downloadPath, { force: true }).catch(() => undefined)
            return {
              kind: 'failed',
              error: {
                code: 'DOWNLOAD_REJECTED',
                category: 'VALIDATION',
                retryable: false,
                safeMessage: `下载文件名「${fileName}」不匹配模式「${fileNamePattern}」`,
              },
              diagnostics: rawResult.diagnostics,
              screenshot: rawResult.screenshot,
              trace: rawResult.trace,
              timedOut: false,
              aborted: false,
            }
          }
        }
      }

      // 2. 超过 CAIRN_OBJECT_MAX_BYTES（默认 32MB）限制校验
      if (fileStat.size > 32 * 1024 * 1024) {
        await rm(downloadPath, { force: true }).catch(() => undefined)
        return {
          kind: 'failed',
          error: {
            code: 'DOWNLOAD_TOO_LARGE',
            category: 'VALIDATION',
            retryable: false,
            safeMessage: `下载文件大小 ${fileStat.size} 超过单对象大小上限`,
          },
          diagnostics: rawResult.diagnostics,
          screenshot: rawResult.screenshot,
          trace: rawResult.trace,
          timedOut: false,
          aborted: false,
        }
      }

      // 3. 落证据与存储
      const contentType = guessMimeType(fileName)
      let meta: EvidenceMetadata | undefined
      if (this.objects) {
        meta = await this.objects.putObjectEvidence({
          type: 'file',
          runId: ctx.runId,
          stepRunId: ctx.stepRunId,
          attemptId: ctx.attemptId,
          artifactKey: `download:${ctx.attemptId}`,
          filePath: downloadPath,
          contentType,
        })
        if (meta.status === 'missing') {
          await rm(downloadPath, { force: true }).catch(() => undefined)
          return {
            kind: 'failed',
            error: {
              code: meta.missingReason === 'file_too_large' ? 'DOWNLOAD_TOO_LARGE' : 'FILE_OBJECT_UNAVAILABLE',
              category: meta.missingReason === 'file_too_large' ? 'VALIDATION' : 'INFRASTRUCTURE',
              retryable: meta.missingReason !== 'file_too_large',
              safeMessage: `保存下载文件失败: ${meta.missingReason}`,
            },
            diagnostics: rawResult.diagnostics,
            screenshot: rawResult.screenshot,
            trace: rawResult.trace,
            timedOut: false,
            aborted: false,
          }
        }
      }

      const fileBytes = await readFile(downloadPath)
      const digest = `sha256:${createHash('sha256').update(fileBytes).digest('hex')}`
      const handle: RunFileHandle = {
        kind: RUN_FILE_HANDLE_KIND,
        scope: 'run',
        runId: ctx.runId,
        objectKey: meta?.objectKey ?? `v1/runs/${ctx.runId}/${ctx.attemptId}`,
        name: fileName,
        mimeType: contentType,
        byteSize: fileStat.size,
        digest: meta?.digest ?? digest,
        createdAt: typeof meta?.createdAt === 'string' ? meta.createdAt : meta?.createdAt ? (meta.createdAt as any).toISOString() : new Date().toISOString(),
      }

      return {
        kind: 'success',
        output: handle,
        screenshot: rawResult.screenshot,
        trace: rawResult.trace,
      }
    } catch (err) {
      return {
        kind: 'failed',
        error: {
          code: 'DOWNLOAD_FAILED',
          category: 'EXECUTOR',
          retryable: true,
          safeMessage: `处理下载文件失败: ${err instanceof Error ? err.message : String(err)}`,
        },
        diagnostics: rawResult.diagnostics,
        screenshot: rawResult.screenshot,
        trace: rawResult.trace,
        timedOut: false,
        aborted: false,
      }
    }
  }

  private async toBrowserCommand(
    step: Step,
    input: JsonValue,
    targetId: string,
    snapshot: RunSnapshot,
    ctx?: StepExecutionContext,
  ): Promise<{ ok: true; command: BrowserCommand } | { ok: false; error: ExecutionError }> {
    if (step.type === 'navigate') {
      const url =
        input && typeof input === 'object' && !Array.isArray(input) && typeof input.url === 'string'
          ? input.url
          : step.input.url
      const allowedOrigins = await this.loadAllowedOrigins(targetId, snapshot)
      if (allowedOrigins.length === 0) {
        return {
          ok: false,
          error: {
            code: 'SESSION_TARGET_MISSING',
            category: 'VALIDATION',
            retryable: false,
            safeMessage: 'Target 没有可用入口，无法校验导航范围',
          },
        }
      }
      return { ok: true, command: { type: 'navigate', url, allowedOrigins } }
    }

    if (step.type === 'click') {
      const target = descriptorFrom(input) ?? step.input.target
      const pageAfter =
        input && typeof input === 'object' && !Array.isArray(input) && (input.pageAfter === 'same' || input.pageAfter === 'popup')
          ? input.pageAfter
          : step.input.pageAfter
      const extras =
        input && typeof input === 'object' && !Array.isArray(input) ? input : step.input
      return {
        ok: true,
        command: {
          type: 'click',
          target,
          ...(pageAfter ? { pageAfter } : {}),
          ...('button' in extras && extras.button ? { button: extras.button as 'left' | 'right' | 'middle' } : {}),
          ...('clickCount' in extras && extras.clickCount ? { clickCount: extras.clickCount as 1 | 2 } : {}),
          ...('modifiers' in extras && Array.isArray(extras.modifiers) && extras.modifiers.length
            ? { modifiers: extras.modifiers as Array<'Alt' | 'Control' | 'Meta' | 'Shift'> }
            : {}),
        },
      }
    }

    if (step.type === 'fill') {
      const target = descriptorFrom(input) ?? step.input.target
      const value =
        input && typeof input === 'object' && !Array.isArray(input) && typeof input.value === 'string'
          ? input.value
          : step.input.value!
      return { ok: true, command: { type: 'fill', target, value } }
    }

    if (step.type === 'extract') {
      const target = descriptorFrom(input) ?? step.input.target
      const many =
        input && typeof input === 'object' && !Array.isArray(input) && 'many' in input && (input as any).many
          ? (input as any).many
          : step.input.many
      return {
        ok: true,
        command: {
          type: 'extract',
          target,
          as: step.input.as,
          ...(step.input.attribute ? { attribute: step.input.attribute } : {}),
          ...(many ? { many } : {}),
        },
      }
    }

    if (step.type === 'assert') {
      const target = descriptorFrom(input) ?? step.input.target
      const expect =
        input && typeof input === 'object' && !Array.isArray(input) && 'expect' in input && (input as any).expect !== undefined
          ? (input as any).expect
          : step.input.expect
      return {
        ok: true,
        command: {
          type: 'assert',
          ...(target ? { target } : {}),
          expect,
        },
      }
    }

    if (step.type === 'select') {
      const target = descriptorFrom(input) ?? step.input.target
      const value =
        input && typeof input === 'object' && !Array.isArray(input) && typeof input.value === 'string'
          ? input.value
          : step.input.value
      return {
        ok: true,
        command: {
          type: 'select',
          target,
          by: step.input.by,
          ...(value !== undefined ? { value } : {}),
          ...(step.input.index !== undefined ? { index: step.input.index } : {}),
        },
      }
    }

    if (step.type === 'keyboard') {
      return {
        ok: true,
        command: {
          type: 'keyboard',
          ...(step.input.target || descriptorFrom(input)
            ? { target: descriptorFrom(input) ?? step.input.target }
            : {}),
          keys: step.input.keys,
        },
      }
    }

    if (step.type === 'wait') {
      if (step.input.kind === 'semantic') {
        return {
          ok: false,
          error: resolutionError('WAIT_KIND_UNAVAILABLE', '语义等待尚未交付，当前部署不能执行'),
        }
      }
      const target = descriptorFrom(input) ?? step.input.target
      return {
        ok: true,
        command: {
          type: 'wait',
          kind: step.input.kind,
          ...(target ? { target } : {}),
          ...(step.input.urlPattern ? { urlPattern: step.input.urlPattern } : {}),
          ...(step.input.text ? { text: step.input.text } : {}),
          ...(step.input.durationMs !== undefined ? { durationMs: step.input.durationMs } : {}),
          ...(step.input.timeoutMs !== undefined ? { timeoutMs: step.input.timeoutMs } : {}),
        },
      }
    }

    if (step.type === 'download') {
      const saveDir = runFileWorkspaceDownloadDir(ctx?.runId ?? 'test-run')
      return {
        ok: true,
        command: {
          type: 'download',
          ...(step.input.target || descriptorFrom(input)
            ? { target: descriptorFrom(input) ?? step.input.target }
            : {}),
          waitMs: step.input.waitMs ?? 30_000,
          saveDir,
          ...(step.input.expect ? { expect: step.input.expect } : {}),
        },
      }
    }

    if (step.type === 'probe') {
      const target = descriptorFrom(input) ?? (step.input.kind === 'element' ? step.input.target : (step.input.kind === 'text' ? step.input.target : undefined))
      return {
        ok: true,
        command: {
          type: 'probe',
          probeKind: step.input.kind,
          ...(target ? { target } : {}),
          ...(step.input.kind === 'element' ? { state: step.input.state ?? 'visible' } : {}),
          ...(step.input.kind === 'text' ? { text: step.input.text } : {}),
          ...(step.input.kind === 'url' ? { urlPattern: step.input.urlPattern } : {}),
          waitMs: step.input.waitMs ?? 1000,
        },
      }
    }

    if (step.type === 'upload') {
      const target = descriptorFrom(input) ?? step.input.target
      const filesConfig =
        input && typeof input === 'object' && !Array.isArray(input) && 'files' in input && Array.isArray((input as any).files)
          ? (input as any).files
          : step.input.files
      const resolvedFiles: ResolvedUploadFile[] = []
      let totalBytes = 0

      const runId = ctx?.runId ?? 'test-run'
      const { fixtureDir, contextDir } = await ensureWorkspaceDirs(runId)

      for (const item of filesConfig) {
        if (item.source === 'asset') {
          const fixtureId = item.fixtureId ?? item.assetId
          if (!fixtureId) {
            return {
              ok: false,
              error: {
                code: 'FIXTURE_NOT_FOUND',
                category: 'VALIDATION',
                retryable: false,
                safeMessage: '未指定 fixtureId',
              },
            }
          }

          let fixtureHandle: RunFileHandle
          try {
            fixtureHandle = await resolveFixtureForRun(this.handle, {
              fixtureId,
              targetId,
              digest: item.digest,
            })
          } catch (err) {
            return mapFixtureResolveError(err, fixtureId)
          }

          const cleanName = safeDownloadFileName(item.name ?? fixtureHandle.name)
          const localPath = join(fixtureDir, `${fixtureId}-${cleanName}`)
          const materialized = await materializeAuthorizedObject({
            objects: this.objects,
            blob: {
              objectKey: fixtureHandle.objectKey,
              byteSize: fixtureHandle.byteSize,
              digest: fixtureHandle.digest,
              mimeType: fixtureHandle.mimeType,
              name: cleanName,
            },
            localPath,
            downloadDir: runFileWorkspaceDownloadDir(runId),
            cleanName,
            maxBytes: UPLOAD_MAX_BYTES - totalBytes,
          })
          if (!materialized.ok) return materialized
          totalBytes += fixtureHandle.byteSize
          resolvedFiles.push({
            localPath: materialized.localPath,
            name: cleanName,
            mimeType: fixtureHandle.mimeType,
            digest: fixtureHandle.digest,
            byteSize: fixtureHandle.byteSize,
          })
        } else if (item.source === 'context') {
          let handle: RunFileHandle | undefined = item.handle
          const fromKey = item.from ?? item.contextKey
          if (!handle) {
            if (!fromKey) {
              return {
                ok: false,
                error: {
                  code: 'FILE_HANDLE_INVALID',
                  category: 'VALIDATION',
                  retryable: false,
                  safeMessage: '未指定 context 变量名',
                },
              }
            }
            const resolved = ctx
              ? readContextValue(ctx.context as Record<string, JsonValue>, fromKey, item.fromField)
              : undefined
            if (!resolved || !resolved.ok) {
              return {
                ok: false,
                error: {
                  code: resolved ? resolved.code : 'UNRESOLVED_REF',
                  category: 'VALIDATION',
                  retryable: false,
                  safeMessage: resolved ? resolved.message : `context 中未找到 ${fromKey}`,
                },
              }
            }
            handle = asRunFileHandle(resolved.value)
            if (!handle) {
              let remoteUrl: string | undefined
              if (typeof resolved.value === 'string' && (resolved.value.startsWith('http://') || resolved.value.startsWith('https://'))) {
                remoteUrl = resolved.value
              } else if (resolved.value && typeof resolved.value === 'object' && !Array.isArray(resolved.value)) {
                const obj = resolved.value as Record<string, unknown>
                if (typeof obj.url === 'string' && (obj.url.startsWith('http://') || obj.url.startsWith('https://'))) {
                  remoteUrl = obj.url
                } else if (typeof obj.downloadUrl === 'string' && (obj.downloadUrl.startsWith('http://') || obj.downloadUrl.startsWith('https://'))) {
                  remoteUrl = obj.downloadUrl
                }
              }

              if (remoteUrl) {
                try {
                  const fetchRes = await fetch(remoteUrl, { signal: AbortSignal.timeout(15000) })
                  if (!fetchRes.ok) {
                    return {
                      ok: false,
                      error: {
                        code: 'DOWNLOAD_FAILED',
                        category: 'INFRASTRUCTURE',
                        retryable: true,
                        safeMessage: `下载动态文件 URL 失败：HTTP ${fetchRes.status} ${fetchRes.statusText}`,
                      },
                    }
                  }
                  const arrayBuf = await fetchRes.arrayBuffer()
                  const buf = Buffer.from(arrayBuf)
                  const digest = createHash('sha256').update(buf).digest('hex')
                  let fileName = item.name
                  if (!fileName) {
                    try {
                      const parsedUrl = new URL(remoteUrl)
                      fileName = parsedUrl.pathname.split('/').filter(Boolean).pop()
                    } catch {}
                  }
                  const cleanName = safeDownloadFileName(fileName || `${fromKey}.dat`)
                  let mimeType = 'application/octet-stream'
                  const headerType = fetchRes.headers.get('content-type')
                  if (headerType) {
                    const parsed = headerType.split(';')[0]?.trim()
                    if (parsed) mimeType = parsed
                  }

                  const localPath = join(contextDir, `${digest.slice(0, 8)}-${cleanName}`)
                  if (buf.byteLength > UPLOAD_MAX_BYTES - totalBytes) {
                    return uploadFailure(
                      'UPLOAD_PAYLOAD_TOO_LARGE',
                      'VALIDATION',
                      false,
                      `上传文件总大小 ${totalBytes + buf.byteLength} 超过 64MB 限制`,
                    )
                  }
                  await writeFile(localPath, buf)
                  totalBytes += buf.byteLength
                  resolvedFiles.push({
                    localPath,
                    name: cleanName,
                    mimeType,
                    digest,
                    byteSize: buf.byteLength,
                  })
                  continue
                } catch (err: unknown) {
                  return {
                    ok: false,
                    error: {
                      code: 'DOWNLOAD_FAILED',
                      category: 'INFRASTRUCTURE',
                      retryable: true,
                      safeMessage: `下载动态文件 URL 异常：${err instanceof Error ? err.message : String(err)}`,
                    },
                  }
                }
              }
            }
          }

          if (!handle) {
            return {
              ok: false,
              error: {
                code: 'FILE_HANDLE_INVALID',
                category: 'VALIDATION',
                retryable: false,
                safeMessage: `从上下文「${fromKey}」解析的文件句柄无效`,
              },
            }
          }

          const runScoped = Boolean(ctx?.runId)
          const authorized = handle.scope === 'fixture'
            ? await authorizeFixtureHandle(this.handle, { targetId, file: handle })
            : runScoped
              ? await authorizeRunHandle(this.handle, { runId: ctx!.runId, file: handle })
              : uploadFailure('FILE_HANDLE_INVALID', 'VALIDATION', false, '当前步骤没有 Run，不能解析文件句柄')
          if (!authorized.ok) return authorized

          const cleanName = safeDownloadFileName(item.name ?? authorized.blob.name)
          const localPath = handle.scope === 'fixture' && handle.fixtureId
            ? join(fixtureDir, `${handle.fixtureId}-${cleanName}`)
            : join(contextDir, `${authorized.blob.digest.slice(0, 8)}-${cleanName}`)
          const materialized = await materializeAuthorizedObject({
            objects: this.objects,
            blob: authorized.blob,
            localPath,
            downloadDir: runFileWorkspaceDownloadDir(runId),
            cleanName,
            maxBytes: UPLOAD_MAX_BYTES - totalBytes,
          })
          if (!materialized.ok) return materialized
          totalBytes += authorized.blob.byteSize
          resolvedFiles.push({
            localPath: materialized.localPath,
            name: cleanName,
            mimeType: authorized.blob.mimeType,
            digest: authorized.blob.digest,
            byteSize: authorized.blob.byteSize,
          })
        }
      }

      if (totalBytes > UPLOAD_MAX_BYTES) {
        return {
          ok: false,
          error: {
            code: 'UPLOAD_PAYLOAD_TOO_LARGE',
            category: 'VALIDATION',
            retryable: false,
            safeMessage: `上传文件总大小 ${totalBytes} 超过 64MB 限制`,
          },
        }
      }

      return {
        ok: true,
        command: {
          type: 'upload',
          target,
          files: resolvedFiles,
        },
      }
    }

    return {
      ok: false,
      error: {
        code: 'BROWSER_CAPABILITY_MISSING',
        category: 'EXECUTOR',
        retryable: false,
        safeMessage: `不支持的浏览器步骤：${step.type}`,
      },
    }
  }

  private async loadAllowedOrigins(targetId: string, snapshot: RunSnapshot): Promise<string[]> {
    if (snapshot.allowedOrigins?.length) return snapshot.allowedOrigins
    const row = await loadTargetForExecution(this.handle, targetId)
    if (!row) return []
    return originsFromTargetUrls(row.entryUrl, row.loginUrl)
  }
}

function descriptorFrom(input: JsonValue): TargetDescriptor | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !('target' in input)) return undefined
  return input.target as TargetDescriptor
}
