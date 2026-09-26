import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm'
import { DEFAULT_REPORT_CONFIG, allSuiteMembers, parseReportTitle, reportConfigTitleSources, reportTitleSources, renderReportTitleV2, reportConfigSchema, reportProfileDtoSchema, reportProfileListQuerySchema, saveReportProfileBodySchema, saveScenarioReportDefaultsBodySchema, substituteReportTitle, type JsonValue, type OutputPolicy, type ReportConfig, type ReportTitleSource, type SaveReportProfileBody, type SuiteDocument } from '@cairn/shared'
import type { Db } from '../client.js'
import { atomic, insertIgnoreRows, locked, schemaFor } from '../native.js'
import { newId } from '../id.js'
import { badRequest, conflict, notFound } from '../runs/errors.js'
import { assertTargetPermission, lockConsoleAuthorization } from '../console/target-authorization.js'
import { recordAudit, type AuditActor } from '../audit/record.js'
import { cursorFilter, paginateResults } from '../cursor.js'

export async function assertReportEditor(db: Db, targetId: string, actorId: string, editScope: 'scenario' | 'suite') {
  await assertTargetPermission(db, actorId, targetId, editScope === 'suite' ? 'suite:write' : 'workflow:write')
}

export async function validateReportConfigAssets(db: Db, targetId: string, config: ReportConfig) {
  try {
    if (config.titleSyntaxVersion === 2) {
      if (!reportTitleSources(config.title).length) {
        const issue = parseReportTitle(config.title).find((part) => part.message)
        throw new Error(issue?.message ?? '标题同时使用了单次运行与场景集专用变量')
      }
      renderReportTitleV2(config.title, {}, reportTitleSources(config.title)[0]!)
    } else substituteReportTitle(config.title, {})
  } catch (error) { throw badRequest('REPORT_TITLE_INVALID', (error as Error).message) }
  if (!config.logoArtifactId) return
  const { artifacts, storedObjects } = schemaFor(db)
  const [logo] = await db.select({ artifact: artifacts, object: storedObjects }).from(artifacts)
    .innerJoin(storedObjects, eq(storedObjects.artifactId, artifacts.id)).where(and(eq(artifacts.id, config.logoArtifactId), eq(artifacts.targetId, targetId), eq(artifacts.kind, 'brand_logo'))).limit(1)
  if (!logo || logo.object.status !== 'available' || logo.object.deleteRequestedAt || logo.object.retainUntil <= new Date()) throw badRequest('REPORT_LOGO_UNAVAILABLE', 'Logo 不属于当前目标或已不可用，请重新上传')
}

export function assertReportTitleSource(config: ReportConfig, source: ReportTitleSource) {
  if (config.titleSyntaxVersion === 2) {
    const issues = parseReportTitle(config.title, source).filter((part) => part.kind !== 'text' && part.kind !== 'variable')
    if (issues.length) throw badRequest('REPORT_TITLE_SOURCE_INCOMPATIBLE', issues[0]!.message ?? '标题变量不适用于当前来源', { variables: issues.map((part) => part.key ?? part.raw) })
    return
  }
  // Legacy templates remain readable, but new bindings must be executable for this source.
  const available = source === 'RUN' ? ['systemName', 'scenarioName', 'executedDate', 'executedRange', 'runNumber'] : ['systemName', 'suiteName', 'executedDate', 'executedRange', 'runNumber']
  const invalid = [...config.title.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]!).filter((key) => !available.includes(key))
  if (!reportConfigTitleSources(config).includes(source)) throw badRequest('REPORT_TITLE_SOURCE_INCOMPATIBLE', `标题变量不适用于当前来源：${invalid.join('、') || '请修复旧版标题'}`, { variables: invalid })
}

