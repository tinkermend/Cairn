import {
  completeAiModelCall,
  reserveAiModelCall,
  type DbHandle,
} from '@cairn/db'
import {
  parseAiOutput,
  type AiCommand,
  type AiExecutionConfig,
  type AiResult,
  type BrowserCommandEvidence,
  type RunGrant,
  type SessionGrant,
} from '@cairn/shared'
import { OBJECT_MISSING_REASONS, shouldCaptureEvidence } from '@cairn/shared'
import type { BrowserSessionManager } from '../browser/session-manager.js'
import { attachObjectEvidence } from '../browser/port.js'
import type { ObjectService } from '../objects/object.service.js'
import { ActionGate } from './midscene/action-gate.js'
import {
  createFormalMidsceneAgent,
  midsceneModelConfig,
  validateBrowserAiModelFamily,
  type FormalAgentHandle,
} from './midscene/formal-agent.js'
import type { OpenAiLike } from './midscene/model-client.js'
import { AI_PORT, type AiPort } from '../engine/ports.js'

export { AI_PORT }

export function createAiPort(input: {
  manager: BrowserSessionManager
  handle: DbHandle
  resolveApiKey: (config: AiExecutionConfig) => Promise<string>
  objects?: ObjectService
}): AiPort {
  return {
    async execute(grant, command, signal, evidence) {
      const gate = new ActionGate(signal)
      const scoped = await input.manager.withManagedPage(
        grant,
        evidence,
        async (page) => {
          assertPageScope(page.url(), command)
          const pagesBefore = page.context().pages().length
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
              }),
            modelConfig: midsceneModelConfig({ config: evidence.config, apiKey }),
            readonly: command.type !== 'ai_action',
          })
          try {
            const result = await runCommand(agent, command, signal)
            assertPageScope(page.url(), command)
            if (page.context().pages().length > pagesBefore) {
              throw Object.assign(new Error('AI 打开了未支持的新窗口'), { code: 'AI_POPUP_UNSUPPORTED' })
            }
            return result
          } finally {
            await agent.destroy().catch(() => undefined)
          }
        },
        // 抓图判据必须和取证判据是同一个，否则断言不成立时截图字节压根没被抓下来。
        (result) => evidenceFailed(command.type, result),
      )
      const failed = evidenceFailed(command.type, scoped.ok ? scoped.value : undefined)
      const screenshot = shouldCaptureEvidence(evidence.screenshot ?? 'on_failure', failed)
        ? await attachObjectEvidence({
            type: 'screenshot',
            bytes: scoped.screenshotBytes,
            contentType: 'image/png',
            objects: input.objects,
            evidence,
            retainUntil: evidence.screenshotRetainUntil,
            emptyReason: OBJECT_MISSING_REASONS.captureFailed,
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
        return { ok: false, hung: false, summary: scoped.error.safeMessage, screenshot, trace }
      }
      return { ...scoped.value, screenshot, trace }
    },
  }
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
}): OpenAiLike {
  return {
    chat: {
      completions: {
        create: async (params, options) => {
          input.gate.assertAllowed('model')
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
            model: input.evidence.model,
          })
          if (!reserved.ok) {
            const error = new Error(reserved.code)
            ;(error as { code?: string }).code = reserved.code
            throw error
          }
          const started = Date.now()
          try {
            const patched =
              params && typeof params === 'object'
                ? { ...params, max_tokens: input.command.maxOutputTokens }
                : params
            const result = await input.inner.chat.completions.create(patched, {
              signal: options?.signal ?? input.signal,
            })
            await completeAiModelCall(input.handle, {
              evidenceId: reserved.evidenceId,
              phase: 'completed',
              model: input.evidence.model,
              durationMs: Date.now() - started,
              inputTokens: usageOf(result, 'prompt'),
              outputTokens: usageOf(result, 'completion'),
              cost: null,
            })
            return result
          } catch (error) {
            await completeAiModelCall(input.handle, {
              evidenceId: reserved.evidenceId,
              phase: 'failed',
              model: input.evidence.model,
              durationMs: Date.now() - started,
              errorCode: error && typeof error === 'object' && 'code' in error ? String(error.code) : 'AI_CALL_FAILED',
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
    const summary = await agent.aiAct(command.instruction)
    return { ok: true, output: { summary: summary ?? 'ok' }, summary: summary ?? '已完成' }
  }
  if (command.type === 'ai_extract') {
    const schema = command.outputSchema
    if (!schema) return { ok: false, summary: '缺少 Output Schema' }
    const parsed = parseAiOutput(await agent.aiQuery(command.instruction, schema), schema)
    if (!parsed.ok) return { ok: false, summary: parsed.message }
    return { ok: true, output: parsed.value }
  }
  const asserted = await agent.aiAssert(command.instruction)
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

export function assertPageScope(url: string, command: AiCommand): void {
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
  if (command.loginOrigin && origin === command.loginOrigin) {
    const loginPath = command.loginPath && command.loginPath.length > 0 ? command.loginPath : '/login'
    if (pathname === loginPath || pathname.startsWith(`${loginPath}/`)) {
      throw Object.assign(new Error('认证页面不执行 AI'), { code: 'AI_AUTH_PAGE_DENIED' })
    }
  }
}

export type AiExecuteEvidence = BrowserCommandEvidence & {
  grant: RunGrant
  maxCalls: number
  model?: string
  config: AiExecutionConfig
}
