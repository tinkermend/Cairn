import {
  completeAiModelCall,
  newId,
  reserveAiModelCall,
  settleAiActionTrace,
  type DbHandle,
} from '@cairn/db'
import {
  parseAiOutput,
  aiCommandSchema,
  urlAllowedByCompiledScope,
  redactErrorSurfaceText,
  type AiCommand,
  type AiExecutionConfig,
  type AiResult,
  type AiCallRoute,
  type AiCallIntent,
  type BrowserCommandEvidence,
  type CompiledAccessScope,
  type ExecutionError,
  type RunGrant,
  type SessionGrant,
} from '@cairn/shared'
import {
  authGateClosedError,
  OBJECT_MISSING_REASONS,
  requiredScreenshotRole,
  shouldCaptureEvidence,
  writeEvidenceArtifactKey,
} from '@cairn/shared'
import type { Page } from 'playwright'
import { installedCompiledScope } from '../browser/target-scope.js'
import type { BrowserSessionManager } from '../browser/session-manager.js'
import { attachObjectEvidence } from '../browser/port.js'
import type { ObjectService } from '../objects/object.service.js'
import { Logger } from '@nestjs/common'
import { ActionGate } from './midscene/action-gate.js'
import { emitAiModelCallLog } from './model-call-log.js'
import {
  createFormalMidsceneAgent,
  midsceneModelConfig,
  validateBrowserAiModelFamily,
  type FormalAgentHandle,
} from './midscene/formal-agent.js'
import { detectFabrication } from './midscene/extract.js'
import type { OpenAiLike } from './midscene/model-client.js'
import { ActionRecorder } from './midscene/action-recorder.js'
import { AI_PORT, type AiLocateResult, type AiPort } from '../engine/ports.js'
import {
  createDirectOpenAiClient,
  isAriaBranchAdmitted,
  tryAriaAssertBranch,
  tryAriaExtractBranch,
  tryAriaLocateBranch,
  type AriaBranchExecutionResult,
} from './aria-tree-branch.js'

export { AI_PORT }

const aiLogger = new Logger('AiPort')

