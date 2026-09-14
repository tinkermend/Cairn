import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RECORDER_SOURCE_VERSION, type CreateRecordingBody } from '@cairn/shared'
import { createRecordingDraft, getRecordingDraft, listRecordingDrafts, openIsolatedDb, type DbHandle } from '../test-entry.js'
import { newId } from '../id.js'
import { consoleAccounts } from '../schema/console.js'
import { targets } from '../schema/targets.js'

const SCHEMA = `cairn_test_${Date.now().toString(36)}_rec`

function body(targetId: string, overrides: Partial<CreateRecordingBody> = {}): CreateRecordingBody {
  return {
    targetId,
    recordingId: '22222222-2222-4222-8222-222222222222',
    sourceVersion: RECORDER_SOURCE_VERSION,
    idempotencyKey: 'rec-0001-key',
    events: [
      {
        name: 'navigate',
        url: 'https://shop.example/login',
        signals: [],
        pageAlias: 'page',
        framePath: [],
      },
      {
        name: 'fill',
        selector: 'internal:role=textbox[name="密码"i]',
        text: 'secret-pass',
        signals: [],
        pageAlias: 'page',
        framePath: [],
        locator: { kind: 'role', body: 'textbox', options: { name: '密码' } },
      },
    ],
    ...overrides,
  }
}

describe('录制草稿 Repository（集成）', { timeout: 30_000 }, () => {
  let handle: DbHandle
  let actorId: string
  let targetId: string

  beforeAll(async () => {
    handle = await openIsolatedDb(SCHEMA)
    actorId = newId()
    targetId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'tester',
      email: `rec-${actorId}@example.com`,
      status: 'active',
    })
    await handle.db.insert(targets).values({
      id: targetId,
      code: `rec-${SCHEMA.slice(-6)}`,
      name: '录制夹具',
      entryUrl: 'https://shop.example',
    })
  })

  afterAll(async () => {
    await handle?.close()
  })

  it('上传归一化后重传不重复，敏感值不落库', async () => {
    const first = await createRecordingDraft(handle.db, body(targetId), { id: actorId })
    expect(first.created).toBe(true)
    expect(first.detail.targetName).toBe('录制夹具')
    expect(first.detail.unresolvedCount).toBe(0)
    expect(first.detail.items.some((item) => item.sensitive && !('value' in (item.input as object)))).toBe(true)
    expect(first.detail.events.some((event) => event.name === 'fill' && event.text)).toBe(false)

    const again = await createRecordingDraft(handle.db, body(targetId), { id: actorId })
    expect(again.created).toBe(false)
    expect(again.detail.id).toBe(first.detail.id)

    await expect(
      createRecordingDraft(
        handle.db,
        body(targetId, {
          events: [{ name: 'navigate', url: 'https://shop.example/other', signals: [], pageAlias: 'page', framePath: [] }],
        }),
        { id: actorId },
      ),
    ).rejects.toMatchObject({ code: 'RECORDING_IDEMPOTENCY_CONFLICT' })

    const listed = await listRecordingDrafts(handle.db, actorId)
    expect(listed.items).toHaveLength(1)
    expect(await getRecordingDraft(handle.db, first.detail.id, actorId)).toMatchObject({ id: first.detail.id })
    await expect(getRecordingDraft(handle.db, first.detail.id, newId())).rejects.toMatchObject({
      code: 'RECORDING_NOT_FOUND',
    })
  })

  it('停用目标不能上传', async () => {
    const disabledId = newId()
    await handle.db.insert(targets).values({
      id: disabledId,
      code: `rec-off-${SCHEMA.slice(-4)}`,
      name: '停用',
      entryUrl: 'https://off.example',
      status: 'disabled',
    })
    await expect(
      createRecordingDraft(handle.db, body(disabledId, { idempotencyKey: 'rec-0002-key' }), { id: actorId }),
    ).rejects.toMatchObject({ code: 'TARGET_DISABLED' })
  })
})
