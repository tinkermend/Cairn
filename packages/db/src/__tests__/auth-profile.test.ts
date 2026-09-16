import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  FACTORY_SESSION_AUTH,
  evaluateAuthVerify,
  targetAuthProfileDefinitionSchema,
  type Step,
} from '@cairn/shared'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import { schemaFor } from '../native.js'
import { newId } from '../id.js'
import {
  createRunWithSnapshot,
  createScenarioWithVersion,
  DomainError,
  getTargetAuthProfileView,
  observeAuthProfileValidation,
  occupyAutoLoginBudget,
  publishTargetAuthProfile,
  startAuthProfileValidation,
  updateTargetAccountIdentity,
  type NativeHandle as DbHandle,
} from '../test-entry.js'
import { getOrCreatePlatformConfig, updatePlatformConfig } from '../platform-config/store.js'

const echoStep: Step = {
  id: '00000000-0000-4000-8000-0000000000c1',
  name: '回显',
  type: 'echo',
  effectType: 'READ_ONLY',
  input: { value: 'hello' },
}

const definition = targetAuthProfileDefinitionSchema.parse({
  verify: {
    mode: 'http',
    success: { status: 200, jsonPath: '$.ok', equals: true },
    failure: { status: 401 },
  },
  identity: { source: 'json', jsonPath: '$.user', normalize: 'trim' },
  scope: { origins: ['https://example.com'], pathPrefixes: ['/api/me'] },
})

