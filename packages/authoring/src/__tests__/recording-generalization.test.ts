import { describe, expect, it } from 'vitest'
import { parseDemonstrationFile } from '../demonstration-adapters.js'
import { foldRecordingGeneralization } from '../recording-generalization.js'
import { generateQuickActionRound, interpretGeneralizationIntent } from '../recording-rules.js'

const targetId = '00000000-0000-4000-8000-000000000001'
const captureId = '00000000-0000-4000-8000-000000000002'
const recordingDraftId = '00000000-0000-4000-8000-000000000003'
const roundCleanLoginId = '00000000-0000-4000-8000-000000000010'
const roundCleanMisfiresId = '00000000-0000-4000-8000-000000000020'
const roundParamId = '00000000-0000-4000-8000-000000000030'
const roundRelaxId = '00000000-0000-4000-8000-000000000040'
const roundOutcomeId = '00000000-0000-4000-8000-000000000050'

function createSampleSource() {
  const json = JSON.stringify([
    { type: 'navigation', url: 'https://example.test/login', timestamp: 1000, hashId: 'n1', pageInfo: { width: 1200, height: 800 } },
    { type: 'input', elementDescription: 'username', value: 'admin', hashId: 'i1', timestamp: 2000, pageInfo: { width: 1200, height: 800 } },
    { type: 'input', elementDescription: 'password', value: 'secret123', hashId: 'i2', timestamp: 3000, pageInfo: { width: 1200, height: 800 } },
    { type: 'click', elementDescription: '登录', hashId: 'c1', timestamp: 4000, pageInfo: { width: 1200, height: 800 } },
    { type: 'navigation', actionType: 'NavigationChanged', url: 'https://example.test/orders', hashId: 'n2', timestamp: 5000, pageInfo: { width: 1200, height: 800 } },
    { type: 'click', elementDescription: '查询', hashId: 'c2', timestamp: 6000, pageInfo: { width: 1200, height: 800 } },
    { type: 'click', elementDescription: '查询', hashId: 'c3', timestamp: 6300, pageInfo: { width: 1200, height: 800 } },
  ])
  return parseDemonstrationFile({ text: json, profile: 'midscene-recorder-json@1', targetId, captureId })
}

