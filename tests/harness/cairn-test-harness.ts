import {
  claimRun,
  computeSnapshotDigest,
  consoleAccounts,
  createRunWithSnapshot,
  createScenarioWithVersion,
  getRun,
  listRunEvidence,
  newId,
  openIsolatedDb,
  registerWorker,
  secrets,
  targetAccounts,
  targets,
  type DbHandle,
} from '@cairn/db/testing'
import {
  DEV_CREDENTIAL_KEY,
  type RunDetailDto,
  type RunGrant,
  type Step,
} from '@cairn/shared'
import { credentialKeyFromEnv, LocalSecretProvider } from '@cairn/secret'
import { ExecutionEngine } from '../../packages/worker/src/engine/engine.js'
import { MockModelClient } from '../../packages/worker/src/ai/mock-model-client.js'
import { dumpTestFailureArtifacts } from '../../packages/worker/src/testing/failure-artifacts.js'

export type HarnessInitOptions = {
  schema?: string
  workerId?: string
  secretKey?: string
}

export type HarnessScenarioOptions = {
  name?: string
  steps: Step[]
  inputs?: { key: string; label: string }[]
  runInput?: Record<string, string>
  targetCode?: string
  targetName?: string
  accountUsername?: string
  accountPassword?: string
}

export type HarnessSetupResult = {
  scenarioId: string
  runId: string
  targetId: string
  accountId: string
  snapshotDigest: string
}

/**
 * 识途全链路自测脚手架 (CairnTestHarness)
 * 允许 AI 开发者以 <10 行代码编排并执行完整的自动化测试闭环：
 * Target -> Account -> Scenario -> Run -> Engine -> StepRuns -> Evidence
 */
export class CairnTestHarness {
  readonly handle: DbHandle
  readonly engine: ExecutionEngine
  readonly secretProvider: LocalSecretProvider
  readonly actorId: string
  readonly workerId: string
  readonly workerInstanceId: string

  private constructor(params: {
    handle: DbHandle
    engine: ExecutionEngine
    secretProvider: LocalSecretProvider
    actorId: string
    workerId: string
    workerInstanceId: string
  }) {
    this.handle = params.handle
    this.engine = params.engine
    this.secretProvider = params.secretProvider
    this.actorId = params.actorId
    this.workerId = params.workerId
    this.workerInstanceId = params.workerInstanceId
  }

