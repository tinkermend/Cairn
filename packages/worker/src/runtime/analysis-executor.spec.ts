import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { AnalysisJobDto } from '@cairn/shared'
import type { DbHandle, PreparedAnalysis } from '@cairn/db'
import { executeAnalysisJob, groundedCandidates } from './analysis-executor.js'

const mocks = vi.hoisted(() => ({ prepare: vi.fn(), submit: vi.fn(), fail: vi.fn(), heartbeat: vi.fn(), secret: vi.fn(), get: vi.fn() }))
vi.mock('@cairn/db', () => ({ prepareAnalysisJob: mocks.prepare, submitAnalysisJob: mocks.submit, failAnalysisJob: mocks.fail, heartbeatAnalysisJob: mocks.heartbeat, recordAnalysisModelUsage: vi.fn(), loadPlatformAiSecret: mocks.secret, getAnalysisJob: mocks.get }))

describe('analyst execution', () => {
  beforeEach(() => vi.resetAllMocks())
  afterEach(() => vi.unstubAllGlobals())
  const job = { analysisJobId: 'job', targetId: 'target', mode: 'run_incremental', checkpointSeq: 0, fencingToken: 1, budget: { maxItems: 20, useAi: false } } as AnalysisJobDto
  const prepared: PreparedAnalysis = { throughSeq: 1, result: {}, coverageGaps: [], noNewData: false, candidates: [], records: [{ sourceId: 'source', sourceRevision: 2, committedSeq: 1, runId: 'run' }], ai: { enabled: true, provider: 'deepseek', baseUrl: 'https://model.example/v1', model: 'test-model', secretRef: { provider: 'local', secretId: 'secret' }, thinkingMode: 'off', requestTimeoutMs: 1000, maxOutputTokens: 512, maxConcurrentJobs: 1 } }

  it('异步准备失败会记录失败，不遗留 RUNNING 作业', async () => {
    mocks.prepare.mockRejectedValue(new Error('input loading failed'))
    mocks.fail.mockResolvedValue({ status: 'RETRY_WAIT' })
    expect(await executeAnalysisJob({} as DbHandle, job, 'worker')).toMatchObject({ status: 'RETRY_WAIT' })
    expect(mocks.fail).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ error: 'input loading failed', retryable: true }))
    expect(mocks.submit).not.toHaveBeenCalled()
  })

  it('模型候选只允许引用冻结输入中的来源', () => {
    const output = (index: number) => JSON.stringify({ candidates: [{ kind: 'experience', title: '观察', summary: '有输入支持的结论', sourceIndexes: [index] }] })
    expect(groundedCandidates(output(0), prepared.records, 'target')[0]?.sources[0]).toMatchObject({ runId: 'run', sourceRevision: 2 })
    expect(() => groundedCandidates(output(99), prepared.records, 'target')).toThrow('ANALYSIS_SOURCE_INVALID')
  })

  it('独立模型配置发起有界调用，保存实际用量、模型和来源', async () => {
    mocks.prepare.mockResolvedValue(structuredClone(prepared))
    mocks.secret.mockResolvedValue({ id: 'secret', ciphertext: 'cipher', modelOrigin: 'https://model.example' })
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ model: 'actual-model', usage: { prompt_tokens: 20, completion_tokens: 10 }, choices: [{ message: { content: JSON.stringify({ candidates: [{ kind: 'experience', title: '观察', summary: '结论', sourceIndexes: [0] }] }) } }] }), { status: 200 }))
    vi.stubGlobal('fetch', fetcher)
    await executeAnalysisJob({} as DbHandle, { ...job, budget: { ...job.budget, useAi: true } }, 'worker', { decrypt: () => 'test-key' } as never)
    expect(fetcher).toHaveBeenCalledOnce()
    const sent = JSON.parse(String(fetcher.mock.calls[0]![1].body)) as Record<string, unknown>
    expect(sent).toMatchObject({ model: 'test-model', temperature: 0, response_format: { type: 'json_object' } })
    expect(sent).not.toHaveProperty('thinking')
    expect(sent).not.toHaveProperty('enable_thinking')
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ redirect: 'error' })
    expect(mocks.submit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ modelUsage: expect.objectContaining({ model: 'actual-model', invoked: true, inputTokens: 20, outputTokens: 10 }), candidates: [expect.objectContaining({ sources: [expect.objectContaining({ runId: 'run' })] })] }))
  })

  it('只按快照方言拼装，不回读当前配置', async () => {
    mocks.prepare.mockResolvedValue({
      ...structuredClone(prepared),
      ai: { ...prepared.ai, provider: 'qwen', model: 'qwen-plus' },
    })
    mocks.secret.mockResolvedValue({ id: 'secret', ciphertext: 'cipher', modelOrigin: 'https://model.example' })
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ candidates: [] }) } }],
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetcher)
    await executeAnalysisJob({} as DbHandle, { ...job, budget: { ...job.budget, useAi: true } }, 'worker', { decrypt: () => 'test-key' } as never)
    expect(JSON.parse(String(fetcher.mock.calls[0]![1].body))).toMatchObject({
      model: 'qwen-plus',
      enable_thinking: false,
    })
  })

  it('快照思考开且提供商未开放时不发请求', async () => {
    mocks.prepare.mockResolvedValue({
      ...structuredClone(prepared),
      ai: { ...prepared.ai, provider: 'qwen', thinkingMode: 'on' },
    })
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    mocks.fail.mockResolvedValue({ status: 'FAILED' })
    await executeAnalysisJob({} as DbHandle, { ...job, budget: { ...job.budget, useAi: true } }, 'worker', { decrypt: () => 'test-key' } as never)
    expect(fetcher).not.toHaveBeenCalled()
    expect(mocks.fail).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ error: expect.stringContaining('ANALYSIS_CONFIG_INVALID'), retryable: false }),
    )
  })

  it('旧快照缺提供商时不调模型，按配置无效失败且不可重试', async () => {
    mocks.prepare.mockResolvedValue({
      ...structuredClone(prepared),
      ai: { ...prepared.ai, provider: undefined },
    })
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    mocks.fail.mockResolvedValue({ status: 'FAILED' })
    await executeAnalysisJob({} as DbHandle, { ...job, budget: { ...job.budget, useAi: true } }, 'worker', { decrypt: () => 'test-key' } as never)
    expect(fetcher).not.toHaveBeenCalled()
    expect(mocks.fail).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ error: expect.stringContaining('ANALYSIS_CONFIG_INVALID'), retryable: false }),
    )
  })
})
