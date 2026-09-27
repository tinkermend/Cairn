import {
  type AssistantKnowledgeAnswerClaim,
  type AssistantKnowledgeAnswerMissing,
  type AssistantKnowledgeAnswerResult,
  type AssistantNextAction,
  normalizeAssistantPageContext,
  hasAllPermissions,
  stepRunFor,
  SCHEDULE_SKIP_REASON_METAS,
  resolveSkipReasonAction,
  type ScheduleSkipReason,
  describeAuthIssue,
  type RunListQuery,
  INCIDENT_STATUSES,
  runListQuerySchema,
} from '@cairn/shared'
import {
  DomainError,
  authorizeTargetRequest,
  getRun,
  loadRunObservation,
  getScenario,
  getSessionDto,
  getSchedule,
  listScheduleOccurrences,
  getDataset,
  readAccountSessionCap,
  findLiveSessions,
  listQueuedRunsForAccount,
  getAccountSessionDetail,
  listRuns,
  loadRunFailureSummaries,
  listIncidents,
} from '@cairn/db'
import { z } from 'zod'
import type { AssistantCapabilityHandlerContext } from '../registry.js'
import { retrieveHelpSnippets, type HelpSnippetResult } from '../help/catalog.js'
import { requireVisibleTarget } from './common.js'
import { extractStepStructureFacts } from './step-structure-facts.js'

const MAX_FACT_CHARS = 12_000
const FAILURE_DIGEST_LIMIT = 50
const FAILURE_DIGEST_INTENT_PATTERN =
  /同一个原因|同因|同样的原因|归并|失败归并|老失败|经常失败|最近.*失败|这些失败|为何老失败|多次失败|失败分析|失败聚集|失败聚类|为什么.*失败|为什么老|主要失败原因/i
const RUN_DIGEST_FILTER_SCHEMA = runListQuerySchema.omit({ limit: true, cursor: true })
const OPEN_INCIDENT_STATUSES = INCIDENT_STATUSES.filter(
  (status) => status !== 'RESOLVED' && status !== 'DISMISSED',
)

function shiftLocalDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function localToday(timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date())
  } catch {
    return new Date().toISOString().slice(0, 10)
  }
}

function formatInTimezone(iso: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(iso))
  } catch {
    return iso
  }
}

/** 解析问题里的相对日期范围，按调度时区的本地日期计算。 */
function parseScheduleDateRange(
  question: string,
  timezone: string,
): { from: string; to: string; label: string } | null {
  const today = localToday(timezone)
  if (/前天/.test(question)) {
    const day = shiftLocalDate(today, -2)
    return { from: day, to: day, label: '前天' }
  }
  if (/昨天|昨晚|昨日|昨夜/.test(question)) {
    const day = shiftLocalDate(today, -1)
    return { from: day, to: day, label: '昨天' }
  }
  if (/今天|今日|今晚|今早/.test(question)) {
    return { from: today, to: today, label: '今天' }
  }
  const days = parseRecentDays(question)
  if (days) {
    return { from: shiftLocalDate(today, -(days - 1)), to: today, label: `最近 ${days} 天` }
  }
  if (/本周|这周|这一周|这个星期/.test(question)) {
    return { from: shiftLocalDate(today, -6), to: today, label: '最近 7 天' }
  }
  return null
}

function parseRecentDays(question: string): number | null {
  const match = /(?:最近|近)\s*(\d{1,3})\s*天|(\d{1,3})\s*天内/.exec(question)
  const days = Number(match?.[1] ?? match?.[2])
  return Number.isInteger(days) && days > 0 ? Math.min(days, 90) : null
}

interface FactItem {
  citation: string
  label: string
  fact: string
}