export async function lockAndValidateReportProfiles(db: Db, targetId: string, document: SuiteDocument) {
  const { reportProfiles } = schemaFor(db)
  const entries = [
    { profileId: document.reportProfileId, source: 'SUITE_RUN' as const },
    ...allSuiteMembers(document).map((member) => ({ profileId: member.reportProfileId, source: 'RUN' as const })),
  ]
  const ids = [...new Set(entries.flatMap((entry) => entry.profileId ? [entry.profileId] : []))].sort()
  if (!ids.length) return
  const rows = await locked(db, db.select().from(reportProfiles).where(inArray(reportProfiles.id, ids)).orderBy(asc(reportProfiles.id)))
  for (const entry of entries) {
    if (!entry.profileId) continue
    const row = rows.find((item) => item.id === entry.profileId && item.targetId === targetId)
    if (!row) throw badRequest('REPORT_PROFILE_NOT_FOUND', '报告配置档不存在或不属于当前目标系统')
    assertReportTitleSource(reportConfigSchema.parse(row.config), entry.source)
  }
}

async function incompatibleProfileBindings(db: Db, targetId: string, profileId: string, config: ReportConfig, actorId: string) {
  const { scenarios, scenarioReportDefaults, scenarioSuites, scenarioSuiteDrafts, scenarioSuiteVersions } = schemaFor(db)
  const visible = async (permission: string) => {
    try { await assertTargetPermission(db, actorId, targetId, permission); return true } catch { return false }
  }
  const canSeeScenarios = await visible('workflow:read')
  const canSeeSuites = await visible('suite:read')
  const conflicts: Array<Record<string, unknown>> = []
  const add = (source: ReportTitleSource, location: Record<string, unknown>) => {
    const issues = parseReportTitle(config.title, source).filter((part) => part.kind !== 'text' && part.kind !== 'variable')
    if (issues.length) conflicts.push({ source, ...location, variables: issues.map((part) => part.key ?? part.raw) })
  }
  const boundScenarios = await db.select({ id: scenarios.id, name: scenarios.name }).from(scenarioReportDefaults)
    .innerJoin(scenarios, eq(scenarios.id, scenarioReportDefaults.scenarioId))
    .where(and(eq(scenarioReportDefaults.profileId, profileId), eq(scenarios.targetId, targetId), isNull(scenarios.deletedAt)))
  for (const scenario of boundScenarios) add('RUN', canSeeScenarios ? { kind: 'scenario', id: scenario.id, name: scenario.name } : { kind: 'scenario', hidden: true })
  const suites = await db.select({ id: scenarioSuites.id, name: scenarioSuites.name }).from(scenarioSuites)
    .where(and(eq(scenarioSuites.targetId, targetId), isNull(scenarioSuites.deletedAt)))
  if (suites.length) {
    const suiteIds = suites.map((suite) => suite.id)
    const drafts = await db.select({ suiteId: scenarioSuiteDrafts.suiteId, document: scenarioSuiteDrafts.document }).from(scenarioSuiteDrafts).where(inArray(scenarioSuiteDrafts.suiteId, suiteIds))
    const versions = await db.select({ suiteId: scenarioSuiteVersions.suiteId, versionNo: scenarioSuiteVersions.versionNo, document: scenarioSuiteVersions.document }).from(scenarioSuiteVersions).where(inArray(scenarioSuiteVersions.suiteId, suiteIds))
    for (const item of [...drafts.map((row) => ({ ...row, versionNo: null })), ...versions]) {
      const suite = suites.find((row) => row.id === item.suiteId)!
      const base = canSeeSuites ? { suiteId: suite.id, name: suite.name, versionNo: item.versionNo } : { hidden: true }
      if (item.document.reportProfileId === profileId) add('SUITE_RUN', { kind: 'suite', ...base })
      for (const member of allSuiteMembers(item.document)) if (member.reportProfileId === profileId) {
        const stageId = item.document.stages?.find((stage) => stage.members.some((entry) => entry.memberId === member.memberId))?.id
        add('RUN', { kind: 'member', ...base, ...(canSeeSuites ? { memberId: member.memberId, stageId } : {}) })
      }
    }
  }
  return conflicts
}

