import { ConflictException, NotFoundException } from '@nestjs/common'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { consoleAccounts, newId, openIsolatedDb, type DbHandle } from '@cairn/db/testing'
import {
  DEV_CREDENTIAL_KEY,
  RECORDER_SOURCE_VERSION,
  RECORDING_NORMALIZER_VERSION,
  type Step,
} from '@cairn/shared'
import type { RequestAccount } from '../common/request-account'
import { RecordingsService } from '../recordings/recordings.service'
import { ScenariosService } from './scenarios.service'
import { TargetsService } from '../targets/targets.service'
import { credentialKeyFromEnv, LocalSecretProvider } from '../secrets/local-secret-provider'

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

describe('录制绑定与回填（真实库）', { timeout: 30_000 }, () => {
  let handle: DbHandle
  let targets: TargetsService
  let scenarios: ScenariosService
  let recordings: RecordingsService
  let actor: RequestAccount
  let other: RequestAccount

  beforeAll(async () => {
    handle = await openIsolatedDb(SCHEMA)
    const actorId = newId()
    const otherId = newId()
    await handle.db.insert(consoleAccounts).values([
      { id: actorId, displayName: 'rec-tester', email: `rec-${actorId}@example.com`, status: 'active' },
      { id: otherId, displayName: 'other', email: `rec-${otherId}@example.com`, status: 'active' },
    ])
    actor = {
      id: actorId,
      displayName: 'rec-tester',
      email: `rec-${actorId}@example.com`,
      status: 'active',
      roles: [],
      permissions: ['target:read', 'target:write', 'workflow:read', 'workflow:write'],
    }
    other = { ...actor, id: otherId, displayName: 'other', email: `rec-${otherId}@example.com` }
    targets = new TargetsService(handle, new LocalSecretProvider(credentialKeyFromEnv(DEV_CREDENTIAL_KEY)))
    scenarios = new ScenariosService(handle)
    recordings = new RecordingsService(handle)
  })

  afterAll(async () => {
    await handle?.close()
  })

  async function seed() {
    const target = await targets.createTarget(
      {
        code: `ri${newId().replaceAll('-', '').slice(0, 10)}`,
        name: '录制回填夹具',
        entryUrl: 'https://shop.example.com',
        authMethod: 'password',
        captchaMode: 'none',
        status: 'active',
        loginFields: null,
      },
      actor,
    )
    const created = await scenarios.create(
      { targetId: target.id, name: `导入 ${newId().slice(0, 8)}`, steps: [navigateStep()] },
      actor,
    )
    return { target, created }
  }

  it('领取、预览、回填、幂等与 OCC 只产生一份完整草稿', async () => {
    const { target, created } = await seed()
    const bound = await scenarios.createRecordingBinding(
      created.id,
      { revision: created.draft!.revision, insertAnchor: { kind: 'after', stepId: created.draft!.document.steps[0]!.id } },
      actor,
    )
    expect(bound.ticket).toHaveLength(64)
    expect(bound.binding.status).toBe('issued')

    const claimed = await recordings.claim(
      { ticket: bound.ticket, apiOrigin: bound.binding.apiOrigin },
      actor,
    )
    expect(claimed.status).toBe('claimed')
    await expect(
      recordings.claim({ ticket: bound.ticket, apiOrigin: bound.binding.apiOrigin }, actor),
    ).rejects.toBeInstanceOf(ConflictException)

    const uploaded = await recordings.create(
      {
        targetId: target.id,
        recordingId: newId(),
        sourceVersion: RECORDER_SOURCE_VERSION,
        idempotencyKey: `imp-${newId().slice(0, 8)}`,
        bindingId: bound.binding.id,
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
      },
      actor,
    )
    expect(uploaded.items.some((item) => item.sourceAction === 'check' && item.status === 'mapped')).toBe(true)

    const preview = await scenarios.previewRecordingImport(
      created.id,
      {
        recordingDraftId: uploaded.id,
        baseRevision: created.draft!.revision,
        insertAnchor: { kind: 'after', stepId: created.draft!.document.steps[0]!.id },
      },
      actor,
    )
    expect(preview.normalizerVersion).toBe(RECORDING_NORMALIZER_VERSION)
    expect(preview.items.filter((item) => item.ready)).toHaveLength(2)
    expect(preview.remainingStepCapacity).toBe(31)

    const dispositions = preview.items.map((item) =>
      item.ready
        ? { sourceIndexes: item.sourceIndexes, disposition: 'accept' as const }
        : { sourceIndexes: item.sourceIndexes, disposition: 'discard' as const, reason: '勾选尚不能映射' },
    )
    const first = await scenarios.applyRecordingImport(
      created.id,
      {
        idempotencyKey: 'apply-once-key',
        baseRevision: created.draft!.revision,
        recordingDraftId: uploaded.id,
        normalizerVersion: RECORDING_NORMALIZER_VERSION,
        sourceDigest: preview.sourceDigest,
        insertAnchor: preview.insertAnchor,
        dispositions,
      },
      actor,
    )
    expect(first.receipt.newRevision).toBe(created.draft!.revision + 1)
    expect(first.scenario.draft?.document.steps.map((step) => step.type)).toEqual(['navigate', 'navigate', 'click'])

    const again = await scenarios.applyRecordingImport(
      created.id,
      {
        idempotencyKey: 'apply-once-key',
        baseRevision: created.draft!.revision,
        recordingDraftId: uploaded.id,
        normalizerVersion: RECORDING_NORMALIZER_VERSION,
        sourceDigest: preview.sourceDigest,
        insertAnchor: preview.insertAnchor,
        dispositions,
      },
      actor,
    )
    expect(again.receipt.id).toBe(first.receipt.id)
    expect(again.scenario.draft?.revision).toBe(first.receipt.newRevision)

    await expect(
      scenarios.applyRecordingImport(
        created.id,
        {
          idempotencyKey: 'apply-other-key',
          baseRevision: first.receipt.newRevision,
          recordingDraftId: uploaded.id,
          normalizerVersion: RECORDING_NORMALIZER_VERSION,
          sourceDigest: preview.sourceDigest,
          insertAnchor: preview.insertAnchor,
          dispositions,
        },
        actor,
      ),
    ).rejects.toBeInstanceOf(ConflictException)

    await expect(
      scenarios.previewRecordingImport(
        created.id,
        {
          recordingDraftId: uploaded.id,
          baseRevision: first.receipt.newRevision,
          insertAnchor: preview.insertAnchor,
        },
        other,
      ),
    ).rejects.toBeInstanceOf(NotFoundException)
  })
})
