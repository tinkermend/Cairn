import { describe, expect, it } from 'vitest'
import {
  assembleRunOutput,
  projectRunOutput,
  projectRunOutputSummary,
  runOutputSchema,
  scenarioDocumentSchema,
  scenarioOutputDeclSchema,
  MAX_RUN_OUTPUT_BYTES,
  type Step,
} from '../index.js'

describe('Scenario Output Declaration Schema (AC01)', () => {
  it('验证合法的 outputs 声明', () => {
    const decl = {
      summaryTemplate: '巡检完成，在售商品 ${total_count} 件',
      metrics: [
        {
          key: 'total_count',
          name: '在售商品数',
          fromContextKey: 'goods_info',
          fromField: 'total',
          unit: '件',
        },
      ],
      dataRowFields: [
        {
          columnKey: 'store_name',
          columnHeader: '店铺名称',
          fromContextKey: 'store_name',
        },
      ],
    }
    const parsed = scenarioOutputDeclSchema.parse(decl)
    expect(parsed.summaryTemplate).toBe('巡检完成，在售商品 ${total_count} 件')
    expect(parsed.metrics).toHaveLength(1)
    expect(parsed.dataRowFields).toHaveLength(1)
  })

  it('拒绝非法 metric key 格式（须小写字母开头，只含小写字母数字下划线）', () => {
    expect(() =>
      scenarioOutputDeclSchema.parse({
        metrics: [
          {
            key: 'Total-Count', // 包含大写与连字符
            name: '在售商品数',
            fromContextKey: 'goods_info',
          },
        ],
      }),
    ).toThrow()
  })

  it('场景文档检验 metrics key 重复', () => {
    const doc = {
      schemaVersion: 1,
      inputs: [],
      steps: [
        {
          id: 's-1',
          name: '步骤1',
          type: 'echo',
          effectType: 'READ_ONLY',
          input: { message: 'hello' },
        },
      ],
      outputs: {
        metrics: [
          { key: 'count', name: '总数1', fromContextKey: 'c1' },
          { key: 'count', name: '总数2', fromContextKey: 'c2' },
        ],
      },
    }
    expect(() => scenarioDocumentSchema.parse(doc)).toThrow('同一场景内 metrics.key 不能重复')
  })

  it('场景文档检验 dataRowFields columnKey 重复', () => {
    const doc = {
      schemaVersion: 1,
      inputs: [],
      steps: [
        {
          id: 's-1',
          name: '步骤1',
          type: 'echo',
          effectType: 'READ_ONLY',
          input: { message: 'hello' },
        },
      ],
      outputs: {
        dataRowFields: [
          { columnKey: 'col1', columnHeader: '头1', fromContextKey: 'c1' },
          { columnKey: 'col1', columnHeader: '头2', fromContextKey: 'c2' },
        ],
      },
    }
    expect(() => scenarioDocumentSchema.parse(doc)).toThrow('同一场景内 dataRowFields.columnKey 不能重复')
  })
})