export function createAiPort(input: {
  manager: BrowserSessionManager
  handle: DbHandle
  resolveApiKey: (config: Pick<AiExecutionConfig, 'secretRef'>) => Promise<string>
  objects?: ObjectService
}): AiPort {
  return {
    async execute(grant, command, signal, evidence) {
      command = aiCommandSchema.parse(command)
      const gate = createStepGate(input.manager, grant, signal)
      // withManagedPage 的页面范围检查失败时拿不到回调结果：单独记住未落定，否则会话会被当成健康留给下一个 Run。
      let hung = false
      const scoped = await input.manager.withManagedPage(
        grant,
        evidence,
        async (page) => {
          assertPageScope(page.url(), command, installedCompiledScope(page.context()))
          const pagesBefore = new Set(page.context().pages())
          // 阶段 B 语义树优先分支（PAS-3）：全部准入条件满足时优先尝试无图文本分析
          const admission = isAriaBranchAdmitted({
            command,
            preferAriaTree: evidence.config.preferAriaTree,
            hasSensitiveSelectors: (evidence.sensitiveSelectors?.length ?? 0) > 0,
          })

          if (admission.admitted && evidence.config.platformAi?.baseUrl && evidence.config.platformAi.model) {
            const textConfig = evidence.config.platformAi
            if (!textConfig.secretRef) {
              throw Object.assign(new Error('平台 AI 文本模型未绑定密钥，请到平台 AI 配置'), { code: 'AI_CONFIG_INVALID' })
            }
            const textBaseUrl = textConfig.baseUrl
            const textModel = textConfig.model
            const textApiKey = await input.resolveApiKey({ secretRef: textConfig.secretRef })

            const budgetClient = createBudgetClient({
              handle: input.handle,
              grant: evidence.grant,
              sessionGrant: grant,
              evidence,
              command,
              signal,
              gate,
              inner: createDirectOpenAiClient({
                baseUrl: textBaseUrl,
                apiKey: textApiKey,
              }),
              model: textModel,
              route: 'aria_text',
              intent: intentForCommand(command),
            })

            let ariaBranchResult: AriaBranchExecutionResult | undefined
            if (command.type === 'ai_assert') {
              ariaBranchResult = await tryAriaAssertBranch({
                page,
                command,
                client: budgetClient,
                modelName: textModel,
                modelFamily: textConfig?.provider ?? evidence.config.modelFamily,
                timeoutMs: textConfig?.requestTimeoutMs ?? evidence.config.requestTimeoutMs,
                signal,
              })
            } else if (command.type === 'ai_extract') {
              ariaBranchResult = await tryAriaExtractBranch({
                page,
                command,
                client: budgetClient,
                modelName: textModel,
                modelFamily: textConfig?.provider ?? evidence.config.modelFamily,
                timeoutMs: textConfig?.requestTimeoutMs ?? evidence.config.requestTimeoutMs,
                signal,
              })
            }

            if (ariaBranchResult?.handled && ariaBranchResult.result) {
              return await settleAiCommand(page, pagesBefore, command, ariaBranchResult.result)
            }

            aiLogger.log(
              `[AriaTreeBranch] 回退到视觉路径: ${redactErrorSurfaceText(ariaBranchResult?.fallbackReason ?? '未知原因')} (runId=${evidence.runId}, stepRunId=${evidence.stepRunId})`,
            )
          }

          const shouldRecord =
            command.type === 'ai_action' &&
            evidence.snapshot?.aiTaskEvidence?.actionEdge === 'record'

          const recorder =
            shouldRecord
              ? new ActionRecorder({
                  page,
                  attemptId: evidence.attemptId,
                  runId: evidence.runId,
                  stepRunId: evidence.stepRunId,
                  agentInstanceId: `agent-${newId()}`,
                  grant: evidence.grant,
                  // verifySessionLeaseForCommit 按 holderWorkerId 比对，缺了它每个动作都会被当成丢租拦下
                  sessionLease: { ...grant, holderWorkerId: evidence.grant.holderWorkerId },
                  db: input.handle,
                  runInput: evidence.runInput,
                  contextBindings: evidence.contextBindings
                    ? new Map(Object.entries(evidence.contextBindings))
                    : undefined,
                  allowedOrigins: evidence.snapshot?.allowedOrigins,
                  sensitiveSelectors: evidence.snapshot?.targetAuth?.sensitiveSelectors,
                })
              : undefined

          const apiKey = await input.resolveApiKey(evidence.config)
          await validateBrowserAiModelFamily(evidence.config.modelFamily)
          const agent = await createFormalMidsceneAgent({
            page,
            gate,
            wrapClient: (inner) =>
              createBudgetClient({
                handle: input.handle,
                grant: evidence.grant,
                sessionGrant: grant,
                evidence,
                command,
                signal,
                gate,
                inner,
                model: evidence.model,
                route: 'vision',
                intent: intentForCommand(command),
              }),
            modelConfig: midsceneModelConfig({ config: evidence.config, apiKey }),
            readonly: command.type !== 'ai_action',
            recorder,
          })
          let commandResult: any
          try {
            const result = await runCommand(agent, command, signal)
            commandResult = result
            hung = result.hung === true
            if (command.type === 'ai_action' && gate.actionsStarted > 0) input.manager.markTransientPageState(grant)
            const authFailure = await input.manager.observeInRunAuth(grant, gate.actionsStarted > 0 ? 'dispatched' : 'not_dispatched', signal)
            if (authFailure) return { ok: false, summary: authFailure.safeMessage, error: authFailure }
            if (!hung && gate.leaseLost) {
              // 丢租后 SDK 的返回值不可信（它可能吞掉被拦下的动作照样完成）：先收尾新开的页，再报结构化丢租。
              await closeUnsupportedPages(page, pagesBefore).catch(() => undefined)
              const error = leaseLostError(gate)
              return { ok: false, summary: error.safeMessage, error }
            }
            if (!hung && command.type === 'ai_action' && signal.aborted && gate.actionsStarted > 0) {
              const error = interruptedActionError()
              return { ok: false, summary: error.safeMessage, error }
            }
            return await settleAiCommand(page, pagesBefore, command, result)
          } finally {
            if (shouldRecord && evidence.step && evidence.snapshot) {
              const stepResult =
                commandResult?.ok === true
                  ? 'SUCCEEDED'
                  : signal.aborted
                    ? 'CANCELLED'
                    : hung
                      ? 'UNKNOWN'
                      : 'FAILED'
              await settleAiActionTrace(input.handle, {
                attemptId: evidence.attemptId,
                runId: evidence.runId,
                stepRunId: evidence.stepRunId,
                step: evidence.step,
                snapshot: evidence.snapshot,
                stepResult,
                errorCode: commandResult?.error?.code,
                grant: evidence.grant,
              }).catch((err) => {
                aiLogger.warn(`settleAiActionTrace failed: ${err.message}`)
              })
            }
            if (recorder) {
              recorder.destroy()
            }
            await agent.destroy().catch(() => undefined)
          }
        },
        // 抓图判据必须和取证判据是同一个，否则断言不成立时截图字节压根没被抓下来。
        (result) => evidenceFailed(command.type, result),
      )
      const failed = evidenceFailed(command.type, scoped.ok ? scoped.value : undefined)
      const captureScreenshot = shouldCaptureEvidence(evidence.screenshot ?? 'on_failure', failed)
      if (captureScreenshot) {
        for (const extra of scoped.extraShots ?? []) {
          await attachObjectEvidence({
            type: 'screenshot',
            bytes: extra.bytes,
            contentType: 'image/png',
            objects: input.objects,
            evidence,
            retainUntil: evidence.screenshotRetainUntil,
            emptyReason: OBJECT_MISSING_REASONS.captureFailed,
            artifactKey: writeEvidenceArtifactKey({
              type: 'screenshot',
              attemptId: evidence.attemptId,
              role: extra.role,
              seq: extra.seq,
            }),
            payload: {
              role: extra.role,
              viewport: evidence.screenshotViewport ?? 'full_page',
              capturedAt: extra.capturedAt ?? new Date().toISOString(),
              ...(extra.pageRef ? { pageRef: extra.pageRef } : {}),
              ...(extra.seq ? { seq: extra.seq } : {}),
              ...(extra.diagnosis ? { diagnosis: extra.diagnosis } : {}),
            },
          })
        }
      }
      const screenshotRole = scoped.faceRole ?? requiredScreenshotRole({ failed, commandType: command.type })
      const screenshot = captureScreenshot
        ? await attachObjectEvidence({
            type: 'screenshot',
            bytes: scoped.screenshotBytes,
            contentType: 'image/png',
            objects: input.objects,
            evidence,
            retainUntil: evidence.screenshotRetainUntil,
            emptyReason: OBJECT_MISSING_REASONS.captureFailed,
            artifactKey: writeEvidenceArtifactKey({
              type: 'screenshot',
              attemptId: evidence.attemptId,
              role: screenshotRole,
              seq: scoped.screenshotSeq,
            }),
            payload: {
              role: screenshotRole,
              viewport: evidence.screenshotViewport ?? 'full_page',
              capturedAt: scoped.screenshotCapturedAt ?? new Date().toISOString(),
              ...(scoped.pageRef ? { pageRef: scoped.pageRef } : {}),
              ...(scoped.screenshotSeq ? { seq: scoped.screenshotSeq } : {}),
              ...(scoped.screenshotDiagnosis ? { diagnosis: scoped.screenshotDiagnosis } : {}),
              ...(scoped.omittedBefore ? { omittedBefore: scoped.omittedBefore } : {}),
            },
          })
        : undefined
      let trace
      if (scoped.tracePath) {
        if (shouldCaptureEvidence(evidence.trace ?? 'off', failed)) {
          const { readFile, unlink } = await import('node:fs/promises')
          const bytes = await readFile(scoped.tracePath).catch(() => undefined)
          trace = await attachObjectEvidence({
            type: 'trace',
            bytes,
            contentType: 'application/zip',
            objects: input.objects,
            evidence,
            retainUntil: evidence.traceRetainUntil,
            emptyReason: OBJECT_MISSING_REASONS.captureFailed,
          })
          await unlink(scoped.tracePath).catch(() => undefined)
        } else {
          const { unlink } = await import('node:fs/promises')
          await unlink(scoped.tracePath).catch(() => undefined)
        }
      }
      if (!scoped.ok) {
        const error =
          scoped.error.code === 'SESSION_LEASE_LOST' && gate.actionsStarted > 0 ? leaseLostError(gate)
            : command.type === 'ai_action' && signal.aborted && gate.actionsStarted > 0 ? interruptedActionError() : scoped.error
        return { ok: false, hung, summary: error.safeMessage, error, screenshot, trace }
      }
      if (!scoped.value.ok && scoped.value.summary === '登录已失效，已阻止继续操作') {
        return {
          ...scoped.value,
          screenshot,
          trace,
          error: authGateClosedError(gate.actionsStarted > 0 ? 'idempotent_failed' : 'not_dispatched'),
        }
      }
      return { ...scoped.value, screenshot, trace }
    },
    async locate(grant, locateInput, signal, evidence) {
      const gate = createStepGate(input.manager, grant, signal)
      const callNs: number[] = []
      const command = {
        type: 'ai_extract',
        instruction: locateInput.prompt,
        allowedOrigins: locateInput.allowedOrigins,
        loginOrigin: locateInput.loginOrigin,
        loginPath: locateInput.loginPath,
        maxCalls: evidence.maxCalls,
        maxOutputTokens: evidence.config.maxOutputTokens,
        requestTimeoutMs: evidence.config.requestTimeoutMs,
        hangWaitMs: evidence.config.hangWaitMs,
      } as AiCommand
      const scoped = await input.manager.withManagedPage(grant, evidence, async (page) => {
        assertPageScope(page.url(), command, installedCompiledScope(page.context()))

        const requestedRoute = locateInput.route ?? 'legacy'
        // v1 保持文本优先；v2 按冻结路线逐档调用。
        const textConfig = evidence.config.platformAi
        if (requestedRoute !== 'vision') {
          if (requestedRoute === 'text' && (!textConfig?.baseUrl || !textConfig.model)) {
            return locateResultFromFailure({
              error: { code: 'AI_CONFIG_INVALID', category: 'VALIDATION', retryable: false, safeMessage: '平台 AI 文本模型未就绪，请检查地址与模型名' },
              callNs,
            })
          }
          if (textConfig?.baseUrl && textConfig.model) {
            if (!textConfig.secretRef) return locateResultFromFailure({
              error: { code: 'AI_CONFIG_INVALID', category: 'VALIDATION', retryable: false, safeMessage: '平台 AI 文本模型未绑定密钥，请到平台 AI 配置' },
              callNs,
            })
            let textApiKey: string
            try {
              textApiKey = await input.resolveApiKey({ secretRef: textConfig.secretRef })
            } catch {
              return locateResultFromFailure({
                error: { code: 'AI_CONFIG_INVALID', category: 'VALIDATION', retryable: false, safeMessage: '平台 AI 文本模型密钥不可用，请重新绑定' },
                callNs,
              })
            }
            const budgetClient = createBudgetClient({
              handle: input.handle,
              grant: evidence.grant,
              sessionGrant: grant,
              evidence,
              command,
              signal,
              gate,
              inner: createDirectOpenAiClient({
                baseUrl: textConfig.baseUrl,
                apiKey: textApiKey,
              }),
              model: textConfig.model,
              route: 'aria_text',
              intent: 'ai_locate',
              onReserved: (n) => {
                callNs.push(n)
              },
            })

            const textLocateRes = await tryAriaLocateBranch({
              page,
              prompt: locateInput.prompt,
              client: budgetClient,
              modelName: textConfig.model,
              modelFamily: textConfig.provider,
              timeoutMs: textConfig.requestTimeoutMs ?? evidence.config.requestTimeoutMs,
              signal,
            })

            if (textLocateRes.handled && textLocateRes.center && textLocateRes.candidate) {
              return {
                ok: true as const,
                route: 'text' as const,
                candidate: textLocateRes.candidate,
                center: textLocateRes.center,
                dpr: textLocateRes.dpr ?? 1,
                callNs,
              }
            }
            const cls = textLocateRes.outcomeClass ?? 'miss'
            if (cls !== 'miss' && cls !== 'ambiguous') {
              const error: ExecutionError = cls === 'budget'
                ? { code: 'AI_BUDGET_EXCEEDED', category: 'VALIDATION', retryable: false, safeMessage: '文本模型调用预算已耗尽' }
                : cls === 'hung'
                  ? { code: 'AI_HUNG', category: 'UNKNOWN', retryable: false, safeMessage: '文本模型调用超时或未落定，会话不可复用' }
                  : cls === 'cancelled'
                    ? { code: 'CANCELLED', category: 'CANCELLED', retryable: false, safeMessage: '文本模型定位已取消' }
                    : { code: 'AI_CALL_FAILED', category: 'EXECUTOR', retryable: false, safeMessage: '文本模型调用失败，请检查平台 AI 配置与服务状态' }
              if (cls === 'hung') gate.markLeaseLost()
              return { ok: false as const, route: 'text' as const, outcomeClass: cls, callNs, hung: cls === 'hung', error, summary: error.safeMessage }
            }
            aiLogger.log(`[AriaLocateBranch] 文本定位${cls === 'ambiguous' ? '不唯一' : '未命中'}: ${redactErrorSurfaceText(textLocateRes.fallbackReason ?? '未知')} (runId=${evidence.runId})`)
            if (requestedRoute === 'text') return {
              ok: false as const, route: 'text' as const, outcomeClass: cls, callNs,
              error: { code: 'AI_NOT_FOUND', category: 'EXECUTOR' as const, retryable: false, safeMessage: cls === 'ambiguous' ? '文本模型定位不唯一或目标被遮挡' : '文本模型未找到目标' },
            }
          }
        }

        if (requestedRoute === 'text' || locateInput.allowVision === false || evidence.config.visionEnabled === false) {
          return locateResultFromFailure({
            error: {
              code: 'AI_NOT_FOUND',
              category: 'EXECUTOR',
              retryable: false,
              safeMessage: '文本模型未命中，且当前解析上限或策略不允许视觉多模态定位',
            },
            summary: '文本模型未命中，且当前解析上限或策略不允许视觉多模态定位',
            callNs,
          })
        }

        // 阶段 2：视觉多模态模型兜底 (MidScene 视觉空间定位，走浏览器 AI 视觉通道)
        const apiKey = await input.resolveApiKey(evidence.config)
        await validateBrowserAiModelFamily(evidence.config.modelFamily)
        const agent = await createFormalMidsceneAgent({
          page,
          gate,
          wrapClient: (inner) =>
            createBudgetClient({
              handle: input.handle,
              grant: evidence.grant,
              sessionGrant: grant,
              evidence,
              command,
              signal,
              gate,
              inner,
              model: evidence.model,
              route: 'vision',
              intent: 'ai_locate',
              onReserved: (n) => {
                callNs.push(n)
              },
            }),
          modelConfig: midsceneModelConfig({ config: evidence.config, apiKey }),
          readonly: true,
        })
        try {
          const settled = await waitWithHang(
            agent.aiLocate(locateInput.prompt, { deepLocate: locateInput.deepLocate }),
            evidence.config.hangWaitMs,
            signal,
          )
          if (!settled.done) {
            gate.markLeaseLost()
            return locateResultFromFailure({ hung: true, callNs })
          }
          if (!settled.ok) {
            if (gate.leaseLost) {
              return locateResultFromFailure({ error: leaseLostError(gate), callNs })
            }
            return locateResultFromFailure({ error: settled.error, callNs })
          }
          if (gate.leaseLost) {
            return locateResultFromFailure({ error: leaseLostError(gate), callNs })
          }
          return { ok: true as const, route: 'vision' as const, center: settled.value.center, dpr: settled.value.dpr, callNs }
        } finally {
          await agent.destroy().catch(() => undefined)
        }
      })
      if (!scoped.ok) {
        return {
          ok: false,
          callNs,
          summary: scoped.error.safeMessage,
          error: scoped.error.code === 'SESSION_LEASE_LOST' ? leaseLostError(gate) : scoped.error,
        }
      }
      return scoped.value
    },
  }
}

