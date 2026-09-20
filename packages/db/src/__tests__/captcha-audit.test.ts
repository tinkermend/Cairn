import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import { schemaFor } from '../native.js'
import { newId } from '../id.js'
import { getSessionOperation, recordCaptchaLoginAttempt, requestSessionOperation, type NativeHandle as DbHandle } from '../test-entry.js'

describe.each(DRIVERS)('%s 验证码登录账本', { timeout: 60_000 }, (driver) => {
  let handle: DbHandle
  let targetId: string
  let accountId: string

  beforeAll(async () => {
    handle = await openContractDb(driver, `captcha_${Date.now().toString(36)}`)
    const { consoleAccounts, targets, targetAccounts } = schemaFor(handle.db)
    const actorId = newId()
    targetId = newId()
    accountId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'captcha-audit',
      email: `captcha-${actorId}@example.com`,
      status: 'active',
    })
    await handle.db.insert(targets).values({
      id: targetId,
      code: `cap-${targetId.slice(0, 8)}`,
      name: '验证码账本',
      entryUrl: 'https://example.com',
    })
    await handle.db.insert(targetAccounts).values({
      id: accountId,
      targetId,
      displayName: 'admin',
      username: 'admin',
      status: 'active',
    })
  })

  afterAll(async () => {
    await handle.close()
  })

  it('开跑前每次尝试落下一条已终态 LOGIN 操作', async () => {
    const sessionId = newId()
    const runId = newId()
    const challengeId = newId()
    const row = await recordCaptchaLoginAttempt(handle.db, {
      key: { targetId, targetAccountId: accountId },
      sessionId,
      generation: 1,
      runId,
      attempt: 1,
      maxAttempts: 2,
      challengeType: 'IMAGE_CAPTCHA',
      outcome: 'captcha_failed',
      audit: {
        challengeId,
        sessionId,
        runId,
        challengeType: 'IMAGE_CAPTCHA',
        handledBy: 'MACHINE',
        attemptsUsed: 1,
        success: false,
        durationMs: 80,
        timestamp: new Date().toISOString(),
      },
    })
    expect(row?.kind).toBe('LOGIN')
    expect(row?.origin).toBe('BACKGROUND')
    expect(row?.status).toBe('FAILED')
    expect(row?.errorCode).toBe('SESSION_AUTH_UNSUPPORTED')
    expect(row?.kindParams.captchaPhase).toBe('MACHINE_HANDLING')
    expect(row?.kindParams.attempt).toBe(1)
    expect(row?.finishedAt).toBeTruthy()
  })

  it('维护 LOGIN 把尝试写入现有操作 kindParams，不另开队列项', async () => {
    const created = await requestSessionOperation(handle.db, {
      key: { targetId, targetAccountId: accountId },
      kind: 'LOGIN',
      origin: 'USER',
      idempotencyKey: `login-captcha-${newId()}`,
    })
    const sessionId = newId()
    const updated = await recordCaptchaLoginAttempt(handle.db, {
      key: { targetId, targetAccountId: accountId },
      sessionId,
      generation: 1,
      operationId: created.operation.id,
      attempt: 1,
      maxAttempts: 2,
      challengeType: 'SLIDER_CAPTCHA',
      outcome: 'ambiguous',
      audit: {
        challengeId: created.operation.id,
        sessionId,
        challengeType: 'SLIDER_CAPTCHA',
        handledBy: 'MACHINE',
        attemptsUsed: 1,
        success: false,
        durationMs: 40,
        timestamp: new Date().toISOString(),
      },
    })
    expect(updated?.id).toBe(created.operation.id)
    expect(updated?.status).toBe('QUEUED')
    expect(updated?.kindParams.outcome).toBe('ambiguous')
    const fresh = await getSessionOperation(handle.db, created.operation.id)
    expect(fresh?.kindParams.attempts).toHaveLength(1)
  })
})
