import {
  COMPILER_VERSION,
  EXECUTION_SCOPE_PROTOCOL,
  VALIDATION_SUBJECT_PROTOCOL,
  canonicalJson,
  normalizeAuthoringDocument,
  syncSha256,
  type ModuleManifest,
  type OutcomeManifest,
  type RunSnapshot,
  type RuntimeInvariantManifest,
  type ScenarioAuthoringDocumentV2,
  type ScenarioDefinition,
  type SampleValidationState,
} from '@cairn/shared'

export function validationSubjectDigest(input: {
  targetId: string
  document: ScenarioAuthoringDocumentV2
  definition: ScenarioDefinition
  compilerVersion?: number
  moduleManifest?: ModuleManifest | null
  outcomeManifest?: OutcomeManifest | null
  runtimeInvariantManifest?: RuntimeInvariantManifest | null
  mapReferences?: readonly unknown[]
}): string {
  return syncSha256(
    canonicalJson({
      protocolVersion: VALIDATION_SUBJECT_PROTOCOL,
      targetId: input.targetId,
      document: normalizeAuthoringDocument(input.document),
      compilerVersion: input.compilerVersion ?? COMPILER_VERSION,
      definition: input.definition,
      moduleManifest: input.moduleManifest?.entries.length ? input.moduleManifest : null,
      outcomeManifest: input.outcomeManifest ?? null,
      runtimeInvariantManifest: input.runtimeInvariantManifest ?? null,
      mapReferences: [...(input.mapReferences ?? [])].sort((a, b) =>
        canonicalJson(a).localeCompare(canonicalJson(b)),
      ),
    }),
  )
}

export function validationRunDigests(snapshot: RunSnapshot): {
  executionScopeDigest: string
  inputDigest: string
} {
  const {
    runId: _id,
    scenarioVersionId: _version,
    createdAt: _time,
    deadlineAt: _deadline,
    digest: _digest,
    input,
    steps: _steps,
    ...scope
  } = snapshot
  const secretKey = /password|passwd|secret|token|cookie|authorization|api[_-]?key|密码|口令/i
  function withoutSecrets(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(withoutSecrets)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [
        key,
        secretKey.test(key) ? { redacted: true } : withoutSecrets(v),
      ]),
    )
  }
  return {
    executionScopeDigest: syncSha256(
      canonicalJson({ protocolVersion: EXECUTION_SCOPE_PROTOCOL, scope }),
    ),
    inputDigest: syncSha256(canonicalJson(withoutSecrets(input))),
  }
}

export function classifyValidationSample(input: {
  matchesSubject: boolean
  hasContext: boolean
  status: string
  outcomeStatus: string
  evidenceStatus: string
  fullyExecuted: boolean
  interventions: readonly string[]
  requiredConditions: number
  conditionStatuses: readonly string[]
}): { state: SampleValidationState; reasons: string[] } {
  if (!input.hasContext)
    return { state: 'inconclusive', reasons: ['历史运行未记录验证主题与执行范围'] }
  if (!input.matchesSubject) return { state: 'stale', reasons: ['定义或依赖与当前草稿不同'] }
  if (
    input.status === 'FAILED' ||
    input.outcomeStatus === 'FAIL' ||
    input.conditionStatuses.includes('FAIL')
  )
    return { state: 'failed', reasons: [input.status === 'FAILED' ? '执行失败' : '业务条件失败'] }
  if (['QUEUED', 'RUNNING', 'RECOVERING', 'WAITING_FOR_AUTH', 'HOLDING'].includes(input.status))
    return { state: 'running', reasons: ['样本尚未结束'] }
  const reasons: string[] = []
  if (input.status !== 'SUCCEEDED') reasons.push('执行结果不能证明完整成功')
  if (!input.fullyExecuted) reasons.push('存在未完整执行或缺少尝试事实的步骤')
  if (input.interventions.length) reasons.push('存在调试覆盖、人工干预或未确认恢复')
  if (input.requiredConditions < 1) reasons.push('没有 MUST 业务成功条件')
  if (
    !input.conditionStatuses.length ||
    input.conditionStatuses.some((status) => status !== 'PASS') ||
    input.outcomeStatus !== 'PASS'
  )
    reasons.push('业务条件存在未知、警告或未评价结果')
  if (input.evidenceStatus !== 'COMPLETE') reasons.push('运行证据尚未完整结算')
  return { state: reasons.length ? 'inconclusive' : 'sample_passed', reasons }
}
