import {
  DEMONSTRATION_ADAPTER_VERSION,
  DEMONSTRATION_PROTOCOL,
  DEMONSTRATION_REDACTION_VERSION,
  demonstrationSourceSchema,
  type AiTaskEvent,
  type DemonstrationFact,
  type DemonstrationObservation,
  type DemonstrationSource,
} from '@cairn/shared'

export interface AiTraceToDemonstrationSourceInput {
  attemptId: string
  runId: string
  stepRunId: string
  targetId: string
  scenarioId: string
  stepId: string
  stepName?: string
  instruction?: string
  events: AiTaskEvent[]
  sdkVersion?: string
  capturedAt?: string
}

/**
 * 将 AI 动作事实转换为统一示教来源（DemonstrationSource）。
 * 纯函数，不接触外部网络或浏览器，严格符合 SSOT。
 */
export function aiTraceToDemonstrationSource(
  input: AiTraceToDemonstrationSourceInput,
): DemonstrationSource {
  // 按序号升序排列，只处理 completed 事件（包含派发前点检与动作后页面观察与耗时）
  const completedEvents = input.events
    .filter((e) => e.phase === 'completed')
    .sort((a, b) => a.ordinal - b.ordinal)

  // 若无 completed 事件但有 prepared（如超时拦截前），取每个序号最新的事件
  const effectiveEvents: AiTaskEvent[] = []
  if (completedEvents.length > 0) {
    effectiveEvents.push(...completedEvents)
  } else {
    const byOrdinal = new Map<number, AiTaskEvent>()
    for (const e of input.events) {
      byOrdinal.set(e.ordinal, e)
    }
    effectiveEvents.push(...[...byOrdinal.values()].sort((a, b) => a.ordinal - b.ordinal))
  }

  const facts: DemonstrationFact[] = effectiveEvents.map((event, index) => {
    let action = event.actionName
    let mode: 'replace' | 'type_only' | 'clear' | undefined = 'replace'
    let clickCount: 1 | 2 | undefined = 1
    let button: 'left' | 'right' | 'middle' | undefined = 'left'

    if (action === 'Tap' || action === 'click') {
      action = 'click'
    } else if (action === 'DoubleClick') {
      action = 'click'
      clickCount = 2
    } else if (action === 'RightClick') {
      action = 'click'
      button = 'right'
    } else if (action === 'Input' || action === 'fill') {
      action = 'fill'
      if ((event.paramsSummary as any)?.mode === 'type_only') {
        mode = 'type_only'
      }
    } else if (action === 'ClearInput') {
      action = 'fill'
      mode = 'clear'
    } else if (action === 'KeyboardPress' || action === 'keyboard' || action === 'press') {
      action = 'keyboard'
    } else if (action === 'Sleep' || action === 'sleep') {
      action = 'sleep'
    } else if (action === 'Navigate' || action === 'navigate') {
      action = 'navigate'
    }

    // 目标描述符：绑定成功且有已验证候选时组装
    const target =
      event.binding.status === 'bound' && event.binding.candidates.length > 0
        ? {
            framePath: [],
            candidates: event.binding.candidates,
            semantic: event.elementDescription ?? undefined,
            ...(event.binding.anchor ? { anchor: event.binding.anchor } : {}),
          }
        : undefined

    // 值来源分类
    let factValue: DemonstrationFact['data']['value']
    if (event.valueProvenance.kind === 'input' || event.valueProvenance.kind === 'context') {
      factValue = {
        state: 'reference',
        from: event.valueProvenance.source || '',
      }
    } else if (event.valueProvenance.kind === 'literal') {
      factValue = {
        state: 'literal',
        text: event.valueProvenance.value ?? '',
      }
    } else if (event.valueProvenance.kind === 'redacted') {
      factValue = {
        state: 'redacted',
        reason: '敏感目标，未存入明文',
      }
    } else if (event.valueProvenance.kind === 'ambiguous') {
      factValue = {
        state: 'redacted',
        reason: `匹配多个可能来源: ${event.valueProvenance.source ?? '未知'}`,
      }
    }

    const beforeObs: DemonstrationObservation = {
      status: 'captured',
      observedAt: event.pageBefore?.timestamp,
      url: event.pageBefore?.url,
      readyState: (event.pageBefore?.readyState as any) ?? 'complete',
      documentEpoch:
        event.pageBefore?.documentEpoch !== undefined
          ? String(event.pageBefore.documentEpoch)
          : undefined,
    }

    const afterObs: DemonstrationObservation = event.pageAfter
      ? {
          status: 'captured',
          observedAt: event.pageAfter.timestamp,
          url: event.pageAfter.url,
          readyState: (event.pageAfter.readyState as any) ?? 'complete',
          documentEpoch:
            event.pageAfter.documentEpoch !== undefined
              ? String(event.pageAfter.documentEpoch)
              : undefined,
        }
      : {
          status: 'omitted',
          reason: '动作未采集后置观察',
        }

    const keyName =
      (event.paramsSummary as any)?.keyName ??
      (event.paramsSummary as any)?.key ??
      undefined

    const durationMs =
      (event.paramsSummary as any)?.durationMs ??
      event.durationMs ??
      undefined

    const url =
      (event.paramsSummary as any)?.url ??
      (action === 'navigate' ? event.pageBefore?.url : undefined)

    const diagnostics: string[] = []
    if (event.binding.status === 'unbound' && event.binding.reason) {
      diagnostics.push(`未绑定候选原因: ${event.binding.reason}`)
    }
    if (event.binding.dataDependent) {
      diagnostics.push('目标依赖特定数据或行锚点，建议在试跑中复核稳定性')
    }

    return {
      id: `fact-${event.ordinal}`,
      sourceIds: [event.id || `evt-${event.ordinal}`],
      sequence: index,
      kind: 'action' as const,
      action,
      pageId: null,
      documentEpoch:
        event.pageBefore?.documentEpoch !== undefined
          ? String(event.pageBefore.documentEpoch)
          : null,
      framePath: null,
      observedAt: event.pageBefore?.timestamp,
      timestampPrecision: 'millisecond' as const,
      semanticSource: 'recorderAI' as const,
      data: {
        instruction: input.instruction,
        targetDescription: event.elementDescription ?? undefined,
        target,
        value: factValue,
        mode,
        clickCount,
        button,
        key: keyName,
        durationMs: typeof durationMs === 'number' ? durationMs : undefined,
        url,
      },
      before: beforeObs,
      after: afterObs,
      diagnostics,
    }
  })

  const sourceData = {
    protocolVersion: DEMONSTRATION_PROTOCOL,
    captureId: input.attemptId,
    targetId: input.targetId,
    sourceKind: 'interaction_trace' as const,
    channel: 'run' as const,
    producerKind: 'cairn_run' as const,
    actorKind: 'ai' as const,
    authorship: 'ai' as const,
    importProfile: 'cairn-ai-trace@1' as const,
    producerVersion: input.sdkVersion ?? '1.12.6',
    detectedShape: 'cairn-ai-trace',
    adapterVersion: DEMONSTRATION_ADAPTER_VERSION,
    redactionVersion: DEMONSTRATION_REDACTION_VERSION,
    capturedAt:
      input.capturedAt ??
      effectiveEvents[0]?.timestamp ??
      input.events[0]?.timestamp ??
      '1970-01-01T00:00:00.000Z',
    facts,
    omittedConfig: [],
    assetManifest: [],
  }

  return demonstrationSourceSchema.parse(sourceData)
}