export async function resolveReportProfile(db: Db, targetId: string, profileId?: string | null) {
  if (!profileId) return { config: DEFAULT_REPORT_CONFIG, source: null }
  const { reportProfiles } = schemaFor(db)
  const [profile] = await db.select().from(reportProfiles).where(and(eq(reportProfiles.id, profileId), eq(reportProfiles.targetId, targetId))).limit(1)
  if (!profile) throw badRequest('REPORT_PROFILE_NOT_FOUND', '报告配置档不存在或不属于当前目标系统')
  return { config: reportConfigSchema.parse(profile.config), source: { profileId: profile.id, revision: profile.revision, name: profile.name } }
}

export async function getReportProfile(db: Db, profileId: string, actorId: string) {
  const { reportProfiles } = schemaFor(db)
  const [profile] = await db.select().from(reportProfiles).where(eq(reportProfiles.id, profileId)).limit(1)
  if (!profile) throw notFound('REPORT_PROFILE_NOT_FOUND', '报告配置档不存在')
  await assertTargetPermission(db, actorId, profile.targetId, 'report:read')
  return reportProfileDtoSchema.parse({ ...profile, updatedAt: profile.updatedAt.toISOString() })
}

export async function listReportProfiles(db: Db, query: { targetId: string; limit?: number; cursor?: string }, actorId: string) {
  const input = reportProfileListQuerySchema.parse(query)
  await assertTargetPermission(db, actorId, input.targetId, 'report:read')
  const { reportProfiles } = schemaFor(db)
  const rows = await db.select().from(reportProfiles).where(and(eq(reportProfiles.targetId, input.targetId), cursorFilter(reportProfiles.updatedAt, reportProfiles.id, input.cursor)))
    .orderBy(desc(reportProfiles.updatedAt), desc(reportProfiles.id)).limit(input.limit + 1)
  const page = paginateResults(rows.map((row) => ({ ...row, createdAt: row.updatedAt })), input.limit)
  return { items: page.items.map((row) => reportProfileDtoSchema.parse({ ...row, updatedAt: row.updatedAt.toISOString() })), nextCursor: page.nextCursor }
}

export async function listReportProfileVersions(db: Db, profileId: string, input: { limit?: number; cursor?: string }, actorId: string) {
  const profile = await getReportProfile(db, profileId, actorId)
  const query = reportProfileListQuerySchema.parse({ ...input, targetId: profile.targetId })
  const { reportProfileVersions } = schemaFor(db)
  const rows = await db.select().from(reportProfileVersions).where(and(eq(reportProfileVersions.profileId, profileId), cursorFilter(reportProfileVersions.createdAt, reportProfileVersions.id, query.cursor)))
    .orderBy(desc(reportProfileVersions.createdAt), desc(reportProfileVersions.id)).limit(query.limit + 1)
  const page = paginateResults(rows, query.limit)
  return { items: page.items.map((row) => ({ ...profile, name: row.name, revision: row.revision, config: row.config, updatedAt: row.createdAt.toISOString() })), nextCursor: page.nextCursor }
}

