import {
  type AuthoringDiff,
  type AuthoringNode,
  type AuthoringOperation,
  type AuthoringStepNode,
  type EffectType,
  type OutcomeContract,
  type ScenarioAuthoringDocumentV2,
  type Step,
  AUTHORING_ALLOWED_STEP_TYPES,
  AUTHORING_STEP_FIELD_POLICIES,
  isAuthoringAllowedStepType,
  insertNodeAfter,
  insertNodeAt,
  locateNode,
  normalizeAuthoringDocument,
  removeNode,
  replaceNode,
  scenarioAuthoringDocumentV2Schema,
  stepSchema,
  walkAuthoringNodes,
} from '@cairn/shared'
import { deterministicStepId } from './expand.js'

export interface ApplyAuthoringOperationsOptions {
  maxOperations?: number
  maxInserts?: number
  allowPolicyUpdate?: boolean
}

export type ApplyAuthoringOperationsResult =
  | {
      ok: true
      document: ScenarioAuthoringDocumentV2
      diffs: AuthoringDiff[]
    }
  | {
      ok: false
      error: {
        code: string
        message: string
        operationId?: string
      }
    }

function isOutputKeyReferencedInDoc(
  doc: ScenarioAuthoringDocumentV2,
  outputKey: string,
  exceptStepId: string,
): boolean {
  if (!outputKey) return false
  if (doc.outputs) {
    for (const val of Object.values(doc.outputs)) {
      if (val && typeof val === 'object' && 'from' in val && (val as { from: unknown }).from === outputKey) {
        return true
      }
    }
  }
  for (const item of walkAuthoringNodes(doc)) {
    if (item.id === exceptStepId) continue
    if (item.node.kind === 'step') {
      const input = (item.node.step.input ?? {}) as Record<string, unknown>
      if (input.from === outputKey) return true
    } else if (item.node.kind === 'module') {
      for (const binding of Object.values(item.node.inputBindings ?? {})) {
        if (binding.kind === 'from' && binding.key === outputKey) return true
      }
    }
  }
  return false
}

function deriveDefaultEffectType(type: string): EffectType {
  switch (type) {
    case 'click':
    case 'fill':
    case 'keyboard':
    case 'ai_action':
      return 'SIDE_EFFECT'
    default:
      return 'READ_ONLY'
  }
}

function isFieldSensitive(fieldPath: string[], value: unknown, stepInput?: Record<string, unknown>): boolean {
  if (stepInput?.sensitive === true) return true
  const pathStr = fieldPath.join('.').toLowerCase()
  return /password|secret|token|credential|key|pwd|auth/i.test(pathStr)
}

/**
 * 将整组受限编排操作原子地应用于内存中的完整结构化草稿 (V2)。
 * 逐项核对节点身份、同分支锚点和允许字段；任一操作失败则原文档完全不变。
 */