function budgetError() {
  return {
    code: 'AI_BUDGET_EXCEEDED',
    category: 'VALIDATION' as const,
    retryable: false,
    safeMessage: '已超过本步骤模型调用预算',
  }
}

export function locateResultFromFailure(input: {
  hung?: boolean
  error?: unknown
  summary?: string
  callNs?: number[]
}): AiLocateResult {
  const callNs = input.callNs ?? []
  if (input.hung) {
    return {
      ok: false,
      hung: true,
      callNs,
      summary: '模型调用在超时后仍未落定',
      error: {
        code: 'AI_HUNG',
        category: 'UNKNOWN',
        retryable: false,
        safeMessage: 'AI 调用未落定，会话不可复用',
      },
    }
  }
  const raw = input.error
  const code = raw && typeof raw === 'object' && 'code' in raw ? String(raw.code) : ''
  if (code === 'AI_BUDGET_EXCEEDED' || code === 'BUDGET_EXHAUSTED') {
    return { ok: false, callNs, summary: '已超过本步骤模型调用预算', error: budgetError() }
  }
  if (code === 'SESSION_LEASE_LOST' || code === 'LEASE_LOST') {
    const error =
      raw && typeof raw === 'object' && 'safeMessage' in raw
        ? (raw as ExecutionError)
        : ({
            code: 'SESSION_LEASE_LOST',
            category: 'INFRASTRUCTURE',
            retryable: false,
            safeMessage: '会话租约已失效',
          } satisfies ExecutionError)
    return { ok: false, callNs, summary: error.safeMessage, error }
  }
  if (raw instanceof Error && raw.message.startsWith('CAIRN_READONLY')) {
    return {
      ok: false,
      callNs,
      summary: '只读 AI 步骤拒绝动作通道',
      error: {
        code: 'AI_EXECUTION_FAILED',
        category: 'VALIDATION',
        retryable: false,
        safeMessage: '只读 AI 步骤拒绝动作通道',
      },
    }
  }
  const summary =
    input.summary ??
    (raw instanceof Error ? raw.message : typeof raw === 'string' ? raw : 'AI 定位失败')
  // Midscene 在明确看不到目标时抛普通 Error。它是定位未命中，允许冻结计划进入下一档；
  // 网络、鉴权和解析异常仍作为调用故障停止，不能靠宽泛的错误文字猜测。
  const visualMiss = raw instanceof Error && /^failed to locate element:/i.test(raw.message.trim())
  if (code === 'AI_NOT_FOUND' || visualMiss) {
    return {
      ok: false,
      outcomeClass: 'miss',
      callNs,
      summary,
      error: {
        code: 'AI_NOT_FOUND',
        category: 'EXECUTOR',
        retryable: true,
        safeMessage: summary.slice(0, 512),
      },
    }
  }
  if (raw && typeof raw === 'object' && 'safeMessage' in raw && 'category' in raw && 'retryable' in raw) {
    const error = raw as ExecutionError
    return { ok: false, callNs, summary: error.safeMessage, error }
  }
  return {
    ok: false,
    callNs,
    summary,
    error: {
      code: 'AI_EXECUTION_FAILED',
      category: 'EXECUTOR',
      retryable: true,
      safeMessage: summary.slice(0, 512),
    },
  }
}

