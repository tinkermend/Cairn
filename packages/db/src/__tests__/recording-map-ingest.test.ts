import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { RECORDER_SOURCE_VERSION, type CreateRecordingBody } from '@cairn/shared'
import { schemaFor } from '../native.js'
import { newId } from '../id.js'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import {
  continueRecordingMapIngest,
  createRecordingDraft,
  deleteRecordingDraft,
  readMapFacts,
  recordingMapIngestTestHooks,
  type NativeHandle as DbHandle,
} from '../test-entry.js'

describe.each(DRIVERS)('%s 录制地图转换', { timeout: 60_000 }, (driver) => {
  let handle: DbHandle
  let actorId: string
  let targetId: string

  beforeAll(async () => {
    handle = await openContractDb(driver, `recmap_${Date.now().toString(36)}`)
    const { consoleAccounts, targets } = schemaFor(handle.db)
    actorId = newId()
    targetId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'rec-map',
      email: `recmap-${actorId}@example.com`,
      status: 'active',
    })
    await handle.db.insert(targets).values({
      id: targetId,
      code: `recmap-${targetId.slice(0, 8)}`,
      name: '录制地图',
      entryUrl: 'https://shop.example',
    })
  })

  afterAll(async () => {
    await handle?.close()
  })

  afterEach(() => {
    recordingMapIngestTestHooks.afterBatch = null
    recordingMapIngestTestHooks.beforeAdvanceCursor = null
  })

  function manyEvents(count: number): CreateRecordingBody['events'] {
    return Array.from({ length: count }, (_, index) =>
      index === 0
        ? {
            name: 'navigate' as const,
            url: 'https://shop.example/list',
            signals: [] as [],
            pageAlias: 'page',
            framePath: [] as string[],
          }
        : {
            name: 'click' as const,
            selector: `text=Item ${index}`,
            signals: [] as [],
            pageAlias: 'page',
            framePath: [] as string[],
            button: 'left',
            clickCount: 1,
            modifiers: 0,
          },
    )
  }

  function body(overrides: Partial<CreateRecordingBody> = {}): CreateRecordingBody {
    return {
      targetId,
      recordingId: newId(),
      sourceVersion: RECORDER_SOURCE_VERSION,
      idempotencyKey: `rec-map-${newId()}`,
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
          selector: 'internal:role=textbox[name="用户"i]',
          text: 'alice',
          signals: [],
          pageAlias: 'page',
          framePath: [],
          locator: { kind: 'role', body: 'textbox', options: { name: '用户' } },
        },
        {
          name: 'fill',
          selector: 'internal:role=textbox[name="用户"i]',
          text: 'alice@example.com',
          signals: [],
          pageAlias: 'page',
          framePath: [],
          locator: { kind: 'role', body: 'textbox', options: { name: '用户' } },
        },
      ],
      ...overrides,
    }
  }

  it('默认不转换；mapIngest 保留归并索引且不重建页面', async () => {
    const plain = await createRecordingDraft(handle.db, body(), { id: actorId })
    const none = await readMapFacts(handle.db, { targetId })
    expect(
      none.facts.some(
        (fact) =>
          fact.type === 'observation' &&
          fact.observation.sourceRef.sourceType === 'recorder' &&
          fact.observation.sourceRef.recordingId === plain.detail.recordingId,
      ),
    ).toBe(false)

    const ingested = await createRecordingDraft(handle.db, body({ mapIngest: true }), { id: actorId })
    const page = await readMapFacts(handle.db, { targetId })
    const recorded = page.facts.filter(
      (fact) =>
        fact.type === 'observation' &&
        fact.observation.sourceRef.sourceType === 'recorder' &&
        fact.observation.sourceRef.recordingId === ingested.detail.recordingId,
    )
    expect(recorded.length).toBe(ingested.detail.itemCount)
    expect(
      recorded.every(
        (fact) =>
          fact.type === 'observation' &&
          fact.observation.completeness === 'none' &&
          fact.observation.phase === 'after_action',
      ),
    ).toBe(true)
    const merged = recorded.find(
      (fact) =>
        fact.type === 'observation' &&
        fact.observation.sourceRef.sourceType === 'recorder' &&
        (fact.observation.sourceRef.sourceIndexes?.length ?? 0) > 1,
    )
    expect(merged).toBeTruthy()
    if (merged && merged.type === 'observation' && merged.observation.sourceRef.sourceType === 'recorder') {
      expect(merged.observation.sourceRef.originalEventIndex).toBe(
        Math.min(...merged.observation.sourceRef.sourceIndexes!),
      )
    }
    expect(JSON.stringify(recorded)).not.toMatch(/alice@example.com/)
  })

  it('中断后从游标续跑，删除草稿则终止', async () => {
    recordingMapIngestTestHooks.afterBatch = () => {
      throw new Error('interrupt ingest')
    }
    const payload: CreateRecordingBody = {
      targetId,
      recordingId: newId(),
      sourceVersion: RECORDER_SOURCE_VERSION,
      idempotencyKey: `rec-map-int-${newId()}`,
      mapIngest: true,
      events: manyEvents(25),
    }
    await expect(createRecordingDraft(handle.db, payload, { id: actorId })).rejects.toThrow('interrupt ingest')
    const { recordingDrafts, recordingMapIngests } = schemaFor(handle.db)
    const [draft] = await handle.db
      .select()
      .from(recordingDrafts)
      .where(eq(recordingDrafts.recordingId, payload.recordingId))
    expect(draft).toBeTruthy()
    const [cursor] = await handle.db
      .select()
      .from(recordingMapIngests)
      .where(eq(recordingMapIngests.recordingDraftId, draft!.id))
    expect(cursor?.status).toBe('pending')
    expect(cursor?.nextIndex).toBeGreaterThan(0)
    recordingMapIngestTestHooks.afterBatch = null
    const continued = await continueRecordingMapIngest(handle.db, { recordingDraftId: draft!.id })
    expect(continued.status).toBe('completed')
    const again = await continueRecordingMapIngest(handle.db, { recordingDraftId: draft!.id })
    expect(again.status).toBe('completed')
    expect(again.written).toBe(0)

    const doomed = await createRecordingDraft(handle.db, body({ mapIngest: false }), { id: actorId })
    await deleteRecordingDraft(handle.db, doomed.detail.id, { id: actorId })
    const aborted = await continueRecordingMapIngest(handle.db, { recordingDraftId: doomed.detail.id })
    expect(aborted.status).toBe('aborted')
  })

  it('事实已落后游标未推进时续跑不中止', async () => {
    recordingMapIngestTestHooks.beforeAdvanceCursor = () => {
      throw new Error('interrupt before cursor')
    }
    const payload: CreateRecordingBody = {
      targetId,
      recordingId: newId(),
      sourceVersion: RECORDER_SOURCE_VERSION,
      idempotencyKey: `rec-map-cas-${newId()}`,
      mapIngest: true,
      events: manyEvents(25),
    }
    await expect(createRecordingDraft(handle.db, payload, { id: actorId })).rejects.toThrow('interrupt before cursor')
    const { recordingDrafts, recordingMapIngests } = schemaFor(handle.db)
    const [draft] = await handle.db
      .select()
      .from(recordingDrafts)
      .where(eq(recordingDrafts.recordingId, payload.recordingId))
    const [cursor] = await handle.db
      .select()
      .from(recordingMapIngests)
      .where(eq(recordingMapIngests.recordingDraftId, draft!.id))
    expect(cursor?.status).toBe('pending')
    expect(cursor?.nextIndex).toBe(0)
    recordingMapIngestTestHooks.beforeAdvanceCursor = null
    const continued = await continueRecordingMapIngest(handle.db, { recordingDraftId: draft!.id })
    expect(continued.status).toBe('completed')
    expect(continued.nextIndex).toBe(draft!.itemCount)
  })

  it('并发续跑不得把已推进的游标回退', async () => {
    let releaseStale!: () => void
    const staleMayProceed = new Promise<void>((resolve) => {
      releaseStale = resolve
    })
    let staleReached!: () => void
    const staleHeld = new Promise<void>((resolve) => {
      staleReached = resolve
    })
    let holding = false
    recordingMapIngestTestHooks.beforeAdvanceCursor = async (expectedNextIndex) => {
      if (expectedNextIndex !== 0) return
      if (holding) return
      holding = true
      staleReached()
      await staleMayProceed
    }

    const created = await createRecordingDraft(handle.db, body({ events: manyEvents(25) }), { id: actorId })
    const stale = continueRecordingMapIngest(handle.db, { recordingDraftId: created.detail.id })
    await staleHeld
    const fast = await continueRecordingMapIngest(handle.db, { recordingDraftId: created.detail.id })
    expect(fast.status).toBe('completed')
    expect(fast.nextIndex).toBe(created.detail.itemCount)
    releaseStale()
    const late = await stale
    expect(late.status).toBe('completed')

    const { recordingMapIngests } = schemaFor(handle.db)
    const [cursor] = await handle.db
      .select()
      .from(recordingMapIngests)
      .where(eq(recordingMapIngests.recordingDraftId, created.detail.id))
    expect(cursor?.status).toBe('completed')
    expect(cursor?.nextIndex).toBe(created.detail.itemCount)
  })

  it('已完成的转换不会因删除草稿被改成中止', async () => {
    const ingested = await createRecordingDraft(handle.db, body({ mapIngest: true }), { id: actorId })
    await deleteRecordingDraft(handle.db, ingested.detail.id, { id: actorId })
    const again = await continueRecordingMapIngest(handle.db, { recordingDraftId: ingested.detail.id })
    expect(again.status).toBe('completed')
    const { recordingMapIngests } = schemaFor(handle.db)
    const [cursor] = await handle.db
      .select()
      .from(recordingMapIngests)
      .where(eq(recordingMapIngests.recordingDraftId, ingested.detail.id))
    expect(cursor?.status).toBe('completed')
  })
})
