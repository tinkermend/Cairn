import { describe, expect, it } from 'vitest'
import {
  compileModuleContent,
  commitStagedOutputs,
  deterministicStepId,
  expandAuthoringDocument,
  moduleContentDigest,
  fallbackAttribution,
  shouldFallbackToNext,
  skipReasonForStep,
  type ExpansionContext,
  type LoadedModuleVersion,
  type ModuleContent,
  type ScenarioAuthoringDocumentV2,
} from '../index.js'

const moduleId = '22222222-2222-4222-8222-222222222222'
const versionId = '33333333-3333-4333-8333-333333333333'
const targetId = '11111111-1111-4111-8111-111111111111'
const invocationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const defaultEcho = '10000000-0000-4000-8000-000000000001'
const altEcho = '10000000-0000-4000-8000-000000000002'
const writeStep = '10000000-0000-4000-8000-000000000003'

function echoStep(id: string, outputKey = 'out'): ModuleContent['implementations'][number]['steps'][number] {
  return {
    id,
    name: '回显',
    type: 'echo',
    effectType: 'READ_ONLY',
    outputKey,
    input: { value: 'ok' },
  }
}

function readOnlyContent(second = false): ModuleContent {
  return {
    contract: {
      inputs: [],
      outputs: [{ key: 'out', label: '输出', shape: { kind: 'scalar', type: 'string' } }],
      effectCeiling: 'READ_ONLY',
      preconditions: [],
      postconditions: [{ meaning: '必须有输出', verification: { kind: 'output_required', outputKey: 'out' } }],
    },
    implementations: [
      {
        implementationKey: 'default',
        kind: 'structured_steps',
        steps: [echoStep(defaultEcho)],
        outputMapping: { out: 'out' },
      },
      ...(second
        ? [
            {
              implementationKey: 'alt',
              kind: 'structured_steps' as const,
              steps: [echoStep(altEcho)],
              outputMapping: { out: 'out' },
            },
          ]
        : []),
    ],
  }
}