/** AI 步骤的停止条件：步骤信号（取消 / 超时）加进程内 SessionGuard 的租约状态。 */
export function createStepGate(
  manager: Pick<BrowserSessionManager, 'guard'>,
  grant: SessionGrant,
  signal: AbortSignal,
): ActionGate {
  return new ActionGate(
    signal,
    () => {
      manager.guard.assertHeld(grant.leaseId, grant)
    },
    () => {
      if ('assertAuthGate' in manager && typeof manager.assertAuthGate === 'function') {
        manager.assertAuthGate(grant.leaseId)
      }
    },
    async () => {
      if ('observeInRunAuth' in manager && typeof manager.observeInRunAuth === 'function') {
        const error = await manager.observeInRunAuth(grant, 'not_dispatched', signal)
        if (error) throw new Error('CAIRN_AUTH_GATE:action')
      }
    },
    async () => {
      if ('observeInRunAuth' in manager && typeof manager.observeInRunAuth === 'function') {
        const error = await manager.observeInRunAuth(grant, 'dispatched', signal)
        if (error) throw new Error('CAIRN_AUTH_GATE:action')
      }
    },
  )
}

/** 调用意图归因：按调用点静态判定，不解析提示词。aiAct 内部的规划与定位统一记 ai_act。 */
function intentForCommand(command: AiCommand): AiCallIntent {
  if (command.type === 'ai_action') return command.action ? 'ai_atomic' : 'ai_act'
  if (command.type === 'ai_extract') return 'ai_extract'
  return 'ai_assert'
}

