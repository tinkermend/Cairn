import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  claimRun,
  consoleAccounts,
  createRunWithSnapshot,
  createScenarioWithVersion,
  getRun,
  newId,
  openIsolatedDb,
  registerWorker,
  targets,
  type DbHandle,
} from '@cairn/db/testing'
import type { SessionGrant, Step } from '@cairn/shared'
import { ExecutionEngine } from './engine.js'
import { StepExecutorRegistry } from './step-executor.js'
import { FixtureStepExecutor } from './fixture-executor.js'
import { AiStepExecutor } from './ai-executor.js'
import type { AiPort, BrowserPort } from './ports.js'
import { testAiExecution } from '../__tests__/harness.js'

const SCHEMA = `cairn_test_${Date.now().toString(36)}_engai`

function echoObject(): Step {
  return {
    id: newId(),
    name: '对象',
    type: 'echo',
    effectType: 'READ_ONLY',
    outputKey: 'order',
    input: { value: { orderNo: 'A-1' } },
  }
}

function echoField(): Step {
  return {
    id: newId(),
    name: '取字段',
    type: 'echo',
    effectType: 'READ_ONLY',
    outputKey: 'copied',
    input: { from: 'order', fromField: 'orderNo' },
  }
}

function aiAssert(retryLimit = 2): Step {
  return {
    id: newId(),
    name: '判断',
    type: 'ai_assert',
    effectType: 'READ_ONLY',
    policy: { retryLimit },
    input: { instruction: '是否成功' },
  }
}

