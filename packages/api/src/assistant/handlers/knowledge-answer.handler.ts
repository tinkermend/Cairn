import {
  type AssistantKnowledgeAnswerClaim,
  type AssistantKnowledgeAnswerMissing,
  type AssistantKnowledgeAnswerResult,
  type AssistantNextAction,
  ASSISTANT_CAPABILITIES,
  availableAssistantCapabilities,
  normalizeAssistantPageContext,
  hasAllPermissions,
  isScenarioRunResultQuestion,
  isScenarioFailureDigestQuestion,
  stepRunFor,
  SCHEDULE_SKIP_REASON_METAS,
  resolveSkipReasonAction,
  type ScheduleSkipReason,
  describeAuthIssue,
  type RunListQuery,
  type RunStatus,
  type OutcomeStatus,
  runListQuerySchema,
} from '@cairn/shared'
import {
  DomainError,
  assertTargetPermission,
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
  listAccountSessionOverview,
  loadAccountAuthDisplay,
  listRuns,
  loadRunFailureSummaries,
} from '@cairn/db'
import { z } from 'zod'
import type { AssistantCapabilityHandlerContext } from '../registry.js'
import { effectiveHelpCatalog, retrieveHelpSnippets, type HelpSnippetResult, type PublishedHelpItem } from '../help/catalog.js'
import { requireVisibleTarget } from './common.js'
import { extractStepStructureFacts } from './step-structure-facts.js'

const MAX_FACT_CHARS = 12_000
const FAILURE_DIGEST_LIMIT = 50
const FAILURE_DIGEST_INTENT_PATTERN =
  /同一个原因|同因|同样的原因|归并|失败归并|老失败|经常失败|最近.*失败|这些失败|为何老失败|多次失败|失败分析|失败聚集|失败聚类|为什么.*失败|为什么老|主要失败原因/i
const TARGET_ACCOUNT_HEALTH_INTENT_PATTERN =
  /(?:账号|账户).*(?:健康|认证|会话|租约)|(?:健康|认证|租约).*(?:账号|账户)/i
const TARGET_REALTIME_CPU_INTENT_PATTERN =
  /(?:(?:cpu|处理器).*(?:利用率|使用率|占用率|负载|多少)|(?:利用率|使用率|占用率|负载).*(?:cpu|处理器)|(?:现在|当前|实时).*(?:cpu|处理器))/i
const ACCOUNT_SESSION_STATE_QUESTION = /(?:这个|当前|该)账号.*(?:能用|等登录|等待登录)/
function isAccountAuthSuccessQuestion(question: string): boolean {
  return /(?:最近|上次|最后).{0,30}(?:认证|登录)/.test(question) &&
    /成功|通过/.test(question)
}
const TARGET_CONFIG_STATUS_QUESTION = /目标系统.{0,12}(?:什么状态|状态是什么|是否启用|是不是启用|是否停用|是不是停用)/
export const NAMED_TARGET_SCOPE_CITATION = 'platform:named_target_scope'
export const NAMED_TARGET_ACCOUNT_RUN_CITATION = 'platform:named_target_account_run_list'
const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  QUEUED: '排队中', RUNNING: '执行中', RECOVERING: '恢复中', WAITING_FOR_AUTH: '等待认证',
  HOLDING: '等待资源', NEEDS_REVIEW: '待人工核查', SUCCEEDED: '执行成功', FAILED: '执行失败', CANCELLED: '已取消',
}
const OUTCOME_STATUS_LABELS: Record<OutcomeStatus, string> = {
  PASS: '业务通过', WARN: '业务警告', FAIL: '业务失败', UNKNOWN: '业务结果未知', NOT_EVALUATED: '业务未评估',
}
const RUN_DIGEST_FILTER_SCHEMA = runListQuerySchema.omit({ limit: true, cursor: true })

export function namedTargetForAccountOrRunQuestion(question: string): string | null {
  const cleaned = question.replace(/^(?:请问|请|麻烦|帮我)?\s*(?:查一下|查查|查询|查看|列出|看看)?\s*/, '')
  const name = /^([^，。？?！!]{2,60}?)的(?:账号|账户|运行)/i.exec(cleaned)?.[1]?.trim()
  return name && !/^(?:这个|当前|本|该|目标|某个|另一个)(?:目标)?(?:系统|平台)?$/.test(name)
    ? name : null
}

function namedTargetScopeResult(lookupFailed = false, ambiguous = false): AssistantKnowledgeAnswerResult {
  return {
    kind: 'knowledge_answer',
    summary: ambiguous
      ? '当前权限范围内有多个同名目标，不能确定要查哪一个。请打开目标详情页再提问。'
      : lookupFailed
      ? '本次无法读取当前授权的目标列表，因此不能核实该目标的账号或运行。请稍后重试，或从「目标系统」打开已授权目标。'
      : '在本次查询可访问的目标范围内，未定位到匹配名称。可能是名称不准确或缺少授权；我无法提供该目标的账号或运行信息，也不能确认它是否存在。请从「目标系统」选择已授权目标，或联系管理员核对访问范围。',
    claims: [{ factKind: 'human_confirmed', text: '目标账号与运行信息须在当前账号获授权的目标范围内查询。', citations: [NAMED_TARGET_SCOPE_CITATION] }],
    missing: [{ key: 'named_target', reason: ambiguous ? 'ambiguous' : lookupFailed ? 'read_failed' : 'not_visible_or_not_found',
      description: ambiguous ? '本次授权范围内有多个同名目标' : lookupFailed ? '授权目标列表读取失败' : '本次授权范围内无匹配名称' }],
    asOf: new Date().toISOString(),
  }
}

export async function buildNamedTargetAccountRunResult(
  db: AssistantCapabilityHandlerContext['db'],
  actor: AssistantCapabilityHandlerContext['actor'],
  targets: AssistantCapabilityHandlerContext['targets'],
  targetId: string,
): Promise<AssistantKnowledgeAnswerResult> {
  await requireVisibleTarget(actor, targetId, targets, db)
  const target = await targets.getTarget(targetId)
  const missing: AssistantKnowledgeAnswerMissing[] = []
  const lines = [`当前授权目标「${target.name}」的账号和运行摘要：`]
  const citations = [NAMED_TARGET_ACCOUNT_RUN_CITATION, `target:${targetId}`]
  try {
    const accounts = await targets.listAccounts(targetId, { limit: 5 })
    lines.push(accounts.items.length
      ? `账号${accounts.nextCursor ? '（前 5 个，还有更多）' : `（${accounts.items.length} 个）`}：${accounts.items.map((item) => `${item.displayName}（${item.status === 'active' ? '启用' : '停用'}）`).join('、')}。`
      : '当前授权范围内没有该目标的账号记录。')
  } catch {
    lines.push('账号列表读取失败，不能据此判断为零个账号。')
    missing.push({ key: 'target_accounts', reason: 'read_failed', description: '目标账号列表暂时不可用' })
  }

  try {
    await assertTargetPermission(db, actor.id, targetId, 'run:read')
    const runs = await listRuns(db, { targetId, limit: 5 }, actor.id)
    citations.push(...runs.items.map((item) => `run:${item.id}`))
    const runLabels = runs.items.map((item) => {
      const createdAt = item.createdAt
        ? `，${new Date(item.createdAt).toISOString().slice(0, 16).replace('T', ' ')} UTC`
        : ''
      return `${item.scenarioName ?? '未命名场景'}：${RUN_STATUS_LABELS[item.status]}、${OUTCOME_STATUS_LABELS[item.outcomeStatus]}（${item.id.slice(0, 8)}${createdAt}）`
    })
    lines.push(runs.items.length
      ? `运行${runs.nextCursor ? '（最近 5 条，还有更多）' : `（${runs.items.length} 条）`}：${runLabels.join('；')}。`
      : '当前授权范围内没有该目标的运行记录。')
  } catch {
    lines.push('当前无法读取该目标的运行列表；不能据此判断为零条运行。')
    missing.push({ key: 'runs', reason: hasAllPermissions(actor.permissions, ['run:read']) ? 'read_failed_or_scope_denied' : 'permission_denied',
      description: '需要该目标的 run:read 授权及可用的运行列表' })
  }

  return {
    kind: 'knowledge_answer',
    summary: lines.join('\n'),
    claims: [{ factKind: 'observed', text: '以上账号和运行摘要来自本次对当前授权范围的查询。', citations }],
    missing,
    asOf: new Date().toISOString(),
    nextActions: [
      { kind: 'target.accounts', label: '查看该目标的完整账号表', href: `/targets/${targetId}`, citations: [`target:${targetId}`] },
      { kind: 'run.detail', label: '打开运行列表继续筛选', href: '/runs', citations: [`target:${targetId}`] },
    ],
  }
}

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

