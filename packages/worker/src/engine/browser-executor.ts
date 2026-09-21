import { loadTargetForExecution, type DbHandle } from '@cairn/db'
import {
  BROWSER_STEP_TYPES,
  originsFromTargetUrls,
  retainUntilFor,
  type BrowserCommand,
  type ExecutionError,
  type JsonValue,
  type RunSnapshot,
  type Step,
  type TargetDescriptor,
} from '@cairn/shared'
import { MapConsumptionService } from '../map/consumption.service.js'
import type { AiPort, BrowserPort } from './ports.js'
import { persistResolutionDecision, resolutionError, runResolutionLadder } from './resolution-ladder.js'
import type {
  StepExecutionContext,
  StepExecutionOutcome,
  StepExecutor,
} from './step-executor.js'

export class BrowserStepExecutor implements StepExecutor {
  readonly supportedTypes: readonly string[] = [...BROWSER_STEP_TYPES]

  constructor(
    private readonly handle: DbHandle,
    private readonly browser?: BrowserPort,
    private readonly ai?: AiPort,
    private readonly consumption = new MapConsumptionService(handle, browser),
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
        effectivePolicy: ctx.snapshot.resolution?.steps[step.id] ?? 'deterministic_only',
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

    const commandOutcome = await this.toBrowserCommand(step, input, targetId, ctx.snapshot)
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

  private async toBrowserCommand(
    step: Step,
    input: JsonValue,
    targetId: string,
    snapshot: RunSnapshot,
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
            ? { modifiers: extras.modifiers as ('Alt' | 'Control' | 'Meta' | 'Shift')[] }
            : {}),
        },
      }
    }

    if (step.type === 'fill') {
      const target = descriptorFrom(input) ?? step.input.target
      const value =
        input && typeof input === 'object' && !Array.isArray(input) && typeof input.value === 'string'
          ? input.value
          : ''
      return { ok: true, command: { type: 'fill', target, value } }
    }

    if (step.type === 'extract') {
      return {
        ok: true,
        command: {
          type: 'extract',
          target: descriptorFrom(input) ?? step.input.target,
          as: step.input.as,
          attribute: step.input.attribute,
        },
      }
    }

    if (step.type === 'assert') {
      return {
        ok: true,
        command: {
          type: 'assert',
          target: descriptorFrom(input) ?? step.input.target,
          expect: step.input.expect,
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

