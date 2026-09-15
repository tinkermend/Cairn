import { afterEach, describe, expect, it } from 'vitest'
import { createAccountBodySchema } from '@cairn/shared'
import * as api from '../index.js'
import { connection, expose } from '../database.js'
import { schemaFor } from '../native.js'
import { eq } from 'drizzle-orm'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import type { DbHandle } from '../client.js'

const handles: DbHandle[] = []
afterEach(async () => {
  for (const handle of handles.splice(0).reverse()) await handle.close()
})

async function fixture(driver: (typeof DRIVERS)[number]) {
  const handle = await openContractDb(driver)
  handles.push(handle)
  const db = expose(handle)
  const rbac = new api.RbacStore(db, {
    hash: async (value: string) => value,
    verify: async (value: string, hash: string) => value === hash,
  })
  const owner = await rbac.createAccount(
    createAccountBodySchema.parse({
      email: `assist-${driver}-${api.newId().slice(0, 8)}`,
      displayName: '助手用户',
      password: 'test-password',
    }),
    null,
  )
  const other = await rbac.createAccount(
    createAccountBodySchema.parse({
      email: `assist-b-${driver}-${api.newId().slice(0, 8)}`,
      displayName: '另一用户',
      password: 'test-password',
    }),
    null,
  )
  return { db, owner, other }
}

function beginInput(
  conversationId: string,
  ownerAccountId: string,
  extra: Partial<Parameters<typeof api.beginAssistantTurn>[1]> = {},
) {
  return {
    conversationId,
    ownerAccountId,
    clientTurnId: `client-${api.newId()}`,
    requestDigest: 'a'.repeat(64),
    question: '这次为什么失败',
    deadlineAt: new Date(Date.now() + 60_000),
    processingToken: api.newId(),
    userLimit: 1,
    platformLimit: 4,
    ...extra,
  }
}

describe.each(DRIVERS)('%s 助手会话与额度', { timeout: 30_000 }, (driver) => {
  it('幂等 clientTurnId 回放，摘要不同则冲突', async () => {
    const { db, owner } = await fixture(driver)
    const conversation = await api.createAssistantConversation(db, {
      ownerAccountId: owner.id,
      title: '诊断',
    })
    const input = beginInput(conversation.id, owner.id, { clientTurnId: 'client-turn-1' })
    const first = await api.beginAssistantTurn(db, input)
    expect(first.replay).toBe(false)
    const replay = await api.beginAssistantTurn(db, input)
    expect(replay.replay).toBe(true)
    expect(replay.turn.id).toBe(first.turn.id)
    await expect(
      api.beginAssistantTurn(db, { ...input, requestDigest: 'b'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'ASSISTANT_TURN_CONFLICT' })
  })

  it('同一用户只能有一个在途轮次，正确令牌结束后才能再开', async () => {
    const { db, owner } = await fixture(driver)
    const conversation = await api.createAssistantConversation(db, {
      ownerAccountId: owner.id,
      title: '在途',
    })
    const token = api.newId()
    const running = await api.beginAssistantTurn(
      db,
      beginInput(conversation.id, owner.id, { processingToken: token }),
    )
    expect(running.turn.status).toBe('RUNNING')
    await expect(
      api.beginAssistantTurn(db, beginInput(conversation.id, owner.id)),
    ).rejects.toMatchObject({ code: 'ASSISTANT_INFLIGHT' })
    await expect(
      api.completeAssistantTurn(db, {
        turnId: running.turn.id,
        ownerAccountId: owner.id,
        processingToken: 'wrong-token',
        status: 'COMPLETED',
      }),
    ).rejects.toMatchObject({ code: 'ASSISTANT_TOKEN_MISMATCH' })
    const done = await api.completeAssistantTurn(db, {
      turnId: running.turn.id,
      ownerAccountId: owner.id,
      processingToken: token,
      status: 'COMPLETED',
    })
    expect(done.status).toBe('COMPLETED')
    const next = await api.beginAssistantTurn(db, beginInput(conversation.id, owner.id))
    expect(next.replay).toBe(false)
    expect(next.turn.status).toBe('RUNNING')
  })

  it('过期 RUNNING 记 INTERRUPTED，迟到提交不能覆盖终态', async () => {
    const { db, owner } = await fixture(driver)
    const conversation = await api.createAssistantConversation(db, {
      ownerAccountId: owner.id,
      title: '超时',
    })
    const token = api.newId()
    const started = await api.beginAssistantTurn(
      db,
      beginInput(conversation.id, owner.id, {
        deadlineAt: new Date(Date.now() - 1000),
        processingToken: token,
      }),
    )
    await api.interruptExpiredAssistantTurns(db)
    const current = await api.getAssistantTurn(db, started.turn.id, owner.id)
    expect(current.status).toBe('INTERRUPTED')
    const late = await api.completeAssistantTurn(db, {
      turnId: started.turn.id,
      ownerAccountId: owner.id,
      processingToken: token,
      status: 'COMPLETED',
      result: {
        kind: 'unsupported',
        reasonCode: 'LATE',
        message: '迟到结果不应写入',
      },
    })
    expect(late.status).toBe('INTERRUPTED')
    expect(late.result).toBeNull()
  })

  it('不能引用其他用户或其他对话的父轮次', async () => {
    const { db, owner, other } = await fixture(driver)
    const mine = await api.createAssistantConversation(db, {
      ownerAccountId: owner.id,
      title: '我的',
    })
    const theirs = await api.createAssistantConversation(db, {
      ownerAccountId: other.id,
      title: '别人的',
    })
    const parent = await api.beginAssistantTurn(db, beginInput(mine.id, owner.id))
    await expect(
      api.beginAssistantTurn(db, beginInput(theirs.id, other.id, { parentTurnId: parent.turn.id })),
    ).rejects.toMatchObject({ code: 'ASSISTANT_PARENT_FORBIDDEN' })
    const theirTurn = await api.beginAssistantTurn(db, beginInput(theirs.id, other.id))
    await expect(api.getAssistantTurn(db, theirTurn.turn.id, owner.id)).rejects.toMatchObject({
      code: 'ASSISTANT_TURN_NOT_FOUND',
    })
  })

  it('系统角色种子包含 ai:assist', async () => {
    const { db } = await fixture(driver)
    const native = connection(db)
    const { consoleRoles, consoleRolePermissions } = schemaFor(native)
    const roles = await native.select().from(consoleRoles)
    for (const role of roles.filter((item) => item.kind === 'system')) {
      const perms = await native
        .select()
        .from(consoleRolePermissions)
        .where(eq(consoleRolePermissions.consoleRoleId, role.id))
      expect(perms.map((item) => item.permission)).toContain('ai:assist')
    }
  })
})