describe.each(DRIVERS)('%s 登录核验与身份', { timeout: 60_000 }, (driver) => {
  let handle: DbHandle
  let actorId: string
  let targetId: string

  beforeAll(async () => {
    handle = await openContractDb(driver, `authp_${Date.now().toString(36)}`)
    const { consoleAccounts, targets } = schemaFor(handle.db)
    actorId = newId()
    targetId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'auth-profile',
      email: `auth-${actorId}@example.com`,
      status: 'active',
    })
    await handle.db.insert(targets).values({
      id: targetId,
      code: `auth-${targetId.slice(0, 8)}`,
      name: '核验夹具',
      entryUrl: 'https://example.com/app',
    })
  })

  afterAll(async () => {
    await handle.close()
  })

  async function makeAccount(label: string): Promise<string> {
    const { targetAccounts } = schemaFor(handle.db)
    const id = newId()
    await handle.db.insert(targetAccounts).values({
      id,
      targetId,
      displayName: label,
      username: `u-${label}`,
      status: 'active',
    })
    return id
  }

  it('SM36 越界新鲜度发布被拒绝，范围内发布后新 Run 冻结修订', async () => {
    const accountId = await makeAccount('sm36')
    await expect(
      publishTargetAuthProfile(handle.db, {
        targetId,
        expectedRevision: 0,
        definition: { ...definition, freshnessSeconds: 10 },
        actor: { id: actorId },
      }),
    ).rejects.toMatchObject({ code: 'AUTH_FRESHNESS_OUT_OF_RANGE' })

    const published = await publishTargetAuthProfile(handle.db, {
      targetId,
      expectedRevision: 0,
      definition: { ...definition, freshnessSeconds: 120 },
      actor: { id: actorId },
    })
    expect(published.current?.revision).toBe(1)

    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `auth-${newId()}`,
      steps: [echoStep],
      actor: { id: actorId },
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      targetAccountId: accountId,
      actor: { id: actorId },
    })
    expect(created.detail.snapshot.authVerification).toMatchObject({
      profileRevision: 1,
      freshnessSeconds: 120,
      capability: 'LEGACY',
    })
  })

  it('SM27 改身份只影响新 Run', async () => {
    const accountId = await makeAccount('sm27')
    const view = await getTargetAuthProfileView(handle.db, targetId)
    const revision = view.current?.revision ?? 0
    if (revision === 0) {
      await publishTargetAuthProfile(handle.db, {
        targetId,
        expectedRevision: 0,
        definition,
        actor: { id: actorId },
      })
    }
    const account = (await getTargetAuthProfileView(handle.db, targetId)).accounts.find((item) => item.accountId === accountId)
    await updateTargetAccountIdentity(handle.db, {
      targetId,
      accountId,
      expectedRevision: account?.configRevision ?? 1,
      expectedIdentity: 'alice',
      actor: { id: actorId },
    })
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `auth-id-${newId()}`,
      steps: [echoStep],
      actor: { id: actorId },
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      targetAccountId: accountId,
      actor: { id: actorId },
    })
    expect(created.detail.snapshot.authVerification?.expectedIdentity).toBe('alice')
  })

  it('SM09 预算占用在提交前计数，跨调用共享', async () => {
    const accountId = await makeAccount('sm09')
    const first = await occupyAutoLoginBudget(handle.db, { targetId, targetAccountId: accountId })
    const second = await occupyAutoLoginBudget(handle.db, { targetId, targetAccountId: accountId })
    expect(first).toMatchObject({ ok: true })
    expect(second).toMatchObject({ ok: false, code: 'AUTH_AUTO_LOGIN_PAUSED' })
  })

  it('SM35 验收观察必须来自核验端口，三项通过后升 IDENTITY_VERIFIED', async () => {
    const accountId = await makeAccount('sm35')
    const existing = await getTargetAuthProfileView(handle.db, targetId)
    const published =
      existing.current ??
      (
        await publishTargetAuthProfile(handle.db, {
          targetId,
          expectedRevision: existing.history[0]?.revision ?? 0,
          definition,
          actor: { id: actorId },
        })
      ).current
    if (!published) throw new Error('expected published profile')
    const account = (await getTargetAuthProfileView(handle.db, targetId)).accounts.find((item) => item.accountId === accountId)!
    await updateTargetAccountIdentity(handle.db, {
      targetId,
      accountId,
      expectedRevision: account.configRevision,
      expectedIdentity: 'alice',
      actor: { id: actorId },
    })
    const started = await startAuthProfileValidation(handle.db, {
      targetId,
      targetAccountId: accountId,
      expectedRevision: published.revision,
      idempotencyKey: `sm35-${accountId}`,
      actor: { id: actorId },
    })
    await expect(
      observeAuthProfileValidation(handle.db, {
        targetId,
        operationId: started.operation.id,
        step: 'valid_pass',
        observation: {
          authState: 'AUTHENTICATED',
          identityState: 'MATCH',
          observedIdentity: 'alice',
          unknownClass: null,
          evidenceSummary: 'handwritten',
          authProfileRevision: published!.revision,
          diagnosticCode: 'handmade',
        },
        actor: { id: actorId },
      }),
    ).rejects.toBeInstanceOf(DomainError)

    const pass = evaluateAuthVerify({
      definition,
      raw: { kind: 'http', status: 200, body: { ok: true, user: 'alice' }, url: 'https://example.com/api/me' },
      expectedIdentity: 'alice',
      revision: published.revision,
    })
    const revoked = evaluateAuthVerify({
      definition,
      raw: { kind: 'http', status: 401, body: {}, url: 'https://example.com/api/me' },
      expectedIdentity: 'alice',
      revision: published.revision,
    })
    const other = evaluateAuthVerify({
      definition,
      raw: { kind: 'http', status: 200, body: { ok: true, user: 'bob' }, url: 'https://example.com/api/me' },
      expectedIdentity: 'alice',
      revision: published.revision,
    })
    const { sessionOperations } = schemaFor(handle.db)
    await handle.db
      .update(sessionOperations)
      .set({ status: 'WAITING_FOR_AUTH' })
      .where(eq(sessionOperations.id, started.operation.id))
    await observeAuthProfileValidation(handle.db, {
      targetId,
      operationId: started.operation.id,
      step: 'valid_pass',
      observation: pass,
      actor: { id: actorId },
    })
    await observeAuthProfileValidation(handle.db, {
      targetId,
      operationId: started.operation.id,
      step: 'server_revoked',
      observation: revoked,
      actor: { id: actorId },
    })
    const finished = await observeAuthProfileValidation(handle.db, {
      targetId,
      operationId: started.operation.id,
      step: 'other_account',
      observation: other,
      actor: { id: actorId },
    })
    expect(finished.status).toBe('SUCCEEDED')
    const after = await getTargetAuthProfileView(handle.db, targetId)
    const row = after.accounts.find((item) => item.accountId === accountId)
    expect(row?.capability).toBe('IDENTITY_VERIFIED')
  })

  it('SM44B 收窄新鲜度范围使已发布 Target 越界时保存被拒绝', async () => {
    const current = await getOrCreatePlatformConfig(handle.db)
    await expect(
      updatePlatformConfig(handle.db, {
        expectedRevision: current.revision,
        document: {
          ...current.document,
          sessionAuth: { ...FACTORY_SESSION_AUTH, freshnessSecondsMin: 300, freshnessSecondsDefault: 300 },
        },
        reason: '收窄新鲜度',
        actor: { id: actorId },
      }),
    ).rejects.toMatchObject({ code: 'AUTH_FRESHNESS_OUT_OF_RANGE' })
  })
})
