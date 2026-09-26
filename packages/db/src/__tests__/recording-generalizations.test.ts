import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { parseDemonstrationFile } from '@cairn/authoring'
import {
  DEMONSTRATION_PROTOCOL,
  RECORDING_GENERALIZATION_RULE_VERSION,
  type ScenarioAuthoringDocumentV2,
} from '@cairn/shared'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import type { DbHandle } from '../client.js'
import { schemaFor } from '../native.js'
import { newId } from '../id.js'
import { createDemonstration } from '../recordings/demonstrations.js'
import {
  getOrCreateRecordingGeneralization,
  saveRecordingGeneralizationDecisions,
  submitRecordingGeneralizationRound,
  updateRecordingGeneralizationRoundStatus,
  handoffCreateScenario,
} from '../recordings/generalizations.js'
import { adjustPlatformConfig } from '../testing.js'
import { registerPlatformAiSecret } from '../platform-config/index.js'

describe.each(DRIVERS)(
  '%s recording generalizations and handoff',
  { timeout: 30_000 },
  (driver) => {
    let handle: DbHandle
    let actorId: string
    let otherId: string
    let targetId: string

    beforeAll(async () => {
      handle = await openContractDb(driver)
      const t = schemaFor(handle.db)
      actorId = newId()
      otherId = newId()
      targetId = newId()

      for (const id of [actorId, otherId]) {
        await handle.db
          .insert(t.consoleAccounts)
          .values({ id, displayName: '泛化测试', email: `${id}@example.test`, status: 'active' })
      }

      const [admin] = await handle.db
        .select()
        .from(t.consoleRoles)
        .where(eq(t.consoleRoles.key, 'admin'))
        .limit(1)

      for (const id of [actorId, otherId]) {
        await handle.db
          .insert(t.consoleAccountRoles)
          .values({
            consoleAccountId: id,
            consoleRoleId: admin!.id,
            targetScopeMode: 'all',
            targetScopeIds: [],
          })
      }

      await handle.db
        .insert(t.targets)
        .values({
          id: targetId,
          code: `gen-${newId()}`,
          name: '泛化测试目标',
          entryUrl: 'https://example.test',
        })

      const secretId = newId()
      await registerPlatformAiSecret(handle.db, {
        id: secretId,
        baseUrl: 'https://model.example/v1',
        ciphertext: Buffer.from('encrypted'),
        actor: { id: actorId },
      })
      await adjustPlatformConfig(
        handle,
        { id: actorId },
        (document) => ({
          ...document,
          browserAi: {
            ...document.browserAi,
            enabled: true,
            baseUrl: 'https://model.example/v1',
            model: 'demo',
            modelFamily: 'openai',
            secretRef: { provider: 'local', secretId },
          },
        }),
        '测试：启用 Browser AI',
      )
    })

    afterAll(async () => {
      await handle?.close()
    })

    const actor = () => ({ id: actorId })
    const source = (
      flow = '      - aiInput: 订单号\n        value: 123456\n      - aiTap: 查询\n      - aiAssert: 出现结果',
    ) =>
      parseDemonstrationFile({
        targetId,
        captureId: newId(),
        profile: 'midscene-yaml-flow@1',
        text: `web:\n  url: https://example.test\ntasks:\n  - name: 查询任务\n    flow:\n${flow}`,
      })

    const upload = async (src = source()) =>
      createDemonstration(
        handle.db,
        {
          name: '泛化导入测试',
          idempotencyKey: newId(),
          source: src,
          acknowledgedOmittedConfig: true,
        },
        actor(),
      )

    it('creates or retrieves recording generalization workspace idempotently', async () => {
      const recording = await upload()
      const res1 = await getOrCreateRecordingGeneralization(handle.db, recording.recordingDraftId, actorId)

      expect(res1.generalization.recordingDraftId).toBe(recording.recordingDraftId)
      expect(res1.generalization.status).toBe('editing')
      expect(res1.generalization.revision).toBe(1)
      expect(res1.generalization.ruleVersion).toBe(RECORDING_GENERALIZATION_RULE_VERSION)
      expect(res1.candidateDocument).toBeDefined()
      expect(res1.generalization.candidateDigest).toBe(res1.candidateDocument ? res1.generalization.candidateDigest : '')
      expect(res1.generalization.rounds).toEqual([])

      const res2 = await getOrCreateRecordingGeneralization(handle.db, recording.recordingDraftId, actorId)
      expect(res2.generalization.id).toBe(res1.generalization.id)
      expect(res2.generalization.revision).toBe(res1.generalization.revision)
    })

    it('saves decision changes and updates candidate document', async () => {
      const recording = await upload()
      const { generalization: init } = await getOrCreateRecordingGeneralization(handle.db, recording.recordingDraftId, actorId)

      const updatedDecisions = init.decisions.map((d, index) => {
        if (index === 1 || d.id === 'task-0-flow-0') {
          return {
            ...d,
            disposition: 'accept' as const,
            parameter: { key: 'customOrderNo', label: '自定义订单号' },
          }
        }
        return d
      })

      const saved = await saveRecordingGeneralizationDecisions(
        handle.db,
        recording.recordingDraftId,
        {
          revision: init.revision,
          decisions: updatedDecisions,
        },
        actor(),
      )

      expect(saved.generalization.revision).toBe(init.revision + 1)
      expect(saved.candidateDocument?.inputs).toContainEqual({
        key: 'customOrderNo',
        label: '自定义订单号',
      })
      expect(saved.generalization.candidateDigest).not.toBe(init.candidateDigest)

      // 乐观锁冲突
      await expect(
        saveRecordingGeneralizationDecisions(
          handle.db,
          recording.recordingDraftId,
          {
            revision: init.revision,
            decisions: updatedDecisions,
          },
          actor(),
        ),
      ).rejects.toMatchObject({ code: 'RECORDING_GENERALIZATION_REVISION_CONFLICT' })
    })

    it('submits quick action rounds and accepts/rejects them', async () => {
      const recording = await upload()
      const { generalization: init } = await getOrCreateRecordingGeneralization(handle.db, recording.recordingDraftId, actorId)

      // 提交放宽等待超时快捷轮次
      const roundRes = await submitRecordingGeneralizationRound(
        handle.db,
        recording.recordingDraftId,
        {
          revision: init.revision,
          quickAction: 'relax_timeout',
        },
        actor(),
      )

      expect(roundRes.round.status).toBe('proposed')
      expect(roundRes.round.operations.length).toBeGreaterThan(0)
      expect(roundRes.generalization.rounds).toHaveLength(1)

      // 采纳轮次
      const accepted = await updateRecordingGeneralizationRoundStatus(
        handle.db,
        recording.recordingDraftId,
        roundRes.round.roundId,
        'accept',
        actor(),
      )

      expect(accepted.generalization.rounds[0]?.status).toBe('accepted')
      expect(accepted.generalization.candidateDigest).toBeDefined()

      // 再次提交轮次并拒绝
      const round2Res = await submitRecordingGeneralizationRound(
        handle.db,
        recording.recordingDraftId,
        {
          revision: accepted.generalization.revision,
          quickAction: 'relax_timeout',
        },
        actor(),
      )

      const rejected = await updateRecordingGeneralizationRoundStatus(
        handle.db,
        recording.recordingDraftId,
        round2Res.round.roundId,
        'reject',
        actor(),
      )

      expect(rejected.generalization.rounds[1]?.status).toBe('rejected')
      // 拒绝不影响之前采纳的 candidateDigest
      expect(rejected.generalization.candidateDigest).toBe(accepted.generalization.candidateDigest)
    })

    it('atomically hands off to create a new scenario with candidate document', async () => {
      const recording = await upload()
      const { generalization: init, candidateDocument } = await getOrCreateRecordingGeneralization(
        handle.db,
        recording.recordingDraftId,
        actorId,
      )

      const handoffRes = await handoffCreateScenario(
        handle.db,
        recording.recordingDraftId,
        {
          name: '全新泛化场景',
          revision: init.revision,
          candidateDigest: init.candidateDigest,
        },
        actor(),
      )

      expect(handoffRes.scenario.name).toBe('全新泛化场景')
      expect(handoffRes.scenario.targetId).toBe(targetId)
      expect(handoffRes.receipt).toBeDefined()
      expect(handoffRes.generalization.status).toBe('handed_off')
      expect(handoffRes.generalization.handedOffScenarioId).toBe(handoffRes.scenario.id)

      // 检查回填后的草稿节点与泛化候选文档一致
      const scenarioDraftNodes = handoffRes.scenario.draft?.document as ScenarioAuthoringDocumentV2
      expect(scenarioDraftNodes.inputs).toEqual(candidateDocument?.inputs)

      // 锁定后禁止再次修改决策
      await expect(
        saveRecordingGeneralizationDecisions(
          handle.db,
          recording.recordingDraftId,
          {
            revision: handoffRes.generalization.revision,
            decisions: init.decisions,
          },
          actor(),
        ),
      ).rejects.toMatchObject({ code: 'RECORDING_GENERALIZATION_LOCKED' })
    })
  },
)