export async function saveReportProfile(db: Db, profileId: string | null, body: SaveReportProfileBody, actor: AuditActor) {
  const input = saveReportProfileBodySchema.parse(body)
  return atomic(db, async (tx) => {
    await lockConsoleAuthorization(tx, actor.id)
    await assertReportEditor(tx, input.targetId, actor.id, input.editScope)
    const config = reportConfigSchema.parse({ ...input.config, titleSyntaxVersion: 2 })
    await validateReportConfigAssets(tx, input.targetId, config)
    if (input.config.selectedEvidenceIds?.length || input.config.screenshotScope === 'selected') throw badRequest('REPORT_PROFILE_SELECTION_INVALID', '配置档不保存某次运行的截图选择，请在生成报告时选图')
    const { reportProfiles, reportProfileVersions, targets } = schemaFor(tx)
    const [target] = await tx.select({ id: targets.id }).from(targets).where(and(eq(targets.id, input.targetId), isNull(targets.deletedAt))).limit(1)
    if (!target) throw notFound('TARGET_NOT_FOUND', '目标系统不存在')
    const id = profileId ?? newId()
    const [existing] = profileId ? await locked(tx, tx.select().from(reportProfiles).where(eq(reportProfiles.id, profileId))) : []
    if (profileId && (!existing || existing.targetId !== input.targetId)) throw notFound('REPORT_PROFILE_NOT_FOUND', '报告配置档不存在')
    if (existing && (existing.revision !== input.expectedRevision || existing.editScope !== input.editScope)) throw conflict('REPORT_PROFILE_REVISION_CONFLICT', '配置档已更新，请刷新后重试；配置档的编辑范围不能更改')
    if (existing) {
      const bindings = await incompatibleProfileBindings(tx, input.targetId, id, config, actor.id)
      if (bindings.length) throw conflict('REPORT_PROFILE_BINDINGS_INCOMPATIBLE', `配置档仍有 ${bindings.length} 处不兼容绑定，请先处理`, { total: bindings.length, bindings })
    }
    const revision = (existing?.revision ?? 0) + 1
    const now = new Date()
    const values = { targetId: input.targetId, name: input.name, config, editScope: input.editScope, revision, updatedByConsoleAccountId: actor.id, updatedAt: now }
    if (existing) await tx.update(reportProfiles).set(values).where(eq(reportProfiles.id, id))
    else await tx.insert(reportProfiles).values({ id, ...values })
    await tx.insert(reportProfileVersions).values({ id: newId(), profileId: id, revision, name: input.name, config, createdByConsoleAccountId: actor.id, createdAt: now })
    await recordAudit(tx, actor, 'report.profile.save', 'report_profile', id, `保存报告配置档第 ${revision} 版`)
    return getReportProfile(tx, id, actor.id)
  })
}

export async function getScenarioReportDefaults(db: Db, scenarioId: string, actorId: string) {
  const { scenarios, scenarioReportDefaults } = schemaFor(db)
  const [scenario] = await db.select().from(scenarios).where(and(eq(scenarios.id, scenarioId), isNull(scenarios.deletedAt))).limit(1)
  if (!scenario) throw notFound('SCENARIO_NOT_FOUND', '场景不存在')
  await assertTargetPermission(db, actorId, scenario.targetId, 'workflow:read')
  const [binding] = await db.select().from(scenarioReportDefaults).where(eq(scenarioReportDefaults.scenarioId, scenarioId)).limit(1)
  return {
    scenarioId,
    profileId: binding?.profileId ?? null,
    revision: binding?.revision ?? 0,
    outputPolicy: binding?.outputPolicy ?? { autoGenerateReport: false, memberReportPolicy: 'inherit' },
  }
}

export async function saveScenarioReportDefaults(db: Db, scenarioId: string, body: { profileId: string | null; expectedRevision: number; outputPolicy?: OutputPolicy }, actor: AuditActor) {
  const input = saveScenarioReportDefaultsBodySchema.parse(body)
  return atomic(db, async (tx) => {
    await lockConsoleAuthorization(tx, actor.id)
    const { scenarios, scenarioReportDefaults } = schemaFor(tx)
    const [scenario] = await locked(tx, tx.select().from(scenarios).where(eq(scenarios.id, scenarioId)))
    if (!scenario || scenario.deletedAt) throw notFound('SCENARIO_NOT_FOUND', '场景不存在')
    await assertReportEditor(tx, scenario.targetId, actor.id, 'scenario')
    if (input.outputPolicy?.autoGenerateReport) {
      await assertTargetPermission(tx, actor.id, scenario.targetId, 'report:export')
    }
    if (input.profileId) {
      const { reportProfiles } = schemaFor(tx)
      const [profile] = await locked(tx, tx.select().from(reportProfiles).where(eq(reportProfiles.id, input.profileId)))
      if (!profile || profile.targetId !== scenario.targetId) throw badRequest('REPORT_PROFILE_NOT_FOUND', '报告配置档不存在或不属于当前目标系统')
      assertReportTitleSource(reportConfigSchema.parse(profile.config), 'RUN')
    }
    const [existing] = await tx.select().from(scenarioReportDefaults).where(eq(scenarioReportDefaults.scenarioId, scenarioId)).limit(1)
    if ((existing?.revision ?? 0) !== input.expectedRevision) throw conflict('REPORT_DEFAULTS_REVISION_CONFLICT', '默认报告配置已更新，请刷新后重试')
    const outputPolicy = input.outputPolicy ?? existing?.outputPolicy ?? { autoGenerateReport: false, memberReportPolicy: 'inherit' }
    const next = { scenarioId, profileId: input.profileId, revision: input.expectedRevision + 1, outputPolicy }
    if (existing) await tx.update(scenarioReportDefaults).set(next).where(eq(scenarioReportDefaults.scenarioId, scenarioId))
    else await tx.insert(scenarioReportDefaults).values(next)
    await recordAudit(tx, actor, 'report.profile.save', 'scenario', scenarioId, '更新场景默认报告配置')
    return next
  })
}