export function applyAuthoringOperations(
  baseDocument: ScenarioAuthoringDocumentV2,
  operations: readonly AuthoringOperation[],
  options: ApplyAuthoringOperationsOptions = {},
): ApplyAuthoringOperationsResult {
  const maxOperations = options.maxOperations ?? 4
  const maxInserts = options.maxInserts ?? 2
  const allowPolicyUpdate = options.allowPolicyUpdate ?? false

  if (!operations || operations.length === 0) {
    return { ok: false, error: { code: 'EMPTY_OPERATIONS', message: '操作列表不能为空' } }
  }
  if (operations.length > maxOperations) {
    return {
      ok: false,
      error: { code: 'OPERATION_LIMIT_EXCEEDED', message: `每轮最多支持 ${maxOperations} 项操作` },
    }
  }
  const insertCount = operations.filter((op) => op.kind === 'insert_step').length
  if (insertCount > maxInserts) {
    return {
      ok: false,
      error: { code: 'INSERT_LIMIT_EXCEEDED', message: `每轮最多支持 ${maxInserts} 项新增步骤` },
    }
  }
  const opIds = new Set<string>()
  for (const op of operations) {
    if (opIds.has(op.id)) {
      return {
        ok: false,
        error: { code: 'DUPLICATE_OPERATION_ID', message: `操作 ID「${op.id}」重复`, operationId: op.id },
      }
    }
    opIds.add(op.id)
  }

  let workingDoc: ScenarioAuthoringDocumentV2
  try {
    workingDoc = structuredClone(normalizeAuthoringDocument(baseDocument))
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'INVALID_BASE_DOCUMENT',
        message: err instanceof Error ? err.message : '基线文档无法解析为合法的结构化草稿',
      },
    }
  }

  const existingStepIds = new Set(walkAuthoringNodes(workingDoc).map((n) => n.id))
  const diffs: AuthoringDiff[] = []

  for (const op of operations) {
    switch (op.kind) {
      case 'insert_step': {
        const step = op.step
        if (!isAuthoringAllowedStepType(step.type)) {
          return {
            ok: false,
            error: {
              code: 'STEP_TYPE_UNSUPPORTED',
              message: `不支持新增「${step.type}」类型步骤`,
              operationId: op.id,
            },
          }
        }
        if (existingStepIds.has(step.id)) {
          return {
            ok: false,
            error: {
              code: 'DUPLICATE_STEP_ID',
              message: `步骤 ID「${step.id}」已存在`,
              operationId: op.id,
            },
          }
        }

        // 校验不允许字段
        if (step.disabled !== undefined) {
          return {
            ok: false,
            error: { code: 'FORBIDDEN_FIELD', message: '模型不得直接设置步骤 disabled 属性', operationId: op.id },
          }
        }
        if (step.optional !== undefined) {
          return {
            ok: false,
            error: { code: 'FORBIDDEN_FIELD', message: '模型不得直接设置步骤 optional 属性', operationId: op.id },
          }
        }
        if (!allowPolicyUpdate && (step as any).policy !== undefined) {
          return {
            ok: false,
            error: { code: 'FORBIDDEN_FIELD', message: '模型不得直接设置步骤 policy 属性', operationId: op.id },
          }
        }

        const policy = AUTHORING_STEP_FIELD_POLICIES[step.type]
        const stepInput = (step.input ?? {}) as Record<string, unknown>
        for (const key of Object.keys(stepInput)) {
          if (!policy.allowedInputKeys.includes(key)) {
            return {
              ok: false,
              error: {
                code: 'FORBIDDEN_FIELD',
                message: `步骤类型「${step.type}」不允许包含「input.${key}」字段`,
                operationId: op.id,
              },
            }
          }
        }

        if (step.outputKey && !policy.allowsOutputKey) {
          return {
            ok: false,
            error: {
              code: 'FORBIDDEN_OUTPUT_KEY',
              message: `步骤类型「${step.type}」不允许设置 outputKey`,
              operationId: op.id,
            },
          }
        }

        // fill 步骤防口令字面值泄露
        if (step.type === 'fill') {
          if (stepInput.sensitive && stepInput.value !== undefined) {
            return {
              ok: false,
              error: {
                code: 'SENSITIVE_LITERAL_FORBIDDEN',
                message: '敏感字段必须引用已声明输入或前序输出绑定，不得直接保存字面口令',
                operationId: op.id,
              },
            }
          }
        }

        // 校验挂载容器与分支
        if (op.parentBlockId) {
          const blockItem = walkAuthoringNodes(workingDoc).find((item) => item.id === op.parentBlockId)
          if (!blockItem || blockItem.node.kind !== 'block') {
            return {
              ok: false,
              error: {
                code: 'BLOCK_NOT_FOUND',
                message: `找不到流程控制块「${op.parentBlockId}」`,
                operationId: op.id,
              },
            }
          }
          if ('then' in blockItem.node) {
            if (op.branchKey !== 'then' && op.branchKey !== 'else') {
              return {
                ok: false,
                error: {
                  code: 'INVALID_BRANCH_KEY',
                  message: `条件块仅支持 then 或 else 分支`,
                  operationId: op.id,
                },
              }
            }
          } else if (op.branchKey !== 'body') {
            return {
              ok: false,
              error: {
                code: 'INVALID_BRANCH_KEY',
                message: `循环块仅支持 body 分支`,
                operationId: op.id,
              },
            }
          }
        }

        if (op.anchorStepId) {
          const anchorLoc = locateNode(workingDoc, op.anchorStepId)
          if (!anchorLoc) {
            return {
              ok: false,
              error: {
                code: 'ANCHOR_NOT_FOUND',
                message: `找不到锚点步骤「${op.anchorStepId}」`,
                operationId: op.id,
              },
            }
          }
          if (anchorLoc.parentId !== op.parentBlockId || anchorLoc.branchKey !== op.branchKey) {
            return {
              ok: false,
              error: {
                code: 'ANCHOR_BRANCH_MISMATCH',
                message: '锚点步骤不在目标分支中',
                operationId: op.id,
              },
            }
          }
        }

        const effectType = ((step as { effectType?: EffectType }).effectType ?? deriveDefaultEffectType((step as { type: string }).type)) as EffectType
        const finalStep = {
          ...step,
          effectType,
        } as Step
        const parsedFinalStep = stepSchema.safeParse(finalStep)
        if (!parsedFinalStep.success) {
          return {
            ok: false,
            error: {
              code: 'SCHEMA_VALIDATION_FAILED',
              message: `stepSchema error: ${parsedFinalStep.error.issues.map((i: any) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
            },
          }
        }
        const newNode: AuthoringStepNode = {
          kind: 'step',
          step: finalStep,
        }

        if (op.anchorStepId) {
          workingDoc = insertNodeAfter(workingDoc, op.anchorStepId, newNode)
        } else {
          workingDoc = insertNodeAt(
            workingDoc,
            { parentId: op.parentBlockId, branchKey: op.branchKey, index: 0 },
            newNode,
          )
        }

        const insertedLoc = locateNode(workingDoc, finalStep.id)
        existingStepIds.add(finalStep.id)

        diffs.push({
          type: 'add',
          stepId: finalStep.id,
          stepName: finalStep.name,
          stepType: finalStep.type,
          parentBlockId: op.parentBlockId,
          branchKey: op.branchKey,
          index: insertedLoc?.index ?? 0,
          riskLevel: effectType,
        })
        break
      }

      case 'update_step': {
        const item = walkAuthoringNodes(workingDoc).find((entry) => entry.id === op.stepId)
        if (!item || item.node.kind !== 'step') {
          return {
            ok: false,
            error: {
              code: 'STEP_NOT_FOUND',
              message: `未在草稿中找到待修改步骤「${op.stepId}」`,
              operationId: op.id,
            },
          }
        }

        const currentStep = item.node.step
        if (!isAuthoringAllowedStepType(currentStep.type)) {
          return {
            ok: false,
            error: {
              code: 'STEP_TYPE_UNSUPPORTED',
              message: `不支持修改「${currentStep.type}」类型步骤`,
              operationId: op.id,
            },
          }
        }

        const patch = op.patch
        const policy = AUTHORING_STEP_FIELD_POLICIES[currentStep.type]
        if (patch.outputKey && !policy.allowsOutputKey) {
          return {
            ok: false,
            error: {
              code: 'FORBIDDEN_OUTPUT_KEY',
              message: `步骤类型「${currentStep.type}」不允许设置 outputKey`,
              operationId: op.id,
            },
          }
        }

        if (patch.input) {
          for (const key of Object.keys(patch.input)) {
            if (!policy.allowedInputKeys.includes(key)) {
              return {
                ok: false,
                error: {
                  code: 'FORBIDDEN_FIELD',
                  message: `步骤类型「${currentStep.type}」不允许修改「input.${key}」字段`,
                  operationId: op.id,
                },
              }
            }
          }
          if (currentStep.type === 'fill') {
            const isSensitive = currentStep.input?.sensitive || patch.input.sensitive
            if (isSensitive && patch.input.value !== undefined) {
              return {
                ok: false,
                error: {
                  code: 'SENSITIVE_LITERAL_FORBIDDEN',
                  message: '敏感字段必须引用已声明输入或前序输出绑定，不得直接保存字面口令',
                  operationId: op.id,
                },
              }
            }
          }
        }

        // 检查改动及 no-op
        const currentInput = (currentStep.input ?? {}) as Record<string, unknown>
        const nextInput = patch.input ? { ...currentInput, ...patch.input } : currentInput
        const nextName = patch.name !== undefined ? patch.name : currentStep.name
        const nextOutputKey = patch.outputKey !== undefined ? patch.outputKey : currentStep.outputKey

        let hasChange = false
        const stepDiffs: AuthoringDiff[] = []

        if (nextName !== currentStep.name) {
          hasChange = true
          stepDiffs.push({
            type: 'modify',
            stepId: currentStep.id,
            stepName: nextName,
            stepType: currentStep.type,
            fieldPath: ['name'],
            from: currentStep.name,
            to: nextName,
          })
        }

        if (nextOutputKey !== currentStep.outputKey) {
          hasChange = true
          stepDiffs.push({
            type: 'modify',
            stepId: currentStep.id,
            stepName: nextName,
            stepType: currentStep.type,
            fieldPath: ['outputKey'],
            from: currentStep.outputKey,
            to: nextOutputKey,
          })
        }

        if (patch.input) {
          for (const [key, val] of Object.entries(patch.input)) {
            const oldVal = currentInput[key]
            if (JSON.stringify(oldVal) !== JSON.stringify(val)) {
              hasChange = true
              const sensitive = isFieldSensitive(['input', key], val, currentInput)
              stepDiffs.push({
                type: 'modify',
                stepId: currentStep.id,
                stepName: nextName,
                stepType: currentStep.type,
                fieldPath: ['input', key],
                from: sensitive ? '******' : oldVal,
                to: sensitive ? '******' : val,
                sensitive,
              })
            }
          }
        }

        if (!hasChange) {
          return {
            ok: false,
            error: {
              code: 'NO_OP_OPERATION',
              message: `步骤「${currentStep.name}」修改未产生任何实际变化`,
              operationId: op.id,
            },
          }
        }

        // 保留原节点的所有非声明字段：origin, outcomes, optional, policy, disabled, effectType
        const updatedStep: Step = {
          ...currentStep,
          name: nextName,
          input: nextInput as any,
          ...(nextOutputKey ? { outputKey: nextOutputKey } : {}),
        }
        const updatedNode: AuthoringStepNode = {
          ...item.node,
          step: updatedStep,
        }

        workingDoc = replaceNode(workingDoc, currentStep.id, updatedNode)
        diffs.push(...stepDiffs)
        break
      }

      case 'remove_step': {
        const item = walkAuthoringNodes(workingDoc).find((entry) => entry.id === op.stepId)
        if (!item || item.node.kind !== 'step') {
          return {
            ok: false,
            error: {
              code: 'STEP_NOT_FOUND',
              message: `未在草稿中找到待删除步骤「${op.stepId}」`,
              operationId: op.id,
            },
          }
        }

        const step = item.node.step
        if (!isAuthoringAllowedStepType(step.type)) {
          return {
            ok: false,
            error: {
              code: 'STEP_TYPE_UNSUPPORTED',
              message: `不支持删除「${step.type}」类型步骤`,
              operationId: op.id,
            },
          }
        }

        // 检查是否有后续引用 (N06)
        if (step.outputKey && isOutputKeyReferencedInDoc(workingDoc, step.outputKey, step.id)) {
          return {
            ok: false,
            error: {
              code: 'REFERENCED_STEP_CANNOT_BE_REMOVED',
              message: `步骤产出的「${step.outputKey}」已被后续步骤或场景输出引用，不能直接删除`,
              operationId: op.id,
            },
          }
        }

        workingDoc = removeNode(workingDoc, op.stepId)
        existingStepIds.delete(op.stepId)

        diffs.push({
          type: 'remove',
          stepId: step.id,
          stepName: step.name,
          stepType: step.type,
          parentBlockId: item.parentId,
          branchKey: item.branchKey,
          index: item.index,
          riskLevel: step.effectType,
        })
        break
      }

      case 'move_step': {
        const item = walkAuthoringNodes(workingDoc).find((entry) => entry.id === op.stepId)
        if (!item || item.node.kind !== 'step') {
          return {
            ok: false,
            error: {
              code: 'STEP_NOT_FOUND',
              message: `未在草稿中找到待移动步骤「${op.stepId}」`,
              operationId: op.id,
            },
          }
        }

        const step = item.node.step
        if (!isAuthoringAllowedStepType(step.type)) {
          return {
            ok: false,
            error: {
              code: 'STEP_TYPE_UNSUPPORTED',
              message: `不支持移动「${step.type}」类型步骤`,
              operationId: op.id,
            },
          }
        }

        // 跨分支移动检查 (N07)
        if (op.parentBlockId !== item.parentId || op.branchKey !== item.branchKey) {
          return {
            ok: false,
            error: {
              code: 'CROSS_BRANCH_MOVE_UNSUPPORTED',
              message: '跨分支、跨循环移动会改变条件执行和变量可见性，本轮暂不支持跨分支移动',
              operationId: op.id,
            },
          }
        }

        if (op.anchorStepId === op.stepId) {
          return {
            ok: false,
            error: {
              code: 'INVALID_ANCHOR',
              message: '移动锚点不能是步骤自身',
              operationId: op.id,
            },
          }
        }

        if (op.anchorStepId) {
          const anchorLoc = locateNode(workingDoc, op.anchorStepId)
          if (!anchorLoc) {
            return {
              ok: false,
              error: {
                code: 'ANCHOR_NOT_FOUND',
                message: `找不到移动锚点步骤「${op.anchorStepId}」`,
                operationId: op.id,
              },
            }
          }
          if (anchorLoc.parentId !== item.parentId || anchorLoc.branchKey !== item.branchKey) {
            return {
              ok: false,
              error: {
                code: 'ANCHOR_BRANCH_MISMATCH',
                message: '移动锚点不在同层级分支内',
                operationId: op.id,
              },
            }
          }
        }

        // 先移除，再插入到目标锚点之后（或分支开头）
        const oldIndex = item.index
        workingDoc = removeNode(workingDoc, op.stepId)
        if (op.anchorStepId) {
          workingDoc = insertNodeAfter(workingDoc, op.anchorStepId, item.node)
        } else {
          workingDoc = insertNodeAt(
            workingDoc,
            { parentId: op.parentBlockId, branchKey: op.branchKey, index: 0 },
            item.node,
          )
        }

        const newLoc = locateNode(workingDoc, op.stepId)
        const newIndex = newLoc?.index ?? 0

        if (newIndex === oldIndex) {
          return {
            ok: false,
            error: {
              code: 'NO_OP_OPERATION',
              message: `步骤「${step.name}」位置未发生变化`,
              operationId: op.id,
            },
          }
        }

        diffs.push({
          type: 'move',
          stepId: step.id,
          stepName: step.name,
          stepType: step.type,
          parentBlockId: item.parentId,
          branchKey: item.branchKey,
          fromIndex: oldIndex,
          toIndex: newIndex,
          detail: `从序号 ${oldIndex + 1} 调整至序号 ${newIndex + 1}`,
        })
        break
      }
      case 'set_step_policy': {
        const item = walkAuthoringNodes(workingDoc).find((entry) => entry.id === op.stepId)
        if (!item || item.node.kind !== 'step') {
          return {
            ok: false,
            error: { code: 'STEP_NOT_FOUND', message: `未找到步骤「${op.stepId}」`, operationId: op.id },
          }
        }
        const stepNode = item.node as AuthoringStepNode
        const step = stepNode.step
        const effect = (step as { effectType?: EffectType }).effectType ?? deriveDefaultEffectType(step.type)
        if (effect === 'SIDE_EFFECT' && op.retryLimit !== undefined && op.retryLimit > 0) {
          return {
            ok: false,
            error: {
              code: 'SIDE_EFFECT_RETRY_FORBIDDEN',
              message: `有副作用步骤「${step.name}」禁止由泛化设置重试`,
              operationId: op.id,
            },
          }
        }
        const prevPolicy = step.policy ? { ...step.policy } : undefined
        const nextPolicy = {
          ...(step.policy ?? {}),
          ...(op.timeoutMs !== undefined ? { timeoutMs: op.timeoutMs } : {}),
          ...(op.retryLimit !== undefined ? { retryLimit: op.retryLimit } : {}),
        }
        step.policy = nextPolicy
        diffs.push({
          type: 'modify',
          stepId: step.id,
          stepName: step.name,
          stepType: step.type,
          fieldPath: ['policy'],
          from: prevPolicy,
          to: nextPolicy,
        })
        break
      }
      case 'add_outcome': {
        const item = walkAuthoringNodes(workingDoc).find((entry) => entry.id === op.stepId)
        if (!item || item.node.kind !== 'step') {
          return {
            ok: false,
            error: { code: 'STEP_NOT_FOUND', message: `未找到步骤「${op.stepId}」`, operationId: op.id },
          }
        }
        if (op.severity !== 'MUST' && op.onViolation === 'halt') {
          return {
            ok: false,
            error: {
              code: 'INVALID_OUTCOME_VIOLATION',
              message: 'SHOULD 或 INFO 级别的成功条件不得中断（halt）执行',
              operationId: op.id,
            },
          }
        }
        const stepNode = item.node as AuthoringStepNode
        const step = stepNode.step
        const outcomeId = deterministicStepId(step.id, op.id, 'outcome')
        const outcomeContract: OutcomeContract = {
          id: outcomeId,
          scope: 'step',
          meaning: op.meaning,
          rule: op.rule,
          severity: op.severity,
          onViolation: op.onViolation,
          provenance: 'generalized',
        }
        stepNode.outcomes = [...(stepNode.outcomes ?? []), outcomeContract]
        diffs.push({
          type: 'outcome_add',
          stepId: step.id,
          stepName: step.name,
          contractId: outcomeId,
          meaning: op.meaning,
          ruleKind: op.rule.kind,
          severity: op.severity,
          onViolation: op.onViolation,
          detail: op.meaning,
        })
        break
      }
    }
  }

  // 终态 Schema 验证
  const parsed = scenarioAuthoringDocumentV2Schema.safeParse(workingDoc)
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: 'SCHEMA_VALIDATION_FAILED',
        message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      },
    }
  }

  return {
    ok: true,
    document: parsed.data,
    diffs,
  }
}
