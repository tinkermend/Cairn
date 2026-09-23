import { describe, expect, it } from 'vitest'
import {
  citationKey,
  type AssistantCitationKey,
  type ScenarioDocument,
} from '@cairn/shared'
import {
  DIAGNOSIS_EVAL_SAMPLES,
  AUTHORING_EVAL_SAMPLES,
  ADVERSARIAL_EVAL_SAMPLES,
} from './eval-fixtures'
import { validateGrounding, buildAuthoringSlice } from '../context-assembler'

describe('AI 基座离线评测引擎 (Eval Runner)', () => {
  describe('诊断评测样本 (DIAGNOSIS_EVAL_SAMPLES)', () => {
    it('常规与 Holdout 诊断样本断言均能被评测引擎确定性判定', () => {
      for (const sample of DIAGNOSIS_EVAL_SAMPLES) {
        expect(sample.capabilityId).toBe('run.diagnose')
        expect(sample.datasetVersion).toBe('v1.0')
        expect(sample.metadata.tags).toContain('diagnosis')

        // 模拟诊断输出中的假说
        const failedStepId = sample.referenceContext.failedStepId as string
        const hypotheses = [
          {
            text: `步骤 ${failedStepId} 发生异常`,
            citations: [citationKey('step', failedStepId)],
          },
        ]
        const validCitations: AssistantCitationKey[] = [citationKey('step', failedStepId)]

        const { valid } = validateGrounding(hypotheses, validCitations)
        expect(valid.length).toBe(1)
        expect(valid[0]!.citations).toContain(`step:${failedStepId}`)
      }
    })
  })

  describe('编写与脱敏评测样本 (AUTHORING_EVAL_SAMPLES)', () => {
    it('敏感字段脱敏样本严格验证 [REDACTED] 替换并阻断原文外泄', () => {
      const redactionSample = AUTHORING_EVAL_SAMPLES.find((s) =>
        s.metadata.tags.includes('redaction'),
      )!
      expect(redactionSample).toBeDefined()
      expect(redactionSample.metadata.holdout).toBe(true)

      const doc: ScenarioDocument = {
        schemaVersion: 1,
        inputs: {},
        steps: [
          {
            id: 'step-fill-password',
            name: '输入密码',
            type: 'fill',
            input: {
              selector: '#password',
              value: 'SuperSecret1234!',
              sensitive: true,
            },
          },
        ],
      }

      const slice = buildAuthoringSlice(doc, 'step-fill-password')
      const firstStep = slice.slicedDocument.steps[0]!
      expect((firstStep.input as any).value).toBe('[REDACTED]')
      expect(JSON.stringify(slice.slicedDocument)).not.toContain('SuperSecret1234!')
    })
  })

  describe('对抗与防幻觉评测样本 (ADVERSARIAL_EVAL_SAMPLES)', () => {
    it('Grounding 验证引擎能准确识破非事实包内的对抗性伪造引用', () => {
      for (const sample of ADVERSARIAL_EVAL_SAMPLES) {
        const fakeCitation = sample.referenceContext.fakeCitationKey as string
        const allowedCitations: AssistantCitationKey[] = [
          citationKey('run', '00000000-0000-4000-8000-000000000001'),
          citationKey('step', '00000000-0000-4000-8000-000000000002'),
        ]

        const hallucinatedHypothesis = [
          {
            text: '模型自行编造的假设，带有虚假引用',
            citations: [fakeCitation as AssistantCitationKey],
          },
        ]

        const result = validateGrounding(hallucinatedHypothesis, allowedCitations)
        expect(result.valid).toHaveLength(0)
        expect(result.invalid).toHaveLength(1)
        expect(result.invalid[0]!.citations).toContain(fakeCitation)
      }
    })
  })
})