export async function handleKnowledgeAnswer(
  ctx: AssistantCapabilityHandlerContext,
): Promise<AssistantKnowledgeAnswerResult> {
  const { actor, slots, body, session, db, targets, signal, onProgress } = ctx
  const question = (body?.question || ctx.question || '').trim()

  if (!session) {
    throw new DomainError('forbidden', 'ASSISTANT_MODEL_DISABLED', '当前未配置或未启用 AI 模型，无法提供问答服务')
  }

  await onProgress?.('loading_facts', '正在检索相关知识与上下文事实...')

  const pageContext = normalizeAssistantPageContext(body.pageContext)
  const allowedCitations = new Set<string>()
  const helpCitations = new Set<string>()
  const factItems: FactItem[] = []
  const missingList: AssistantKnowledgeAnswerMissing[] = []
  const nextActions: AssistantNextAction[] = []
  const helpNextActions: AssistantNextAction[] = []

  // 1. 检索已发布的帮助文档知识片段
  const helpSnippets = retrieveHelpSnippets(question, {
    topK: 3,
    maxChars: 500,
    permissions: actor.permissions,
  })

  for (const snippet of helpSnippets) {
    allowedCitations.add(snippet.id)
    helpCitations.add(snippet.id)
    factItems.push({
      citation: snippet.id,
      label: `官方帮助 [${snippet.title}]`,
      fact: snippet.content,
    })

    if (snippet.category === 'studio') {
      helpNextActions.push({
        kind: 'studio.step',
        label: '前往场景工作室',
        href: snippet.pageRoute,
        citations: [],
      })
    } else if (snippet.category === 'run') {
      helpNextActions.push({
        kind: 'run.review',
        label: '前往运行列表复盘',
        href: snippet.pageRoute,
        citations: [],
      })
    } else if (snippet.category === 'target' || snippet.category === 'session') {
      helpNextActions.push({
        kind: 'target.accounts',
        label: '查看目标系统与账号',
        href: snippet.pageRoute,
        citations: [],
      })
    } else if (snippet.category === 'platform') {
      helpNextActions.push({
        kind: 'platform.config',
        label: '前往平台配置',
        href: snippet.pageRoute,
        citations: [],
      })
    }
  }

  // 2. 校验与装配当前页面的实体事实（零信任：服务端重新鉴权与校验）
  if (pageContext?.view?.tab) {
    allowedCitations.add('view:tab')
    factItems.push({
      citation: 'view:tab',
      label: '当前页面视图选项卡',
      fact: `当前正在查看的标签页: ${pageContext.view.tab}`,
    })
  }

  const runId = String(pageContext?.runId ?? slots.runId ?? '')
  if (runId) {
    if (hasAllPermissions(actor.permissions, ['run:read'])) {
      try {
        await getRun(db, runId, actor.id)
        const obs = await loadRunObservation(db, runId, actor.id)
        if (obs) {
          if (obs.run.targetId) {
            await requireVisibleTarget(actor, obs.run.targetId, targets, db)
          }
          const runCitation = `run:${obs.run.id}`
          allowedCitations.add(runCitation)
          factItems.push({
            citation: runCitation,
            label: `当前运行事实 (${obs.run.id.slice(0, 8)})`,
            fact: `运行ID: ${obs.run.id}, 场景: ${obs.run.scenarioName ?? obs.run.scenarioId}, 目标系统: ${obs.run.targetName ?? obs.run.targetId}, 状态: ${obs.run.status}, 业务结果: ${obs.run.outcomeStatus}, 证据状态: ${obs.run.evidenceStatus ?? '未知'}`,
          })

          // CQ-03: 解析所选 StepRun / Attempt 细节
          const targetStepId = String(
            pageContext?.stepId ||
              (pageContext?.view?.selectedRef?.kind === 'step' || pageContext?.view?.selectedRef?.kind === 'stepRun'
                ? pageContext.view.selectedRef.id
                : ''),
          )
          let matchedStepRun = obs.run.stepRuns.find((item) => item.id === targetStepId)
            ?? stepRunFor(obs.run.stepRuns, targetStepId)

          if (matchedStepRun) {
            const stepRunCitation = `stepRun:${matchedStepRun.id}`
            allowedCitations.add(stepRunCitation)
            factItems.push({
              citation: stepRunCitation,
              label: `步骤运行 (${matchedStepRun.name})`,
              fact: `步骤运行ID: ${matchedStepRun.id}, 步骤ID: ${matchedStepRun.stepId}, 步骤名: ${matchedStepRun.name}, 状态: ${matchedStepRun.status}, 业务结果: ${matchedStepRun.outcomeStatus}, 尝试次数: ${matchedStepRun.attempts.length}${
                matchedStepRun.attempts.some((a) => a.error)
                  ? `, 最新失败原因: ${matchedStepRun.attempts.find((a) => a.error)?.error?.safeMessage || '执行异常'}`
                  : ''
              }`,
            })
          }

          if (pageContext?.view?.selectedRef?.kind === 'attempt') {
            const targetAttemptId = pageContext.view.selectedRef.id
            const foundAttempt = obs.run.stepRuns
              .flatMap((s) => s.attempts)
              .find((a) => a.id === targetAttemptId)
            if (foundAttempt) {
              const attemptCitation = `attempt:${foundAttempt.id}`
              allowedCitations.add(attemptCitation)
              factItems.push({
                citation: attemptCitation,
                label: `尝试记录 (第 ${foundAttempt.attemptNo} 次尝试)`,
                fact: `尝试ID: ${foundAttempt.id}, 尝试序号: ${foundAttempt.attemptNo}, 状态: ${foundAttempt.status}, 开始时点: ${foundAttempt.startedAt}${
                  foundAttempt.error ? `, 失败原因: ${foundAttempt.error.safeMessage}` : ''
                }`,
              })
            } else {
              missingList.push({
                key: 'attempt',
                reason: 'not_found_or_mismatch',
                description: '当前查看的 Attempt 不属于该运行或未找到对应尝试记录',
              })
            }
          }

          if (pageContext?.stepId) {
            const ev = obs.evidence.items.find(
              (item) => item.stepRunId === pageContext.stepId || item.id === pageContext.stepId || item.stepRunId === matchedStepRun?.id,
            )
            if (ev) {
              const stepCitation = `evidence:${ev.id}`
              allowedCitations.add(stepCitation)
              factItems.push({
                citation: stepCitation,
                label: `步骤证据 (${ev.type})`,
                fact: `证据ID: ${ev.id}, 类型: ${ev.type}, 状态: ${ev.status}`,
              })
            }
          }
        }
      } catch {
        missingList.push({
          key: 'run',
          reason: 'access_denied_or_not_found',
          description: '关联的运行不存在或当前账号无权访问',
        })
      }
    } else {
      missingList.push({
        key: 'run',
        reason: 'permission_denied',
        description: '缺少 run:read 权限，无法读取当前运行事实',
      })
    }
  }

  const scenarioId = String(pageContext?.scenarioId ?? slots.scenarioId ?? '')
  if (scenarioId) {
    if (hasAllPermissions(actor.permissions, ['workflow:read'])) {
      try {
        await authorizeTargetRequest(db, actor.id, { scenarioId, permissions: ['workflow:read'] })
        const scenario = await getScenario(db, scenarioId)
        await requireVisibleTarget(actor, scenario.targetId, targets, db)
        const scCitation = `scenario:${scenario.id}`
        allowedCitations.add(scCitation)
        factItems.push({
          citation: scCitation,
          label: `当前场景事实 (${scenario.name})`,
          fact: `场景名称: ${scenario.name}, 目标ID: ${scenario.targetId}, 已发布版本: ${scenario.published?.versionId ?? '未发布'}, 草稿修订号: ${scenario.draft?.revision ?? '无草稿'}`,
        })

        // CQ-04: Studio 未保存草稿安全隔离标记
        if (pageContext?.draft?.isDirty) {
          const draftNoticeCitation = `scenario:${scenario.id}:draft_status`
          allowedCitations.add(draftNoticeCitation)
          factItems.push({
            citation: draftNoticeCitation,
            label: '草稿未保存提示',
            fact: `当前画布存在未保存修改；本次解答严格基于已保存定义（草稿修订号: ${scenario.draft?.revision ?? '未知'}）。未保存内容未纳入事实依据。`,
          })
        }

        // CQ-06: 场景步骤结构化事实解析引擎 (Step Structure Fact Extractor)
        const targetStepId = String(
          pageContext?.stepId ||
            (pageContext?.view?.selectedRef?.kind === 'step' ? pageContext.view.selectedRef.id : ''),
        )
        if (targetStepId) {
          const stepFactsResult = extractStepStructureFacts(scenario, targetStepId)
          if (!stepFactsResult.found) {
            missingList.push({
              key: `step:${targetStepId}`,
              reason: 'step_not_found',
              description: `选中的步骤 ID「${targetStepId}」在当前场景中不存在`,
            })
          } else {
            for (const item of stepFactsResult.facts) {
              allowedCitations.add(item.citation)
              factItems.push(item)
            }
          }
        }
      } catch {
        missingList.push({
          key: 'scenario',
          reason: 'access_denied_or_not_found',
          description: '关联的场景不存在或当前账号无权访问',
        })
      }
    } else {
      missingList.push({
        key: 'scenario',
        reason: 'permission_denied',
        description: '缺少 workflow:read 权限，无法读取当前场景事实',
      })
    }
  }

  const targetId = String(pageContext?.targetId ?? slots.targetId ?? '')
  if (targetId) {
    if (hasAllPermissions(actor.permissions, ['target:read'])) {
      try {
        await requireVisibleTarget(actor, targetId, targets, db)
        const target = await targets.getTarget(targetId)
        const targetCitation = `target:${target.id}`
        allowedCitations.add(targetCitation)
        factItems.push({
          citation: targetCitation,
          label: `当前目标系统事实 (${target.name})`,
          fact: `目标系统: ${target.name}, 入口地址: ${target.entryUrl}, 状态: ${target.status}, 认证方式: ${target.authMethod}`,
        })
      } catch {
        missingList.push({
          key: 'target',
          reason: 'access_denied_or_not_found',
          description: '关联的目标系统不存在或当前账号无权访问',
        })
      }
    } else {
      missingList.push({
        key: 'target',
        reason: 'permission_denied',
        description: '缺少 target:read 权限，无法读取当前目标系统事实',
      })
    }
  }

  // CQ-16: 跨运行失败归并与可靠性事件背景。只在运行列表页、或未选中步骤的场景页触发，
  // 避免把其他运行的失败混进单次运行或单个步骤的问答。
  const pageKind = pageContext?.pageKind ?? pageContext?.page
  const focusedStepId =
    pageContext?.stepId ||
    (pageContext?.view?.selectedRef?.kind === 'step' ? pageContext.view.selectedRef.id : '')
  const isRunListPage = pageKind === 'run' && !runId
  const isScenarioOverview =
    (pageKind === 'studio' || pageKind === 'scenario') && Boolean(scenarioId) && !focusedStepId
  const rawRunFilters = pageContext?.view?.filters ?? {}
  const hasFailureDigestIntent = FAILURE_DIGEST_INTENT_PATTERN.test(question)
  const shouldPerformFailureDigest =
    (isRunListPage &&
      (hasFailureDigestIntent ||
        (rawRunFilters.status === 'FAILED' && /失败|报错|异常|运行|问题|怎么回事|分析|总结|为什么/i.test(question)))) ||
    (isScenarioOverview && hasFailureDigestIntent)

  if (shouldPerformFailureDigest) {
    let runQuery: RunListQuery | null = null
    if (isRunListPage) {
      // 与运行列表共用同一份查询 schema，保证助手分析的范围就是页面当前筛选出的范围
      const parsedFilters = RUN_DIGEST_FILTER_SCHEMA.safeParse(rawRunFilters)
      if (!parsedFilters.success) {
        missingList.push({
          key: 'run_filters',
          reason: 'invalid_filters',
          description: '运行列表的筛选条件无法识别，未进行失败归并',
        })
      } else if (parsedFilters.data.status && parsedFilters.data.status !== 'FAILED') {
        missingList.push({
          key: 'run_filters',
          reason: 'status_not_failed',
          description: `当前运行列表按「${parsedFilters.data.status}」状态筛选，筛选结果中没有失败运行可供归并`,
        })
      } else {
        runQuery = { ...parsedFilters.data, status: 'FAILED', limit: FAILURE_DIGEST_LIMIT }
      }
    } else {
      const days = parseRecentDays(question) ?? 7
      runQuery = {
        scenarioId,
        status: 'FAILED',
        limit: FAILURE_DIGEST_LIMIT,
        from: new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString(),
      }
    }

    if (runQuery && !hasAllPermissions(actor.permissions, ['run:read'])) {
      missingList.push({
        key: 'runs',
        reason: 'permission_denied',
        description: '缺少 run:read 权限，无法读取运行记录进行失败归并分析',
      })
    } else if (runQuery) {
      try {
        const runListResp = await listRuns(db, runQuery, actor.id)
        const runsList = runListResp.items ?? []

        if (runsList.length === 0) {
          missingList.push({
            key: 'runs',
            reason: 'no_failed_runs',
            description: '当前筛选条件与权限范围内未检索到任何失败的运行记录',
          })
        } else {
          const runIds = runsList.map((r) => r.id)
          const summaries = await loadRunFailureSummaries(db, runIds)
          const summaryMap = new Map(summaries.map((s) => [s.runId, s]))

          interface FailureCluster {
            scenarioName: string
            stepName: string
            errorDescription: string
            sampleMessage?: string
            count: number
            firstSeenAt: string
            lastSeenAt: string
            sampleRunIds: string[]
          }

          const clusterMap = new Map<string, FailureCluster>()

          for (const run of runsList) {
            const summary = summaryMap.get(run.id)
            const scName = run.scenarioName || run.scenarioId || '未知场景'
            const stName =
              summary?.stepName ||
              summary?.stepId ||
              (summary?.cancelReason ? '取消终止' : '未知步骤')
            // 只使用错误码与脱敏后的 safeMessage，原始错误信息不进入模型上下文
            const errText =
              summary?.errorCode ||
              (summary?.errorSafeMessage ? summary.errorSafeMessage.slice(0, 80).trim() : null) ||
              (summary?.cancelReason ? `运行已取消 (${summary.cancelReason})` : null) ||
              '执行失败'

            const groupKey = `${scName}::${stName}::${errText}`
            const rawTime = run.createdAt || summary?.finishedAt
            const timestamp =
              rawTime instanceof Date
                ? rawTime.toISOString()
                : typeof rawTime === 'string'
                  ? rawTime
                  : new Date().toISOString()

            let cluster = clusterMap.get(groupKey)
            if (!cluster) {
              cluster = {
                scenarioName: scName,
                stepName: stName,
                errorDescription: errText,
                sampleMessage: summary?.errorSafeMessage?.slice(0, 120).trim() || undefined,
                count: 0,
                firstSeenAt: timestamp,
                lastSeenAt: timestamp,
                sampleRunIds: [],
              }
              clusterMap.set(groupKey, cluster)
            }

            cluster.count++
            if (new Date(timestamp) < new Date(cluster.firstSeenAt)) cluster.firstSeenAt = timestamp
            if (new Date(timestamp) > new Date(cluster.lastSeenAt)) cluster.lastSeenAt = timestamp
            if (cluster.sampleRunIds.length < 3 && !cluster.sampleRunIds.includes(run.id)) {
              cluster.sampleRunIds.push(run.id)
            }
          }

          const clusters = Array.from(clusterMap.values()).sort((a, b) => b.count - a.count)
          const truncationNotice =
            runsList.length >= FAILURE_DIGEST_LIMIT
              ? `（已达单批上限 ${FAILURE_DIGEST_LIMIT} 条，仅分析最近 ${FAILURE_DIGEST_LIMIT} 次失败）`
              : ''

          const runActions: AssistantNextAction[] = []
          for (const cluster of clusters) {
            for (const sampleId of cluster.sampleRunIds) {
              allowedCitations.add(`run:${sampleId}`)
            }
            const topSampleId = cluster.sampleRunIds[0]
            if (topSampleId && runActions.length < 3) {
              runActions.push({
                kind: 'run.detail',
                label: `查看代表性失败运行 (${topSampleId.slice(0, 8)})`,
                href: `/runs/${topSampleId}`,
                citations: [`run:${topSampleId}`],
              })
            }
          }

          const topRunId = runsList[0]?.id ?? ''
          const primaryCit = `run:${topRunId}`
          allowedCitations.add(primaryCit)
          factItems.push({
            citation: primaryCit,
            label: `失败运行归并总览 (${runsList.length}条运行)`,
            fact: `共检索到 ${runsList.length} 条失败运行记录${truncationNotice}，按「场景 + 失败步骤 + 错误」确定性分组为 ${clusters.length} 组。`,
          })

          for (const cluster of clusters) {
            const repCit = `run:${cluster.sampleRunIds[0] || topRunId}`
            allowedCitations.add(repCit)
            factItems.push({
              citation: repCit,
              label: `失败聚类: ${cluster.stepName} (${cluster.count}次)`,
              fact: `场景: ${cluster.scenarioName}, 步骤: ${cluster.stepName}, 错误: ${cluster.errorDescription}${
                cluster.sampleMessage && cluster.sampleMessage !== cluster.errorDescription
                  ? `, 错误说明示例: ${cluster.sampleMessage}`
                  : ''
              }, 出现次数: ${cluster.count} 次 (最早: ${cluster.firstSeenAt}, 最近: ${cluster.lastSeenAt}), 样例运行: ${cluster.sampleRunIds.join(', ')}`,
            })
          }

          const incidentActions: AssistantNextAction[] = []
          if (hasAllPermissions(actor.permissions, ['reliability:read'])) {
            try {
              const allTargetIds = Array.from(
                new Set(runsList.map((r) => r.targetId).filter((tid): tid is string => Boolean(tid))),
              )
              for (const tid of allTargetIds.slice(0, 3)) {
                const incResp = await listIncidents(
                  db,
                  { targetId: tid, statuses: [...OPEN_INCIDENT_STATUSES], limit: 2 },
                  actor.id,
                )
                for (const inc of incResp.items ?? []) {
                  const incCit = `incident:${inc.id}`
                  allowedCitations.add(incCit)
                  factItems.push({
                    citation: incCit,
                    label: `目标可靠性事件 (${inc.id.slice(0, 8)})`,
                    fact: `关联目标系统存在未关闭的可靠性事件: ${inc.title}，严重级别: ${inc.severity}，状态: ${inc.status}，摘要: ${inc.summary}${inc.lastSeenAt ? `，最近活跃时点: ${inc.lastSeenAt}` : ''}`,
                  })
                  incidentActions.push({
                    kind: 'incident.detail',
                    label: `查看关联可靠性事件 (${inc.id.slice(0, 8)})`,
                    href: `/maintenance/incidents/${inc.id}`,
                    citations: [incCit],
                  })
                }
              }
            } catch {
              // 可靠性事件读取失败不阻断核心聚类
            }
          } else {
            missingList.push({
              key: 'reliability_incidents',
              reason: 'permission_denied',
              description: '缺少 reliability:read 权限，未读取关联目标系统的可靠性事件背景',
            })
          }

          // 结果最多展示 3 个处置入口：保证第一个是最主要失败组的运行，其后是事件，再是其余运行
          const digestActions = [
            ...runActions.slice(0, 1),
            ...incidentActions.slice(0, 1),
            ...runActions.slice(1),
            ...incidentActions.slice(1),
          ]
          nextActions.unshift(...digestActions)
        }
      } catch {
        missingList.push({
          key: 'runs',
          reason: 'access_denied_or_not_found',
          description: '检索失败运行或提取错误事实时发生异常',
        })
      }
    }
  }

  // CQ-12: Session 受管会话事实与跨账号多活实例隔离
  const sessionId = String(
    pageContext?.primaryRef?.kind === 'session'
      ? pageContext.primaryRef.id
      : pageContext?.view?.selectedRef?.kind === 'session'
        ? pageContext.view.selectedRef.id
        : slots.sessionId ?? '',
  )
  if (sessionId) {
    if (hasAllPermissions(actor.permissions, ['target:read'])) {
      try {
        await authorizeTargetRequest(db, actor.id, { sessionId, permissions: ['session:read'] })
        const sessionDto = await getSessionDto(db, sessionId)
        if (!sessionDto) {
          missingList.push({
            key: 'session',
            reason: 'not_found',
            description: '关联的受管会话不存在',
          })
        } else {
          await requireVisibleTarget(actor, sessionDto.targetId, targets, db)
          // 检查 scopeRefs 边界（防止越权或伪造其他账号的 sessionId）
          let scopeMismatch = false
          if (Array.isArray(pageContext?.scopeRefs)) {
            for (const scope of pageContext.scopeRefs) {
              if (scope.kind === 'target' && scope.id !== sessionDto.targetId) {
                scopeMismatch = true
                break
              }
              if (
                ((scope.kind as string) === 'account' || (scope.kind as string) === 'target_account') &&
                scope.id !== sessionDto.targetAccountId
              ) {
                scopeMismatch = true
                break
              }
            }
          }
          if (scopeMismatch) {
            missingList.push({
              key: 'session',
              reason: 'scope_mismatch',
              description: '会话实例与当前目标系统或账号作用域不匹配',
            })
          } else {
            const sessionCitation = `session:${sessionDto.id}`
            allowedCitations.add(sessionCitation)

            // 1. 活跃租约与占用情况
            let leaseFact = '租约持有: 空闲无租约'
            const activeLease = sessionDto.activeLease
            const legacyWorkerId = sessionDto.ownerWorkerId || (sessionDto as any).leaseOwnerWorkerId
            if (activeLease) {
              const elapsedMinutes = Math.max(
                0,
                Math.floor((Date.now() - new Date(activeLease.acquiredAt).getTime()) / 60000),
              )
              leaseFact = `租约已被占用: Worker ${activeLease.holderWorkerId}${activeLease.runId ? `，运行 ID ${activeLease.runId}` : ''}，用途 ${activeLease.purpose}，已占用约 ${elapsedMinutes} 分钟 (自 ${activeLease.acquiredAt})`
              if (activeLease.runId && hasAllPermissions(actor.permissions, ['run:read'])) {
                const runCit = `run:${activeLease.runId}`
                allowedCitations.add(runCit)
                nextActions.push({
                  kind: 'run.detail',
                  label: '查看占用该会话的运行',
                  href: `/runs/${activeLease.runId}`,
                  citations: [runCit],
                })
              }
            } else if (legacyWorkerId) {
              leaseFact = `租约持有: Worker ${legacyWorkerId}`
            }

            // 2. 最近认证错误与失败分析
            let authFact = `认证状态: ${sessionDto.authState ?? '未知'}`
            if (sessionDto.lastAuthError) {
              const issueDesc = describeAuthIssue(sessionDto.lastAuthError)
              authFact = `认证状态: ${sessionDto.authState ?? '未知'}, 最近认证失败: 错误代码 ${sessionDto.lastAuthError}${issueDesc ? ` (${issueDesc})` : ''}${sessionDto.lastAuthCheckedAt ? `，检查于 ${sessionDto.lastAuthCheckedAt}` : ''}${sessionDto.lastAuthSuccessAt ? `，上次成功认证: ${sessionDto.lastAuthSuccessAt}` : ''}`
            } else if (sessionDto.lastAuthSuccessAt) {
              authFact = `认证状态: ${sessionDto.authState ?? '未知'}，上次成功认证: ${sessionDto.lastAuthSuccessAt}`
            }

            // 3. 账号模式与并发容量
            let capFact = ''
            let liveCount = 1
            let effectiveCap = 1
            if (sessionDto.targetId && sessionDto.targetAccountId) {
              try {
                const cap = await readAccountSessionCap(db, {
                  targetId: sessionDto.targetId,
                  targetAccountId: sessionDto.targetAccountId,
                })
                effectiveCap = cap.effectiveCap
                const liveSessions = await findLiveSessions(db, {
                  targetId: sessionDto.targetId,
                  targetAccountId: sessionDto.targetAccountId,
                })
                liveCount = liveSessions.length
                capFact = `账号会话模式: ${cap.mode === 'exclusive' ? 'exclusive (独占单活)' : 'concurrent (多活并发)'}，最大有效并发实例上限: ${cap.effectiveCap}，当前活跃会话数: ${liveCount}`
              } catch {
                // 忽略配额读取异常
              }
            }

            // 4. 排队等待中的运行分析
            let queueFact = '排队运行: 当前该账号无排队等待的运行'
            if (sessionDto.targetAccountId) {
              try {
                const queuedRuns = await listQueuedRunsForAccount(db, sessionDto.targetAccountId, 5)
                if (queuedRuns.length > 0) {
                  let queueReason = '未能从现有数据确定具体原因'
                  if (activeLease) {
                    queueReason = '当前会话正被其他运行独占占用'
                  } else if (liveCount >= effectiveCap) {
                    queueReason = '账号活跃会话实例已达上限'
                  } else if (sessionDto.authState !== 'AUTHENTICATED') {
                    queueReason = '账号认证尚未就绪'
                  }
                  const runIds = queuedRuns.map((r) => r.id.slice(0, 8)).join(', ')
                  queueFact = `排队等待运行: 该账号下有 ${queuedRuns.length} 条运行排队中 (${runIds})，可能原因（根据当前占用与认证状态推断）: ${queueReason}`
                  if (hasAllPermissions(actor.permissions, ['run:read'])) {
                    for (const r of queuedRuns.slice(0, 3)) {
                      allowedCitations.add(`run:${r.id}`)
                    }
                  }
                }
              } catch {
                // 忽略排队读取异常
              }
            }

            const factParts = [
              `会话ID: ${sessionDto.id}`,
              `目标系统ID: ${sessionDto.targetId}`,
              `账号ID: ${sessionDto.targetAccountId}`,
              `状态: ${sessionDto.status}`,
              authFact,
              `健康状态: ${sessionDto.health ?? '未知'}`,
              leaseFact,
            ]
            if (capFact) factParts.push(capFact)
            if (queueFact) factParts.push(queueFact)

            factItems.push({
              citation: sessionCitation,
              label: `受管会话事实 (${sessionDto.id.slice(0, 8)})`,
              fact: factParts.join(', '),
            })

            if (sessionDto.targetId && sessionDto.targetAccountId) {
              nextActions.push({
                kind: 'target.accounts',
                label: sessionDto.authState !== 'AUTHENTICATED' ? '前往账号重新认证' : '查看当前会话与账号',
                href: `/sessions/${sessionDto.targetId}/${sessionDto.targetAccountId}`,
                citations: [sessionCitation],
              })
            }
          }
        }
      } catch {
        missingList.push({
          key: 'session',
          reason: 'access_denied_or_not_found',
          description: '关联的受管会话不存在或当前账号无权访问',
        })
      }
    } else {
      missingList.push({
        key: 'session',
        reason: 'permission_denied',
        description: '缺少 target:read 权限，无法读取当前受管会话事实',
      })
    }
  } else if (
    (pageContext?.page === 'session' || pageContext?.pageKind === 'session') &&
    (pageContext?.targetId || pageContext?.scopeRefs?.some((r) => r.kind === 'target'))
  ) {
    const targetId = String(
      pageContext?.targetId ??
        pageContext?.scopeRefs?.find((r) => r.kind === 'target')?.id ??
        slots.targetId ??
        '',
    )
    const targetAccountId = String(
      pageContext?.scopeRefs?.find((r) => r.kind === 'account' || (r.kind as string) === 'target_account')?.id ??
        (pageContext?.primaryRef?.kind === 'account' ? pageContext.primaryRef.id : undefined) ??
        slots.targetAccountId ??
        '',
    )
    if (targetId && targetAccountId) {
      if (hasAllPermissions(actor.permissions, ['target:read'])) {
        try {
          await requireVisibleTarget(actor, targetId, targets, db)
          const detail = await getAccountSessionDetail(db, { targetId, targetAccountId })
          const targetCitation = `target:${targetId}`
          allowedCitations.add(targetCitation)

          const authFact = detail.lastAuthError
            ? `最近认证失败: 错误代码 ${detail.lastAuthError} (${describeAuthIssue(detail.lastAuthError) ?? '认证异常'})`
            : `账号会话状态: ${detail.status}`
          const capFact = `有效并发实例上限: ${detail.effectiveCap}，当前活跃实例数: ${detail.liveCount}`

          let queueFact = '排队运行: 当前该账号无排队等待的运行'
          const queuedRuns = await listQueuedRunsForAccount(db, targetAccountId, 5)
          if (queuedRuns.length > 0) {
            const runIdsStr = queuedRuns.map((r) => r.id.slice(0, 8)).join(', ')
            const queueReason =
              detail.liveCount >= detail.effectiveCap
                ? '账号活跃会话实例已达上限'
                : detail.lastAuthError
                  ? '账号最近认证失败，会话尚未就绪'
                  : detail.liveCount === 0
                    ? '账号当前没有活跃的会话实例'
                    : '未能从现有数据确定具体原因'
            queueFact = `排队运行: 该账号当前有 ${queuedRuns.length} 条运行处于排队中 (${runIdsStr})，可能原因（根据实例数与认证状态推断）: ${queueReason}`
            if (hasAllPermissions(actor.permissions, ['run:read'])) {
              for (const r of queuedRuns.slice(0, 3)) {
                allowedCitations.add(`run:${r.id}`)
              }
            }
          }

          factItems.push({
            citation: targetCitation,
            label: `账号会话事实 (${detail.accountDisplayName || detail.accountUsername})`,
            fact: `目标系统: ${detail.targetName}, 账号: ${detail.accountDisplayName || detail.accountUsername}, 账号状态: ${detail.accountStatus}, ${authFact}, ${capFact}, ${queueFact}`,
          })

          nextActions.push({
            kind: 'target.accounts',
            label: '前往账号进行登录与维护',
            href: `/sessions/${targetId}/${targetAccountId}`,
            citations: [targetCitation],
          })
        } catch {
          missingList.push({
            key: 'session',
            reason: 'access_denied_or_not_found',
            description: '关联的目标账号会话不存在或当前用户无权访问',
          })
        }
      } else {
        missingList.push({
          key: 'session',
          reason: 'permission_denied',
          description: '缺少 target:read 权限，无法读取当前受管会话事实',
        })
      }
    }
  }

  // CQ-13: Schedule 调度规则事实
  const scheduleId = String(
    pageContext?.primaryRef?.kind === 'schedule'
      ? pageContext.primaryRef.id
      : pageContext?.view?.selectedRef?.kind === 'schedule'
        ? pageContext.view.selectedRef.id
        : slots.scheduleId ?? '',
  )
  if (scheduleId) {
    if (hasAllPermissions(actor.permissions, ['schedule:read'])) {
      try {
        const schedule = await getSchedule(db, scheduleId, actor.id)
        if (schedule) {
          const sId = schedule.scheduleId ?? (schedule as any).id ?? scheduleId
          const scCit = `schedule:${sId}`
          allowedCitations.add(scCit)
          factItems.push({
            citation: scCit,
            label: `调度规则事实 (${schedule.name || sId.slice(0, 8)})`,
            fact: `调度ID: ${sId}, 消费类型: ${schedule.consumerKey ?? 'scenario'}, 启用状态: ${schedule.enabled ? '已启用' : '已停用'}, 时区: ${schedule.definition?.timezone ?? '未设置'}${
              schedule.nextDueAt ? `, 下次触发时间: ${schedule.nextDueAt}` : ''
            }`,
          })

          // 触发记录：按问题中的时间范围（调度时区下的本地日期）筛选，并说明是否截断
          try {
            const timezone = schedule.definition?.timezone || 'Asia/Shanghai'
            const range = parseScheduleDateRange(question, timezone)
            const fetchLimit = range ? 60 : 20
            const occurrencesResp = await listScheduleOccurrences(db, sId, { limit: fetchLimit })
            const fetched = occurrencesResp.items ?? []
            const occurrences = range
              ? fetched.filter((item) => item.localStartDate >= range.from && item.localStartDate <= range.to)
              : fetched
            const oldestFetched = fetched.at(-1)?.localStartDate
            const truncated = Boolean(occurrencesResp.nextCursor) &&
              (!range || (oldestFetched !== undefined && oldestFetched >= range.from))
            const scopeText = range
              ? `${range.label}（${range.from} 至 ${range.to}，${timezone}）`
              : `最近 ${occurrences.length} 次`
            const truncationText = truncated
              ? range
                ? `；仅读取了最近 ${fetchLimit} 条触发记录，该时间范围内可能还有更早的记录未纳入`
                : `；仅分析最近 ${fetchLimit} 次触发，更早的记录未纳入`
              : ''

            if (occurrences.length === 0) {
              factItems.push({
                citation: scCit,
                label: '调度触发记录范围',
                fact: range
                  ? `${scopeText}内没有触发记录${truncationText}`
                  : '该调度尚无触发记录',
              })
            } else {
              let admittedCount = 0
              let skippedCount = 0
              let failedCount = 0
              const skipReasonCounts = new Map<string, number>()

              for (const item of occurrences) {
                const occCit = `occurrence:${item.occurrenceId}`
                allowedCitations.add(occCit)

                if (item.admissionStatus === 'ADMITTED') admittedCount++
                else if (item.admissionStatus === 'SKIPPED') {
                  skippedCount++
                  if (item.reason) {
                    skipReasonCounts.set(item.reason, (skipReasonCounts.get(item.reason) ?? 0) + 1)
                  }
                } else if (item.admissionStatus === 'FAILED') failedCount++

                const meta = item.reason ? SCHEDULE_SKIP_REASON_METAS[item.reason as ScheduleSkipReason] : null
                const reasonText = item.reason
                  ? `跳过原因: ${meta?.label ?? item.reason} [${item.reason}]${meta?.explanation ? ` (${meta.explanation})` : ''}`
                  : ''
                const refText = item.runId ? `, 关联运行: ${item.runId}` : item.suiteRunId ? `, 关联集合运行: ${item.suiteRunId}` : ''
                const slotText = item.windowStartUtc
                  ? `应触发时刻: ${formatInTimezone(item.windowStartUtc, timezone)}${
                      item.windowEndUtc ? ` 至 ${formatInTimezone(item.windowEndUtc, timezone)}` : ''
                    } (${timezone})`
                  : `应触发日期: ${item.localStartDate}（未记录具体时刻）`

                factItems.push({
                  citation: occCit,
                  label: `调度触发记录 (${item.localStartDate})`,
                  fact: `触发记录ID: ${item.occurrenceId}, ${slotText}, 来源: ${item.source === 'manual' ? '手动触发' : '定时触发'}, 准入状态: ${item.admissionStatus}${reasonText ? `, ${reasonText}` : ''}${refText}`,
                })
              }

              let topReason = ''
              let topReasonCount = 0
              for (const [r, count] of skipReasonCounts.entries()) {
                if (count > topReasonCount) {
                  topReasonCount = count
                  topReason = r
                }
              }
              const topMeta = topReason ? SCHEDULE_SKIP_REASON_METAS[topReason as ScheduleSkipReason] : null
              factItems.push({
                citation: scCit,
                label: '调度触发汇总统计',
                fact: `${scopeText}触发统计: 已准入 ${admittedCount} 次, 已跳过 ${skippedCount} 次, 准入失败 ${failedCount} 次${
                  topReason ? `。主要跳过原因: ${topMeta?.label ?? topReason} (${topReasonCount} 次)` : ''
                }${truncationText}`,
              })

              // 列表按生成时间倒序。只有范围内最近一条本身被跳过才给出处置入口。
              const latest = occurrences[0]
              if (latest?.admissionStatus === 'SKIPPED' && latest.reason) {
                const action = resolveSkipReasonAction(latest.reason as ScheduleSkipReason, {
                  targetId: schedule.targetId,
                  runId: latest.runId,
                  scheduleId: sId,
                })
                if (action) {
                  nextActions.push({
                    kind: action.kind,
                    label: action.label,
                    href: action.href,
                    citations: [scCit],
                  })
                }
              }
            }
          } catch {
            // occurrences 读取失败不阻断 schedule 基本事实
          }

          nextActions.push({
            kind: 'schedule.edit',
            label: '查看调度列表',
            href: '/schedules',
            citations: [scCit],
          })
        }
      } catch {
        missingList.push({
          key: 'schedule',
          reason: 'access_denied_or_not_found',
          description: '关联的调度规则不存在或当前账号无权访问',
        })
      }
    } else {
      missingList.push({
        key: 'schedule',
        reason: 'permission_denied',
        description: '缺少 schedule:read 权限，无法读取当前调度规则事实',
      })
    }
  }

  // CQ-14: Dataset 数据集与快照事实
  const datasetId = String(
    pageContext?.primaryRef?.kind === 'dataset'
      ? pageContext.primaryRef.id
      : pageContext?.view?.selectedRef?.kind === 'dataset'
        ? pageContext.view.selectedRef.id
        : slots.datasetId ?? '',
  )
  if (datasetId) {
    if (hasAllPermissions(actor.permissions, ['dataset:read'])) {
      try {
        const dataset = await getDataset(db, datasetId, actor.id)
        if (!dataset) {
          missingList.push({
            key: 'dataset',
            reason: 'not_found',
            description: '关联的数据集不存在',
          })
        } else {
          const dsCit = `dataset:${dataset.id}`
          allowedCitations.add(dsCit)
          factItems.push({
            citation: dsCit,
            label: `数据集与快照事实 (${dataset.name})`,
            fact: `数据集ID: ${dataset.id}, 名称: ${dataset.name}, 来源类型: ${dataset.sourceType}, 总行数: ${dataset.rowCount}, 导入时间: ${dataset.createdAt}, 更新时间: ${dataset.updatedAt}${
              dataset.selectedSheet ? `, 当前工作表: ${dataset.selectedSheet}` : ''
            }。注意：页内数据为快照抽样视图，不代表外部源系统全量实时数据。`,
          })
          nextActions.push({
            kind: 'platform.config',
            label: '查看数据集列表',
            href: '/datasets',
            citations: [dsCit],
          })
        }
      } catch {
        missingList.push({
          key: 'dataset',
          reason: 'access_denied_or_not_found',
          description: '关联的数据集不存在或当前账号无权访问',
        })
      }
    } else {
      missingList.push({
        key: 'dataset',
        reason: 'permission_denied',
        description: '缺少 dataset:read 权限，无法读取当前数据集事实',
      })
    }
  }

  // 3. 上下文预算控制 (ASSISTANT_MAX_FACT_CHARS = 12,000)
  let accumulatedChars = 0
  const boundedFacts: FactItem[] = []
  for (const item of factItems) {
    const itemLen = item.fact.length + item.label.length + 30
    if (accumulatedChars + itemLen > MAX_FACT_CHARS) {
      break
    }
    accumulatedChars += itemLen
    boundedFacts.push(item)
  }

  // 4. 若无任何可用知识片段与实体事实，诚实拒绝作答，不捏造事实
  if (boundedFacts.length === 0) {
    return {
      kind: 'knowledge_answer',
      summary: '在当前授权范围与知识库中未检索到与您提问相关的权威事实或帮助文档。',
      claims: [],
      missing: [
        {
          key: 'knowledge_base',
          reason: 'no_matching_facts',
          description: '未检索到与问题相关的已发布帮助片段或可访问实体事实。',
        },
        ...missingList,
      ],
      asOf: new Date().toISOString(),
    }
  }

  // 5. 模型生成有源解答
  await onProgress?.('generating', '正在基于已知事实与知识生成有源解答...')

  const llmResult = await session.completeJson(
    'knowledge_answer',
    z.strictObject({
      summary: z.string().min(1).max(2000),
      claims: z.array(
        z.strictObject({
          factKind: z.enum(['observed', 'human_confirmed', 'inferred']),
          text: z.string().min(1).max(500),
          citations: z.array(z.string()).default([]),
          premises: z.array(z.string()).optional(),
        }),
      ),
      missing: z
        .array(
          z.strictObject({
            key: z.string().min(1),
            reason: z.string().min(1),
            description: z.string().optional(),
          }),
        )
        .optional(),
    }),
    [
      {
        role: 'system',
        content: `你是识途平台的有源开放问答专家。你必须严格基于系统提供的【已知事实与知识片段】回答用户问题。
【核心规则】
1. 严禁捏造事实、推测未给出的平台数据或编造不存在的写操作指令。
2. 每一个 claim 必须附带 citations，且 citations 中的 key 必须存在于【可用引用键列表】中。
3. 对每个 claim 准确评定 factKind：
   - observed: 直接来自提供的实体状态或运行证据观测值；
   - human_confirmed: 来自已发布的官方帮助文档、规则或配置规范；
   - inferred: 基于已知前提所做的合理推断，必须在 premises 中列出依据的已知事实，并在 citations 中引用对应 key。
4. 如果用户提问涉及特定时间范围（如「昨晚」「本周」），请结合当前时间（currentTime）与触发记录中的时间进行语义匹配与聚焦；若用户询问的时间范围超出所提供触发记录的覆盖范围，必须在回答中明确说明“所查阅的历史触发记录仅包含最近 20 次，更早的记录已被截断”，严禁推测或编造未提供的历史事实。
5. 如果用户提问涉及失败运行归并、聚类分析或多次失败原因归纳：严格基于聚合事实中的分组统计（包括各分组的错误原因、步骤与发生次数）进行归纳说明，严禁臆造未给出的运行、分组或关联事件；涉及的具体分组必须引用对应的样例运行 ID（run:<id>）或关联事件 ID（incident:<id>）。如果分析的失败运行达到 50 条上限，请在回答中明确提及该结果基于最近 50 条已截断记录。
6. 如果提供的材料不足以完整回答用户的问题，必须在 missing 列表中诚实登记缺失项（key, reason, description），不能凭空臆造。
7. 保持解答专业、清晰、条理分明。`,
      },
      {
        role: 'user',
        content: JSON.stringify({
          question,
          currentTime: new Date().toISOString(),
          pageContext: pageContext
            ? {
                routeKey: pageContext.routeKey,
                pageKind: pageContext.pageKind,
              }
            : null,
          availableCitations: Array.from(allowedCitations),
          contextFacts: boundedFacts,
        }),
      },
    ],
    signal,
  )

  await onProgress?.('validating', '正在校验回答的引用真实性与一致性...')

  let summary = '基于已知事实回答如下：'
  let validatedClaims: AssistantKnowledgeAnswerClaim[] = []
  const validatedMissing: AssistantKnowledgeAnswerMissing[] = [...missingList]

  if (llmResult.ok) {
    summary = llmResult.value.summary
    for (const c of llmResult.value.claims) {
      // 过滤未知引用
      const validCitations = c.citations.filter((cit) => allowedCitations.has(cit))
      if (c.factKind === 'inferred') {
        // 推理类 claim 必须有已验证前提或有效引用，缺依据则降级过滤并记录缺口 (CQ-08 / 4.3 节)
        const hasPremises = Array.isArray(c.premises) && c.premises.length > 0
        if (validCitations.length > 0 || hasPremises) {
          validatedClaims.push({
            factKind: 'inferred',
            text: c.text,
            citations: validCitations,
            premises: c.premises,
          })
        } else {
          validatedMissing.push({
            key: 'unsupported_inference',
            reason: 'missing_premises_or_citations',
            description: `推论缺乏已知事实前提或有效引用，已被系统安全过滤: ${c.text.slice(0, 100)}`,
          })
        }
      } else {
        // 官方帮助与实体观测不能仅凭合法引用键互相冒充。
        const sourceMatches = c.factKind === 'human_confirmed'
          ? validCitations.every((citation) => helpCitations.has(citation))
          : validCitations.every((citation) => !helpCitations.has(citation))
        if (validCitations.length > 0 && sourceMatches) {
          validatedClaims.push({
            factKind: c.factKind,
            text: c.text,
            citations: validCitations,
          })
        } else if (validCitations.length > 0) {
          validatedMissing.push({
            key: 'source_kind_mismatch',
            reason: 'citation_source_mismatch',
            description: '回答中的事实类型与引用来源不一致，已略去该结论',
          })
        }
      }
    }
    if (llmResult.value.missing) {
      validatedMissing.push(...llmResult.value.missing)
    }
  } else {
    // LLM 调用失败或返回无效格式时的安全保底
    summary = '无法基于已知事实生成完整解答，以下为相关的已确认知识事实：'
    for (const fact of boundedFacts.slice(0, 3)) {
      validatedClaims.push({
        factKind: helpCitations.has(fact.citation) ? 'human_confirmed' : 'observed',
        text: `${fact.label}: ${fact.fact.slice(0, 200)}`,
        citations: [fact.citation],
      })
    }
    validatedMissing.push({
      key: 'model_inference',
      reason: 'generation_failed',
      description: '模型推理未完成或未返回合规结构',
    })
  }

  // 实体操作优先于通用帮助目录链接
  const finalNextActions = [...nextActions]
  for (const helpAction of helpNextActions) {
    if (finalNextActions.length >= 3) break
    if (!finalNextActions.some((a) => a.kind === helpAction.kind)) {
      finalNextActions.push(helpAction)
    }
  }

  await onProgress?.('persisting', '正在整理最终回答...')

  return {
    kind: 'knowledge_answer',
    summary,
    claims: validatedClaims,
    missing: validatedMissing,
    asOf: new Date().toISOString(),
    nextActions: finalNextActions.slice(0, 3),
  }
}
