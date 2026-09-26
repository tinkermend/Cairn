import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SERVICE_DELIVERY_POLICY,
  LEGACY_SERVICE_DELIVERY_POLICY,
  projectExternalRunOutput,
  serviceDeliveryPolicySchema,
} from '../service-delivery.js'
import type { RunOutput, ScenarioOutputDecl } from '../run-output.js'

describe('serviceDeliveryPolicySchema', () => {
  it('validates delivery policy shapes', () => {
    expect(
      serviceDeliveryPolicySchema.parse({
        runOutput: true,
        finalScreenshot: false,
        failureScreenshot: true,
      }),
    ).toEqual({
      runOutput: true,
      finalScreenshot: false,
      failureScreenshot: true,
    })
    expect(() =>
      serviceDeliveryPolicySchema.parse({
        runOutput: true,
      }),
    ).toThrow()
  })

  it('exposes default and legacy policies', () => {
    expect(DEFAULT_SERVICE_DELIVERY_POLICY).toEqual({
      runOutput: true,
      finalScreenshot: false,
      failureScreenshot: false,
    })
    expect(LEGACY_SERVICE_DELIVERY_POLICY).toEqual({
      runOutput: false,
      finalScreenshot: false,
      failureScreenshot: false,
    })
  })
})

describe('projectExternalRunOutput', () => {
  const sampleRunOutput: RunOutput = {
    status: 'NORMAL',
    summary: '已提取 10 件订单，错误率 0%',
    metrics: {
      order_count: 10,
      internal_debug_metric: 999,
    },
    dataRow: {
      order_no: 'ORD-001',
      secret_internal_tag: 'debug',
    },
    findings: [
      {
        id: 'f-1',
        severity: 'INFO',
        title: '库存正常',
        detail: '内部排查细节，不应泄露给外部',
        evidenceId: '00000000-0000-0000-0000-000000000001',
        stepOrdinal: 3,
      },
    ],
    assembledAt: '2026-09-26T12:00:00.000Z',
  }

  it('returns null if output is empty or scenario has no declared outputs', () => {
    expect(projectExternalRunOutput(null, null)).toBeNull()
    const emptyDecl: ScenarioOutputDecl = {
      metrics: [],
      dataRowFields: [],
    }
    expect(projectExternalRunOutput(sampleRunOutput, emptyDecl)).toBeNull()
  })

  it('projects only declared metrics, dataRow fields, and stripped findings', () => {
    const decl: ScenarioOutputDecl = {
      summaryTemplate: '汇总结果: ${order_count}',
      metrics: [
        {
          key: 'order_count',
          name: '订单量',
          fromContextKey: 'orderCount',
        },
      ],
      dataRowFields: [
        {
          columnKey: 'order_no',
          columnHeader: '订单编号',
          fromContextKey: 'orderNo',
        },
      ],
    }

    const projected = projectExternalRunOutput(sampleRunOutput, decl)
    expect(projected).toEqual({
      status: 'NORMAL',
      summary: '已提取 10 件订单，错误率 0%',
      metrics: {
        order_count: 10,
      },
      dataRow: {
        order_no: 'ORD-001',
      },
      findings: [
        {
          id: 'f-1',
          severity: 'INFO',
          title: '库存正常',
          stepOrdinal: 3,
        },
      ],
      assembledAt: '2026-09-26T12:00:00.000Z',
    })
    expect((projected?.findings[0] as any)?.detail).toBeUndefined()
    expect((projected?.findings[0] as any)?.evidenceId).toBeUndefined()
    expect(projected?.metrics.internal_debug_metric).toBeUndefined()
    expect(projected?.dataRow.secret_internal_tag).toBeUndefined()
  })

  it('suppresses summary if scenario did not declare summary template or key', () => {
    const decl: ScenarioOutputDecl = {
      metrics: [
        {
          key: 'order_count',
          name: '订单量',
          fromContextKey: 'orderCount',
        },
      ],
      dataRowFields: [],
    }

    const projected = projectExternalRunOutput(sampleRunOutput, decl)
    expect(projected?.summary).toBeNull()
  })
})
