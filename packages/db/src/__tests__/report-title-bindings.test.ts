import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { DEFAULT_REPORT_CONFIG, EMPTY_SUITE_DOCUMENT, suiteDocumentSchema } from '@cairn/shared'
import { newId } from '../id.js'
import { schemaFor } from '../native.js'
import { openContractDb } from './contract-fixture.js'
import { createScenarioWithVersion, createSuite, saveReportProfile, saveScenarioReportDefaults, type NativeHandle } from '../test-entry.js'
import { assertReportTitleSource } from '../reports/profiles.js'

describe('报告标题绑定兼容性（PostgreSQL）', { timeout: 90_000 }, () => {
  let handle: NativeHandle
  let targetId: string
  let actorId: string
  let scenarioId: string
  let versionId: string
  let profileId: string

  beforeAll(async () => {
    handle = await openContractDb('postgres', `title_${Date.now()}`)
    const { consoleAccounts, consoleRoles, consoleAccountRoles, targets } = schemaFor(handle.db)
    actorId = newId(); targetId = newId()
    await handle.db.insert(consoleAccounts).values({ id: actorId, displayName: '标题测试', email: `${actorId}@example.com`, status: 'active' })
    const [admin] = await handle.db.select().from(consoleRoles).where(eq(consoleRoles.key, 'admin'))
    await handle.db.insert(consoleAccountRoles).values({ consoleAccountId: actorId, consoleRoleId: admin!.id, targetScopeMode: 'all' })
    await handle.db.insert(targets).values({ id: targetId, code: `title-${targetId}`, name: '标题目标', entryUrl: 'https://example.com' })
    const scenario = await createScenarioWithVersion(handle.db, { targetId, name: '标题场景', actor: { id: actorId }, steps: [{ id: newId(), name: '回显', type: 'echo', effectType: 'READ_ONLY', input: { value: 'ok' } }] })
    scenarioId = scenario.id; versionId = scenario.published!.versionId
    const profile = await saveReportProfile(handle.db, null, { targetId, name: '标题配置', editScope: 'scenario', config: { ...DEFAULT_REPORT_CONFIG, title: '{systemName}' } }, { id: actorId })
    profileId = profile.id
  })
  afterAll(async () => { await handle?.close() })

  it('更新时列出场景默认、草稿、所有发布版本及平铺/阶段成员，且不写入新版本', async () => {
    await saveScenarioReportDefaults(handle.db, scenarioId, { profileId, expectedRevision: 0 }, { id: actorId })
    const { scenarioSuites, scenarioSuiteDrafts, scenarioSuiteVersions, reportProfiles, reportProfileVersions, consoleAuditEvents } = schemaFor(handle.db)
    const member = { memberId: 'm1', ordinal: 0, scenarioId, scenarioVersionId: versionId, input: {}, reportProfileId: profileId }
    const flat = suiteDocumentSchema.parse({ ...EMPTY_SUITE_DOCUMENT, reportProfileId: profileId, members: [member] })
    const staged = suiteDocumentSchema.parse({ ...EMPTY_SUITE_DOCUMENT, reportProfileId: profileId, members: [], stages: [{ id: 'first', name: '前序阶段', ordinal: 0, members: [member] }] })
    const suiteId = newId()
    await handle.db.insert(scenarioSuites).values({ id: suiteId, targetId, name: '绑定集合', createdByConsoleAccountId: actorId })
    await handle.db.insert(scenarioSuiteDrafts).values({ suiteId, revision: 1, document: flat, updatedByConsoleAccountId: actorId })
    await handle.db.insert(scenarioSuiteVersions).values([
      { id: newId(), suiteId, versionNo: 1, document: flat, digest: 'a', publishedByConsoleAccountId: actorId },
      { id: newId(), suiteId, versionNo: 2, document: staged, digest: 'b', publishedByConsoleAccountId: actorId },
    ])
    const auditsBefore = await handle.db.select().from(consoleAuditEvents).where(eq(consoleAuditEvents.resourceId, profileId))
    const update = { targetId, name: '标题配置', editScope: 'scenario' as const, expectedRevision: 1, config: { ...DEFAULT_REPORT_CONFIG, title: '{suiteName}' } }
    let caught: any
    try { await saveReportProfile(handle.db, profileId, update, { id: actorId }) } catch (error) { caught = error }
    expect(caught?.code).toBe('REPORT_PROFILE_BINDINGS_INCOMPATIBLE')
    expect(caught?.details?.bindings).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'scenario' }), expect.objectContaining({ kind: 'member', versionNo: 2 })]))
    const [profile] = await handle.db.select().from(reportProfiles).where(eq(reportProfiles.id, profileId))
    const versions = await handle.db.select().from(reportProfileVersions).where(eq(reportProfileVersions.profileId, profileId))
    expect(profile?.revision).toBe(1)
    expect(versions).toHaveLength(1)
    expect(await handle.db.select().from(consoleAuditEvents).where(eq(consoleAuditEvents.resourceId, profileId))).toHaveLength(auditsBefore.length)
    const suiteOnly = { ...update, config: { ...DEFAULT_REPORT_CONFIG, title: '{scenarioName}' } }
    await expect(saveReportProfile(handle.db, profileId, suiteOnly, { id: actorId })).rejects.toMatchObject({ code: 'REPORT_PROFILE_BINDINGS_INCOMPATIBLE' })
  })

  it('并发绑定与更新不能留下不兼容组合', async () => {
    const profile = await saveReportProfile(handle.db, null, { targetId, name: '并发配置', editScope: 'scenario', config: { ...DEFAULT_REPORT_CONFIG, title: '{systemName}' } }, { id: actorId })
    const second = await createScenarioWithVersion(handle.db, { targetId, name: '并发场景', actor: { id: actorId }, steps: [{ id: newId(), name: '回显', type: 'echo', effectType: 'READ_ONLY', input: { value: 'ok' } }] })
    const results = await Promise.allSettled([
      saveScenarioReportDefaults(handle.db, second.id, { profileId: profile.id, expectedRevision: 0 }, { id: actorId }),
      saveReportProfile(handle.db, profile.id, { targetId, name: '并发配置', editScope: 'scenario', expectedRevision: 1, config: { ...DEFAULT_REPORT_CONFIG, title: '{suiteName}' } }, { id: actorId }),
    ])
    expect(results.some((result) => result.status === 'rejected')).toBe(true)
    const { reportProfiles, scenarioReportDefaults } = schemaFor(handle.db)
    const [saved] = await handle.db.select().from(reportProfiles).where(eq(reportProfiles.id, profile.id))
    const [binding] = await handle.db.select().from(scenarioReportDefaults).where(eq(scenarioReportDefaults.scenarioId, second.id))
    expect(!(saved?.config.title === '{suiteName}' && binding?.profileId === profile.id)).toBe(true)
  })

  it('新场景与平铺/阶段集合绑定按实际消费来源拒绝不兼容标题', async () => {
    expect(() => assertReportTitleSource({ ...DEFAULT_REPORT_CONFIG, title: '{unknown1}' }, 'RUN')).toThrow()
    await expect(saveReportProfile(handle.db, null, { targetId, name: '互斥变量', editScope: 'scenario', config: { ...DEFAULT_REPORT_CONFIG, title: '{scenarioName} {suiteName}' } }, { id: actorId })).rejects.toMatchObject({ code: 'REPORT_TITLE_INVALID' })
    const runOnly = await saveReportProfile(handle.db, null, { targetId, name: '仅运行', editScope: 'suite', config: { ...DEFAULT_REPORT_CONFIG, title: '{scenarioName}' } }, { id: actorId })
    const suiteOnly = await saveReportProfile(handle.db, null, { targetId, name: '仅集合', editScope: 'scenario', config: { ...DEFAULT_REPORT_CONFIG, title: '{suiteName}' } }, { id: actorId })
    await expect(saveScenarioReportDefaults(handle.db, scenarioId, { profileId: suiteOnly.id, expectedRevision: 1 }, { id: actorId })).rejects.toMatchObject({ code: 'REPORT_TITLE_SOURCE_INCOMPATIBLE' })
    const member = { memberId: 'm1', ordinal: 0, scenarioId, scenarioVersionId: versionId, input: {} }
    const flat = suiteDocumentSchema.parse({ ...EMPTY_SUITE_DOCUMENT, reportProfileId: runOnly.id, members: [member] })
    await expect(createSuite(handle.db, { targetId, name: '错误总报告', document: flat }, { id: actorId })).rejects.toMatchObject({ code: 'REPORT_TITLE_SOURCE_INCOMPATIBLE' })
    const staged = suiteDocumentSchema.parse({ ...EMPTY_SUITE_DOCUMENT, members: [], stages: [{ id: 's1', name: '第一阶段', ordinal: 0, members: [{ ...member, reportProfileId: suiteOnly.id }] }] })
    await expect(createSuite(handle.db, { targetId, name: '错误阶段成员', document: staged }, { id: actorId })).rejects.toMatchObject({ code: 'REPORT_TITLE_SOURCE_INCOMPATIBLE' })
  })
})