describe('RunOutput Assembly & Fallback (AC02, AC03, AC04, AC05)', () => {
  const outputsDeclForIncompleteRun = {
    summaryTemplate: '密钥已创建，状态正常',
    metrics: [{ key: 'item_count', name: '项目数', fromContextKey: 'report', fromField: 'total' }],
    dataRowFields: [{ columnKey: 'report_id', columnHeader: 'ID', fromContextKey: 'report', fromField: 'id' }],
  }
  const sampleSteps: Step[] = [
    {
      id: 'step-1',
      name: '提取商品数据',
      type: 'extract',
      effectType: 'READ_ONLY',
      outputKey: 'item_count',
      input: {
        target: { kind: 'css', selector: '.count' },
        extract: { kind: 'text' },
      },
    },
    {
      id: 'step-2',
      name: '检查库存状态',
      type: 'assert',
      effectType: 'READ_ONLY',
      input: {
        target: { kind: 'css', selector: '.status' },
        expect: { kind: 'text_equals', value: 'OK' },
      },
    },
  ]

  it('AC02: 正常运行输出装配（显式声明：模板替换、指标与数据宽表）', () => {
    const output = assembleRunOutput({
      definition: {
        steps: sampleSteps,
        outputs: {
          summaryTemplate: '巡检完成，在售商品 ${item_count} 件，耗时 ${latency}ms',
          metrics: [
            { key: 'item_count', name: '在售商品数', fromContextKey: 'item_count', unit: '件' },
            { key: 'latency', name: '接口耗时', fromContextKey: 'latency', unit: 'ms' },
          ],
          dataRowFields: [
            { columnKey: 'item_count', columnHeader: '商品数', fromContextKey: 'item_count' },
            { columnKey: 'category', columnHeader: '分类', fromContextKey: 'details', fromField: 'cat' },
          ],
        },
      },
      context: {
        item_count: 1420,
        latency: 142,
        details: { cat: '服饰箱包' },
      },
      outcomeResults: [],
      stepRuns: [
        { id: 'sr-1', stepId: 'step-1', ordinal: 0, status: 'SUCCEEDED' },
        { id: 'sr-2', stepId: 'step-2', ordinal: 1, status: 'SUCCEEDED' },
      ],
      status: 'SUCCEEDED',
      outcomeStatus: 'PASS',
      now: '2026-09-22T14:00:00.000Z',
    })

    expect(output.summary).toBe('巡检完成，在售商品 1420 件，耗时 142ms')
    expect(output.status).toBe('NORMAL')
    expect(output.metrics).toEqual({
      item_count: 1420,
      latency: 142,
    })
    expect(output.dataRow).toEqual({
      item_count: 1420,
      category: '服饰箱包',
    })
    expect(output.findings).toHaveLength(0)
    expect(output.assembledAt).toBe('2026-09-22T14:00:00.000Z')
    expect(runOutputSchema.parse(output)).toEqual(output)
  })

  it('AC03: 存量无配置场景智能保底（自动根据 OutcomeStatus 派生结论，自动收集 extract 变量）', () => {
    const output = assembleRunOutput({
      definition: {
        steps: sampleSteps, // 无 outputs
      },
      context: {
        item_count: 99,
        unrelated: 'foo',
      },
      outcomeResults: [],
      stepRuns: [
        { id: 'sr-1', stepId: 'step-1', ordinal: 0, status: 'SUCCEEDED' },
      ],
      status: 'SUCCEEDED',
      outcomeStatus: 'PASS',
    })

    expect(output.summary).toBe('流程执行完成，所有检查项均符合预期。')
    expect(output.status).toBe('NORMAL')
    // 自动收集了 step-1 extract 的标量结果
    expect(output.metrics).toEqual({
      item_count: 99,
    })
    expect(output.findings).toHaveLength(0)
  })

  it('AC03: 存量无配置场景各状态保底结论', () => {
    const warnOut = assembleRunOutput({
      status: 'SUCCEEDED',
      outcomeStatus: 'WARN',
    })
    expect(warnOut.summary).toBe('流程执行完成，存在需要注意的业务警告。')
    expect(warnOut.status).toBe('WARNING')

    const failOut = assembleRunOutput({
      status: 'SUCCEEDED',
      outcomeStatus: 'FAIL',
    })
    expect(failOut.summary).toBe('流程执行完成，但业务检查未通过。')
    expect(failOut.status).toBe('ANOMALOUS')

    const unknownOut = assembleRunOutput({
      status: 'SUCCEEDED',
      outcomeStatus: 'UNKNOWN',
    })
    expect(unknownOut.summary).toBe('流程执行完成，但业务结果无法确认。')
    expect(unknownOut.status).toBe('UNDETERMINED')

    const notEvaluatedOut = assembleRunOutput({
      status: 'SUCCEEDED',
      outcomeStatus: 'NOT_EVALUATED',
    })
    expect(notEvaluatedOut.status).toBe('UNDETERMINED')

    const cancelledOut = assembleRunOutput({
      status: 'CANCELLED',
    })
    expect(cancelledOut.summary).toBe('任务已被人工或系统取消。')
    expect(cancelledOut.status).toBe('UNDETERMINED')

    const errorOut = assembleRunOutput({
      status: 'FAILED',
      error: { safeMessage: '网络连接超时' },
    })
    expect(errorOut.summary).toBe('执行过程中断：网络连接超时')
    expect(errorOut.status).toBe('UNDETERMINED')
    expect(errorOut.findings).toHaveLength(1)
    expect(errorOut.findings[0]!.title).toBe('步骤执行异常中断')
  })

  it.each([
    ['FAILED', '执行过程中断：调试会话等待超时'],
    ['CANCELLED', '任务已被人工或系统取消。'],
    ['NEEDS_REVIEW', '运行待人工核查，业务结果尚未确认。'],
  ])('%s 时不使用宣称完成的业务结论模板，仍保留已产生的指标与数据', (status, summary) => {
    const output = assembleRunOutput({
      status,
      outcomeStatus: 'NOT_EVALUATED',
      error: { safeMessage: '调试会话等待超时' },
      outputsDecl: outputsDeclForIncompleteRun,
      context: { report: { total: 1, id: 7, title: '部分数据' } },
    })

    expect(output.summary).toBe(summary)
    expect(output.status).toBe('UNDETERMINED')
    expect(output.metrics).toEqual({ item_count: 1 })
    expect(output.dataRow).toEqual({ report_id: 7 })
  })

  it('失败时也不使用从上下文读取的成功结论', () => {
    const output = assembleRunOutput({
      status: 'FAILED',
      outcomeStatus: 'NOT_EVALUATED',
      outputsDecl: { summaryFromContextKey: 'result', metrics: [], dataRowFields: [] },
      context: { result: '密钥已创建' },
    })
    expect(output.summary).toBe('执行过程中断。')
    expect(output.status).toBe('UNDETERMINED')
  })

  it.each([
    ['FAIL', '流程执行完成，但业务检查未通过。'],
    ['UNKNOWN', '流程执行完成，但业务结果无法确认。'],
  ])('执行成功但业务结果为 %s 时，声明模板与历史摘要都不宣称业务成功', (outcomeStatus, summary) => {
    const output = assembleRunOutput({
      status: 'SUCCEEDED',
      outcomeStatus,
      outputsDecl: outputsDeclForIncompleteRun,
      context: { report: { total: 1, id: 7, title: '部分数据' } },
    })
    expect(output.summary).toBe(summary)
    expect(output.metrics).toEqual({ item_count: 1 })
    expect(output.dataRow).toEqual({ report_id: 7 })

    const projected = projectRunOutputSummary({ ...output, summary: '密钥已创建，状态正常' }, 'SUCCEEDED', outcomeStatus)
    expect(projected.summary).toBe(summary)
    expect(projected.status).toBe(outcomeStatus === 'FAIL' ? 'ANOMALOUS' : 'UNDETERMINED')
    expect(projected.metrics).toEqual(output.metrics)
    expect(projected.dataRow).toEqual(output.dataRow)
  })

  it('历史输出的 NORMAL 不掩盖未判定，已确认的业务失败仍显示异常', () => {
    const old = assembleRunOutput({ status: 'SUCCEEDED', outcomeStatus: 'PASS' })
    expect(projectRunOutput(old, 'FAILED', 'NOT_EVALUATED')).toMatchObject({
      status: 'UNDETERMINED',
      summary: '执行过程中断。',
    })
    expect(projectRunOutput(old, 'SUCCEEDED', 'UNKNOWN')).toMatchObject({
      status: 'UNDETERMINED',
      summary: '流程执行完成，但业务结果无法确认。',
    })
    expect(projectRunOutput(old, 'SUCCEEDED', 'NOT_EVALUATED')).toMatchObject({
      status: 'UNDETERMINED',
      summary: '流程执行完成，但业务结果未评价。',
    })
    expect(projectRunOutput(old, 'SUCCEEDED', 'FAIL')).toMatchObject({
      status: 'ANOMALOUS',
      summary: '流程执行完成，但业务检查未通过。',
    })
    expect(projectRunOutput(old, 'SUCCEEDED', 'PASS')).toEqual(old)
  })

  it('AC04: 异常与断言违规转化为 Findings（绑定 severity、evidenceId、stepOrdinal，高亮 ANOMALOUS）', () => {
    const output = assembleRunOutput({
      definition: {
        steps: sampleSteps,
      },
      context: { item_count: 0 },
      outcomeResults: [
        {
          id: 'out-1',
          contractId: 'contract-stock',
          meaning: '库存数量必须大于 0',
          severity: 'MUST',
          verdict: 'FAIL',
          evidenceId: 'a0000000-0000-4000-8000-000000000001',
          stepId: 'step-2',
          details: { current: 0, expected: '>0' },
        },
        {
          id: 'out-2',
          contractId: 'contract-notice',
          meaning: '建议关注优惠券配额',
          severity: 'INFO',
          verdict: 'WARN',
          stepId: 'step-1',
        },
      ],
      stepRuns: [
        { id: 'sr-1', stepId: 'step-1', ordinal: 0, status: 'SUCCEEDED' },
        { id: 'sr-2', stepId: 'step-2', ordinal: 1, status: 'FAILED' },
      ],
      status: 'FAILED',
      outcomeStatus: 'FAIL',
    })

    expect(output.status).toBe('ANOMALOUS')
    expect(output.findings).toHaveLength(2)

    const [f1, f2] = output.findings
    expect(f1).toMatchObject({
      id: 'contract-stock',
      severity: 'HIGH',
      title: '库存数量必须大于 0',
      evidenceId: 'a0000000-0000-4000-8000-000000000001',
      stepOrdinal: 1,
    })
    expect(f1?.detail).toContain('"current":0')

    expect(f2).toMatchObject({
      id: 'contract-notice',
      severity: 'WARN',
      title: '建议关注优惠券配额',
      stepOrdinal: 0,
    })
  })

  it('AC05: 体积超限截断保护（>64 KiB 安全截断至上限内，添加截断标记）', () => {
    // 构造 50 个大详情的 findings，总大小超过 64 KiB (65536 bytes)
    const output = assembleRunOutput({
      definition: {
        steps: sampleSteps,
        outputs: {
          summaryTemplate: '巡检报告：发现问题',
        },
      },
      context: {},
      outcomeResults: Array.from({ length: 50 }, (_, i) => ({
        id: `out-${i}`,
        contractId: `contract-${i}`,
        meaning: `违规检查项 ${i}`,
        verdict: 'FAIL',
        details: { data: 'y'.repeat(1600) },
      })),
      status: 'FAILED',
      outcomeStatus: 'FAIL',
    })

    const serialized = JSON.stringify(output)
    expect(new TextEncoder().encode(serialized).length).toBeLessThanOrEqual(MAX_RUN_OUTPUT_BYTES)
    expect(output.summary).toContain('(已截断)')
    expect(runOutputSchema.parse(output)).toBeDefined()
  })
})