function createBudgetClient(input: {
  handle: DbHandle
  grant: RunGrant
  sessionGrant: SessionGrant
  evidence: BrowserCommandEvidence & { grant: RunGrant; maxCalls: number; model?: string; config: AiExecutionConfig }
  command: AiCommand
  signal: AbortSignal
  gate: ActionGate
  inner: OpenAiLike
  onReserved?: (n: number) => void
  route?: AiCallRoute
  intent?: AiCallIntent
  model?: string
}): OpenAiLike {
  return {
    chat: {
      completions: {
        create: async (params, options) => {
          input.gate.assertAllowed('model')
          const paramModel =
            params && typeof params === 'object' && 'model' in params && typeof (params as { model?: unknown }).model === 'string'
              ? (params as { model: string }).model.trim()
              : undefined
          const actualModel = paramModel || input.model || input.evidence.model
          const actualRoute: AiCallRoute = input.route ?? 'vision'
          const reserved = await reserveAiModelCall(input.handle, {
            runId: input.evidence.runId,
            stepRunId: input.evidence.stepRunId,
            attemptId: input.evidence.attemptId,
            maxCalls: input.command.maxCalls,
            grant: input.grant,
            sessionLease: {
              ...input.sessionGrant,
              holderWorkerId: input.grant.holderWorkerId,
            },
            model: actualModel,
            route: actualRoute,
          })
          if (!reserved.ok) {
            const error = new Error(reserved.code)
            ;(error as { code?: string }).code = reserved.code
            throw error
          }
          input.onReserved?.(reserved.n)
          const started = Date.now()
          try {
            const patched =
              params && typeof params === 'object'
                ? { ...params, max_tokens: input.command.maxOutputTokens }
                : params
            const result = await input.inner.chat.completions.create(patched, {
              signal: options?.signal ?? input.signal,
            })
            const durationMs = Date.now() - started
            const inputTokens = usageOf(result, 'prompt')
            const outputTokens = usageOf(result, 'completion')
            await completeAiModelCall(input.handle, {
              evidenceId: reserved.evidenceId,
              phase: 'completed',
              model: actualModel,
              route: actualRoute,
              intent: input.intent,
              durationMs,
              inputTokens,
              outputTokens,
              cost: null,
              summary: actualRoute === 'aria_text' ? 'aria_text' : undefined,
            })
            emitAiModelCallLog(aiLogger, {
              runId: input.evidence.runId,
              stepRunId: input.evidence.stepRunId,
              attemptId: input.evidence.attemptId,
              model: actualModel,
              route: actualRoute,
              durationMs,
              phase: 'completed',
              inputTokens,
              outputTokens,
            })
            return result
          } catch (error) {
            const durationMs = Date.now() - started
            const errorCode = classifyAiCallErrorCode(error)
            await completeAiModelCall(input.handle, {
              evidenceId: reserved.evidenceId,
              phase: 'failed',
              model: actualModel,
              route: actualRoute,
              intent: input.intent,
              durationMs,
              errorCode,
              summary: actualRoute === 'aria_text' ? 'aria_text' : undefined,
            })
            emitAiModelCallLog(aiLogger, {
              runId: input.evidence.runId,
              stepRunId: input.evidence.stepRunId,
              attemptId: input.evidence.attemptId,
              model: actualModel,
              route: actualRoute,
              durationMs,
              phase: 'failed',
              errorCode,
            })
            throw error
          }
        },
      },
    },
  }
}

