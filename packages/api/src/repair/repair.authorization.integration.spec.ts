import { NotFoundException } from '@nestjs/common'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adoptRepairCandidate, createRepairCandidate, getRepairCandidate, rejectRepairCandidate, reopenRepairCandidate, validateRepairCandidate } from '@cairn/db'
import {
  and,
  consoleAccountRoles,
  consoleAccounts,
  eq,
  grantScopedPermissions,
  newId,
  openIsolatedDb,
  scenarios,
  targets,
  type DbHandle,
} from '@cairn/db/testing'
import type { RequestAccount } from '../common/request-account'
import { RepairService } from './repair.service'

const SCHEMA = `cairn_test_${Date.now().toString(36)}_repair_scope`

describe('修复候选按目标授权（真实库）', { timeout: 30_000 }, () => {
  let handle: DbHandle
  let service: RepairService
  let actor: RequestAccount
  let splitScopeActor: RequestAccount
  let ownCandidate: Awaited<ReturnType<typeof createRepairCandidate>>
  let foreignCandidate: Awaited<ReturnType<typeof createRepairCandidate>>
  let collisionCandidate: Awaited<ReturnType<typeof createRepairCandidate>>

  beforeAll(async () => {
    handle = await openIsolatedDb(SCHEMA)
    service = new RepairService(handle)
    const actorId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'Repair Scope Viewer',
      email: `repair-scope-${actorId}@example.com`,
      status: 'active',
    })
    await grantScopedPermissions(handle.db, actorId, ['target:read', 'run:read', 'run:execute', 'workflow:write'])
    actor = {
      id: actorId,
      displayName: 'Repair Scope Viewer',
      email: `repair-scope-${actorId}@example.com`,
      status: 'active',
      roles: [],
      permissions: ['target:read', 'run:read', 'run:execute', 'workflow:write'],
    }

    const ownTargetId = newId()
    const foreignTargetId = newId()
    await handle.db.insert(targets).values([
      { id: ownTargetId, code: `repair-${ownTargetId.replaceAll('-', '')}`, name: 'Own target', entryUrl: 'https://example.com' },
      { id: foreignTargetId, code: `repair-${foreignTargetId.replaceAll('-', '')}`, name: 'Foreign target', entryUrl: 'https://example.org' },
    ])
    await handle.db.update(consoleAccountRoles).set({ targetScopeMode: 'selected', targetScopeIds: [ownTargetId] })
      .where(eq(consoleAccountRoles.consoleAccountId, actorId))

    const splitScopeId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: splitScopeId,
      displayName: 'Split Scope Viewer',
      email: `repair-split-${splitScopeId}@example.com`,
      status: 'active',
    })
    const readRoleId = await grantScopedPermissions(handle.db, splitScopeId, ['target:read', 'run:read', 'run:execute'])
    const writeRoleId = await grantScopedPermissions(handle.db, splitScopeId, ['workflow:write'])
    await handle.db.update(consoleAccountRoles).set({ targetScopeMode: 'selected', targetScopeIds: [ownTargetId] })
      .where(and(eq(consoleAccountRoles.consoleAccountId, splitScopeId), eq(consoleAccountRoles.consoleRoleId, readRoleId)))
    await handle.db.update(consoleAccountRoles).set({ targetScopeMode: 'selected', targetScopeIds: [foreignTargetId] })
      .where(and(eq(consoleAccountRoles.consoleAccountId, splitScopeId), eq(consoleAccountRoles.consoleRoleId, writeRoleId)))
    splitScopeActor = { ...actor, id: splitScopeId, permissions: ['target:read', 'run:read', 'run:execute', 'workflow:write'] }

    const ownScenarioId = newId()
    const foreignScenarioId = newId()
    await handle.db.insert(scenarios).values([
      { id: ownScenarioId, targetId: ownTargetId, name: 'Own repair', createdByConsoleAccountId: actorId },
      { id: foreignScenarioId, targetId: foreignTargetId, name: 'Foreign repair', createdByConsoleAccountId: actorId },
    ])

    const guardResults = {
      allowedFields: { name: 'allowedFields', status: 'passed', reason: 'ok' },
      unchangedBusinessGoal: { name: 'unchangedBusinessGoal', status: 'passed', reason: 'ok' },
      sideEffectSafety: { name: 'sideEffectSafety', status: 'passed', reason: 'ok' },
      contextIntegrity: { name: 'contextIntegrity', status: 'passed', reason: 'ok' },
      overallPassed: true,
    } as const
    const digestManifest = {
      sourceDefinitionDigest: 'a'.repeat(64),
      postPatchExecutionDigest: 'b'.repeat(64),
      originalContractDigest: 'c'.repeat(64),
      algorithmVersion: 'v1',
    } as const
    const create = (scenarioId: string, candidateId = `rep_${newId().replaceAll('-', '')}`) => createRepairCandidate(handle, {
      candidateId,
      scenarioId,
      sourceAttemptId: newId(),
      patchTargetRef: { kind: 'scenario', scenarioId, stepId: newId(), sourceDefinitionDigest: 'a'.repeat(64) },
      patch: { kind: 'REPLACE_LOCATOR', suggestedCandidate: { by: 'css', value: '#submit' } },
      hypothesis: 'Changed selector',
      digestManifest,
      guardResults,
    })
    ownCandidate = await create(ownScenarioId)
    foreignCandidate = await create(foreignScenarioId)
    collisionCandidate = await create(foreignScenarioId, ownCandidate.id)
  })

  afterAll(async () => { await handle?.close() })

  async function expectHidden(task: Promise<unknown>) {
    try {
      await task
      expect.unreachable('范围外候选应返回 404')
    } catch (error) {
      expect(error).toBeInstanceOf(NotFoundException)
      expect((error as NotFoundException).getResponse()).toMatchObject({ code: 'TARGET_NOT_FOUND' })
    }
  }

  it('UUID 与 rep_ ID 均按候选所属目标隐藏，范围内可正常读取', async () => {
    expect((await service.getCandidate(ownCandidate.id, actor.id)).id).toBe(ownCandidate.id)
    expect((await service.getCandidate(ownCandidate.candidateId, actor.id)).id).toBe(ownCandidate.id)
    await expectHidden(service.getCandidate(foreignCandidate.id, actor.id))
    await expectHidden(service.getCandidate(foreignCandidate.candidateId, actor.id))
  })

  it('验证、采纳、驳回、重开都先拒绝范围外候选，且不产生副作用', async () => {
    await expectHidden(service.validateCandidate(foreignCandidate.candidateId, {}, actor))
    await expectHidden(service.adoptCandidate(foreignCandidate.id, { expectedRevision: 1 }, actor.id))
    await expectHidden(service.rejectCandidate(foreignCandidate.candidateId, { reason: 'no' }, actor.id))
    await expectHidden(service.reopenCandidate(foreignCandidate.id, actor.id))
    expect((await getRepairCandidate(handle, foreignCandidate.id))?.status).toBe('proposed')

    const rejected = await service.rejectCandidate(ownCandidate.candidateId, { reason: 'needs review' }, actor.id)
    expect(rejected.status).toBe('rejected')
    const reopened = await service.reopenCandidate(ownCandidate.id, actor.id)
    expect(reopened.status).toBe('proposed')
  })

  it('目标可读但操作权限落在另一目标时仍返回 404', async () => {
    expect((await service.getCandidate(ownCandidate.id, splitScopeActor.id)).id).toBe(ownCandidate.id)
    await expectHidden(service.validateCandidate(ownCandidate.id, {}, splitScopeActor))
    await expectHidden(service.adoptCandidate(ownCandidate.candidateId, { expectedRevision: 1 }, splitScopeActor.id))
    await expectHidden(service.rejectCandidate(ownCandidate.id, {}, splitScopeActor.id))
    await expectHidden(service.reopenCandidate(ownCandidate.candidateId, splitScopeActor.id))
    expect((await getRepairCandidate(handle, ownCandidate.id))?.status).toBe('proposed')
  })

  it('UUID 主键与另一候选的 candidateId 相撞时仍只操作主键记录', async () => {
    expect((await service.getCandidate(ownCandidate.id, actor.id)).id).toBe(ownCandidate.id)
    const rejected = await service.rejectCandidate(ownCandidate.id, {}, actor.id)
    expect(rejected.id).toBe(ownCandidate.id)
    expect((await getRepairCandidate(handle, collisionCandidate.id))?.status).toBe('proposed')
  })

  it('数据库写入事务也重查目标范围，不能绕过服务层前置检查', async () => {
    const before = await getRepairCandidate(handle, ownCandidate.id)
    await expect(validateRepairCandidate(handle, ownCandidate.id, {
      actor: { id: splitScopeActor.id }, scopeActorId: splitScopeActor.id,
    })).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' })
    await expect(adoptRepairCandidate(handle, {
      idOrCandidateId: ownCandidate.id, expectedRevision: 1, adoptedBy: splitScopeActor.id, scopeActorId: splitScopeActor.id,
    })).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' })
    await expect(rejectRepairCandidate(handle, ownCandidate.id, splitScopeActor.id, undefined, splitScopeActor.id))
      .rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' })
    await expect(reopenRepairCandidate(handle, ownCandidate.id, splitScopeActor.id, splitScopeActor.id))
      .rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' })
    expect((await getRepairCandidate(handle, ownCandidate.id))?.status).toBe(before?.status)
  })
})