/** A narrow, deterministic guard for an explicit contradiction of a published rule. */
function contradictsPublishedHelp(text: string, citations: readonly string[], facts: readonly FactItem[]): boolean {
  const claim = text.replace(/\s+/g, '')
  if (citations.includes('help:studio-retry')) {
    const source = facts.find((fact) => fact.citation === 'help:studio-retry')?.fact
    if (source?.includes('重试上限（0~10 次）') && (
      /(?:步骤|Studio|识途).{0,16}(?:不能|无法|不可|不支持|禁止).{0,6}(?:配置|设置|使用)?(?:步骤)?重试/i.test(claim) ||
      /(?:重试策略|步骤重试).{0,10}(?:不能|无法|不可|不支持|禁止).{0,6}(?:配置|设置)/i.test(claim) ||
      /(?:(?<!不)支持|(?<!不)可配置|(?<!不)可设置|填写).{0,24}(?:maxAttempts|初始退避|最大退避)/i.test(claim)
    )) return true
  }
  if (citations.includes('help:studio-steps')) {
    const source = facts.find((fact) => fact.citation === 'help:studio-steps')?.fact
    if (source?.includes('草稿未保存时仅在画布生效') && (
      /(?:草稿|画布).{0,12}(?:没保存|未保存|不保存).{0,20}(?<!不)(?:可以|能|允许|支持|可).{0,6}试跑/.test(claim) ||
      /(?:无需|不必|不用|不需要)保存.{0,12}(?<!不)(?:可以|能|可|直接).{0,6}试跑/.test(claim)
    )) return true
  }
  return false
}

function citedFactText(citations: readonly string[], facts: readonly FactItem[]): string {
  const cited = new Set(citations)
  return facts.filter((fact) => {
    if (cited.has(fact.citation)) return true
    // A session fact can name an occupying or queued Run and expose its run:
    // citation without adding a duplicate fact item for every embedded Run.
    return citations.some((citation) => {
      const [kind, id] = citation.split(':')
      return ['run', 'stepRun', 'attempt', 'occurrence'].includes(kind ?? '') &&
        Boolean(id && id.length >= 8 && fact.fact.includes(id))
    })
  }).map((fact) => fact.fact).join('\n')
}

function normalizedEvidenceText(text: string): string {
  return text.replace(/\s+/g, '').replace(/％/g, '%').toLocaleLowerCase()
}

/** Check concrete amounts before accepting a model sentence as sourced. */
function unsupportedQuantities(text: string, source: string): string[] {
  const normalizedSource = normalizedEvidenceText(source)
  const quantities = text.match(/\d+(?:\.\d+)?\s*(?:%|％|次|条|个|天|小时|分钟|毫秒|秒|ms|GB|MB|KB)/gi) ?? []
  return quantities.filter((quantity) => !normalizedSource.includes(normalizedEvidenceText(quantity)))
}

function premisesQuoteCitedFacts(premises: readonly string[] | undefined, source: string): boolean {
  if (!premises?.length || !source) return false
  const normalizedSource = normalizedEvidenceText(source)
  return premises.every((premise) => {
    const quote = normalizedEvidenceText(premise)
    return quote.length >= 6 && normalizedSource.includes(quote)
  })
}

const GENERIC_HELP_TERMS = new Set(['步骤', '场景', '运行', '目标', '账号', '状态', '数据', '配置'])

/** Keep model-selected help excerpts focused on the user's concrete topic. */
function helpFocusTerms(question: string, snippets: readonly HelpSnippetResult[], catalog: readonly PublishedHelpItem[]): Map<string, string[]> {
  const available = new Set(snippets.map((snippet) => snippet.id))
  const lowerQuestion = question.toLocaleLowerCase()
  const items = catalog.filter((item) => available.has(item.id))
  const matchedSpecific = items.filter((item) => item.keywords.some((term) =>
    term.length >= 2 && !GENERIC_HELP_TERMS.has(term) &&
    lowerQuestion.includes(term.toLocaleLowerCase())))
  if (matchedSpecific.length > 0) {
    return new Map(matchedSpecific.map((item) => [item.id,
      item.keywords.filter((term) => term.length >= 2 && !GENERIC_HELP_TERMS.has(term))]))
  }
  return new Map(items.map((item) => [item.id,
    item.keywords.filter((term) => term.length >= 2 && lowerQuestion.includes(term.toLocaleLowerCase()))]))
}

const CAPABILITY_OVERVIEW_CITATION = 'platform:capability_overview'
export const TARGET_CPU_UNAVAILABLE_CITATION = 'platform:target_cpu_unavailable'
export const PAGE_CONTEXT_MISMATCH_CITATION = 'platform:page_context_mismatch'
export const RUN_FAILURE_DIGEST_CITATION = 'platform:run_failure_digest_v1'
const CAPABILITY_OVERVIEW_QUESTION =
  /^(?:(?:识途(?:助手)?|你|助手)?(?:都)?(?:能|可以)(?:帮我|替我)?(?:做|处理)(?:什么|哪些)(?:事|事情|任务|工作)?|(?:识途(?:助手)?|你|助手)(?:目前)?(?:有哪些|有什么|支持哪些|具备哪些)(?:能力|功能|用途))[？?。！!]*$/

/** Rebuild from the current actor's permissions when an old turn is read. */
export function buildCapabilityOverviewResult(permissions: readonly string[]): AssistantKnowledgeAnswerResult {
  const available = new Set(
    availableAssistantCapabilities(permissions)
      .filter((item) => item.available)
      .map((item) => item.id),
  )
  const lines = ASSISTANT_CAPABILITIES
    .filter((item) => available.has(item.id))
    .map((item) => `- ${item.label}：${item.description}`)
  const summary = lines.length > 0
    ? `你当前有权限使用以下助手功能。能否完成具体问题，还取决于是否有对应对象和可核验的来源：\n${lines.join('\n')}\n\n分析运行或场景时，请打开对应页面或提供对象；业务数据查询需要已批准快照，页面指引需要已登记入口或目标地图。运行诊断只依据已记录的事实，当前不会读取截图内容或把未确认的原因说成结论。编排建议需要已保存草稿，助手不会直接替你执行修改。`
    : '当前账号没有可用的助手能力，请联系管理员检查权限。'
  return {
    kind: 'knowledge_answer',
    summary,
    claims: [{
      factKind: 'human_confirmed',
      text: '以上能力清单按当前账号权限生成。',
      citations: [CAPABILITY_OVERVIEW_CITATION],
    }],
    missing: [],
    asOf: new Date().toISOString(),
  }
}

/** Stable platform capability notice that can be rebuilt when a turn is read. */
export function buildTargetCpuUnavailableResult(): AssistantKnowledgeAnswerResult {
  return {
    kind: 'knowledge_answer',
    summary: '识途当前没有这个目标外部实例的实时 CPU 利用率数据，不能给出“现在是多少”的数值。请在目标系统自身的监控页面核对，或接入经授权的指标来源。',
    claims: [{
      factKind: 'human_confirmed',
      text: '识途平台当前未接入目标外部实例的实时 CPU 利用率指标来源。',
      citations: [TARGET_CPU_UNAVAILABLE_CITATION],
    }],
    missing: [{ key: 'target_cpu_metric', reason: 'source_unavailable', description: '未接入该目标外部实例的实时 CPU 指标来源' }],
    asOf: new Date().toISOString(),
  }
}

/** Stable explanation of why unrelated page references cannot be analyzed together. */
export function buildPageContextMismatchResult(): AssistantKnowledgeAnswerResult {
  return {
    kind: 'knowledge_answer',
    summary: '当前页面引用的运行、场景或目标系统不属于同一上下文，无法据此分析。请打开正确的对象页面后重试。',
    claims: [{
      factKind: 'human_confirmed',
      text: '助手只会合并经核对属于同一上下文的运行、场景与目标系统事实。',
      citations: [PAGE_CONTEXT_MISMATCH_CITATION],
    }],
    missing: [{ key: 'page_context', reason: 'scope_mismatch', description: '页面中的运行、场景和目标系统关联关系不一致' }],
    asOf: new Date().toISOString(),
  }
}

export const KNOWLEDGE_STATUS_CITATIONS = {
  no_matching_facts: 'platform:knowledge_status:no_matching_facts',
  session_permission_denied: 'platform:knowledge_status:session_permission_denied',
  session_access_denied: 'platform:knowledge_status:session_access_denied',
  session_read_failed: 'platform:knowledge_status:session_read_failed',
  no_verified_claims: 'platform:knowledge_status:no_verified_claims',
  scenario_run_permission_denied: 'platform:knowledge_status:scenario_run_permission_denied',
  scenario_run_access_denied: 'platform:knowledge_status:scenario_run_access_denied',
  scenario_run_read_failed: 'platform:knowledge_status:scenario_run_read_failed',
} as const
export type KnowledgeAnswerStatus = keyof typeof KNOWLEDGE_STATUS_CITATIONS