function usageOf(result: unknown, field: 'prompt' | 'completion'): number | null {
  if (!result || typeof result !== 'object' || !('usage' in result)) return null
  const usage = (result as { usage?: Record<string, unknown> }).usage
  const key = field === 'prompt' ? 'prompt_tokens' : 'completion_tokens'
  const value = usage?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * 把 AI 调用失败归一化成可聚合的 errorCode。限流（HTTP 429 / 常见 provider
 * 限流子码）统一归一为 RATE_LIMITED，供 monitoring 的 rateLimitHits 聚合识别；
 * 命中 provider 自带的 .code 时原样透传，其余退化为通用 AI_CALL_FAILED。
 */
export function classifyAiCallErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return 'AI_CALL_FAILED'
  const status = 'status' in error ? Number((error as { status?: unknown }).status) : undefined
  const rawCode = 'code' in error ? String((error as { code?: unknown }).code) : undefined
  if (status === 429 || rawCode === 'rate_limit_exceeded' || rawCode === 'RESOURCE_EXHAUSTED') {
    return 'RATE_LIMITED'
  }
  return rawCode ?? 'AI_CALL_FAILED'
}

async function runCommand(
  agent: FormalAgentHandle,
  command: AiCommand,
  signal: AbortSignal,
): Promise<AiResult> {
  const work = invoke(agent, command)
  const settled = await waitWithHang(work, command.hangWaitMs, signal)
  if (!settled.done) {
    agent.gate.markLeaseLost()
    return { ok: false, hung: true, summary: '模型调用在超时后仍未落定' }
  }
  if (!settled.ok) {
    const error = settled.error
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
    if (code === 'AI_BUDGET_EXCEEDED') {
      return { ok: false, hung: false, summary: '已超过本步骤模型调用预算' }
    }
    if (error instanceof Error && error.message.startsWith('CAIRN_READONLY')) {
      return { ok: false, hung: false, summary: '只读 AI 步骤拒绝动作通道' }
    }
    if (error instanceof Error && error.message.startsWith('CAIRN_AUTH_GATE')) {
      return { ok: false, hung: false, summary: '登录已失效，已阻止继续操作' }
    }
    return {
      ok: false,
      hung: false,
      summary: error instanceof Error ? error.message : 'AI 执行失败',
    }
  }
  return settled.value
}

