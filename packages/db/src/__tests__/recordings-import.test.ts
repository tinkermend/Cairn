import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  RECORDER_SOURCE_VERSION,
  RECORDING_NORMALIZER_VERSION,
  type CreateRecordingBody,
  type Step,
} from '@cairn/shared'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import {
  applyRecordingImport,
  claimRecordingBinding,
  createRecordingBinding,
  createRecordingDraft,
  createScenarioWithVersion,
  previewRecordingImport,
  type NativeHandle as DbHandle,
} from '../test-entry.js'
import { newId } from '../id.js'
import { schemaFor } from '../native.js'

const SCHEMA = `cairn_test_${Date.now().toString(36)}_recimp`

function navigateStep(url = 'https://shop.example.com'): Step {
  return {
    id: newId(),
    name: '打开页面',
    type: 'navigate',
    effectType: 'SIDE_EFFECT',
    input: { url },
  }
}

function recordingBody(targetId: string, overrides: Partial<CreateRecordingBody> = {}): CreateRecordingBody {
  return {
    targetId,
    recordingId: newId(),
    sourceVersion: RECORDER_SOURCE_VERSION,
    idempotencyKey: `imp-${newId().slice(0, 8)}`,
    events: [
      {
        name: 'navigate',
        url: 'https://shop.example.com/orders',
        signals: [],
        pageAlias: 'page',
        framePath: [],
      },
      {
        name: 'click',
        locator: { kind: 'role', body: 'button', options: { name: '查询' } },
        pageAlias: 'page',
        framePath: [],
      },
      {
        name: 'check',
        locator: { kind: 'default', body: '#agree' },
        pageAlias: 'page',
        framePath: [],
      },
    ],
    ...overrides,
  }
}

describe.each(DRIVERS)('%s 录制绑定与回填', { timeout: 30_000 }, (driver) => {
  let handle: DbHandle
  let actorId: string
  let otherId: string
  let targetId: string

  beforeAll(async () => {
    handle = await openContractDb(driver, SCHEMA)
    const { consoleAccounts, targets } = schemaFor(handle.db)
    actorId = newId()
    otherId = newId()
    targetId = newId()
    await handle.db.insert(consoleAccounts).values([
      { id: actorId, displayName: 'rec-tester', email: `rec-${actorId}@example.com`, status: 'active' },
      { id: otherId, displayName: 'other', email: `rec-${otherId}@example.com`, status: 'active' },
    ])
    await handle.db.insert(targets).values({
      id: targetId,
      code: `ri-${SCHEMA.slice(-6)}`,
      name: '录制回填夹具',
      entryUrl: 'https://shop.example.com',
    })
  })

  afterAll(async () => {
    await handle?.close()
  })

  it('未领取不能绑定上传；领取后预览回填，勾选保持待处理', async () => {
    const created = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `导入 ${newId().slice(0, 8)}`,
      steps: [navigateStep()],
      actor: { id: actorId },
    })
    const bound = await createRecordingBinding(
      handle.db,
      created.id,
      {
        revision: created.draft!.revision,
        insertAnchor: { kind: 'after', stepId: created.draft!.document.steps[0]!.id },
        apiOrigin: 'http://localhost:3030',
      },
      { id: actorId },
    )
    await expect(
      createRecordingDraft(
        handle.db,
        recordingBody(targetId, { bindingId: bound.binding.id, idempotencyKey: `u-${newId().slice(0, 8)}` }),
        { id: actorId },
      ),
    ).rejects.toMatchObject({ code: 'RECORDING_BINDING_EXPIRED' })

    await expect(
      claimRecordingBinding(
        handle.db,
        { ticket: bound.ticket, apiOrigin: 'http://localhost:4173' },
        { id: actorId },
      ),
    ).rejects.toMatchObject({ code: 'RECORDING_BINDING_ORIGIN_MISMATCH' })

    const claimed = await claimRecordingBinding(
      handle.db,
      { ticket: bound.ticket, apiOrigin: 'http://localhost:3030' },
      { id: actorId },
    )
    expect(claimed.status).toBe('claimed')

    const uploaded = await createRecordingDraft(
      handle.db,
      recordingBody(targetId, { bindingId: bound.binding.id }),
      { id: actorId },
    )
    expect(uploaded.detail.items.some((item) => item.sourceAction === 'check' && item.status === 'unresolved')).toBe(
      true,
    )

    const preview = await previewRecordingImport(
      handle.db,
      created.id,
      {
        recordingDraftId: uploaded.detail.id,
        baseRevision: created.draft!.revision,
        insertAnchor: { kind: 'after', stepId: created.draft!.document.steps[0]!.id },
      },
      actorId,
    )
    expect(preview.normalizerVersion).toBe(RECORDING_NORMALIZER_VERSION)
    expect(preview.items.filter((item) => item.ready)).toHaveLength(2)

    await expect(
      previewRecordingImport(
        handle.db,
        created.id,
        {
          recordingDraftId: uploaded.detail.id,
          baseRevision: created.draft!.revision,
          insertAnchor: preview.insertAnchor,
        },
        otherId,
      ),
    ).rejects.toMatchObject({ code: 'RECORDING_NOT_FOUND' })

    const applied = await applyRecordingImport(
      handle.db,
      created.id,
      {
        idempotencyKey: `apply-${uploaded.detail.id.slice(0, 8)}`,
        baseRevision: created.draft!.revision,
        recordingDraftId: uploaded.detail.id,
        normalizerVersion: RECORDING_NORMALIZER_VERSION,
        sourceDigest: preview.sourceDigest,
        insertAnchor: preview.insertAnchor,
        dispositions: preview.items.map((item) =>
          item.ready
            ? { sourceIndexes: item.sourceIndexes, disposition: 'accept' as const }
            : { sourceIndexes: item.sourceIndexes, disposition: 'discard' as const, reason: '勾选尚不能映射' },
        ),
      },
      { id: actorId },
    )
    expect(applied.scenario.draft?.document.steps.map((step) => step.type)).toEqual(['navigate', 'navigate', 'click'])
  })
})
