import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as dbApi from '@cairn/db'
import { PROCESS_LOG_EVENTS } from '@cairn/shared'
import { settleRun } from './engine-settle.js'

const ENGINE_DIR = __dirname
const FORBIDDEN_IMPORT =
  /(?:from|import|require)\s*\(?\s*['"][^'"]*(?:playwright|midscene|page-agent|@midscene\/|@page-agent\/|@cairn\/storage)/i
/** Engine 只能通过注入的 BrowserPort 使用会话，不得直接引用 ../browser。 */
const FORBIDDEN_BROWSER_DIR = /(?:from|import|require)\s*\(?\s*['"][^'"]*\.\.\/browser/

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      yield* walk(full)
      continue
    }
    if (name.endsWith('.ts')) yield full
  }
}

describe('Engine 依赖边界', () => {
  it('递归检查源码与测试不引用浏览器或 AI SDK', () => {
    const hits: string[] = []
    for (const file of walk(ENGINE_DIR)) {
      const text = readFileSync(file, 'utf8')
      if (FORBIDDEN_IMPORT.test(text) || FORBIDDEN_BROWSER_DIR.test(text)) hits.push(file.slice(ENGINE_DIR.length + 1))
    }
    expect(hits).toEqual([])
  })

  it('ES-P2 纯函数文件不引用 engine.ts，也无模块级可变状态', () => {
    const files = ['engine-step-plan.ts', 'engine-candidate-plan.ts', 'engine-decisions.ts']
    for (const name of files) {
      const text = readFileSync(join(ENGINE_DIR, name), 'utf8')
      expect(text, name).not.toMatch(/from ['"]\.\/engine\.js['"]/)
      expect(text, name).not.toMatch(/^(let|var) /m)
    }
  })

  it('ES-D3 协作模块不互相 import，收尾不依赖 Attempt／闸门／调试', () => {
    const attempt = readFileSync(join(ENGINE_DIR, 'engine-attempt.ts'), 'utf8')
    const auth = readFileSync(join(ENGINE_DIR, 'engine-auth-gate.ts'), 'utf8')
    const debug = readFileSync(join(ENGINE_DIR, 'engine-debug.ts'), 'utf8')
    const settle = readFileSync(join(ENGINE_DIR, 'engine-settle.ts'), 'utf8')
    const engine = readFileSync(join(ENGINE_DIR, 'engine.ts'), 'utf8')
    expect(attempt).not.toMatch(/engine-auth-gate/)
    expect(auth).not.toMatch(/engine-attempt/)
    expect(debug).not.toMatch(/engine-attempt|engine-auth-gate|engine-settle/)
    expect(settle).not.toMatch(/engine-attempt|engine-auth-gate|engine-debug|engine-preflight/)
    expect(engine).not.toMatch(/completeMapJobSlice|projectModuleInvocationResults|settleRunEvidence|settleRunOutcome/)
    expect(engine).not.toMatch(/^function /m)
    expect(Object.keys(PROCESS_LOG_EVENTS)).toEqual([
      'runStarted',
      'runFinished',
      'attemptStarted',
      'attemptFinished',
      'runHolding',
      'aiModelCall',
      'aiModelCallFailed',
    ])
  })
})

describe('Engine 收尾登记表', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const grant = {
    holderWorkerId: 'worker-1',
    leaseId: 'lease-1',
  } as const

  function host() {
    return { emitProcess: vi.fn() }
  }

  function haltedRow(overrides: Record<string, unknown> = {}) {
    return {
      status: 'SUCCEEDED',
      snapshot: {
        mapJob: { jobId: '00000000-0000-4000-8000-000000000099' },
        moduleManifest: { entries: [{ moduleId: 'm1' }] },
        outcomeManifest: { entries: [{ contractId: 'c1' }] },
      },
      ...overrides,
    }
  }

  it('ES-C1 逐项故障注入时其余收尾仍执行', async () => {
    vi.spyOn(dbApi, 'loadRunRow').mockResolvedValue(haltedRow() as never)
    const cases = [
      ['settleRunEvidence', 'evidence'] as const,
      ['completeMapJobSlice', 'mapJob'] as const,
      ['projectModuleInvocationResults', 'moduleResults'] as const,
      ['settleRunOutcome', 'outcomeResults'] as const,
    ]
    for (const [fn, failed] of cases) {
      const evidence = vi.spyOn(dbApi, 'settleRunEvidence').mockReset()
      const map = vi.spyOn(dbApi, 'completeMapJobSlice').mockReset()
      const modules = vi.spyOn(dbApi, 'projectModuleInvocationResults').mockReset()
      const outcomes = vi.spyOn(dbApi, 'settleRunOutcome').mockReset()
      evidence.mockResolvedValue(undefined as never)
      map.mockResolvedValue({ continue: false, jobId: 'j' } as never)
      modules.mockResolvedValue(undefined as never)
      outcomes.mockResolvedValue(undefined as never)
      vi.spyOn(dbApi, fn).mockRejectedValue(new Error(`${failed} boom`))
      const engine = host()
      await settleRun.call(engine as never, {} as never, 'run-1', grant as never)
      expect(evidence).toHaveBeenCalled()
      expect(map).toHaveBeenCalled()
      expect(modules).toHaveBeenCalled()
      expect(outcomes).toHaveBeenCalled()
      expect(engine.emitProcess).toHaveBeenCalledWith(
        'warn',
        expect.any(String),
        expect.objectContaining({
          runId: 'run-1',
          workerId: 'worker-1',
          leaseId: 'lease-1',
          settler: failed,
        }),
      )
    }
  })

  it('ES-C2 地图作业成功只调一次 completeMapJobSlice；已取消仍按 cancelled 收尾', async () => {
    const map = vi.spyOn(dbApi, 'completeMapJobSlice').mockResolvedValue({ continue: false, jobId: 'j' } as never)
    vi.spyOn(dbApi, 'settleRunEvidence').mockResolvedValue(undefined as never)
    vi.spyOn(dbApi, 'projectModuleInvocationResults').mockResolvedValue(undefined as never)
    vi.spyOn(dbApi, 'settleRunOutcome').mockResolvedValue(undefined as never)
    vi.spyOn(dbApi, 'loadRunRow').mockResolvedValue(haltedRow() as never)
    await settleRun.call(host() as never, {} as never, 'run-map', grant as never)
    expect(map).toHaveBeenCalledTimes(1)
    expect(map).toHaveBeenCalledWith(expect.anything(), 'run-map', 'completed')

    map.mockClear()
    vi.spyOn(dbApi, 'loadRunRow').mockResolvedValue(haltedRow({ status: 'CANCELLED' }) as never)
    await settleRun.call(host() as never, {} as never, 'run-map', grant as never)
    expect(map).toHaveBeenCalledTimes(1)
    expect(map).toHaveBeenCalledWith(expect.anything(), 'run-map', 'cancelled')
  })

  it('ES-C3 收尾共用一次 loadRunRow', async () => {
    const load = vi.spyOn(dbApi, 'loadRunRow').mockResolvedValue(haltedRow() as never)
    vi.spyOn(dbApi, 'settleRunEvidence').mockResolvedValue(undefined as never)
    vi.spyOn(dbApi, 'completeMapJobSlice').mockResolvedValue({ continue: false, jobId: 'j' } as never)
    vi.spyOn(dbApi, 'projectModuleInvocationResults').mockResolvedValue(undefined as never)
    vi.spyOn(dbApi, 'settleRunOutcome').mockResolvedValue(undefined as never)
    await settleRun.call(host() as never, {} as never, 'run-1', grant as never)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('ES-C4 读行失败时证据收尾仍执行，地图、模块与结果轴跳过', async () => {
    vi.spyOn(dbApi, 'loadRunRow').mockRejectedValue(new Error('row gone'))
    const evidence = vi.spyOn(dbApi, 'settleRunEvidence').mockResolvedValue(undefined as never)
    const map = vi.spyOn(dbApi, 'completeMapJobSlice').mockResolvedValue({ continue: false, jobId: 'j' } as never)
    const modules = vi.spyOn(dbApi, 'projectModuleInvocationResults').mockResolvedValue(undefined as never)
    const outcomes = vi.spyOn(dbApi, 'settleRunOutcome').mockResolvedValue(undefined as never)
    await settleRun.call(host() as never, {} as never, 'run-1', grant as never)
    expect(evidence).toHaveBeenCalledTimes(1)
    expect(map).not.toHaveBeenCalled()
    expect(modules).not.toHaveBeenCalled()
    expect(outcomes).not.toHaveBeenCalled()
  })

  it('ES-C6 收尾失败 warn 带齐 ID 且不新增事件名表', async () => {
    vi.spyOn(dbApi, 'loadRunRow').mockResolvedValue(haltedRow({ snapshot: {} }) as never)
    vi.spyOn(dbApi, 'settleRunEvidence').mockRejectedValue(new Error('upload'))
    const engine = host()
    await settleRun.call(engine as never, {} as never, 'run-1', grant as never)
    expect(engine.emitProcess).toHaveBeenCalledWith(
      'warn',
      '证据收尾失败',
      expect.objectContaining({
        runId: 'run-1',
        workerId: 'worker-1',
        leaseId: 'lease-1',
        settler: 'evidence',
        message: 'upload',
      }),
    )
  })
})