const KNOWLEDGE_STATUS_MESSAGES: Record<KnowledgeAnswerStatus, {
  summary: string
  claim: string
  missing: AssistantKnowledgeAnswerMissing
}> = {
  no_matching_facts: {
    summary: '这次请求在可用的授权范围与知识中未检索到相关权威事实或帮助文档。请提供具体对象或换一种问法。',
    claim: '没有可引用事实时，识途助手不会推测实体结论。',
    missing: { key: 'knowledge_base', reason: 'no_matching_facts', description: '没有可用于回答本次问题的已发布帮助片段或授权实体事实' },
  },
  session_permission_denied: {
    summary: '这次请求缺少目标系统或会话读取权限，无法检查账号健康度。权限变更后请重新提问。',
    claim: '识途助手只在具备相应读取权限时检查目标账号和会话。',
    missing: { key: 'session_overview', reason: 'permission_denied', description: '需要 target:read 和 session:read 权限' },
  },
  session_access_denied: {
    summary: '这次请求未能访问目标账号与会话信息，或目标已不存在。请核对当前页面和访问范围后重新提问。',
    claim: '识途助手不会展示未获目标范围授权的账号和会话事实。',
    missing: { key: 'session_overview', reason: 'access_denied_or_not_found', description: '目标或会话范围不可访问' },
  },
  session_read_failed: {
    summary: '这次请求的账号和会话健康数据读取失败，无法判断是否有就绪账号或可用会话。请稍后重试。',
    claim: '识途助手不会把实时读取失败解释为零个健康账号。',
    missing: { key: 'session_overview', reason: 'read_failed', description: '实时会话总览读取失败' },
  },
  no_verified_claims: {
    summary: '这次请求未产生通过事实引用校验的结论，无法给出可靠分析。请提供具体对象或缩小问题范围后重试。',
    claim: '识途助手只展示通过来源引用校验的实体结论。',
    missing: { key: 'model_inference', reason: 'no_verified_claims', description: '模型未返回可核验的结论' },
  },
  scenario_run_permission_denied: {
    summary: '当前权限不足以读取这个场景的运行结果，不能判断是否已运行成功。请联系管理员核对场景与运行读取权限。',
    claim: '判断场景是否运行成功需要读取该场景的授权运行记录。',
    missing: { key: 'scenario_runs', reason: 'permission_denied', description: '需要 workflow:read、run:read 和 target:read 权限' },
  },
  scenario_run_access_denied: {
    summary: '无法访问当前场景或其运行范围，不能判断是否已运行成功。请从有权限的场景页重新提问。',
    claim: '助手不会从不可访问的场景或运行中推断执行结果。',
    missing: { key: 'scenario_runs', reason: 'access_denied_or_not_found', description: '场景或目标范围不可访问' },
  },
  scenario_run_read_failed: {
    summary: '这次未能读取场景运行记录，不能判断是否已运行成功。请稍后重试，或打开运行记录核对。',
    claim: '运行列表读取失败不能解释成没有运行或已经通过。',
    missing: { key: 'scenario_runs', reason: 'read_failed', description: '运行记录查询暂时失败' },
  },
}

/** Rebuild a fixed, object-free status instead of replaying historical free text. */
export function buildKnowledgeStatusResult(status: KnowledgeAnswerStatus): AssistantKnowledgeAnswerResult {
  const item = KNOWLEDGE_STATUS_MESSAGES[status]
  return {
    kind: 'knowledge_answer',
    summary: item.summary,
    claims: [{ factKind: 'human_confirmed', text: item.claim, citations: [KNOWLEDGE_STATUS_CITATIONS[status]] }],
    missing: [item.missing],
    asOf: new Date().toISOString(),
  }
}

export function knowledgeStatusFromCitation(citation: string): KnowledgeAnswerStatus | null {
  return (Object.keys(KNOWLEDGE_STATUS_CITATIONS) as KnowledgeAnswerStatus[])
    .find((status) => KNOWLEDGE_STATUS_CITATIONS[status] === citation) ?? null
}

