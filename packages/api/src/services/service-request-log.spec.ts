import { describe, expect, it } from 'vitest'
import {
  serviceRequestOutcomeFor,
  serviceRequestSummaryFromRequest,
} from './service-request-log'

describe('service request log safety boundary', () => {
  it('uses a stable fallback instead of persisting an arbitrary exception code', () => {
    expect(serviceRequestOutcomeFor('INTERNAL_SECRET_REFERENCE', 500)).toEqual({
      errorCode: 'HTTP_500',
      errorMessage: '服务端未能完成请求',
      diagnostic: { category: 'internal' },
    })
    expect(serviceRequestOutcomeFor('IP_FORBIDDEN', 403)).toEqual({
      errorCode: 'IP_FORBIDDEN',
      errorMessage: '请求来源 IP 不在调用方白名单中',
      diagnostic: { category: 'network' },
    })
  })

  it('copies only allowlisted request fields and input keys', () => {
    const summary = serviceRequestSummaryFromRequest({
      method: 'POST',
      originalUrl: '/api/open/v1/runs?ignored=true',
      url: '/api/open/v1/runs?ignored=true',
      body: {
        scenarioId: '01a0ba32-c002-71a3-906c-53116d7fba4c',
        scenarioVersionId: '01a0ba32-c002-71a3-906c-53116d7fba4d',
        targetAccountId: null,
        idempotencyKey: 'safe-request-id',
        input: { orderId: 'never-record-this-value', password: 'also-never' },
        authorization: 'Bearer never-record-this-token',
      },
    } as never)
    expect(summary).toEqual({
      scenarioId: '01a0ba32-c002-71a3-906c-53116d7fba4c',
      scenarioVersionId: '01a0ba32-c002-71a3-906c-53116d7fba4d',
      targetAccountId: null,
      idempotencyKey: 'safe-request-id',
      inputKeys: ['orderId', 'password'],
    })
    expect(JSON.stringify(summary)).not.toContain('never-record-this')
  })
})
