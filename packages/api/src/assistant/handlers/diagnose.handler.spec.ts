import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DomainError, getRun, listRuns } from '@cairn/db'
import { assembleDiagnoseContext } from '../context-assembler'
import { handleRunDiagnose } from './diagnose.handler'

vi.mock('@cairn/db', () => ({
  DomainError: class DomainError extends Error {
    constructor(public kind: string, public code: string, message: string) {
      super(message)
    }
  },
  listRuns: vi.fn(),
  getRun: vi.fn(),
  assertTargetPermission: vi.fn(),
}))

vi.mock('../context-assembler', async (importOriginal) => ({
  ...await importOriginal<typeof import('../context-assembler')>(),
  assembleDiagnoseContext: vi.fn(),
  validateGrounding: vi.fn(),
}))

function context() {
  return {
    db: {},
    actor: { id: 'reader-1' },
    slots: { findRecentFailed: true },
    body: {
      question: '最近 7 天有失败运行吗？',
      pageContext: { targetId: 'target-1' },
    },
    onProgress: vi.fn(),
  } as any
}

describe('recent failed run lookup', () => {
  beforeEach(() => vi.clearAllMocks())

  it('filters FAILED in storage before pagination and states the checked scope when empty', async () => {
    vi.mocked(listRuns).mockResolvedValueOnce({ items: [], nextCursor: null } as any)

    const answer = await handleRunDiagnose(context())

    expect(listRuns).toHaveBeenCalledOnce()
    expect(listRuns).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'FAILED', limit: 1, targetId: 'target-1' }),
      'reader-1',
    )
    expect(answer.facts[0]?.text).toContain('状态为 FAILED')
    expect(answer.facts[0]?.text).not.toContain('TIMED_OUT')
    expect(answer.missingInformation).toEqual([])
  })

  it('does not report no failures when the run query fails', async () => {
    vi.mocked(listRuns).mockRejectedValueOnce(new Error('database unavailable'))

    await expect(handleRunDiagnose(context())).rejects.toMatchObject({
      code: 'RUN_LIST_UNAVAILABLE',
      kind: 'unavailable',
    } satisfies Partial<DomainError>)
  })
})

