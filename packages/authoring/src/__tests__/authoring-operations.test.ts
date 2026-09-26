import { describe, expect, it } from 'vitest'
import {
  type AuthoringOperation,
  type ScenarioAuthoringDocumentV2,
  normalizeAuthoringDocument,
  authoringDocumentDigest,
} from '@cairn/shared'
import { applyAuthoringOperations } from '../authoring-operations.js'

describe('applyAuthoringOperations (原子应用与纯函数受限编辑)', () => {
  const baseDoc: ScenarioAuthoringDocumentV2 = normalizeAuthoringDocument({
    authoringSchemaVersion: 2,
    inputs: [{ key: 'orderId', label: '订单号', type: 'string', required: true }],
    nodes: [
      {
        kind: 'step',
        step: {
          id: '01912345-0000-7000-8000-000000000011',
          name: '打开订单列表',
          type: 'navigate',
          effectType: 'READ_ONLY',
          input: { url: 'https://example.com/orders' },
        },
      },
      {
        kind: 'step',
        step: {
          id: '01912345-0000-7000-8000-000000000012',
          name: '提取客户编号',
          type: 'extract',
          effectType: 'READ_ONLY',
          outputKey: 'customerId',
          input: { as: 'text', target: { framePath: [], candidates: [{ by: 'css', value: '.cust-id' }] } },
        },
        origin: {
          kind: 'module_unwrap',
          moduleVersionId: '01912345-0000-7000-8000-000000000001',
          invocationId: '01912345-0000-7000-8000-000000000002',
        },
        outcomes: [
          {
            id: '01912345-0000-7000-8000-000000000003',
            scope: 'step',
            meaning: '必须提取到有效客户编号',
            severity: 'MUST',
            onViolation: 'halt',
            provenance: 'manual',
            rule: {
              kind: 'deterministic',
              target: { framePath: [], candidates: [{ by: 'css', value: '.cust-id' }] },
              expect: { kind: 'visible' },
            },
          },
        ],
      },
      {
        kind: 'step',
        step: {
          id: '01912345-0000-7000-8000-000000000013',
          name: '填写客户编号',
          type: 'fill',
          effectType: 'SIDE_EFFECT',
          input: {
            target: { framePath: [], candidates: [{ by: 'css', value: '#input-cust' }] },
            from: 'customerId',
          },
        },
      },
      {
        kind: 'step',
        step: {
          id: '01912345-0000-7000-8000-000000000014',
          name: '断言结果',
          type: 'assert',
          effectType: 'READ_ONLY',
          input: {
            target: { framePath: [], candidates: [{ by: 'css', value: '#msg' }] },
            expect: { kind: 'text_contains', value: '已处理' },
          },
        },
      },
    ],
  })

  it('P02/P03: 允许正常更新已有步骤的受限字段，并保全 origin 与 outcomes', async () => {
    const ops: AuthoringOperation[] = [
      {
        kind: 'update_step',
        id: 'op_1',
        stepId: '01912345-0000-7000-8000-000000000012',
        patch: {
          name: '提取最新客户编号',
        },
      },
      {
        kind: 'update_step',
        id: 'op_2',
        stepId: '01912345-0000-7000-8000-000000000014',
        patch: {
          input: {
            target: { framePath: [], candidates: [{ by: 'css', value: '#msg' }] },
            expect: { kind: 'text_contains', value: '查询成功' },
          },
        },
      },
    ]

    const result = applyAuthoringOperations(baseDoc, ops)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const extNode = result.document.nodes[1] as any
    expect(extNode.step.name).toBe('提取最新客户编号')
    expect(extNode.origin).toEqual(baseDoc.nodes[1]?.origin)
    expect(extNode.outcomes).toEqual(baseDoc.nodes[1]?.outcomes)

    const assertNode = result.document.nodes[3] as any
    expect(assertNode.step.input.expect.value).toBe('查询成功')

    expect(result.diffs).toHaveLength(2)
    expect(result.diffs[0]).toMatchObject({
      type: 'modify',
      stepId: '01912345-0000-7000-8000-000000000012',
      fieldPath: ['name'],
      from: '提取客户编号',
      to: '提取最新客户编号',
    })
    expect(result.diffs[1]).toMatchObject({
      type: 'modify',
      stepId: '01912345-0000-7000-8000-000000000014',
      fieldPath: ['input', 'expect'],
    })
  })

  it('P04/P05: 允许在指定锚点新增步骤，并正确计算添加 diff', () => {
    const ops: AuthoringOperation[] = [
      {
        kind: 'insert_step',
        id: 'op_ins_1',
        step: {
          id: '01912345-0000-7000-8000-000000000015',
          name: '等待查询结果可见',
          type: 'wait',
          effectType: 'READ_ONLY',
          input: {
            kind: 'visible',
            target: { framePath: [], candidates: [{ by: 'css', value: '#table' }] },
          },
        },
        anchorStepId: '01912345-0000-7000-8000-000000000013',
      },
    ]

    const result = applyAuthoringOperations(baseDoc, ops)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.document.nodes).toHaveLength(5)
    expect(result.document.nodes[3]?.kind === 'step' && result.document.nodes[3].step.id).toBe(
      '01912345-0000-7000-8000-000000000015',
    )
    expect(result.diffs).toHaveLength(1)
    expect(result.diffs[0]).toMatchObject({
      type: 'add',
      stepId: '01912345-0000-7000-8000-000000000015',
      index: 3,
      riskLevel: 'READ_ONLY',
    })
  })

  it('P07: 同分支纯重排只产生 move diff，位置未变报 NO_OP', () => {
    const ops: AuthoringOperation[] = [
      {
        kind: 'move_step',
        id: 'op_move_1',
        stepId: '01912345-0000-7000-8000-000000000014',
        anchorStepId: '01912345-0000-7000-8000-000000000011', // 移到 step_nav_01 之后（index 1）
      },
    ]

    const result = applyAuthoringOperations(baseDoc, ops)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.document.nodes[1]?.kind === 'step' && result.document.nodes[1].step.id).toBe(
      '01912345-0000-7000-8000-000000000014',
    )
    expect(result.diffs).toEqual([
      {
        type: 'move',
        stepId: '01912345-0000-7000-8000-000000000014',
        stepName: '断言结果',
        stepType: 'assert',
        parentBlockId: undefined,
        branchKey: undefined,
        fromIndex: 3,
        toIndex: 1,
        detail: '从序号 4 调整至序号 2',
      },
    ])

    // 位置未变报 NO_OP
    const noopResult = applyAuthoringOperations(baseDoc, [
      {
        kind: 'move_step',
        id: 'op_noop',
        stepId: '01912345-0000-7000-8000-000000000014',
        anchorStepId: '01912345-0000-7000-8000-000000000013', // 它本来就在 step_fill_01 之后
      },
    ])
    expect(noopResult.ok).toBe(false)
    if (!noopResult.ok) {
      expect(noopResult.error.code).toBe('NO_OP_OPERATION')
    }
  })

  it('N06: 拒绝删除产出被后续步骤引用的步骤', () => {
    const ops: AuthoringOperation[] = [
      {
        kind: 'remove_step',
        id: 'op_del_1',
        stepId: '01912345-0000-7000-8000-000000000012', // customerId 被 step_fill_01 引用
      },
    ]

    const result = applyAuthoringOperations(baseDoc, ops)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('REFERENCED_STEP_CANNOT_BE_REMOVED')
      expect(result.error.message).toContain('customerId')
    }
  })

  it('N07: 拒绝跨分支移动步骤', () => {
    const blockDoc: ScenarioAuthoringDocumentV2 = {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [],
      nodes: [
        {
          kind: 'block',
          blockId: '01912345-0000-7000-8000-000000000010',
          control: { type: 'if', condition: { kind: 'literal', value: true } },
          then: [
            {
              kind: 'step',
              step: {
                id: '01912345-0000-7000-8000-000000000021',
                name: 'Then 内填写',
                type: 'fill',
                effectType: 'SIDE_EFFECT',
                input: { target: { framePath: [], candidates: [{ by: 'css', value: '#input' }] }, from: 'orderId' },
              },
            },
          ],
          else: [
            {
              kind: 'step',
              step: {
                id: '01912345-0000-7000-8000-000000000022',
                name: 'Else 内操作',
                type: 'click',
                effectType: 'SIDE_EFFECT',
                input: { target: { framePath: [], candidates: [{ by: 'css', value: '#btn' }] } },
              },
            },
          ],
        },
      ],
    }

    const moveCrossResult = applyAuthoringOperations(blockDoc, [
      {
        kind: 'move_step',
        id: 'op_cross',
        stepId: '01912345-0000-7000-8000-000000000021',
        parentBlockId: '01912345-0000-7000-8000-000000000010',
        branchKey: 'else', // 试图移入 else
      },
    ])

    expect(moveCrossResult.ok).toBe(false)
    if (!moveCrossResult.ok) {
      expect(moveCrossResult.error.code).toBe('CROSS_BRANCH_MOVE_UNSUPPORTED')
    }
  })

  it('N08: 敏感 fill 步骤禁止传入字面口令', () => {
    const result = applyAuthoringOperations(baseDoc, [
      {
        kind: 'insert_step',
        id: 'op_pwd',
        step: {
          id: '01912345-0000-7000-8000-000000000016',
          name: '输入密码',
          type: 'fill',
          effectType: 'SIDE_EFFECT',
          input: {
            target: { framePath: [], candidates: [{ by: 'css', value: '#pwd' }] },
            value: 'plaintext_password_123',
            sensitive: true,
          },
        },
      },
    ])

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('SENSITIVE_LITERAL_FORBIDDEN')
    }
  })

  it('硬性约束：单次最多 4 项操作，最多 2 项新增', () => {
    const fiveOps: AuthoringOperation[] = [
      { kind: 'update_step', id: '1', stepId: '01912345-0000-7000-8000-000000000011', patch: { name: '1' } },
      { kind: 'update_step', id: '2', stepId: '01912345-0000-7000-8000-000000000011', patch: { name: '2' } },
      { kind: 'update_step', id: '3', stepId: '01912345-0000-7000-8000-000000000011', patch: { name: '3' } },
      { kind: 'update_step', id: '4', stepId: '01912345-0000-7000-8000-000000000011', patch: { name: '4' } },
      { kind: 'update_step', id: '5', stepId: '01912345-0000-7000-8000-000000000011', patch: { name: '5' } },
    ]
    const r1 = applyAuthoringOperations(baseDoc, fiveOps)
    expect(r1.ok).toBe(false)
    if (!r1.ok) expect(r1.error.code).toBe('OPERATION_LIMIT_EXCEEDED')

    const threeInserts: AuthoringOperation[] = [
      {
        kind: 'insert_step',
        id: '1',
        step: {
          id: '01912345-0000-7000-8000-000000000091',
          name: '1',
          type: 'navigate',
          input: { url: 'https://a.test' },
        },
      },
      {
        kind: 'insert_step',
        id: '2',
        step: {
          id: '01912345-0000-7000-8000-000000000092',
          name: '2',
          type: 'navigate',
          input: { url: 'https://b.test' },
        },
      },
      {
        kind: 'insert_step',
        id: '3',
        step: {
          id: '01912345-0000-7000-8000-000000000093',
          name: '3',
          type: 'navigate',
          input: { url: 'https://c.test' },
        },
      },
    ]
    const r2 = applyAuthoringOperations(baseDoc, threeInserts)
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.error.code).toBe('INSERT_LIMIT_EXCEEDED')
  })

  it('原子性保证：任一操作失败则整组回滚，原草稿完全不变', async () => {
    const originalDigest = await authoringDocumentDigest(baseDoc)

    const mixedOps: AuthoringOperation[] = [
      {
        kind: 'update_step',
        id: 'op_valid_1',
        stepId: '01912345-0000-7000-8000-000000000011',
        patch: { name: '正常修改名称' },
      },
      {
        kind: 'update_step',
        id: 'op_invalid_2',
        stepId: '01912345-0000-7000-8000-000000000099',
        patch: { name: '无效节点' },
      },
    ]

    const result = applyAuthoringOperations(baseDoc, mixedOps)
    expect(result.ok).toBe(false)

    const postDigest = await authoringDocumentDigest(baseDoc)
    expect(postDigest).toBe(originalDigest)
    expect(baseDoc.nodes[0]?.kind === 'step' && baseDoc.nodes[0].step.name).toBe('打开订单列表')
  })
})