async function invoke(agent: FormalAgentHandle, command: AiCommand): Promise<AiResult> {
  if (command.type === 'ai_action') {
    if (command.action) {
      await agent.aiAtomic(command.action)
      return { ok: true, output: { summary: '原子操作已完成' }, summary: '原子操作已完成' }
    }
    const summary = await agent.aiAct(command.instruction!)
    return { ok: true, output: { summary: summary ?? 'ok' }, summary: summary ?? '已完成' }
  }
  if (command.type === 'ai_extract') {
    const schema = command.outputSchema
    if (!schema) return { ok: false, summary: '缺少 Output Schema' }
    const raw = await agent.aiQuery(command.instruction!, schema)
    const parsed = parseAiOutput(raw, schema)
    if (!parsed.ok) return { ok: false, summary: parsed.message }
    if (schema.kind === 'list' && agent.page) {
      const pageText = await agent.page.locator('body').innerText().catch(() => '')
      const list = parsed.value as unknown[]
      for (const item of list) {
        if (typeof item === 'string') {
          if (detectFabrication(pageText, item)) {
            return { ok: false, summary: `提取项包含编造值：${item}` }
          }
        } else if (item && typeof item === 'object') {
          for (const val of Object.values(item)) {
            if (typeof val === 'string' && val.trim() !== '' && detectFabrication(pageText, val)) {
              return { ok: false, summary: `提取项包含编造值：${val}` }
            }
          }
        }
      }
    }
    return { ok: true, output: parsed.value }
  }
  const asserted = await agent.aiAssert(command.instruction!)
  const output = {
    passed: asserted.pass,
    reason: asserted.thought ?? asserted.message ?? (asserted.pass ? '条件成立' : '条件不成立'),
  }
  return { ok: true, output, summary: output.reason }
}

/**
 * 证据策略眼里的「这次尝试失败了吗」。
 *
 * ai_assert 的 passed:false 是步骤失败，但模型调用本身是成功的；只看调用结果的话
 * on_failure 永远拿不到断言不成立时的失败截图，结算又按浏览器步骤要求它，Run 会停在
 * evidence INCOMPLETE。
 */
export function evidenceFailed(type: AiCommand['type'], result: AiResult | undefined): boolean {
  if (!result || !result.ok) return true
  if (type !== 'ai_assert') return false
  const output = result.output
  if (!output || typeof output !== 'object' || Array.isArray(output)) return true
  return output.passed !== true
}