describe('authorized Run diagnosis facts', () => {
  beforeEach(() => vi.clearAllMocks())

  const runId = '11111111-1111-4111-8111-111111111111'
  const stepRunId = '22222222-2222-4222-8222-222222222222'
  const stepId = '33333333-3333-4333-8333-333333333333'
  const attemptId = '44444444-4444-4444-8444-444444444444'
  const evidenceId = '77777777-7777-4777-8777-777777777777'

  function diagnosisContext(status: 'FAILED' | 'NEEDS_REVIEW' | 'SUCCEEDED', code: string, safeMessage: string,
    screenshotAvailable = false, screenshotDiagnosis?: 'suspected_blank' | 'still_loading' | 'not_flagged',
    includeError = true) {
    const run = {
      id: runId,
      targetId: '55555555-5555-4555-8555-555555555555',
      scenarioId: '66666666-6666-4666-8666-666666666666',
      status,
      outcomeStatus: status === 'SUCCEEDED' ? 'PASS' : 'UNKNOWN',
      stepRuns: [{
        id: stepRunId,
        stepId,
        name: status === 'FAILED' ? '点击 Groups 导航' : '视觉点击 Groups 导航',
        status: status === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED',
        attempts: [{
          id: attemptId,
          status: status === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED',
          error: includeError ? { code, safeMessage, cause: { message: 'PRIVATE_INTERNAL_CAUSE' } } : null,
        }],
      }],
    }
    vi.mocked(getRun).mockResolvedValueOnce(run as any)
    vi.mocked(assembleDiagnoseContext).mockResolvedValueOnce({
      observation: { run, eventSeq: 23, evidence: { items: screenshotAvailable
        ? [{ id: evidenceId, type: 'screenshot', status: 'available', stepRunId, attemptId,
          payload: screenshotDiagnosis ? { role: 'on_error', viewport: 'full_page',
            capturedAt: '2026-09-27T14:40:37.483Z', diagnosis: screenshotDiagnosis,
            sensitive: true } : undefined }] : [] } },
      pack: {
        focus: 'failure',
        text: 'authorized facts',
        citations: [`run:${runId}`, `attempt:${attemptId}`],
        facts: [
          { id: 'status', text: `运行状态为 ${status}，证据轴为 PENDING。`, citations: [`run:${runId}`] },
          ...(includeError ? [{ id: `step-${stepRunId}-error`, text: `步骤最近错误：${code}。`, citations: [`step:${stepId}`, `attempt:${attemptId}`] }] : []),
        ],
        missingInformation: [],
        missingReasons: [],
        nextActions: [
          { kind: 'run.detail', label: '打开运行详情', href: `/runs/${runId}`, citations: [`run:${runId}`] },
          { kind: 'run.evidence', label: '查看运行证据', href: `/runs/${runId}`, citations: [`run:${runId}`] },
        ],
      },
    } as any)
    return {
      db: {},
      actor: { id: 'reader-1', permissions: ['target:read', 'run:read'] },
      slots: { runId, focus: 'failure' },
      body: { question: '这次为什么失败？', pageContext: { runId } },
      targets: { getTarget: vi.fn(async () => ({ id: run.targetId, name: '授权目标' })) },
      session: null,
    } as any
  }

  it('includes only the authorized Attempt safeMessage, not internal cause', async () => {
    const answer = await handleRunDiagnose(diagnosisContext('FAILED', 'AI_NOT_FOUND', '文本模型定位不唯一或目标被遮挡'))

    const failure = answer.facts.find((fact) => fact.id === `step-${stepRunId}-error`)
    expect(failure?.text).toContain('AI_NOT_FOUND')
    expect(failure?.text).toContain('文本模型定位不唯一或目标被遮挡')
    expect(failure?.citations).toContain(`attempt:${attemptId}`)
    expect(JSON.stringify(answer)).not.toContain('PRIVATE_INTERNAL_CAUSE')
  })

  it('通用执行器错误没有根因事实时不生成有引用但无依据的猜测', async () => {
    const ctx = diagnosisContext('FAILED', 'EXECUTOR_ERROR', '执行器执行失败', true)
    ctx.session = {} as any

    const answer = await handleRunDiagnose(ctx)

    expect(answer.hypotheses).toEqual([])
    expect(answer.facts.find((fact) => fact.id === `step-${stepRunId}-error`)?.text).toContain('EXECUTOR_ERROR')
    expect(answer.missingInformation.join(' ')).toContain('无法确定是浏览器、网络、脚本还是页面导致')
    expect(answer.nextActions.some((item) => item.kind === 'run.evidence')).toBe(true)
    expect(answer.nextActions.find((item) => item.kind === 'run.evidence')?.href).toBe(`/runs/${runId}?stepRunId=${stepRunId}`)
    expect(answer.nextActions.some((item) => item.kind === 'target.accounts')).toBe(false)
    expect(answer.missingInformation.join(' ')).toContain('没有读取图像内容')
  })

  it('成功运行没有失败步骤时不让模型生成失败根因', async () => {
    const ctx = diagnosisContext('SUCCEEDED', '', '', true, undefined, false)
    ctx.body.question = '这次运行为什么失败？'
    ctx.session = {} as any
    const answer = await handleRunDiagnose(ctx)
    expect(answer.hypotheses).toEqual([])
    expect(answer.missingInformation.join(' ')).toContain('状态为 SUCCEEDED')
    expect(answer.missingInformation.join(' ')).toContain('不能描述截图里的具体页面状态')
    expect(answer.missingInformation.find((item) => item.includes('截图'))).not.toContain('失败根因')
    expect(answer.hypotheses).toEqual([])
  })

  it('运行标为失败但没有具体错误记录时不编造根因', async () => {
    const ctx = diagnosisContext('FAILED', '', '', false, undefined, false)
    ctx.session = {} as any
    const answer = await handleRunDiagnose(ctx)
    expect(answer.hypotheses).toEqual([])
    expect(answer.missingInformation.join(' ')).toContain('没有可定位的失败步骤和具体错误记录')
    expect(answer.hypotheses).toEqual([])
  })

  it('认证错误有账号来源时才提供账号核查入口', async () => {
    const ctx = diagnosisContext('FAILED', 'AUTH_NOT_VERIFIED', '目标系统认证未通过')
    ctx.session = { completeJson: vi.fn() }
    const answer = await handleRunDiagnose(ctx)
    expect(answer.nextActions.some((item) => item.kind === 'target.accounts')).toBe(true)
    expect(answer.hypotheses).toEqual([])
    expect(ctx.session.completeJson).not.toHaveBeenCalled()
    expect(answer.missingInformation.join(' ')).toContain('更深层的原因没有独立证据')
  })

  it('定位不唯一或遮挡无法区分时不顺着用户猜元素不存在', async () => {
    const ctx = diagnosisContext('FAILED', 'AI_NOT_FOUND', '文本模型定位不唯一或目标被遮挡', true)
    ctx.body.question = '这次点不到 Groups，是不是按钮被遮挡了？先看什么证据？'
    ctx.session = {} as any

    const answer = await handleRunDiagnose(ctx)

    expect(answer.hypotheses).toEqual([])
    expect(answer.facts.find((fact) => fact.id === `step-${stepRunId}-error`)?.text).toContain('定位不唯一或目标被遮挡')
    expect(answer.missingInformation.join(' ')).toContain('不能确认是哪一种，也不能断定元素不存在')
    expect(answer.nextActions.find((item) => item.kind === 'run.evidence')?.href).toBe(`/runs/${runId}?stepRunId=${stepRunId}`)
  })

  it('prioritizes human review without describing NEEDS_REVIEW as a failed Run', async () => {
    const answer = await handleRunDiagnose(diagnosisContext('NEEDS_REVIEW', 'AI_ACTION_INTERRUPTED', 'AI 动作发出后被取消或超时，页面上的结果需要核查'))

    expect(answer.facts.find((fact) => fact.id === 'status')?.text).toContain('需先人工核查实际页面结果')
    expect(answer.facts.find((fact) => fact.id === 'status')?.text).not.toContain('运行状态为 FAILED')
    expect(answer.nextActions[0]).toMatchObject({ kind: 'run.review', label: '先人工核查运行结果', href: `/runs/${runId}` })
    expect(answer.nextActions.find((item) => item.kind === 'run.evidence')?.label).toContain('操作后的实际状态')
    expect(answer.nextActions.find((item) => item.kind === 'run.evidence')?.href).toBe(`/runs/${runId}?stepRunId=${stepRunId}`)
  })

  it('明确区分截图已记录与图像内容已分析', async () => {
    const answer = await handleRunDiagnose(diagnosisContext('FAILED', 'AI_NOT_FOUND',
      '文本模型定位不唯一或目标被遮挡', true))
    expect(answer.missingInformation).toContain(
      '运行中有已记录的截图，但本次分析没有读取图像内容；无法确认具体页面内容、所在位置或失败根因。请在运行证据中人工核对。')
    expect(answer.nextActions.find((item) => item.kind === 'run.evidence')).toBeDefined()
  })

  it.each(['suspected_blank', 'still_loading'] as const)(
    '只把采集端 %s 标记作为带证据引用的质量线索，不宣称已读图或确认根因',
    async (diagnosis) => {
      const answer = await handleRunDiagnose(diagnosisContext('FAILED', 'AI_NOT_FOUND',
        '文本模型定位不唯一或目标被遮挡', true, diagnosis))
      const screenshotFact = answer.facts.find((fact) => fact.id === `screenshot-${evidenceId}`)
      expect(screenshotFact?.citations).toEqual([`evidence:${evidenceId}`])
      expect(screenshotFact?.text).toContain(diagnosis === 'suspected_blank' ? '疑似空白' : '疑似仍在加载')
      expect(screenshotFact?.text).toContain('失败现场截图（2026-09-27T14:40:37.483Z）')
      expect(screenshotFact?.text).toContain('不能据此确认页面位置或失败根因')
      expect(answer.missingInformation.join(' ')).toContain('没有读取图像内容')
      expect(JSON.stringify(answer)).not.toContain('sensitive')
    },
  )

  it('未标记为空白的截图不被说成页面正常', async () => {
    const answer = await handleRunDiagnose(diagnosisContext('FAILED', 'AI_NOT_FOUND',
      '文本模型定位不唯一或目标被遮挡', true, 'not_flagged'))
    expect(answer.facts.some((fact) => fact.id === `screenshot-${evidenceId}`)).toBe(false)
    expect(answer.missingInformation.join(' ')).toContain('没有读取图像内容')
  })

  it('用户追问截图中的页面状态时，不用文字模型猜测图像内容或追加无关的模型失败', async () => {
    const ctx = diagnosisContext('NEEDS_REVIEW', 'AI_ACTION_INTERRUPTED',
      'AI 动作发出后被取消或超时，页面上的结果需要核查', true)
    ctx.body.question = '这次视觉点击失败后，截图里页面停在哪里？我能直接重跑吗？'
    ctx.session = {} as any

    const answer = await handleRunDiagnose(ctx)

    expect(answer.hypotheses).toEqual([])
    expect(answer.missingInformation).toContain(
      '运行中有已记录的截图，但本次分析没有读取图像内容；无法确认具体页面内容、所在位置或失败根因。请在运行证据中人工核对。')
    expect(answer.missingInformation.join(' ')).not.toContain('模型未能')
    expect(answer.facts.find((fact) => fact.id === 'status')?.text).toContain('不能直接重跑')
  })
})