export async function handleKnowledgeAnswer(
  ctx: AssistantCapabilityHandlerContext,
): Promise<AssistantKnowledgeAnswerResult> {
  const { actor, slots, body, session, db, targets, signal, onProgress } = ctx
  const question = (body?.question || ctx.question || '').trim()

  if (!session) {
    throw new DomainError('forbidden', 'ASSISTANT_MODEL_DISABLED', '当前未配置或未启用 AI 模型，无法提供问答服务')
  }

  if (CAPABILITY_OVERVIEW_QUESTION.test(question)) {
    return buildCapabilityOverviewResult(actor.permissions)
  }

  await onProgress?.('loading_facts', '正在检索相关知识与上下文事实...')

  const pageContext = normalizeAssistantPageContext(body.pageContext)
  const currentScenarioId = pageContext?.scenarioId ?? (typeof slots.scenarioId === 'string' ? slots.scenarioId : undefined)
  if (currentScenarioId && !pageContext?.runId && isScenarioRunResultQuestion(question)) {
    if (!hasAllPermissions(actor.permissions, ['workflow:read', 'run:read', 'target:read'])) {
      return buildKnowledgeStatusResult('scenario_run_permission_denied')
    }
    let scenario: Awaited<ReturnType<typeof getScenario>>
    try {
      await authorizeTargetRequest(db, actor.id, {
        scenarioId: currentScenarioId,
        permissions: ['workflow:read', 'run:read'],
      })
      scenario = await getScenario(db, currentScenarioId)
      if (pageContext?.targetId && pageContext.targetId !== scenario.targetId) {
        return buildPageContextMismatchResult()
      }
      await requireVisibleTarget(actor, scenario.targetId, targets, db)
    } catch {
      return buildKnowledgeStatusResult('scenario_run_access_denied')
    }
    let recent: Awaited<ReturnType<typeof listRuns>>
    try {
      recent = await listRuns(db, { scenarioId: currentScenarioId, limit: 1 }, actor.id)
    } catch {
      return buildKnowledgeStatusResult('scenario_run_read_failed')
    }

    // The exact Run selected by this query must be persisted for historical
    // readback to reauthorize the answer. A target slot would incorrectly
    // demand session:read for this Run-only answer.
    slots.scenarioId = currentScenarioId
    delete slots.targetId
    delete slots.stepId
    const asOf = new Date().toISOString()
    const latest = recent.items[0]
    if (!latest) {
      const summary = `截至本次查询，当前可见的场景「${scenario.name}」没有运行记录，无法确认它已经运行成功。请在「运行记录」中核对；如有试跑权限，也可试跑当前草稿。`
      return {
        kind: 'knowledge_answer', summary,
        claims: [{ factKind: 'observed', text: `本次查询未找到场景「${scenario.name}」的授权运行记录。`, citations: [`scenario:${currentScenarioId}`] }],
        missing: [{ key: 'scenario_runs', reason: 'no_visible_runs', description: '本次授权范围内未找到该场景的运行记录' }],
        asOf,
        nextActions: [{ kind: 'run.detail', label: '查看运行记录', href: '/runs', citations: [] }],
      }
    }

    slots.runId = latest.id
    const versionLabel = latest.scenarioVersionKind === 'trial' ? '试跑版本' : '已发布版本'
    const resultText = `${RUN_STATUS_LABELS[latest.status]}、${OUTCOME_STATUS_LABELS[latest.outcomeStatus]}`
    const passed = latest.status === 'SUCCEEDED' && latest.outcomeStatus === 'PASS'
    const conclusion = passed
      ? '这能确认该次运行的执行与业务检查都通过。'
      : '这不能确认该次运行的执行与业务检查都通过。'
    const summary = `场景「${scenario.name}」最近一次可见运行（${latest.id.slice(0, 8)}，${latest.createdAt.slice(0, 16).replace('T', ' ')} UTC）为${resultText}。${conclusion}该次运行使用${versionLabel}；它不能证明当前草稿已通过。`
    return {
      kind: 'knowledge_answer', summary,
      claims: [{ factKind: 'observed', text: `最近一次运行 ${latest.id}：${resultText}。`, citations: [`scenario:${currentScenarioId}`, `run:${latest.id}`] }],
      missing: [], asOf,
      nextActions: [{ kind: 'run.detail', label: '查看这次运行详情与证据', href: `/runs/${latest.id}`, citations: [`run:${latest.id}`] }],
    }
  }
  const namedTarget = namedTargetForAccountOrRunQuestion(question)
  let namedTargetMatch: { id: string; name: string } | undefined
  if (namedTarget) {
    if (!hasAllPermissions(actor.permissions, ['target:read'])) return namedTargetScopeResult()
    try {
      let nextCursor: string | undefined
      const matches: { id: string; name: string }[] = []
      do {
        const page = await targets.listTargets({ search: namedTarget, cursor: nextCursor, limit: 100 }, actor)
        matches.push(...page.items.filter((target) => target.name.toLocaleLowerCase() === namedTarget.toLocaleLowerCase()))
        nextCursor = page.nextCursor ?? undefined
      } while (matches.length < 2 && nextCursor)
      if (matches.length === 0) return namedTargetScopeResult()
      if (matches.length > 1) return namedTargetScopeResult(false, true)
      namedTargetMatch = matches[0]!
      slots.targetId = namedTargetMatch.id
      if (!TARGET_ACCOUNT_HEALTH_INTENT_PATTERN.test(question)) {
        return await buildNamedTargetAccountRunResult(db, actor, targets, namedTargetMatch.id)
      }
    } catch {
      return namedTargetScopeResult(true)
    }
  }
  if (
    (pageContext?.page === 'target' || pageContext?.pageKind === 'target') &&
    pageContext.targetId &&
    TARGET_REALTIME_CPU_INTENT_PATTERN.test(question) &&
    !/(?:执行节点|worker|浏览器宿主)/i.test(question)
  ) {
    return buildTargetCpuUnavailableResult()
  }
  // A target health question, including one from a target-scoped session list,
  // needs live authorized session facts. An account detail has its own path.
  if (
    (namedTargetMatch || pageContext?.page === 'target' || pageContext?.pageKind === 'target' ||
      (pageContext?.pageKind === 'session' && pageContext.routeKey === 'sessions.index.systems')) &&
    (namedTargetMatch?.id || pageContext?.targetId) &&
    TARGET_ACCOUNT_HEALTH_INTENT_PATTERN.test(question)
  ) {
    const targetId = namedTargetMatch?.id ?? pageContext!.targetId!
    if (!hasAllPermissions(actor.permissions, ['target:read', 'session:read'])) {
      return buildKnowledgeStatusResult('session_permission_denied')
    }
    try {
      await requireVisibleTarget(actor, targetId, targets, db)
      await authorizeTargetRequest(db, actor.id, { targetId, permissions: ['session:read'] })
    } catch {
      return buildKnowledgeStatusResult('session_access_denied')
    }
    try {
      const overview = await listAccountSessionOverview(db, { targetId, limit: 5 }, actor.id)
      const citation = `target:${targetId}`
      const totals = overview.summary
      const statusLabels = {
        ready: '已就绪',
        needs_check: '待检查',
        needs_login: '需重新登录',
        identity_mismatch: '身份不匹配',
        maintenance: '维护中',
        executing: '执行中',
        lost: '会话失联',
        unprepared: '未准备',
      }
      const summaryLine = `该目标共有 ${totals.total} 个关联账号：就绪可用 ${totals.available}、问题状态 ${totals.problem}、未准备 ${totals.unprepared}、忙碌 ${totals.busy}；保留中的会话 ${totals.retained}。`
      const accountLines = overview.items.map((item) => {
        const lease = item.occupyingRunId || item.occupyingOperationId ? '有租约占用' : '无已记录的租约占用'
        const auth = item.lastAuthCheckedAt
          ? `最近认证检查 ${item.lastAuthCheckedAt}`
          : '当前总览未记录最近认证检查时间'
        return `${item.accountDisplayName}：${item.accountStatus === 'disabled' ? '账号已停用，' : ''}${statusLabels[item.status]}；活跃会话 ${item.liveCount}/${item.effectiveCap}；${lease}；${auth}。`
      })
      const liveAccounts = overview.items.filter((item) => item.liveCount > 0)
      const occupiedAccounts = overview.items.filter((item) => item.occupyingRunId || item.occupyingOperationId)
      const coverage = overview.nextCursor ? '前 5 个账号中' : '该目标当前'
      const liveSummary = `${coverage}有 ${liveAccounts.length} 个账号持有活跃会话、${occupiedAccounts.length} 个账号有已记录的租约占用；活跃会话不等于正在被运行占用。`
      const noReadyNotice = totals.total > 0 && totals.available === 0
        ? '当前没有就绪可用的会话；仅凭这一状态不能断定账号密码错误。'
        : ''
      const summary = [namedTargetMatch ? `目标系统「${namedTargetMatch.name}」：` : '', summaryLine, liveSummary, ...accountLines, overview.nextCursor ? '这里只展示前 5 个账号，请到会话管理查看其余账号。' : '', noReadyNotice]
        .filter(Boolean)
        .join('\n')
      const unknownAuthChecks = overview.items.filter((item) => !item.lastAuthCheckedAt).length
      return {
        kind: 'knowledge_answer',
        summary,
        claims: [{ factKind: 'observed', text: summaryLine, citations: [citation] }],
        missing: unknownAuthChecks > 0
          ? [{ key: 'auth_probe', reason: 'not_observed_in_current_overview', description: `${unknownAuthChecks} 个已列出的账号未在当前总览中记录最近认证检查时间，无法确认其凭据当前是否有效` }]
          : [],
        asOf: new Date().toISOString(),
        sourceAsOf: overview.asOf,
      }
    } catch {
      return buildKnowledgeStatusResult('session_read_failed')
    }
  }
  const allowedCitations = new Set<string>()
  const helpCitations = new Set<string>()
  const factItems: FactItem[] = []
  const missingList: AssistantKnowledgeAnswerMissing[] = []
  const nextActions: AssistantNextAction[] = []
  const helpNextActions: AssistantNextAction[] = []

  // 1. 检索已发布的帮助文档知识片段
  const helpCatalog = effectiveHelpCatalog()
  const helpSnippets = retrieveHelpSnippets(question, {
    topK: 3,
    maxChars: 500,
    permissions: actor.permissions,
    catalog: helpCatalog,
  })
  const exactFormHelp = helpSnippets.find((snippet) => {
    if (!snippet.id.startsWith('help:target-config-')) return false
    const field = helpCatalog.find((item) => item.id === snippet.id)
    return Boolean(field?.keywords.some((keyword) => keyword.length >= 3 && question.toLocaleLowerCase().includes(keyword.toLocaleLowerCase())))
  })
  if (exactFormHelp && /(?:怎么填|如何填|填什么|什么意思|含义|作用|选填|必填|不填|留空|默认|配置)/.test(question) &&
    !/(?:帮我|替我|给我).{0,6}(?:填写|填上|设置|改成)/.test(question)) {
    // Field help is global product documentation. Do not bind its history to
    // an unrelated target/run merely because the user asked from that page.
    for (const key of ['targetId', 'runId', 'scenarioId', 'sessionId', 'scheduleId', 'datasetId']) delete slots[key]
    const publishedContent = helpCatalog.find((item) => item.id === exactFormHelp.id)?.content ?? exactFormHelp.content
    return {
      kind: 'knowledge_answer',
      summary: publishedContent,
      claims: [{ factKind: 'human_confirmed', text: publishedContent, citations: [exactFormHelp.id] }],
      missing: [],
      asOf: new Date().toISOString(),
      nextActions: [{ kind: 'target.detail', label: '打开目标系统配置', href: '/targets', citations: [] }],
    }
  }
  const relevantHelpTerms = helpFocusTerms(question, helpSnippets, helpCatalog)

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

  // Resolve relationships from authorized records before giving the model any
  // entity facts. Individually readable IDs may still belong to different
  // targets or scenarios when a page context is stale or malformed.
  const runId = String(pageContext?.runId ?? slots.runId ?? '')
  const scenarioId = String(pageContext?.scenarioId ?? slots.scenarioId ?? '')
  const targetId = String(pageContext?.targetId ?? slots.targetId ?? '')
  let authorizedRunScope: { targetId?: string; scenarioId?: string } | null = null
  let authorizedScenarioScope: { targetId?: string } | null = null
  if (runId && (scenarioId || targetId) && hasAllPermissions(actor.permissions, ['run:read', 'target:read'])) {
    try {
      const run = await getRun(db, runId, actor.id)
      if (run.targetId) await requireVisibleTarget(actor, run.targetId, targets, db)
      authorizedRunScope = { targetId: run.targetId, scenarioId: run.scenarioId }
    } catch {
      // The existing run fact loader will report inaccessible or missing data.
    }
  }
  if (scenarioId && (targetId || runId) && hasAllPermissions(actor.permissions, ['workflow:read', 'target:read'])) {
    try {
      await authorizeTargetRequest(db, actor.id, { scenarioId, permissions: ['workflow:read'] })
      const scenario = await getScenario(db, scenarioId)
      if (scenario.targetId) await requireVisibleTarget(actor, scenario.targetId, targets, db)
      authorizedScenarioScope = { targetId: scenario.targetId }
    } catch {
      // The existing scenario fact loader will report inaccessible or missing data.
    }
  }
  if (
    (targetId && authorizedRunScope?.targetId && authorizedRunScope.targetId !== targetId) ||
    (scenarioId && authorizedRunScope?.scenarioId && authorizedRunScope.scenarioId !== scenarioId) ||
    (targetId && authorizedScenarioScope?.targetId && authorizedScenarioScope.targetId !== targetId) ||
    (authorizedRunScope?.targetId && authorizedScenarioScope?.targetId && authorizedRunScope.targetId !== authorizedScenarioScope.targetId)
  ) {
    return buildPageContextMismatchResult()
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
          fact: `目标系统: ${target.name}, 入口地址: ${target.entryUrl}, 配置状态: ${target.status}（${target.status === 'active' ? '已启用' : '已停用'}）, 认证方式: ${target.authMethod}`,
        })
        if (
          (pageContext?.pageKind === 'target' || pageContext?.page === 'target') &&
          TARGET_CONFIG_STATUS_QUESTION.test(question) &&
          !/(?:账号|账户|会话|认证|运行|业务|健康)/.test(question)
        ) {
          const status = target.status === 'active' ? '已启用' : '已停用'
          const statusFact = `目标系统「${target.name}」的配置状态为${status}（${target.status}）。`
          return {
            kind: 'knowledge_answer',
            summary: `${statusFact}这个状态只说明目标系统记录是否启用，不能据此判断账号认证或业务服务是否健康。`,
            claims: [{ factKind: 'observed', text: statusFact, citations: [targetCitation] }],
            missing: [],
            asOf: new Date().toISOString(),
            nextActions: [{
              kind: 'target.accounts', label: '查看该目标系统与账号',
              href: `/targets/${target.id}`, citations: [targetCitation],
            }],
          }
        }
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
    (pageKind === 'studio' || pageKind === 'scenario') && Boolean(scenarioId) &&
    (!focusedStepId || isScenarioFailureDigestQuestion(question))
  const rawRunFilters = pageContext?.view?.filters ?? {}
  const hasFailureDigestIntent = FAILURE_DIGEST_INTENT_PATTERN.test(question)
  const shouldPerformFailureDigest =
    (isRunListPage &&
      (hasFailureDigestIntent ||
        (rawRunFilters.status === 'FAILED' && /失败|报错|异常|运行|问题|怎么回事|分析|总结|为什么/i.test(question)))) ||
    (isScenarioOverview && hasFailureDigestIntent)

  let verifiedFailureDigest: AssistantKnowledgeAnswerResult | null = null
  let scopedScenarioName: string | undefined
  if (shouldPerformFailureDigest) {
    if (isScenarioOverview) {
      if (!hasAllPermissions(actor.permissions, ['workflow:read', 'run:read', 'target:read'])) {
        return buildKnowledgeStatusResult('scenario_run_permission_denied')
      }
      try {
        await authorizeTargetRequest(db, actor.id, { scenarioId, permissions: ['workflow:read', 'run:read'] })
        const scenario = await getScenario(db, scenarioId)
        if (targetId && targetId !== scenario.targetId) return buildPageContextMismatchResult()
        await requireVisibleTarget(actor, scenario.targetId, targets, db)
        scopedScenarioName = scenario.name
      } catch {
        return buildKnowledgeStatusResult('scenario_run_access_denied')
      }
      slots.scenarioId = scenarioId
      delete slots.targetId
      delete slots.stepId
    }
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

        if (runsList.length === 0 && isScenarioOverview) {
          const days = parseRecentDays(question) ?? 7
          return {
            kind: 'knowledge_answer',
            summary: `在本次授权范围内，场景「${scopedScenarioName}」最近 ${days} 天没有状态为 FAILED 的运行记录；这不代表其余运行的业务检查都通过，也不代表当前草稿已经试跑成功。`,
            claims: [{ factKind: 'observed', text: `本次查询在场景「${scopedScenarioName}」最近 ${days} 天未找到 FAILED 运行。`, citations: [`scenario:${scenarioId}`] }],
            missing: [{ key: 'failed_runs', reason: 'no_failed_runs', description: `当前场景最近 ${days} 天未找到 FAILED 运行` }],
            asOf: new Date().toISOString(),
            nextActions: [{ kind: 'run.detail', label: '查看运行记录', href: '/runs', citations: [] }],
          }
        }
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

          // This response is a deterministic summary of the exact Run set.
          // Related incidents have a separate permission/scope and must not be
          // inferred or linked from a few representative runs.

          // The digest is derived from the full bounded Run set, not from the
          // model's choice of representative citations. Persist that complete
          // source set so historical reads can reauthorize every input Run.
          const sourceCitations = runIds.map((id) => `run:${id}`)
          const grouping = runsList.length === 1
            ? '当前范围只有 1 条失败运行，无法判断多次失败是否同因。'
            : clusters.length === 1
              ? `按场景、失败步骤与错误分组，这 ${runsList.length} 条失败运行属于同一错误表现组；仅凭此不能确认根因完全相同。`
              : `按场景、失败步骤与错误分组，这 ${runsList.length} 条失败运行分为 ${clusters.length} 个错误表现组；现有事实不能确认它们同因。`
          const groupLines = clusters.slice(0, 5).map((cluster) =>
            `${cluster.stepName}：${cluster.errorDescription}（${cluster.count} 次）`)
          const remaining = clusters.length > 5 ? `另有 ${clusters.length - 5} 组未在摘要展开。` : ''
          const scopeText = isScenarioOverview
            ? `场景「${scopedScenarioName}」最近 ${parseRecentDays(question) ?? 7} 天的授权范围`
            : '当前筛选与权限范围'
          const summary = [
            `在${scopeText}内检查了 ${runsList.length} 条 FAILED 运行${truncationNotice}。`,
            grouping,
            groupLines.length ? `分组：${groupLines.join('；')}。` : '',
            remaining,
          ].filter(Boolean).join(' ')
          verifiedFailureDigest = {
            kind: 'knowledge_answer',
            summary,
            claims: [{
              factKind: 'observed',
              text: `当前筛选与权限范围内的 ${runsList.length} 条失败运行确定性分为 ${clusters.length} 组。`,
              citations: [RUN_FAILURE_DIGEST_CITATION, ...sourceCitations],
            }],
            missing: [
              ...missingList,
              ...(runsList.length === 1 ? [{
                key: 'comparison_runs', reason: 'only_one_failed_run',
                description: '当前筛选范围只有一条失败运行，无法比较多个失败原因',
              }] : []),
              ...(runsList.length >= FAILURE_DIGEST_LIMIT ? [{
                key: 'older_runs', reason: 'truncated',
                description: `只分析了最近 ${FAILURE_DIGEST_LIMIT} 条失败运行`,
              }] : []),
            ],
            asOf: new Date().toISOString(),
            nextActions: runActions.slice(0, 3),
          }
        }
      } catch {
        if (isScenarioOverview) return buildKnowledgeStatusResult('scenario_run_read_failed')
        missingList.push({
          key: 'runs',
          reason: 'access_denied_or_not_found',
          description: '检索失败运行或提取错误事实时发生异常',
        })
      }
    }
  }

  if (verifiedFailureDigest) return verifiedFailureDigest

  // CQ-12: Session 受管会话事实与跨账号多活实例隔离
  const sessionId = String(
    pageContext?.primaryRef?.kind === 'session'
      ? pageContext.primaryRef.id
      : pageContext?.view?.selectedRef?.kind === 'session'
        ? pageContext.view.selectedRef.id
        : slots.sessionId ?? '',
  )
  if (sessionId) {
    if (hasAllPermissions(actor.permissions, ['target:read', 'session:read'])) {
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
            let canReadRuns = false
            if (hasAllPermissions(actor.permissions, ['run:read'])) {
              try {
                await authorizeTargetRequest(db, actor.id, { targetId: sessionDto.targetId, permissions: ['run:read'] })
                canReadRuns = true
              } catch {
                // Session facts remain available without run access.
              }
            }
            const legacyWorkerId = sessionDto.ownerWorkerId || (sessionDto as any).leaseOwnerWorkerId
            if (activeLease) {
              const elapsedMinutes = Math.max(
                0,
                Math.floor((Date.now() - new Date(activeLease.acquiredAt).getTime()) / 60000),
              )
              leaseFact = `租约已被占用: Worker ${activeLease.holderWorkerId}${activeLease.runId && canReadRuns ? `，运行 ID ${activeLease.runId}` : ''}，用途 ${activeLease.purpose}，已占用约 ${elapsedMinutes} 分钟 (自 ${activeLease.acquiredAt})`
              if (activeLease.runId && canReadRuns) {
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
              leaseFact = `会话归属 Worker ${legacyWorkerId}，未记录活动租约`
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
            let queueFact = canReadRuns
              ? '排队运行: 当前该账号无排队等待的运行'
              : '排队运行: 未检查（当前账号无权读取该目标运行）'
            if (sessionDto.targetAccountId && canReadRuns) {
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
                  const runIds = queuedRuns.map((r) => r.id).join(', ')
                  queueFact = `排队等待运行: 该账号下有 ${queuedRuns.length} 条运行排队中 (${runIds})，可能原因（根据当前占用与认证状态推断）: ${queueReason}`
                  for (const r of queuedRuns.slice(0, 3)) {
                    allowedCitations.add(`run:${r.id}`)
                  }
                }
              } catch {
                queueFact = '排队运行: 读取失败，无法判断是否有排队运行'
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

            // A current account/session question is answerable from the
            // authorized DTO. Do not let an unrelated help snippet or model
            // failure displace these live facts.
            if (ACCOUNT_SESSION_STATE_QUESTION.test(question)) {
              const authenticated = sessionDto.authState === 'AUTHENTICATED'
              const ready = authenticated && sessionDto.status === 'OPEN' && sessionDto.health === 'HEALTHY'
              const readiness = ready
                ? '当前记录显示会话已认证、开放且健康；下一次复用仍以运行时检查为准。'
                : `当前记录显示会话状态 ${sessionDto.status}、认证状态 ${sessionDto.authState ?? '未知'}、健康状态 ${sessionDto.health ?? '未知'}，不能断定已经可用。`
              const leaseSummary = activeLease
                ? `当前活动租约由 Worker ${activeLease.holderWorkerId} 持有，用途 ${activeLease.purpose}${activeLease.runId && canReadRuns ? `，占用运行 ID ${activeLease.runId}` : ''}。`
                : legacyWorkerId
                  ? `当前会话由 Worker ${legacyWorkerId} 管理，但没有已记录的活动租约；不能据此说它正占用会话。`
                  : '当前未记录活动租约，不能说有其他运行正占着这条会话。'
              const authSummary = sessionDto.lastAuthSuccessAt
                ? `最近一次成功认证记录为 ${sessionDto.lastAuthSuccessAt}。`
                : '当前记录没有最近成功认证时间，无法判断最近一次认证何时成功。'
              const authErrorSummary = sessionDto.lastAuthError
                ? `最近认证错误记录为 ${sessionDto.lastAuthError}${describeAuthIssue(sessionDto.lastAuthError) ? `（${describeAuthIssue(sessionDto.lastAuthError)}）` : ''}${sessionDto.lastAuthCheckedAt ? `，检查于 ${sessionDto.lastAuthCheckedAt}` : ''}；这是记录到的错误，不能仅据此断定当前仍在重试。`
                : ''
              const premiseCorrection = /等登录|等待登录/.test(question) && authenticated
                ? '当前会话记录不支持“仍在等登录”的前提。'
                : ''
              const summary = [readiness, leaseSummary, authErrorSummary, authSummary, premiseCorrection].filter(Boolean).join(' ')
              const occupantAction = activeLease?.runId && canReadRuns ? [{
                kind: 'run.detail' as const,
                label: '查看占用该会话的运行',
                href: `/runs/${activeLease.runId}`,
                citations: [`run:${activeLease.runId}`],
              }] : []
              return {
                kind: 'knowledge_answer',
                summary,
                claims: [{ factKind: 'observed', text: summary, citations: [sessionCitation] }],
                missing: sessionDto.lastAuthSuccessAt ? [] : [{
                  key: 'last_auth_success', reason: 'not_recorded',
                  description: '当前会话记录没有最近成功认证时间',
                }],
                asOf: new Date().toISOString(),
                nextActions: [...occupantAction, ...(sessionDto.targetId && sessionDto.targetAccountId ? [{
                  kind: 'target.accounts' as const,
                  label: '查看当前会话与账号',
                  href: `/sessions/${sessionDto.targetId}/${sessionDto.targetAccountId}`,
                  citations: [sessionCitation],
                }] : [])],
              }
            }

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
        description: '缺少 target:read 或 session:read 权限，无法读取当前受管会话事实',
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
      if (hasAllPermissions(actor.permissions, ['target:read', 'session:read'])) {
        try {
          await requireVisibleTarget(actor, targetId, targets, db)
          await authorizeTargetRequest(db, actor.id, { targetId, permissions: ['session:read'] })
          const detail = await getAccountSessionDetail(db, { targetId, targetAccountId })
          const targetCitation = `target:${targetId}`
          allowedCitations.add(targetCitation)

          let canReadRuns = false
          if (hasAllPermissions(actor.permissions, ['run:read'])) {
            try {
              await authorizeTargetRequest(db, actor.id, { targetId, permissions: ['run:read'] })
              canReadRuns = true
            } catch {
              // Account and session facts remain available without run access.
            }
          }

          const asksCurrentAccountState = ACCOUNT_SESSION_STATE_QUESTION.test(question)
          const asksAuthSuccess = isAccountAuthSuccessQuestion(question)
          if (asksCurrentAccountState || asksAuthSuccess) {
            const authState = detail.session?.authState ?? '无活跃会话'
            let authHistory: { lastAuthSuccessAt: string | null } | undefined
            let authHistoryReadFailed = false
            try {
              authHistory = (await loadAccountAuthDisplay(db, [targetAccountId])).get(targetAccountId)
            } catch {
              authHistoryReadFailed = true
            }
            const recentlyAuthenticated = detail.session?.lastAuthSuccessAt ?? authHistory?.lastAuthSuccessAt
            const occupied = detail.occupancy ?? detail.instances?.find((instance) => instance.occupancy)?.occupancy
            const accountStatusLabels: Record<string, string> = {
              ready: '就绪', needs_check: '待检查', needs_login: '需重新登录',
              identity_mismatch: '身份不匹配', maintenance: '维护中',
              executing: '执行中', lost: '会话失联', unprepared: '未准备',
            }
            const usable = detail.accountStatus === 'active' && detail.status === 'ready' &&
              authState === 'AUTHENTICATED' && detail.liveCount > 0
            const readiness = usable
              ? `当前账号状态为就绪，已有 ${detail.liveCount} 个活跃会话，主会话已认证；下一次复用仍以运行时检查为准。`
              : `当前账号状态为${accountStatusLabels[detail.status] ?? detail.status}，活跃会话 ${detail.liveCount}/${detail.effectiveCap}，主会话认证状态 ${authState}；不能断定现在可用。`
            const lease = occupied
              ? `当前会话有${occupied.purpose}用途的占用${occupied.occupyingRunId && canReadRuns ? `，占用运行 ID ${occupied.occupyingRunId}` : ''}；${occupied.occupyingRunId && canReadRuns ? '可查看这条运行' : '请在会话页核对占用者'}。`
              : '当前没有已记录的会话占用。'
            const authError = detail.lastAuthError
              ? `最近认证错误记录为 ${detail.lastAuthError}${describeAuthIssue(detail.lastAuthError) ? `（${describeAuthIssue(detail.lastAuthError)}）` : ''}${detail.session?.lastAuthCheckedAt ? `，检查于 ${detail.session.lastAuthCheckedAt}` : ''}；如当前无活跃会话，不能据此断定错误仍在发生。`
              : ''
            const auth = recentlyAuthenticated
              ? detail.session?.lastAuthSuccessAt
                ? `当前主会话最近一次成功认证记录为 ${recentlyAuthenticated}。`
                : `账号历史上最近一次成功认证记录为 ${recentlyAuthenticated}；这不代表当前有可用会话。`
              : authHistoryReadFailed
                ? '账号认证历史读取失败，无法确认最近成功认证时间。'
                : '当前可见记录没有最近成功认证时间。'
            const premise = /等登录|等待登录/.test(question)
              ? usable
                ? '现有记录不支持“仍在等登录”的前提。'
                : detail.lastAuthError
                  ? '当前尚未就绪；最近认证错误可能与登录受阻有关，但记录不能证明它是这次等待的直接原因。'
                  : '现有记录只表明当前尚未就绪，不能确定是在等待登录或判断具体原因；请核对最近认证错误和会话操作。'
              : ''
            const summary = asksAuthSuccess && !asksCurrentAccountState
              ? `${auth}${/吗|是否|有没有/.test(question)
                  ? ' 这条记录不能确认最近一次认证尝试是否成功。'
                  : ''}`
              : [readiness, lease, authError, auth, premise].filter(Boolean).join(' ')
            const occupantRunId = occupied?.occupyingRunId && canReadRuns ? occupied.occupyingRunId : null
            if (occupantRunId) allowedCitations.add(`run:${occupantRunId}`)
            return {
              kind: 'knowledge_answer',
              summary,
              claims: [{ factKind: 'observed', text: summary, citations: [targetCitation] }],
              missing: recentlyAuthenticated ? [] : [{
                key: 'last_auth_success', reason: authHistoryReadFailed ? 'read_failed' : 'not_recorded',
                description: authHistoryReadFailed ? '账号认证历史读取失败' : '当前可见记录没有最近成功认证时间',
              }],
              asOf: new Date().toISOString(),
              sourceAsOf: detail.asOf,
              nextActions: [...(occupantRunId ? [{
                kind: 'run.detail' as const, label: '查看占用该会话的运行',
                href: `/runs/${occupantRunId}`, citations: [`run:${occupantRunId}`],
              }] : []), {
                kind: 'target.accounts', label: '查看当前会话与账号',
                href: `/sessions/${targetId}/${targetAccountId}`,
                citations: [targetCitation],
              }],
            }
          }

          const authFact = detail.lastAuthError
            ? `最近认证失败: 错误代码 ${detail.lastAuthError} (${describeAuthIssue(detail.lastAuthError) ?? '认证异常'})`
            : `账号会话状态: ${detail.status}`
          const capFact = `有效并发实例上限: ${detail.effectiveCap}，当前活跃实例数: ${detail.liveCount}`

          let queueFact = canReadRuns
            ? '排队运行: 当前该账号无排队等待的运行'
            : '排队运行: 未检查（当前账号无权读取该目标运行）'
          if (canReadRuns) {
            try {
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
                for (const r of queuedRuns.slice(0, 3)) {
                  allowedCitations.add(`run:${r.id}`)
                }
              }
            } catch {
              queueFact = '排队运行: 读取失败，无法判断是否有排队运行'
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
          description: '缺少 target:read 或 session:read 权限，无法读取当前受管会话事实',
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
              const createdLocalDate = new Intl.DateTimeFormat('en-CA', { timeZone: timezone })
                .format(new Date(schedule.createdAt))
              if (range) {
                const rangeText = `${range.label}按 ${timezone} 时区对应 ${range.from}${range.from === range.to ? '' : ` 至 ${range.to}`}`
                const createdText = `这条调度创建于 ${formatInTimezone(schedule.createdAt, timezone)}`
                const localWeekday = range.from === range.to
                  ? new Date(`${range.from}T00:00:00.000Z`).getUTCDay() || 7
                  : null
                const calendarRule = schedule.definition.timeRule?.kind === 'calendar'
                  ? schedule.definition.timeRule : null
                const excludedWeekday = !truncated && localWeekday !== null && calendarRule !== null &&
                  !calendarRule.weekdays.includes(localWeekday as 1 | 2 | 3 | 4 | 5 | 6 | 7)
                const weekdayNames = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
                const summary = createdLocalDate > range.to
                  ? `${rangeText}。${createdText}，晚于所问日期，当时尚不存在，因此不可能由这条规则触发；所查范围也没有触发记录。`
                  : excludedWeekday
                    ? `${rangeText}。该规则只在${calendarRule!.weekdays.map((day) => weekdayNames[day - 1]).join('、')}计划触发，而 ${range.from} 是${weekdayNames[localWeekday! - 1]}，不在计划日期；因此没有应触发的计划，也没有已记录的跳过事件。${createdText}。`
                  : `${rangeText}。截至本次查询，${truncated ? `最近 ${fetchLimit} 条触发记录中未见该日期的记录，但更早记录被截断` : '所查范围没有触发记录'}。${createdText}，目前${schedule.enabled ? '已启用' : '已停用'}${schedule.nextDueAt ? `，下次预计触发于 ${formatInTimezone(schedule.nextDueAt, timezone)}` : ''}。现有记录不能确定该日期未运行的原因；请核对规则时间窗与调度事件，不能把“没有触发记录”当成一次已记录的跳过。`
                return {
                  kind: 'knowledge_answer',
                  summary,
                  claims: [{ factKind: 'observed', text: summary, citations: [scCit] }],
                  missing: createdLocalDate > range.to || excludedWeekday ? [] : [{
                    key: 'schedule_trigger_cause', reason: 'not_recorded',
                    description: '没有该日期的触发或跳过事件，无法确定未运行原因',
                  }],
                  asOf: new Date().toISOString(),
                  nextActions: [{ kind: 'schedule.edit', label: '查看调度列表', href: '/schedules', citations: [scCit] }],
                }
              }
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

              // A dated "why didn't it run" question can be answered from
              // admission records without asking the model to infer a cause.
              if (range && /(?:没跑|未跑|没运行|未运行|为什么没|怎么没)/.test(question)) {
                const scheduled = occurrences.filter((item) => item.source === 'scheduled')
                if (scheduled.length > 0) {
                  const admitted = scheduled.filter((item) => item.admissionStatus === 'ADMITTED')
                  const skipped = scheduled.filter((item) => item.admissionStatus === 'SKIPPED')
                  const failed = scheduled.filter((item) => item.admissionStatus === 'FAILED')
                  const pending = scheduled.filter((item) => item.admissionStatus === 'PENDING')
                  const scheduledReasons = new Map<string, number>()
                  for (const item of skipped) {
                    if (item.reason) scheduledReasons.set(item.reason, (scheduledReasons.get(item.reason) ?? 0) + 1)
                  }
                  const reasonDetails = [...scheduledReasons.entries()].map(([reason, count]) => {
                    const meta = SCHEDULE_SKIP_REASON_METAS[reason as ScheduleSkipReason]
                    return `${meta?.label ?? reason}（${reason}，${count} 次）`
                  })
                  const admissionDetails = [
                    admitted.length ? `已准入 ${admitted.length} 次` : '',
                    skipped.length ? `已跳过 ${skipped.length} 次` : '',
                    failed.length ? `准入失败 ${failed.length} 次` : '',
                    pending.length ? `仍待准入 ${pending.length} 次` : '',
                  ].filter(Boolean).join('，')
                  const latestScheduled = scheduled[0]
                  const skipAction = latestScheduled?.admissionStatus === 'SKIPPED' && latestScheduled.reason
                    ? resolveSkipReasonAction(latestScheduled.reason as ScheduleSkipReason, {
                        targetId: schedule.targetId, runId: latestScheduled.runId, scheduleId: sId,
                      })
                    : null
                  const slot = latestScheduled?.windowStartUtc
                    ? `最近一条应触发于 ${formatInTimezone(latestScheduled.windowStartUtc, timezone)}（${timezone}）`
                    : `最近一条对应 ${latestScheduled?.localStartDate}（${timezone}，未记录具体时刻）`
                  const conclusion = admitted.length
                    ? '至少有一次定时触发已准入，不能说完全没跑；是否执行完成或成功需要查看关联运行。'
                    : skipped.length && !failed.length
                      ? '已记录定时触发，但在准入阶段被跳过；这些记录不能证明有运行开始。'
                      : '已记录定时触发，但没有已准入的记录；需按准入状态和关联运行进一步核对。'
                  const summary = `${range.label}（${range.from}，${timezone}）的已读取定时触发记录共 ${scheduled.length} 条：${admissionDetails}。${slot}。${reasonDetails.length ? `记录的跳过原因：${reasonDetails.join('；')}。` : skipped.length ? '跳过记录未给出原因。' : ''}${conclusion}${truncationText}`
                  return {
                    kind: 'knowledge_answer',
                    summary,
                    claims: [{ factKind: 'observed', text: summary,
                      citations: [scCit, ...scheduled.map((item) => `occurrence:${item.occurrenceId}`)] }],
                    missing: truncated ? [{ key: 'schedule_occurrences', reason: 'truncated',
                      description: '只读取了最近一页触发记录，该时间范围内可能还有更早记录' }] : [],
                    asOf: new Date().toISOString(),
                    nextActions: [...(skipAction ? [{
                      kind: skipAction.kind, label: skipAction.label, href: skipAction.href,
                      citations: [`occurrence:${latestScheduled!.occurrenceId}`],
                    }] : []), {
                      kind: 'schedule.edit', label: '查看调度列表', href: '/schedules', citations: [scCit],
                    }],
                  }
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
    const status = buildKnowledgeStatusResult('no_matching_facts')
    return { ...status, missing: [...status.missing, ...missingList] }
  }
  const boundedCitations = new Set([...allowedCitations].filter((citation) =>
    citedFactText([citation], boundedFacts).length > 0))
  const helpOnlyFacts = missingList.length === 0 &&
    boundedFacts.every((fact) => helpCitations.has(fact.citation))

  // 5. 模型生成有源解答
  await onProgress?.('generating', '正在基于已知事实与知识生成有源解答...')

  const llmResult = await session.completeJson(
    'knowledge_answer',
    z.object({
      claims: z.array(
        z.strictObject({
          factKind: z.enum(['observed', 'human_confirmed', 'inferred']),
          text: z.string().min(1).max(500),
          citations: z.array(z.string()).default([]),
          premises: z.array(z.string()).optional(),
          evidenceQuote: z.string().min(8).max(500).optional(),
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
   - observed: 直接来自提供的实体状态或运行证据观测值；必须额外填写 evidenceQuote，从所引实体事实中逐字复制连续原文。服务端仅展示这段原文，不展示改写的 text；
   - human_confirmed: 来自已发布的官方帮助文档、规则或配置规范；必须额外填写 evidenceQuote，从所引帮助正文逐字复制连续原文。服务端仅展示这段原文，不展示改写的 text；
   - 不要输出 inferred：引用事实能证明前提存在，却不能自动证明新结论成立。无法直接引用的解释请登记在 missing，不要作为已验证结论展示。运行故障原因应由专用诊断能力处理。
4. 如果用户提问涉及特定时间范围（如「昨晚」「本周」），请结合当前时间（currentTime）与触发记录中的时间进行语义匹配与聚焦；若用户询问的时间范围超出所提供触发记录的覆盖范围，必须在回答中明确说明“所查阅的历史触发记录仅包含最近 20 次，更早的记录已被截断”，严禁推测或编造未提供的历史事实。
5. 如果用户提问涉及失败运行归并、聚类分析或多次失败原因归纳：严格基于聚合事实中的分组统计（包括各分组的错误原因、步骤与发生次数）进行归纳说明，严禁臆造未给出的运行、分组或关联事件；涉及的具体分组必须引用对应的样例运行 ID（run:<id>）或关联事件 ID（incident:<id>）。如果分析的失败运行达到 50 条上限，请在回答中明确提及该结果基于最近 50 条已截断记录。
6. 如果提供的材料不足以完整回答用户的问题，必须在 missing 列表中诚实登记缺失项（key, reason, description），不能凭空臆造。
7. 只保留回答问题所需的关键结论，claims 最多 5 条，每条尽量不超过 120 字，避免逐项复述完整资料。服务端会从通过校验的 claims 生成摘要，不要另写 summary。
【输出格式】
请只输出一个合法 JSON 对象，不要 Markdown 或额外说明。JSON 结构示例（文字仅为格式占位，不可照抄）：
{"claims":[],"missing":[]}
有结论时，claims 中每项必须包含 factKind、text、citations、evidenceQuote；factKind 只使用 observed 或 human_confirmed。citations 必须从下方 availableCitations 中选择。`,
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
          availableCitations: Array.from(boundedCitations),
          contextFacts: boundedFacts,
        }),
      },
    ],
    signal,
    false,
    helpOnlyFacts ? 'off' : undefined,
  )

  await onProgress?.('validating', '正在校验回答的引用真实性与一致性...')

  let summary = '基于已知事实回答如下：'
  let validatedClaims: AssistantKnowledgeAnswerClaim[] = []
  const validatedMissing: AssistantKnowledgeAnswerMissing[] = [...missingList]
  let extractiveHelpFallbackCitation: string | undefined
  let extractiveObservedFallbackCitation: string | undefined
  let extractiveInferenceFallbackCitation: string | undefined

  if (llmResult.ok) {
    for (const c of llmResult.value.claims) {
      // A claim must cite only facts actually sent to the model. Do not drop
      // unknown keys and keep the rest, which would launder an unsupported claim.
      const validCitations = c.citations.filter((cit) => boundedCitations.has(cit))
      if (validCitations.length !== c.citations.length || validCitations.length === 0) {
        validatedMissing.push({ key: 'unsupported_citation', reason: 'unknown_or_truncated_source',
          description: '回答引用了本次未提供给模型的事实，已略去该结论' })
        continue
      }
      const sourceText = citedFactText(validCitations, boundedFacts)
      const sourceQuote = c.factKind !== 'inferred' ? c.evidenceQuote?.trim() : undefined
      const verifiedSourceCitation = sourceQuote && validCitations.find((citation) =>
        citedFactText([citation], boundedFacts).includes(sourceQuote))
      // Confirmed help and observed entity claims display only checked source
      // excerpts. The model's discarded paraphrase is not a validated fact.
      const displayedText = verifiedSourceCitation ? sourceQuote : c.text
      if (unsupportedQuantities(displayedText, sourceText).length > 0) {
        validatedMissing.push({ key: 'unsupported_quantity', reason: 'amount_not_in_cited_facts',
          description: '回答出现引用事实中没有的具体数量，已略去该结论' })
        continue
      }
      if (contradictsPublishedHelp(displayedText, validCitations, boundedFacts)) {
        validatedMissing.push({
          key: 'published_help_contradiction',
          reason: 'contradicts_published_help',
          description: '回答结论与已发布帮助中的明确规则相矛盾，已略去该结论',
        })
        continue
      }
      if (c.factKind === 'inferred') {
        // Verifying premises does not establish the model's conclusion. Keep
        // the cited source useful without publishing an unverified inference.
        if (premisesQuoteCitedFacts(c.premises, sourceText)) {
          extractiveInferenceFallbackCitation ??= validCitations[0]
          validatedMissing.push({
            key: 'unverified_inference',
            reason: 'conclusion_not_verified',
            description: '推论的前提可核对，但结论未获事实证明；已略去推断并保留来源',
          })
        } else {
          validatedMissing.push({
            key: 'unsupported_inference',
            reason: 'premises_not_in_cited_facts',
            description: `推论前提未能在所引事实中逐字核对，已略去该结论: ${c.text.slice(0, 100)}`,
          })
        }
      } else {
        // 官方帮助与实体观测不能仅凭合法引用键互相冒充。
        const sourceMatches = c.factKind === 'human_confirmed'
          ? validCitations.every((citation) => helpCitations.has(citation))
          : validCitations.every((citation) => !helpCitations.has(citation))
        if (validCitations.length > 0 && sourceMatches) {
          if (c.factKind === 'human_confirmed') {
            if (!verifiedSourceCitation || !sourceQuote) {
              extractiveHelpFallbackCitation ??= validCitations[0]
              validatedMissing.push({
                key: 'unverified_help_quote',
                reason: 'quote_not_in_cited_help',
                description: '模型的帮助结论没有可逐字核对的原文，已略去改写',
              })
              continue
            }
            const focusTerms = relevantHelpTerms.get(verifiedSourceCitation)
            if (relevantHelpTerms.size > 0 && !focusTerms?.some((term) =>
              sourceQuote.toLocaleLowerCase().includes(term.toLocaleLowerCase()))) {
              continue
            }
            validatedClaims.push({
              factKind: 'human_confirmed',
              text: sourceQuote,
              citations: [verifiedSourceCitation],
            })
            continue
          }
          if (!verifiedSourceCitation || !sourceQuote) {
            extractiveObservedFallbackCitation ??= validCitations[0]
            validatedMissing.push({
              key: 'unverified_observation_quote',
              reason: 'quote_not_in_cited_fact',
              description: '模型的实体观察结论没有可逐字核对的事实片段，已略去改写',
            })
            continue
          }
          validatedClaims.push({
            factKind: 'observed',
            text: sourceQuote,
            citations: [verifiedSourceCitation],
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
    // Model-written gap descriptions are also user-visible. A fabricated
    // diagnosis can bypass claim validation by appearing in `missing` instead.
    // Keep only the signal that the answer may be incomplete; server-derived
    // missing details above retain their specific, checked descriptions.
    if (!helpOnlyFacts && llmResult.value.missing?.length) {
      validatedMissing.push({
        key: 'unverified_question_scope',
        reason: 'source_gap_not_verified',
        description: '以上只包含可核验的事实；问题的其余部分尚无独立来源，无法确认。',
      })
    }
    if (validatedClaims.length === 0 && extractiveHelpFallbackCitation) {
      const source = boundedFacts.find((fact) => fact.citation === extractiveHelpFallbackCitation)
      if (source) {
        validatedClaims.push({
          factKind: 'human_confirmed',
          text: source.fact.slice(0, 500),
          citations: [source.citation],
        })
      }
    }
    if (validatedClaims.length === 0 && extractiveObservedFallbackCitation) {
      const source = citedFactText([extractiveObservedFallbackCitation], boundedFacts)
      if (source) {
        validatedClaims.push({
          factKind: 'observed',
          text: source.slice(0, 500),
          citations: [extractiveObservedFallbackCitation],
        })
      }
    }
    if (validatedClaims.length === 0 && extractiveInferenceFallbackCitation) {
      const source = citedFactText([extractiveInferenceFallbackCitation], boundedFacts)
      if (source) {
        validatedClaims.push({
          factKind: helpCitations.has(extractiveInferenceFallbackCitation) ? 'human_confirmed' : 'observed',
          text: source.slice(0, 500),
          citations: [extractiveInferenceFallbackCitation],
        })
      }
    }
    // A free-form model summary has no citation of its own. Keep it limited to
    // the retained claims so a rejected conclusion cannot survive there.
    summary = validatedClaims.map((claim) => claim.text).join('\n').slice(0, 2000)
  } else {
    // When generation fails, the retrieved authorized facts are still useful.
    // Prefer the first scoped entity facts. For help-only questions, one top
    // ranked source is enough; appending another help article adds noise.
    const entityFacts = boundedFacts.filter((fact) => !helpCitations.has(fact.citation))
    const fallbackFacts = entityFacts.length > 0
      ? entityFacts.slice(0, 2)
      : boundedFacts.filter((fact) => helpCitations.has(fact.citation)).slice(0, 1)
    for (const fact of fallbackFacts) {
      validatedClaims.push({
        factKind: helpCitations.has(fact.citation) ? 'human_confirmed' : 'observed',
        text: `${fact.label}: ${fact.fact}`.slice(0, 500),
        citations: [fact.citation],
      })
    }
    summary = validatedClaims.map((claim) => claim.text).join('\n').slice(0, 2000)
    validatedMissing.push({
      key: 'model_inference',
      reason: 'generation_failed',
      description: '模型未完成归纳；以上直接列出最相关的已核验资料，可能无法完整回答多事实问题',
    })
  }

  // 实体操作优先于通用帮助目录链接
  const finalNextActions = [...nextActions]
  const fallbackHelpRoutes = llmResult.ok ? null : new Set(
    helpSnippets
      .filter((snippet) => validatedClaims.some((claim) => claim.citations.includes(snippet.id)))
      .map((snippet) => snippet.pageRoute),
  )
  for (const helpAction of helpNextActions) {
    if (finalNextActions.length >= 3) break
    if (fallbackHelpRoutes && !fallbackHelpRoutes.has(helpAction.href)) continue
    if (!finalNextActions.some((a) => a.kind === helpAction.kind)) {
      finalNextActions.push(helpAction)
    }
  }

  await onProgress?.('persisting', '正在整理最终回答...')

  if (validatedClaims.length === 0) {
    const status = buildKnowledgeStatusResult('no_verified_claims')
    return {
      ...status,
      missing: [...status.missing, ...validatedMissing],
      nextActions: finalNextActions.slice(0, 3),
    }
  }

  return {
    kind: 'knowledge_answer',
    summary,
    claims: validatedClaims,
    missing: validatedMissing,
    asOf: new Date().toISOString(),
    nextActions: finalNextActions.slice(0, 3),
  }
}
