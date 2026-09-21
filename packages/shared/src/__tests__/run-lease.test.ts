import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RUN_LEASE_TTL_SECONDS,
  DEFAULT_RUN_MAX_RECOVERIES,
  DEFAULT_WORKER_LOST_AFTER_SECONDS,
  FINISHED_RUN_STATUSES,
  HALTED_RUN_STATUSES,
  RUN_LEASE_ERROR_CODES,
  isFinishedRunStatus,
  isHaltedRunStatus,
  resumeAuthBodySchema,
  reviewRunBodySchema,
  runGrantSchema,
  workerEnvSchema,
} from '../index.js'
import { DEV_CREDENTIAL_KEY, DEV_INTERNAL_AUTH_SECRET } from '../env.js'

const grant = {
  runId: '00000000-0000-4000-8000-000000000031',
  leaseId: '00000000-0000-4000-8000-000000000032',
  fencingToken: 1,
  holderWorkerId: 'worker-a',
  expiresAt: '2026-09-11T03:00:00.000Z',
}

/** 密钥必填、无默认值，parse 时必须带上。 */
const WORKER_SECRETS = {
  CAIRN_CREDENTIAL_KEY: DEV_CREDENTIAL_KEY,
  CAIRN_INTERNAL_AUTH_SECRET: DEV_INTERNAL_AUTH_SECRET,
}

describe('HALTED / FINISHED', () => {
  it('NEEDS_REVIEW 暂停自动推进但不是最终结论', () => {
    expect(HALTED_RUN_STATUSES).toContain('NEEDS_REVIEW')
    expect(FINISHED_RUN_STATUSES).not.toContain('NEEDS_REVIEW')
    expect(isHaltedRunStatus('NEEDS_REVIEW')).toBe(true)
    expect(isFinishedRunStatus('NEEDS_REVIEW')).toBe(false)
    expect(isFinishedRunStatus('FAILED')).toBe(true)
  })
})

describe('runGrantSchema', () => {
  it('接受完整 grant', () => {
    expect(runGrantSchema.parse(grant)).toEqual(grant)
  })

  it('拒绝自造 fencing token 形状', () => {
    expect(() => runGrantSchema.parse({ ...grant, fencingToken: 0 })).toThrow()
    expect(() => runGrantSchema.parse({ ...grant, extra: true })).toThrow()
  })
})

describe('review / resume body', () => {
  it('只允许 fail / cancel', () => {
    expect(reviewRunBodySchema.parse({ conclusion: 'fail', note: '已知副作用' })).toEqual({
      conclusion: 'fail',
      note: '已知副作用',
    })
    expect(() => reviewRunBodySchema.parse({ conclusion: 'resume' })).toThrow()
  })

  it('note 超长被拒', () => {
    expect(() => reviewRunBodySchema.parse({ conclusion: 'cancel', note: 'x'.repeat(513) })).toThrow()
    expect(resumeAuthBodySchema.parse({})).toEqual({})
  })
})

describe('RUN_LEASE_ERROR_CODES', () => {
  it('只保留有产生者的码', () => {
    // WORKER_ID_CONFLICT 由 registerWorker 抛出，RUN_RECOVERY_EXHAUSTED 写进 Evidence。
    // WORKER_PROTOCOL_UNSUPPORTED 用于 Worker 协议能力闸门。
    // WORKER_HAS_ACTIVE_TASKS、WORKER_IS_ACTIVE 用于节点删除安全守卫。
    expect(RUN_LEASE_ERROR_CODES).toEqual([
      'WORKER_ID_CONFLICT',
      'WORKER_PROTOCOL_UNSUPPORTED',
      'RUN_RECOVERY_EXHAUSTED',
      'WORKER_HAS_ACTIVE_TASKS',
      'WORKER_IS_ACTIVE',
    ])
  })
})

describe('workerEnvSchema run lease', () => {
  it('默认值对齐方案', () => {
    const env = workerEnvSchema.parse({ ...WORKER_SECRETS })
    expect(env.CAIRN_WORKER_CAPACITY).toBe(1)
    expect(env.CAIRN_WORKER_HEARTBEAT_MS).toBe(5_000)
    expect(env.CAIRN_RUN_LEASE_TTL_SECONDS).toBe(DEFAULT_RUN_LEASE_TTL_SECONDS)
    expect(env.CAIRN_WORKER_LOST_AFTER_SECONDS).toBe(DEFAULT_WORKER_LOST_AFTER_SECONDS)
    expect(env.CAIRN_RUN_MAX_RECOVERIES).toBe(DEFAULT_RUN_MAX_RECOVERIES)
  })

  it('LOST_AFTER ≤ TTL 与 TTL < 3×HEARTBEAT 拒绝启动', () => {
    const lost = workerEnvSchema.safeParse({ ...WORKER_SECRETS, 
      CAIRN_WORKER_LOST_AFTER_SECONDS: '30',
      CAIRN_RUN_LEASE_TTL_SECONDS: '30',
    })
    expect(lost.success).toBe(false)
    expect(lost.error?.issues.map((i) => i.path.join('.'))).toContain('CAIRN_WORKER_LOST_AFTER_SECONDS')

    const ttl = workerEnvSchema.safeParse({ ...WORKER_SECRETS, 
      CAIRN_RUN_LEASE_TTL_SECONDS: '10',
      CAIRN_WORKER_HEARTBEAT_MS: '5000',
    })
    expect(ttl.success).toBe(false)
    expect(ttl.error?.issues.map((i) => i.path.join('.'))).toContain('CAIRN_RUN_LEASE_TTL_SECONDS')
  })
})