describe('AM-F 多实现与冻结回退', () => {
  it('AMF-01 任一实现超出副作用上限或缺少输出映射时发布阻断', () => {
    const content: ModuleContent = {
      contract: {
        inputs: [],
        outputs: [{ key: 'out', label: '输出', shape: { kind: 'scalar', type: 'string' } }],
        effectCeiling: 'READ_ONLY',
        preconditions: [],
        postconditions: [{ meaning: '必须有输出', verification: { kind: 'output_required', outputKey: 'out' } }],
      },
      implementations: [
        {
          implementationKey: 'default',
          kind: 'structured_steps',
          steps: [echoStep(defaultEcho)],
          outputMapping: { out: 'out' },
        },
        {
          implementationKey: 'alt',
          kind: 'structured_steps',
          steps: [
            {
              id: writeStep,
              name: '点击',
              type: 'click',
              effectType: 'SIDE_EFFECT',
              input: { target: { framePath: [], candidates: [{ by: 'css', value: '#go' }] } },
            },
          ],
          outputMapping: {},
        },
      ],
    }
    const result = compileModuleContent(content, { mode: 'release' })
    expect(result.ok).toBe(false)
    expect(result.diagnostics.some((item) => item.code === 'MODULE_EFFECT_EXCEEDS_CEILING')).toBe(true)
    expect(result.diagnostics.some((item) => item.code === 'MODULE_OUTPUT_UNMAPPED')).toBe(true)
  })

  it('AMF-01 后置条件未绑定到本实现步骤时发布阻断', () => {
    const content: ModuleContent = {
      contract: {
        inputs: [],
        outputs: [],
        effectCeiling: 'READ_ONLY',
        preconditions: [],
        postconditions: [
          { meaning: '断言通过', verification: { kind: 'step', stepId: defaultEcho } },
        ],
      },
      implementations: [
        {
          implementationKey: 'default',
          kind: 'structured_steps',
          steps: [
            {
              id: defaultEcho,
              name: '断言',
              type: 'assert',
              effectType: 'READ_ONLY',
              input: { expect: { kind: 'text_contains', value: 'ok' }, target: { framePath: [], candidates: [{ by: 'css', value: 'h1' }] } },
            },
          ],
          outputMapping: {},
        },
        {
          implementationKey: 'alt',
          kind: 'structured_steps',
          steps: [echoStep(altEcho)],
          outputMapping: {},
        },
      ],
    }
    const result = compileModuleContent(content, { mode: 'release' })
    expect(result.ok).toBe(false)
    expect(result.diagnostics.some((item) => item.code === 'MODULE_CONDITION_STEP_INVALID')).toBe(true)
  })

  it('AMF-04 非只读或平台未开放时阻断冻结回退', () => {
    const writeContent: ModuleContent = {
      ...readOnlyContent(true),
      contract: {
        ...readOnlyContent(true).contract,
        effectCeiling: 'SIDE_EFFECT',
      },
    }
    const loaded = (content: ModuleContent, key = 'mod'): LoadedModuleVersion => ({
      moduleId,
      targetId,
      moduleKey: key,
      name: '模块',
      versionId,
      versionNo: 1,
      publicationStatus: 'published',
      contentDigest: moduleContentDigest(content),
      contractDigest: 'c',
      implementationDigest: 'i',
      content,
    })
    const doc: ScenarioAuthoringDocumentV2 = {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [],
      nodes: [
        {
          kind: 'module',
          invocationId,
          moduleId,
          moduleVersionId: versionId,
          implementationKey: 'default',
          selection: { mode: 'frozen_fallback', candidates: ['default', 'alt'] },
          inputBindings: {},
          outputBindings: { out: 'exposed' },
        },
      ],
    }
    const ctx = (content: ModuleContent, fallbackEnabled = false): ExpansionContext => ({
      targetId,
      mode: 'publish',
      fallbackEnabled,
      loadedModules: new Map([[versionId, loaded(content)]]),
    })
    const disabled = expandAuthoringDocument(doc, ctx(readOnlyContent(true), false))
    expect(disabled.ok).toBe(false)
    expect(disabled.diagnostics.some((item) => item.code === 'MODULE_FALLBACK_DISABLED')).toBe(true)

    const notReadOnly = expandAuthoringDocument(doc, ctx(writeContent, true))
    expect(notReadOnly.ok).toBe(false)
    expect(notReadOnly.diagnostics.some((item) => item.code === 'MODULE_FALLBACK_NOT_READ_ONLY')).toBe(true)
  })

  it('pinned 保持原步骤 ID，回退展开全部候选且不提前占用暴露键', () => {
    const content = readOnlyContent(true)
    const loaded: LoadedModuleVersion = {
      moduleId,
      targetId,
      moduleKey: 'order.query',
      name: '查询',
      versionId,
      versionNo: 1,
      publicationStatus: 'published',
      contentDigest: moduleContentDigest(content),
      contractDigest: 'c',
      implementationDigest: 'i',
      content,
    }
    const pinnedDoc: ScenarioAuthoringDocumentV2 = {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [],
      nodes: [
        {
          kind: 'module',
          invocationId,
          moduleId,
          moduleVersionId: versionId,
          implementationKey: 'default',
          inputBindings: {},
          outputBindings: { out: 'exposed' },
        },
      ],
    }
    const pinned = expandAuthoringDocument(pinnedDoc, {
      targetId,
      mode: 'publish',
      loadedModules: new Map([[versionId, loaded]]),
    })
    expect(pinned.ok).toBe(true)
    expect(pinned.definition?.steps[0]?.id).toBe(deterministicStepId(invocationId, defaultEcho))
    expect(pinned.definition?.steps[0]?.outputKey).toBe('exposed')
    expect(pinned.manifest.candidateGroups).toBeUndefined()

    const fallbackDoc: ScenarioAuthoringDocumentV2 = {
      ...pinnedDoc,
      nodes: [
        {
          kind: 'module',
          invocationId,
          moduleId,
          moduleVersionId: versionId,
          implementationKey: 'default',
          inputBindings: {},
          outputBindings: { out: 'exposed' },
          selection: { mode: 'frozen_fallback', candidates: ['default', 'alt'] },
        },
      ],
    }
    const fallback = expandAuthoringDocument(fallbackDoc, {
      targetId,
      mode: 'publish',
      fallbackEnabled: true,
      loadedModules: new Map([[versionId, loaded]]),
    })
    expect(fallback.ok).toBe(true)
    expect(fallback.definition?.steps).toHaveLength(2)
    expect(fallback.definition?.steps[0]?.id).toBe(deterministicStepId(invocationId, defaultEcho, 'default'))
    expect(fallback.definition?.steps[0]?.outputKey).not.toBe('exposed')
    expect(fallback.manifest.candidateGroups).toHaveLength(1)
    expect(fallback.manifest.candidateGroups?.[0]?.alternatives[1]?.implementationKey).toBe('alt')
  })

  it('AMF-08 暂存输出只在提交后出现在暴露键', () => {
    const committed = commitStagedOutputs({ m0_default_out: 'from-alt' }, { exposed: 'm0_default_out' })
    expect(committed.exposed).toBe('from-alt')
    expect(commitStagedOutputs({ other: 1 }, { exposed: 'missing' }).exposed).toBeUndefined()
  })

  it('外部原因与核查不回退，模块原因才回退', () => {
    expect(fallbackAttribution({ code: 'SESSION_AUTH_TIMEOUT', category: 'INFRASTRUCTURE' })).toBe('EXTERNAL_INFRA')
    expect(shouldFallbackToNext({
      attribution: 'EXTERNAL_INFRA',
      debugHold: false,
      hasNextAlternative: true,
    })).toBe(false)
    expect(shouldFallbackToNext({
      attribution: 'MODULE',
      runStatus: 'NEEDS_REVIEW',
      debugHold: false,
      hasNextAlternative: true,
    })).toBe(false)
    expect(shouldFallbackToNext({
      attribution: 'MODULE',
      debugHold: false,
      hasNextAlternative: true,
    })).toBe(true)
  })

  it('跳过原因由候选组与选中实现派生', () => {
    const group = {
      groupId: invocationId,
      invocationId,
      alternatives: [
        {
          implementationKey: 'default',
          implementationDigest: 'a',
          stepIds: ['s1', 's2'],
          postconditionStepIds: [],
          outputStaging: {},
        },
        {
          implementationKey: 'alt',
          implementationDigest: 'b',
          stepIds: ['s3'],
          postconditionStepIds: [],
          outputStaging: {},
        },
      ],
    }
    expect(skipReasonForStep({
      stepId: 's2',
      group,
      stepStatus: 'SKIPPED',
      attemptedKeys: ['default'],
      selected: 'alt',
    })).toBe('fallback')
    expect(skipReasonForStep({
      stepId: 's3',
      group,
      stepStatus: 'SKIPPED',
      attemptedKeys: ['default'],
      selected: 'default',
    })).toBe('not_needed')
    expect(skipReasonForStep({
      stepId: 's3',
      group,
      stepStatus: 'SKIPPED',
      attemptedKeys: ['default'],
    })).toBe('not_attempted')
  })
})