export async function waitWithHang<T>(
  work: Promise<T>,
  hangWaitMs: number,
  signal: AbortSignal,
): Promise<{ done: true; ok: true; value: T } | { done: true; ok: false; error: unknown } | { done: false }> {
  let finished = false
  const wrapped = work.then(
    (value) => {
      finished = true
      return { done: true as const, ok: true as const, value }
    },
    (error: unknown) => {
      finished = true
      return { done: true as const, ok: false as const, error }
    },
  )
  if (!signal.aborted) {
    const abort = new Promise<'aborted'>((resolve) => {
      signal.addEventListener('abort', () => resolve('aborted'), { once: true })
    })
    const first = await Promise.race([wrapped, abort])
    if (first !== 'aborted') return first
  }
  const hang = new Promise<'hang'>((resolve) => setTimeout(resolve, hangWaitMs, 'hang'))
  const second = await Promise.race([wrapped, hang])
  if (second === 'hang' && !finished) return { done: false }
  return (await wrapped) as { done: true; ok: true; value: T } | { done: true; ok: false; error: unknown }
}

export function assertPageScope(url: string, command: AiCommand, scope?: CompiledAccessScope): void {
  let origin: string
  let pathname = '/'
  try {
    const parsed = new URL(url)
    origin = parsed.origin
    pathname = parsed.pathname
  } catch {
    throw Object.assign(new Error('当前页面地址无法解析'), { code: 'AI_ORIGIN_INVALID' })
  }
  if (!command.allowedOrigins.includes(origin)) {
    throw Object.assign(new Error(`当前页面源 ${origin} 不在允许范围内`), { code: 'AI_ORIGIN_DENIED' })
  }
  if (scope && !urlAllowedByCompiledScope(url, scope)) {
    throw Object.assign(new Error(`当前页面源 ${origin} 不在允许范围内`), { code: 'AI_ORIGIN_DENIED' })
  }
  if (command.loginOrigin && origin === command.loginOrigin) {
    const loginPath = command.loginPath && command.loginPath.length > 0 ? command.loginPath : '/login'
    if (pathname === loginPath || pathname.startsWith(`${loginPath}/`)) {
      throw Object.assign(new Error('认证页面不执行 AI'), { code: 'AI_AUTH_PAGE_DENIED' })
    }
  }
}

/**
 * 丢租的结构化错误，判定只看 gate，不解析 SDK 包过一层的报错文本。
 *
 * 已放行过动作：页面上可能已经发生点击，记 UNKNOWN，副作用步骤由引擎转人工核查——
 * 与 finishAttempt 对「成功但会话租约已失效」的处置一致。没放行过动作记 INFRASTRUCTURE。
 */
export function leaseLostError(gate: ActionGate): ExecutionError {
  const acted = gate.actionsStarted > 0
  return {
    code: 'SESSION_LEASE_LOST',
    category: acted ? 'UNKNOWN' : 'INFRASTRUCTURE',
    retryable: false,
    safeMessage: acted ? '会话租约在 AI 动作开始后失效，页面上的结果未确认' : '会话租约已失效，AI 步骤未发出动作',
  }
}

export function interruptedActionError(): ExecutionError {
  return { code: 'AI_ACTION_INTERRUPTED', category: 'UNKNOWN', retryable: false, safeMessage: 'AI 动作发出后被取消或超时，页面上的结果需要核查' }
}

/**
 * 命令返回后的页面收尾。
 *
 * 未落定（hung）原样返回：Engine 随后先 invalidate 再 release，会话连同页面整体作废；
 * 这里若再做页面检查并抛错，会盖掉 hung，会话就会被当成健康的留给下一个 Run。
 */
export async function settleAiCommand(
  page: Page,
  pagesBefore: ReadonlySet<Page>,
  command: AiCommand,
  result: AiResult,
): Promise<AiResult> {
  if (result.hung) return result
  await closeUnsupportedPages(page, pagesBefore)
  assertPageScope(page.url(), command, installedCompiledScope(page.context()))
  return result
}

/** AI 步骤里新开的页不属于任何 Run，release 只关 runPages，留着会带进后续 Run：先关掉再报未支持。 */
export async function closeUnsupportedPages(page: Page, pagesBefore: ReadonlySet<Page>): Promise<void> {
  const opened = page.context().pages().filter((item) => !pagesBefore.has(item))
  if (opened.length === 0) return
  await Promise.all(opened.map((item) => item.close().catch(() => undefined)))
  throw Object.assign(new Error(`AI 打开了未支持的新窗口，已关闭 ${opened.length} 个`), {
    code: 'AI_POPUP_UNSUPPORTED',
  })
}

export type AiExecuteEvidence = BrowserCommandEvidence & {
  grant: RunGrant
  maxCalls: number
  model?: string
  config: AiExecutionConfig
}