describe('ExecutionEngine × AI 边界', { timeout: 60_000 }, () => {
  let handle: DbHandle
  let actorId: string
  let targetId: string
  let workerId: string
  let instanceId: string

  beforeAll(async () => {
    handle = await openIsolatedDb(SCHEMA)
    actorId = newId()
    targetId = newId()
    workerId = `ai-engine-${Date.now().toString(36)}`
    instanceId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'ai-tester',
      email: `ai-${actorId}@example.com`,
      status: 'active',
    })
    await handle.db.insert(targets).values({
      id: targetId,
      code: `ai-${SCHEMA.slice(-6)}`,
      name: 'AI 夹具',
      entryUrl: 'https://example.com',
    })
    await registerWorker(handle.db, { workerId, instanceId, capacity: 4, lostAfterSeconds: 60 })
  })

  afterAll(async () => {
    await handle?.close()
  })

  async function claimThis(runId: string) {
    await handle.pool!.query(
      `UPDATE runs SET status = 'CANCELLED', finished_at = now(), updated_at = now()
        WHERE status IN ('QUEUED', 'RECOVERING') AND id <> $1`,
      [runId],
    )
    const grant = await claimRun(handle, { workerId, instanceId, leaseTtlSeconds: 60 })
    if (!grant || grant.runId !== runId) throw new Error('未领到目标 Run')
    return grant
  }

  it('fromField 读取前序对象字段', async () => {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '字段引用',
      steps: [echoObject(), echoField()],
      actor: { id: actorId },
      compileMode: 'save',
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    const engine = new ExecutionEngine(handle, undefined, undefined, new StepExecutorRegistry([new FixtureStepExecutor()]))
    await engine.execute(created.detail.id, { grant: await claimThis(created.detail.id) })
    const detail = await getRun(handle.db, created.detail.id)
    expect(detail.status).toBe('SUCCEEDED')
    expect(detail.context.copied).toBe('A-1')
  })

  it('passed:false 不重试；hung 先 invalidate 再 release', async () => {
    let calls = 0
    const order: string[] = []
    const sessionGrant: SessionGrant = {
      sessionId: newId(),
      leaseId: newId(),
      generation: 1,
      sessionFencingToken: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }
    const browser: BrowserPort = {
      acquire: async () => ({ ok: true, grant: sessionGrant }),
      release: async () => {
        order.push('release')
      },
      invalidate: async () => {
        order.push('invalidate')
      },
      execute: async () => ({ ok: true, output: null }),
    }
    const failing: AiPort = {
      execute: async () => {
        calls += 1
        return { ok: true, output: { passed: false, reason: '不对' } }
      },
    }
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '断言不重试',
      steps: [aiAssert(2)],
      actor: { id: actorId },
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
      aiExecution: testAiExecution(),
    })
    const engine = new ExecutionEngine(
      handle,
      browser,
      undefined,
      new StepExecutorRegistry([new FixtureStepExecutor(), new AiStepExecutor(failing)]),
    )
    await engine.execute(created.detail.id, { grant: await claimThis(created.detail.id) })
    const detail = await getRun(handle.db, created.detail.id)
    expect(detail.status).toBe('FAILED')
    expect(calls).toBe(1)
    expect(detail.stepRuns[0]?.attempts).toHaveLength(1)

    calls = 0
    const hung: AiPort = {
      execute: async () => ({ ok: false, hung: true, summary: '未落定' }),
    }
    const hungScenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '迟到隔离',
      steps: [
        {
          id: newId(),
          name: '操作',
          type: 'ai_action',
          effectType: 'SIDE_EFFECT',
          input: { instruction: '点查询' },
        },
      ],
      actor: { id: actorId },
    })
    const hungRun = await createRunWithSnapshot(handle.db, {
      scenarioId: hungScenario.id,
      actor: { id: actorId },
      aiExecution: testAiExecution(),
    })
    const hungEngine = new ExecutionEngine(
      handle,
      browser,
      undefined,
      new StepExecutorRegistry([new AiStepExecutor(hung)]),
    )
    await hungEngine.execute(hungRun.detail.id, { grant: await claimThis(hungRun.detail.id) })
    const hungDetail = await getRun(handle.db, hungRun.detail.id)
    expect(hungDetail.status).toBe('NEEDS_REVIEW')
    expect(order.slice(-2)).toEqual(['invalidate', 'release'])
  })

  it('丢租：放行过动作的副作用 AI 步骤进 NEEDS_REVIEW；未放行动作的记 SESSION_LEASE_LOST 且不重试', async () => {
    const sessionGrant: SessionGrant = {
      sessionId: newId(),
      leaseId: newId(),
      generation: 1,
      sessionFencingToken: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }
    const browser: BrowserPort = {
      acquire: async () => ({ ok: true, grant: sessionGrant }),
      release: async () => {},
      invalidate: async () => {},
      execute: async () => ({ ok: true, output: null }),
    }

    const acted: AiPort = {
      execute: async () => ({
        ok: false,
        summary: '会话租约在 AI 动作开始后失效，页面上的结果未确认',
        error: {
          code: 'SESSION_LEASE_LOST',
          category: 'UNKNOWN',
          retryable: false,
          safeMessage: '会话租约在 AI 动作开始后失效，页面上的结果未确认',
        },
      }),
    }
    const actionScenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '丢租已动作',
      steps: [
        {
          id: newId(),
          name: '操作',
          type: 'ai_action',
          effectType: 'SIDE_EFFECT',
          input: { instruction: '点提交' },
        },
      ],
      actor: { id: actorId },
    })
    const actionRun = await createRunWithSnapshot(handle.db, {
      scenarioId: actionScenario.id,
      actor: { id: actorId },
      aiExecution: testAiExecution(),
    })
    await new ExecutionEngine(
      handle,
      browser,
      undefined,
      new StepExecutorRegistry([new AiStepExecutor(acted)]),
    ).execute(actionRun.detail.id, { grant: await claimThis(actionRun.detail.id) })
    const actionDetail = await getRun(handle.db, actionRun.detail.id)
    expect(actionDetail.status).toBe('NEEDS_REVIEW')
    expect(actionDetail.stepRuns[0]?.attempts[0]?.error?.code).toBe('SESSION_LEASE_LOST')

    let calls = 0
    const idle: AiPort = {
      execute: async () => {
        calls += 1
        return {
          ok: false,
          summary: '会话租约已失效，AI 步骤未发出动作',
          error: {
            code: 'SESSION_LEASE_LOST',
            category: 'INFRASTRUCTURE',
            retryable: false,
            safeMessage: '会话租约已失效，AI 步骤未发出动作',
          },
        }
      },
    }
    const readScenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '丢租未动作',
      steps: [aiAssert(2)],
      actor: { id: actorId },
    })
    const readRun = await createRunWithSnapshot(handle.db, {
      scenarioId: readScenario.id,
      actor: { id: actorId },
      aiExecution: testAiExecution(),
    })
    await new ExecutionEngine(
      handle,
      browser,
      undefined,
      new StepExecutorRegistry([new AiStepExecutor(idle)]),
    ).execute(readRun.detail.id, { grant: await claimThis(readRun.detail.id) })
    const readDetail = await getRun(handle.db, readRun.detail.id)
    expect(readDetail.status).toBe('FAILED')
    expect(calls).toBe(1)
    expect(readDetail.stepRuns[0]?.attempts).toHaveLength(1)
    expect(readDetail.stepRuns[0]?.attempts[0]?.error?.code).toBe('SESSION_LEASE_LOST')
  })

  // 真实 SDK 会把 abort 包成自己的错误再返回，执行器拿不到 AbortError。
  // 中止判定必须回落到引擎信号，否则 AI Action 超时会被记成可解释的普通失败。
  it('AI Action 超时被 SDK 包成普通失败时仍进 NEEDS_REVIEW', async () => {
    const sessionGrant: SessionGrant = {
      sessionId: newId(),
      leaseId: newId(),
      generation: 1,
      sessionFencingToken: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }
    const browser: BrowserPort = {
      acquire: async () => ({ ok: true, grant: sessionGrant }),
      release: async () => {},
      invalidate: async () => {},
      execute: async () => ({ ok: true, output: null }),
    }
    let calls = 0
    const swallowing: AiPort = {
      execute: async (_grant, _command, signal) => {
        calls += 1
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
        return { ok: false, summary: 'AI model request failed: CAIRN_ABORTED:model' }
      },
    }
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '超时未确认',
      steps: [
        {
          id: newId(),
          name: '操作',
          type: 'ai_action',
          effectType: 'SIDE_EFFECT',
          policy: { timeoutMs: 300 },
          input: { instruction: '点提交' },
        },
      ],
      actor: { id: actorId },
    })
    const run = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
      aiExecution: testAiExecution(),
    })
    const engine = new ExecutionEngine(
      handle,
      browser,
      undefined,
      new StepExecutorRegistry([new AiStepExecutor(swallowing)]),
    )
    await engine.execute(run.detail.id, { grant: await claimThis(run.detail.id) })
    const detail = await getRun(handle.db, run.detail.id)
    expect(detail.status).toBe('NEEDS_REVIEW')
    expect(calls).toBe(1)
    expect(detail.stepRuns[0]?.attempts).toHaveLength(1)
  })
})
