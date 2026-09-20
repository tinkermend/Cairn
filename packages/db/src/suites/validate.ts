import { and, eq, isNull } from 'drizzle-orm'
import {
  assertPublishedSuiteDocument,
  assertRunFromResolved,
  ScenarioValidationError,
  type JsonValue,
  type SuiteDocument,
  type SuiteValidationIssue,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { schemaFor } from '../native.js'
import { resolveReportProfile } from '../reports/profiles.js'

export async function validateSuiteDocument(
  db: Db,
  targetId: string,
  document: SuiteDocument,
): Promise<SuiteValidationIssue[]> {
  const issues: SuiteValidationIssue[] = [...assertPublishedSuiteDocument(document)]
  const { scenarios, scenarioVersions, targetAccounts } = schemaFor(db)
  for (const source of [{ profileId: document.reportProfileId, memberId: undefined }, ...document.members.map((member) => ({ profileId: member.reportProfileId, memberId: member.memberId }))]) {
    if (!source.profileId) continue
    try { await resolveReportProfile(db, targetId, source.profileId) }
    catch { issues.push({ memberId: source.memberId, code: 'REPORT_PROFILE_NOT_FOUND', message: '报告配置档不存在或不属于当前目标系统', severity: 'error' }) }
  }
  let previousAccountId: string | undefined
  for (const member of document.members) {
    const [scenario] = await db
      .select()
      .from(scenarios)
      .where(and(eq(scenarios.id, member.scenarioId), isNull(scenarios.deletedAt)))
      .limit(1)
    if (!scenario) {
      issues.push({ memberId: member.memberId, code: 'SCENARIO_NOT_FOUND', message: '成员场景不存在', severity: 'error' })
      continue
    }
    if (scenario.targetId !== targetId) {
      issues.push({ memberId: member.memberId, code: 'SCENARIO_TARGET_MISMATCH', message: '成员场景不属于该目标系统', severity: 'error' })
    }
    if (scenario.status === 'disabled') {
      issues.push({ memberId: member.memberId, code: 'SCENARIO_DISABLED', message: '成员场景已停用', severity: 'error' })
    }
    const [version] = await db
      .select()
      .from(scenarioVersions)
      .where(eq(scenarioVersions.id, member.scenarioVersionId))
      .limit(1)
    if (!version || version.scenarioId !== member.scenarioId) {
      issues.push({ memberId: member.memberId, code: 'SCENARIO_VERSION_NOT_FOUND', message: '成员场景版本不存在', severity: 'error' })
      continue
    }
    if (version.kind !== 'published') {
      issues.push({ memberId: member.memberId, code: 'SCENARIO_VERSION_NOT_PUBLISHED', message: '集合只能引用已发布版本', severity: 'error' })
    }
    try {
      assertRunFromResolved(version.definition.steps, { ...document.sharedInput, ...member.input })
    } catch (error) {
      issues.push({
        memberId: member.memberId,
        code: error instanceof ScenarioValidationError ? error.code : 'SUITE_INPUT_INVALID',
        message: error instanceof Error ? error.message : '成员输入无效',
        severity: 'error',
      })
    }
    const accountId = member.targetAccountId ?? document.defaultTargetAccountId
    if (accountId) {
      const [account] = await db
        .select()
        .from(targetAccounts)
        .where(and(eq(targetAccounts.id, accountId), isNull(targetAccounts.deletedAt)))
        .limit(1)
      if (!account || account.targetId !== targetId) {
        issues.push({ memberId: member.memberId, code: 'RUN_ACCOUNT_MISMATCH', message: '目标账号不属于该目标系统', severity: 'error' })
      } else if (account.status === 'disabled') {
        issues.push({ memberId: member.memberId, code: 'RUN_ACCOUNT_DISABLED', message: '目标账号已停用', severity: 'error' })
      }
    }
    if (previousAccountId && accountId === previousAccountId) {
      issues.push({
        memberId: member.memberId,
        code: 'ENTRY_NAVIGATION_WARNING',
        message: '与上一成员共用账号，页面入口可能不是该场景预期起点',
        severity: 'warning',
      })
    }
    previousAccountId = accountId
  }
  return issues
}

export function mergeMemberInput(document: SuiteDocument, memberId: string, runOverride?: Record<string, JsonValue>) {
  const member = document.members.find((item) => item.memberId === memberId)
  return {
    ...(document.sharedInput ?? {}),
    ...(member?.input ?? {}),
    ...(runOverride ?? {}),
  }
}
