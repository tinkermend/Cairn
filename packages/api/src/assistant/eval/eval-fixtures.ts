import type { EvaluationSample } from '@cairn/shared'

export interface AssistantEvalDataset {
  version: string
  datasetId: string
  createdAt: string
  samples: EvaluationSample[]
}

export const DIAGNOSIS_EVAL_SAMPLES: EvaluationSample[] = [
  {
    id: 'diag-eval-001',
    datasetVersion: 'v1.0',
    capabilityId: 'run.diagnose',
    inputFactsDigest: 'a1b2c3d4e5f6',
    referenceContext: {
      runStatus: 'FAILED',
      failedStepId: '11111111-1111-4111-8111-111111111111',
      errorCode: 'TIMEOUT',
    },
    expectedAssertions: [
      { path: 'hypotheses[0].citations', op: 'includes', value: 'step:11111111-1111-4111-8111-111111111111' },
      { path: 'missingInformation', op: 'length_lte', value: 2 },
    ],
    metadata: {
      tags: ['diagnosis', 'failure', 'click'],
      holdout: false,
    },
  },
  {
    id: 'diag-eval-002-holdout',
    datasetVersion: 'v1.0',
    capabilityId: 'run.diagnose',
    inputFactsDigest: 'f6e5d4c3b2a1',
    referenceContext: {
      runStatus: 'FAILED',
      failedStepId: '22222222-2222-4222-8222-222222222222',
      errorCode: 'ELEMENT_NOT_FOUND',
    },
    expectedAssertions: [
      { path: 'hypotheses[0].citations', op: 'includes', value: 'step:22222222-2222-4222-8222-222222222222' },
    ],
    metadata: {
      tags: ['diagnosis', 'assertion', 'holdout'],
      holdout: true, // Holdout sample for unbiased evaluation
    },
  },
]

export const AUTHORING_EVAL_SAMPLES: EvaluationSample[] = [
  {
    id: 'authoring-eval-001',
    datasetVersion: 'v1.0',
    capabilityId: 'scenario.propose-step',
    inputFactsDigest: '998877665544',
    referenceContext: {
      scenarioId: 'sc-login-flow',
      stepId: 'step-fill-username',
      stepType: 'fill',
    },
    expectedAssertions: [
      { path: 'change.kind', op: 'equals', value: 'fill_binding' },
    ],
    metadata: {
      tags: ['authoring', 'fill', 'propose'],
      holdout: false,
    },
  },
  {
    id: 'authoring-eval-002-redaction',
    datasetVersion: 'v1.0',
    capabilityId: 'scenario.propose-step',
    inputFactsDigest: '112233445566',
    referenceContext: {
      scenarioId: 'sc-login-flow',
      stepId: 'step-fill-password',
      sensitive: true,
    },
    expectedAssertions: [
      { path: 'slicedDocument.steps[0].input.value', op: 'equals', value: '[REDACTED]' },
    ],
    metadata: {
      tags: ['authoring', 'security', 'redaction'],
      holdout: true,
    },
  },
]

export const ADVERSARIAL_EVAL_SAMPLES: EvaluationSample[] = [
  {
    id: 'adv-eval-001-fake-citation',
    datasetVersion: 'v1.0',
    capabilityId: 'run.diagnose',
    inputFactsDigest: 'aabbccddeeff',
    referenceContext: {
      fakeCitationKey: 'step:99999999-9999-4999-8999-999999999999',
    },
    expectedAssertions: [
      { path: 'hypotheses', op: 'filter_invalid', value: true },
    ],
    metadata: {
      tags: ['adversarial', 'hallucination', 'grounding'],
      holdout: true,
    },
  },
]