export async function freezeRunReportContext(db: Db, input: {
  runId: string
  scenarioId: string
  targetId: string
  scenarioName: string
  targetName: string
  displayName?: string
  overrideProfileId?: string
  isTrial?: boolean
  isMapJob?: boolean
  debugMode?: string
  purpose?: string
  suppressMemberReport?: boolean
}) {
  await lockReportDefaults(db, [input.scenarioId], input.overrideProfileId ? [input.overrideProfileId] : [])
  const { scenarioReportDefaults, runReportContexts, reportTriggers } = schemaFor(db)
  const [binding] = await db.select().from(scenarioReportDefaults).where(eq(scenarioReportDefaults.scenarioId, input.scenarioId)).limit(1)
  const baseline = await resolveReportProfile(db, input.targetId, binding?.profileId)
  const override = input.overrideProfileId ? await resolveReportProfile(db, input.targetId, input.overrideProfileId) : null
  const config = reportConfigSchema.parse({ ...baseline.config, ...override?.config })
  const configSources: Record<string, JsonValue> = { scenario: baseline.source, member: override?.source ?? null }
  const outputPolicy = binding?.outputPolicy ?? { autoGenerateReport: false, memberReportPolicy: 'inherit' }
  await db.insert(runReportContexts).values({
    runId: input.runId,
    displayName: input.displayName ?? input.scenarioName ?? '未命名场景',
    targetName: input.targetName ?? '默认目标',
    timeZone: config.timeZone,
    reportConfig: config,
    configSources,
    outputPolicy,
  })
  const isEligible =
    !input.isTrial &&
    !input.isMapJob &&
    (input.debugMode == null || input.debugMode === 'runThrough') &&
    (input.purpose == null || input.purpose === 'user') &&
    !input.suppressMemberReport

  if (isEligible && outputPolicy.autoGenerateReport) {
    const now = new Date()
    await insertIgnoreRows(db, reportTriggers, {
      subjectKind: 'RUN',
      subjectId: input.runId,
      status: 'pending',
      idempotencyKey: `auto-run-report:${input.runId}`,
      createdAt: now,
      updatedAt: now,
    })
  }
}

/** Lock the entire suite's defaults in a stable order before freezing any member. */
export async function lockReportDefaults(db: Db, scenarioIds: string[], extraProfileIds: string[]) {
  const { scenarios, scenarioReportDefaults, reportProfiles } = schemaFor(db)
  if (scenarioIds.length) await locked(db, db.select({ id: scenarios.id }).from(scenarios).where(inArray(scenarios.id, scenarioIds)).orderBy(asc(scenarios.id)))
  const bindings = scenarioIds.length ? await db.select().from(scenarioReportDefaults).where(inArray(scenarioReportDefaults.scenarioId, scenarioIds)) : []
  const ids = [...new Set([...extraProfileIds, ...bindings.flatMap((row) => row.profileId ? [row.profileId] : [])])]
  if (ids.length) await locked(db, db.select({ id: reportProfiles.id }).from(reportProfiles).where(inArray(reportProfiles.id, ids)).orderBy(asc(reportProfiles.id)))
}