describe('recording generalization engine', () => {
  it('folds recording demonstration into deterministic candidate document', () => {
    const source = createSampleSource()
    const res1 = foldRecordingGeneralization({
      source,
      recordingDraftId,
      baseDecisions: [],
      rounds: [],
    })
    expect(res1.ok).toBe(true)
    if (!res1.ok) return

    const res2 = foldRecordingGeneralization({
      source,
      recordingDraftId,
      baseDecisions: [],
      rounds: [],
    })
    expect(res2.ok).toBe(true)
    if (!res2.ok) return

    // 确定性 Digest 严格一致
    expect(res1.candidateDigest).toBe(res2.candidateDigest)
    expect(res1.document.nodes.length).toBeGreaterThan(0)
  })

  it('generates clean_login rule round to strip login sequence when target has auth', () => {
    const source = createSampleSource()
    const baseFold = foldRecordingGeneralization({
      source,
      recordingDraftId,
      baseDecisions: [],
      rounds: [],
    })
    expect(baseFold.ok).toBe(true)
    if (!baseFold.ok) return

    const roundRes = generateQuickActionRound({
      recordingDraftId,
      roundId: roundCleanLoginId,
      action: 'clean_login',
      source,
      currentDocument: baseFold.document,
      targetHasAuth: true,
    })

    expect(roundRes.ok).toBe(true)
    if (!roundRes.ok) return

    expect(roundRes.round.operations.length).toBeGreaterThan(0)
    expect(roundRes.round.operations.every((op) => op.kind === 'remove_step')).toBe(true)
  })

  it('refuses clean_login when target does not have auth configured', () => {
    const source = createSampleSource()
    const baseFold = foldRecordingGeneralization({
      source,
      recordingDraftId,
      baseDecisions: [],
      rounds: [],
    })
    expect(baseFold.ok).toBe(true)
    if (!baseFold.ok) return

    const roundRes = generateQuickActionRound({
      recordingDraftId,
      roundId: roundCleanLoginId,
      action: 'clean_login',
      source,
      currentDocument: baseFold.document,
      targetHasAuth: false,
    })

    expect(roundRes.ok).toBe(false)
    if (!roundRes.ok) {
      expect(roundRes.error.code).toBe('AUTH_NOT_CONFIGURED')
    }
  })

  it('generates clean_misfires rule round for rapid consecutive clicks on same target', () => {
    const source = createSampleSource()
    const baseFold = foldRecordingGeneralization({
      source,
      recordingDraftId,
      baseDecisions: [],
      rounds: [],
    })
    expect(baseFold.ok).toBe(true)
    if (!baseFold.ok) return

    const roundRes = generateQuickActionRound({
      recordingDraftId,
      roundId: roundCleanMisfiresId,
      action: 'clean_misfires',
      source,
      currentDocument: baseFold.document,
    })

    expect(roundRes.ok).toBe(true)
    if (!roundRes.ok) return

    expect(roundRes.round.operations.length).toBe(1)
    expect(roundRes.round.operations[0].kind).toBe('remove_step')
  })

  it('generates parameterize rule round with dataset column sample matching', () => {
    const source = createSampleSource()
    const baseFold = foldRecordingGeneralization({
      source,
      recordingDraftId,
      baseDecisions: [],
      rounds: [],
    })
    expect(baseFold.ok).toBe(true)
    if (!baseFold.ok) return

    const roundRes = generateQuickActionRound({
      recordingDraftId,
      roundId: roundParamId,
      action: 'parameterize',
      source,
      currentDocument: baseFold.document,
      targetDatasets: [
        {
          id: 'ds-user',
          name: '用户数据集',
          schema: [
            {
              key: 'username',
              name: '登录账号',
              type: 'string',
              sampleValues: ['admin', 'guest'],
            },
          ],
        },
      ],
    })

    expect(roundRes.ok).toBe(true)
    if (!roundRes.ok) return

    expect(roundRes.round.decisionPatches.length).toBe(1)
    expect(roundRes.round.decisionPatches[0].parameter?.key).toBe('username')
    expect(roundRes.round.decisionPatches[0].parameter?.label).toBe('登录账号')
  })

  it('generates relax_timeout and expect_outcome quick action rounds', () => {
    const source = createSampleSource()
    const baseFold = foldRecordingGeneralization({
      source,
      recordingDraftId,
      baseDecisions: [],
      rounds: [],
    })
    expect(baseFold.ok).toBe(true)
    if (!baseFold.ok) return

    const relaxRes = generateQuickActionRound({
      recordingDraftId,
      roundId: roundRelaxId,
      action: 'relax_timeout',
      source,
      currentDocument: baseFold.document,
    })
    expect(relaxRes.ok).toBe(true)
    if (relaxRes.ok) {
      expect(relaxRes.round.operations[0].kind).toBe('set_step_policy')
    }

    const outcomeRes = generateQuickActionRound({
      recordingDraftId,
      roundId: roundOutcomeId,
      action: 'expect_outcome',
      source,
      currentDocument: baseFold.document,
    })
    expect(outcomeRes.ok).toBe(true)
    if (outcomeRes.ok) {
      expect(outcomeRes.round.operations[0].kind).toBe('add_outcome')
    }
  })

  it('correctly interprets positive natural language user requests', () => {
    const source = createSampleSource()
    const baseFold = foldRecordingGeneralization({
      source,
      recordingDraftId,
      baseDecisions: [],
      rounds: [],
    })
    expect(baseFold.ok).toBe(true)
    if (!baseFold.ok) return

    // S1: 调参意图
    const s1Res = interpretGeneralizationIntent({
      recordingDraftId,
      roundId: roundRelaxId,
      intent: '这一步多等一会儿',
      source,
      currentDocument: baseFold.document,
    })
    expect(s1Res.ok).toBe(true)
    if (s1Res.ok) {
      expect(s1Res.round.operations[0].kind).toBe('set_step_policy')
    }

    // S2: 参数化意图
    const s2Res = interpretGeneralizationIntent({
      recordingDraftId,
      roundId: roundParamId,
      intent: '客户名改成参数，以后按数据集批量跑',
      source,
      currentDocument: baseFold.document,
    })
    expect(s2Res.ok).toBe(true)
    if (s2Res.ok) {
      expect(s2Res.round.decisionPatches.length).toBeGreaterThan(0)
    }

    // S3: 成功条件与期望结果
    const s3Res = interpretGeneralizationIntent({
      recordingDraftId,
      roundId: roundOutcomeId,
      intent: '提交后应该看到保存成功',
      source,
      currentDocument: baseFold.document,
    })
    expect(s3Res.ok).toBe(true)
    if (s3Res.ok) {
      expect(s3Res.round.operations[0].kind).toBe('add_outcome')
    }

    // 清洗意图
    const cleanRes = interpretGeneralizationIntent({
      recordingDraftId,
      roundId: roundCleanLoginId,
      intent: '帮我剔除登录步骤',
      source,
      currentDocument: baseFold.document,
      targetHasAuth: true,
    })
    expect(cleanRes.ok).toBe(true)
    if (cleanRes.ok) {
      expect(cleanRes.round.operations.some((o) => o.kind === 'remove_step')).toBe(true)
    }

    // 取数意图
    const extractRes = interpretGeneralizationIntent({
      recordingDraftId,
      roundId: '00000000-0000-4000-8000-000000000099',
      intent: '把这里的工单数量取出来',
      source,
      currentDocument: baseFold.document,
    })
    expect(extractRes.ok).toBe(true)
    if (extractRes.ok) {
      expect(extractRes.round.operations[0].kind).toBe('insert_step')
    }
  })

  it('accurately intercepts negative examples with domain error codes and guidance (§13)', () => {
    const source = createSampleSource()
    const baseFold = foldRecordingGeneralization({
      source,
      recordingDraftId,
      baseDecisions: [],
      rounds: [],
    })
    expect(baseFold.ok).toBe(true)
    if (!baseFold.ok) return

    // 负例 1: 指代不明 / 模糊意图 -> CLARIFICATION_NEEDED
    const neg1 = interpretGeneralizationIntent({
      recordingDraftId,
      roundId: 'neg-1',
      intent: '优化一下',
      source,
      currentDocument: baseFold.document,
    })
    expect(neg1.ok).toBe(false)
    if (!neg1.ok) {
      expect(neg1.error.code).toBe('CLARIFICATION_NEEDED')
      expect(neg1.error.message).toContain('意图过于模糊')
    }

    // 负例 2: 页面列表循环 / 页面驱动 -> PAGE_LOOP_UNSUPPORTED
    const neg2 = interpretGeneralizationIntent({
      recordingDraftId,
      roundId: 'neg-2',
      intent: '对页面上每一个客户都点一次',
      source,
      currentDocument: baseFold.document,
    })
    expect(neg2.ok).toBe(false)
    if (!neg2.ok) {
      expect(neg2.error.code).toBe('PAGE_LOOP_UNSUPPORTED')
      expect(neg2.error.message).toContain('一期暂不支持页面列表循环')
    }

    // 负例 3: 明文口令字面量 -> SENSITIVE_LITERAL_FORBIDDEN
    const neg3 = interpretGeneralizationIntent({
      recordingDraftId,
      roundId: 'neg-3',
      intent: '密码改成 123456',
      source,
      currentDocument: baseFold.document,
    })
    expect(neg3.ok).toBe(false)
    if (!neg3.ok) {
      expect(neg3.error.code).toBe('SENSITIVE_LITERAL_FORBIDDEN')
      expect(neg3.error.message).toContain('禁止在泛化意图中写入明文密码')
    }

    // 负例 4: 步骤重排 -> REORDERING_NOT_SUPPORTED
    const neg4 = interpretGeneralizationIntent({
      recordingDraftId,
      roundId: 'neg-4',
      intent: '把第2步移到第1步前面',
      source,
      currentDocument: baseFold.document,
    })
    expect(neg4.ok).toBe(false)
    if (!neg4.ok) {
      expect(neg4.error.code).toBe('REORDERING_NOT_SUPPORTED')
      expect(neg4.error.message).toContain('录制顺序即业务操作顺序')
    }

    // 负例 5: 控制分支结构 -> CONTROL_FLOW_UNSUPPORTED
    const neg5 = interpretGeneralizationIntent({
      recordingDraftId,
      roundId: 'neg-5',
      intent: '如果失败了就跳转到另外一个网页',
      source,
      currentDocument: baseFold.document,
    })
    expect(neg5.ok).toBe(false)
    if (!neg5.ok) {
      expect(neg5.error.code).toBe('CONTROL_FLOW_UNSUPPORTED')
      expect(neg5.error.message).toContain('一期暂不支持条件分支')
    }
  })
})