  static async create(options?: HarnessInitOptions): Promise<CairnTestHarness> {
    const schema = options?.schema ?? `cairn_harness_${Date.now().toString(36)}`
    const handle = await openIsolatedDb(schema)

    const actorId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'harness-runner',
      email: `harness-${actorId}@cairn.local`,
      status: 'active',
    })

    const workerId = options?.workerId ?? `harness-worker-${Date.now().toString(36)}`
    const workerInstanceId = newId()
    await registerWorker(handle.db, {
      workerId,
      instanceId: workerInstanceId,
      capacity: 10,
      lostAfterSeconds: 60,
    })

    const rawKey = options?.secretKey ?? process.env.CAIRN_CREDENTIAL_KEY ?? DEV_CREDENTIAL_KEY
    const secretProvider = new LocalSecretProvider(credentialKeyFromEnv(rawKey))

    const engine = new ExecutionEngine(handle, undefined, secretProvider)

    return new CairnTestHarness({
      handle,
      engine,
      secretProvider,
      actorId,
      workerId,
      workerInstanceId,
    })
  }

  /**
   * 声明式快速准备 Target、Account、Scenario 与 Run
   */
  async setupScenario(options: HarnessScenarioOptions): Promise<HarnessSetupResult> {
    const targetId = newId()
    const targetCode = options.targetCode ?? `tgt-${Date.now().toString(36)}`
    await this.handle.db.insert(targets).values({
      id: targetId,
      code: targetCode,
      name: options.targetName ?? 'Harness 目标系统',
      entryUrl: 'https://harness.cairn.local',
    })

    const accountId = newId()
    const secretId = newId()
    const password = options.accountPassword ?? 'harness-pass-123'
    const ciphertext = this.secretProvider.encrypt(secretId, password)

    await this.handle.db.insert(secrets).values({
      id: secretId,
      provider: 'local',
      ciphertext,
    })

    await this.handle.db.insert(targetAccounts).values({
      id: accountId,
      targetId,
      displayName: options.accountUsername ?? 'harness-operator',
      username: options.accountUsername ?? 'harness-operator',
      secretProvider: 'local',
      secretId,
      status: 'active',
    })

    const scenario = await createScenarioWithVersion(this.handle.db, {
      targetId,
      name: options.name ?? 'Harness 测试场景',
      steps: options.steps,
      inputs: options.inputs,
      actor: { id: this.actorId },
    })

    const run = await createRunWithSnapshot(this.handle.db, {
      scenarioId: scenario.id,
      input: options.runInput,
      actor: { id: this.actorId },
    })

    const snapshotDigest = computeSnapshotDigest(run.detail.snapshot)

    return {
      scenarioId: scenario.id,
      runId: run.detail.id,
      targetId,
      accountId,
      snapshotDigest,
    }
  }

  /**
   * 领取并执行 Run 直至收敛
   */
  async executeRun(runId: string, options?: { signal?: AbortSignal }): Promise<RunDetailDto> {
    // 排除同一测试中的其它待跑 Run，确保精准领取目标 Run
    await this.handle.pool.query(
      `UPDATE runs
          SET status = 'CANCELLED',
              finished_at = COALESCE(finished_at, now()),
              updated_at = now()
        WHERE status IN ('QUEUED', 'RECOVERING')
          AND id <> $1`,
      [runId],
    )

    const grant = await claimRun(this.handle, {
      workerId: this.workerId,
      instanceId: this.workerInstanceId,
      leaseTtlSeconds: 60,
    })

    if (!grant || grant.runId !== runId) {
      throw new Error(`无法领取 Run [${runId}]，可能已被其它 Worker 持有或状态非 QUEUED/RECOVERING`)
    }

    await this.engine.execute(runId, {
      grant,
      signal: options?.signal,
    })

    return getRun(this.handle.db, runId)
  }

  /**
   * 断言 Run 最终状态
   */
  async assertRunCompleted(
    runId: string,
    expectedStatus: 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'NEEDS_REVIEW',
  ): Promise<RunDetailDto> {
    const detail = await getRun(this.handle.db, runId)
    if (detail.status !== expectedStatus) {
      await dumpTestFailureArtifacts({
        testName: `assertRunCompleted_${runId}`,
        error: new Error(`Run 状态期望为 ${expectedStatus}，但实际为 ${detail.status}`),
        context: { runId, status: detail.status, stepRuns: detail.stepRuns },
      })
      throw new Error(`Run [${runId}] 状态校验失败: 期望 ${expectedStatus}, 实际为 ${detail.status}`)
    }
    return detail
  }

  /**
   * 断言证据产生
   */
  async assertEvidenceCreated(runId: string, criteria?: { minCount?: number; kinds?: string[] }) {
    const evidenceList = await listRunEvidence(this.handle.db, runId)
    if (criteria?.minCount !== undefined && evidenceList.length < criteria.minCount) {
      throw new Error(`Run [${runId}] 证据数量不足: 期望至少 ${criteria.minCount} 条，实际仅产生 ${evidenceList.length} 条`)
    }
    if (criteria?.kinds) {
      for (const kind of criteria.kinds) {
        const found = evidenceList.some((e) => e.kind === kind)
        if (!found) {
          throw new Error(`Run [${runId}] 缺少类型为 [${kind}] 的 Evidence`)
        }
      }
    }
    return evidenceList
  }

  async close(): Promise<void> {
    await this.handle.close()
  }
}
