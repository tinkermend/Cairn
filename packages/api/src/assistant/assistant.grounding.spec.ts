import { describe, expect, it, vi } from 'vitest'
import { validateGrounding } from './context-assembler.js'
import { handleOperationsDiagnose } from './handlers/operations.handler.js'
import { citationKey, type AssistantCitationKey, type AssistantFact } from '@cairn/shared'
import * as dbModule from '@cairn/db'

const UUID_RUN_1 = '01920000-0000-7000-8000-000000000100'
const UUID_STEP_1 = '01920000-0000-7000-8000-000000000200'
const UUID_GHOST = '01920000-0000-7000-8000-000000000999'

describe('Scheme B Grounding Validator and Temporal Freshness', () => {
  describe('validateGrounding substantive checks', () => {
    it('approves claims with valid citations and consistent facts', () => {
      const allowed: AssistantCitationKey[] = [
        citationKey('run', UUID_RUN_1),
        citationKey('step', UUID_STEP_1),
      ]
      const items = [
        {
          text: '步骤执行失败是因为外部网络超时',
          citations: [citationKey('step', UUID_STEP_1)],
        },
      ]

      const { valid, invalid } = validateGrounding(items, allowed)
      expect(valid.length).toBe(1)
      expect(invalid.length).toBe(0)
    })

    it('rejects items with empty citations or unknown citation keys', () => {
      const allowed: AssistantCitationKey[] = [citationKey('run', UUID_RUN_1)]
      const items = [
        {
          text: '没有引用的假设',
          citations: [],
        },
        {
          text: '引用了虚构对象的假设',
          citations: [citationKey('run', UUID_GHOST)],
        },
      ]

      const { valid, invalid, invalidReasons } = validateGrounding(items, allowed)
      expect(valid.length).toBe(0)
      expect(invalid.length).toBe(2)
      expect(invalidReasons?.[0]).toBe('MISSING_CITATIONS')
      expect(invalidReasons?.[1]).toContain('UNKNOWN_CITATIONS')
    })

    it('rejects revision mismatch when sourceRevisions are provided', () => {
      const allowed: AssistantCitationKey[] = [
        `term:${UUID_RUN_1}:1` as AssistantCitationKey,
      ]
      const items = [
        {
          text: '使用过期的术语版本',
          citations: [`term:${UUID_RUN_1}:1` as AssistantCitationKey],
        },
      ]

      const { valid, invalid, invalidReasons } = validateGrounding(items, allowed, {
        sourceRevisions: { [UUID_RUN_1]: 2 }, // Expected revision is 2, citation cited revision 1
      })
      expect(valid.length).toBe(0)
      expect(invalid.length).toBe(1)
      expect(invalidReasons?.[0]).toContain('REVISION_MISMATCH')
    })

    it('rejects contradictory claims against confirmed facts', () => {
      const allowed: AssistantCitationKey[] = [citationKey('run', UUID_RUN_1)]
      const items = [
        {
          text: '本次运行执行成功，未发现异常',
          citations: [citationKey('run', UUID_RUN_1)],
        },
      ]

      const facts: AssistantFact[] = [
        {
          id: 'fact-1',
          text: '运行状态为 FAILED',
          citations: [citationKey('run', UUID_RUN_1)],
          factKey: 'status',
          value: 'FAILED',
        },
      ]

      const { valid, invalid, invalidReasons } = validateGrounding(items, allowed, { facts })
      expect(valid.length).toBe(0)
      expect(invalid.length).toBe(1)
      expect(invalidReasons?.[0]).toBe('CONTRADICTS_CONFIRMED_FACT_STATUS_FAILED')
    })
  })

  describe('handleOperationsDiagnose with real monitoring facts', () => {
    it('degrades to unknown and reports stale heartbeat when Worker heartbeat is stale', async () => {
      const asOf = new Date('2026-09-23T10:00:00.000Z')
      const mockFleet = {
        asOf,
        data: {
          workerPool: {
            ready: 1,
            draining: 0,
            stopped: 0,
            lost: 0,
            heartbeatFresh: 0,
            heartbeatStale: 1,
          },
          slots: {
            running: 0,
            holding: 0,
            waitingForAuth: 0,
            leftoverAuthHolds: 0,
            expiredLeaseResidue: 0,
            runCapacityUsed: 0,
          },
        } as any,
        liveHeartbeatStale: 1, // 1 worker with stale heartbeat!
      }

      vi.spyOn(dbModule, 'summarizeFleet').mockResolvedValue(mockFleet)
      vi.spyOn(dbModule, 'summarizeQueues').mockResolvedValue({
        asOf,
        data: { metrics: { 'queue.claimableRuns': { value: 0 } } } as any,
      })

      const mockCtx: any = {
        db: {} as any,
        actor: { id: 'act-1', email: 'test@example.com' },
        slots: {},
        question: '现在系统运行正常吗？',
        body: { question: '现在系统运行正常吗？' },
        session: null,
        onProgress: vi.fn(),
      }

      const result = await handleOperationsDiagnose(mockCtx)
      expect(result.kind).toBe('diagnosis')
      // Must NOT claim system is normal
      const normalObs = result.facts.find((f) => f.text.includes('基础服务与 Worker 进程运行正常'))
      expect(normalObs).toBeUndefined()

      // Must explicitly mention stale heartbeat
      const staleObs = result.facts.find((f) => f.text.includes('心跳已超时失效'))
      expect(staleObs).toBeDefined()
    })

    it('reports fresh status and validUntil when heartbeats are fresh and workers ready', async () => {
      const asOf = new Date('2026-09-23T10:00:00.000Z')
      const mockFleet = {
        asOf,
        data: {
          workerPool: {
            ready: 2,
            draining: 0,
            stopped: 0,
            lost: 0,
            heartbeatFresh: 2,
            heartbeatStale: 0,
          },
          slots: {
            running: 1,
            holding: 0,
            waitingForAuth: 0,
            leftoverAuthHolds: 0,
            expiredLeaseResidue: 0,
            runCapacityUsed: 1,
          },
        } as any,
        liveHeartbeatStale: 0,
      }

      vi.spyOn(dbModule, 'summarizeFleet').mockResolvedValue(mockFleet)
      vi.spyOn(dbModule, 'summarizeQueues').mockResolvedValue({
        asOf,
        data: { metrics: { 'queue.claimableRuns': { value: 0 } } } as any,
      })

      const mockCtx: any = {
        db: {} as any,
        actor: { id: 'act-1', email: 'test@example.com' },
        slots: {},
        question: 'Worker 节点健康度怎么样？',
        body: { question: 'Worker 节点健康度怎么样？' },
        session: null,
        onProgress: vi.fn(),
      }

      const result = await handleOperationsDiagnose(mockCtx)
      expect(result.kind).toBe('diagnosis')
      const freshObs = result.facts.find((f) => f.text.includes('基础服务与 Worker 进程运行正常'))
      expect(freshObs).toBeDefined()
      expect(freshObs?.text).toContain('READY 节点数: 2')
    })
  })
})
