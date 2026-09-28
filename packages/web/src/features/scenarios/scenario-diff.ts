import {
  isAuthoringDocumentV2,
  walkAuthoringNodes,
  type ScenarioDocument,
  type ScenarioAuthoringDocumentV2,
  type ScenarioModuleInvocationNode,
  type AuthoringBlockNode,
  type Step,
} from '@cairn/shared'

export interface PropertyChange {
  field: string
  label: string
  before: unknown
  after: unknown
}

export type NodeDiffItem =
  | { kind: 'step_added'; step: Step; index: number }
  | { kind: 'step_removed'; step: Step; originalIndex: number }
  | {
      kind: 'step_modified'
      stepId: string
      name: string
      changes: PropertyChange[]
    }
  | { kind: 'module_added'; node: ScenarioModuleInvocationNode; index: number }
  | { kind: 'module_removed'; node: ScenarioModuleInvocationNode; originalIndex: number }
  | {
      kind: 'module_modified'
      invocationId: string
      name: string
      changes: PropertyChange[]
    }
  | { kind: 'block_added'; node: AuthoringBlockNode; index: number }
  | { kind: 'block_removed'; node: AuthoringBlockNode; originalIndex: number }
  | {
      kind: 'block_modified'
      blockId: string
      name: string
      changes: PropertyChange[]
    }

export interface InputDiffItem {
  kind: 'added' | 'removed' | 'modified'
  key: string
  label: string
  before?: unknown
  after?: unknown
}

export interface ContractDiffItem {
  kind: 'added' | 'removed' | 'modified'
  id: string
  name: string
  before?: unknown
  after?: unknown
}

export interface ScenarioDiffResult {
  hasChanges: boolean
  isInitialPublish: boolean
  nodeChanges: NodeDiffItem[]
  inputChanges: InputDiffItem[]
  outcomeChanges: ContractDiffItem[]
  summary: {
    addedCount: number
    modifiedCount: number
    removedCount: number
  }
}

type NormalizedNode =
  | { kind: 'step'; id: string; name: string; step: Step }
  | { kind: 'module'; id: string; name: string; node: ScenarioModuleInvocationNode }
  | { kind: 'block'; id: string; name: string; node: AuthoringBlockNode }

function extractNodes(doc: ScenarioDocument | ScenarioAuthoringDocumentV2 | null | undefined): NormalizedNode[] {
  if (!doc) return []
  if (isAuthoringDocumentV2(doc)) {
    return walkAuthoringNodes(doc).map(({ node }) => {
      if (node.kind === 'module') {
        return {
          kind: 'module',
          id: node.invocationId,
          name: node.name || node.moduleId,
          node,
        }
      }
      if (node.kind === 'block') {
        return {
          kind: 'block',
          id: node.blockId,
          name: node.name || '条件分支',
          node,
        }
      }
      return {
        kind: 'step',
        id: node.step.id,
        name: node.step.name,
        step: node.step,
      }
    })
  }
  return (('steps' in doc && Array.isArray(doc.steps)) ? doc.steps : []).map((step) => ({
    kind: 'step',
    id: step.id,
    name: step.name,
    step,
  }))
}

function compareSteps(before: Step, after: Step): PropertyChange[] {
  const changes: PropertyChange[] = []

  if (before.name !== after.name) {
    changes.push({
      field: 'name',
      label: '步骤名称',
      before: before.name,
      after: after.name,
    })
  }

  if (before.type !== after.type) {
    changes.push({
      field: 'type',
      label: '步骤类型',
      before: before.type,
      after: after.type,
    })
  }

  if (Boolean(before.disabled) !== Boolean(after.disabled)) {
    changes.push({
      field: 'disabled',
      label: '启用状态',
      before: before.disabled ? '已停用' : '已启用',
      after: after.disabled ? '已停用' : '已启用',
    })
  }

  if (before.outputKey !== after.outputKey) {
    changes.push({
      field: 'outputKey',
      label: '输出变量名',
      before: before.outputKey ?? '(无)',
      after: after.outputKey ?? '(无)',
    })
  }

  // 深度比较 input 核心字段
  if (JSON.stringify(before.input) !== JSON.stringify(after.input)) {
    changes.push({
      field: 'input',
      label: '动作参数',
      before: before.input,
      after: after.input,
    })
  }

  // 比较 fieldRefs
  if (JSON.stringify(before.fieldRefs) !== JSON.stringify(after.fieldRefs)) {
    changes.push({
      field: 'fieldRefs',
      label: '字段变量绑定',
      before: before.fieldRefs ?? {},
      after: after.fieldRefs ?? {},
    })
  }

  // 比较 policy
  if (JSON.stringify(before.policy) !== JSON.stringify(after.policy)) {
    changes.push({
      field: 'policy',
      label: '重试与超时策略',
      before: before.policy ?? {},
      after: after.policy ?? {},
    })
  }

  return changes
}

function compareModules(
  before: ScenarioModuleInvocationNode,
  after: ScenarioModuleInvocationNode,
): PropertyChange[] {
  const changes: PropertyChange[] = []

  if ((before.name ?? '') !== (after.name ?? '')) {
    changes.push({
      field: 'name',
      label: '模块名称',
      before: before.name ?? '',
      after: after.name ?? '',
    })
  }

  if (Boolean(before.disabled) !== Boolean(after.disabled)) {
    changes.push({
      field: 'disabled',
      label: '启用状态',
      before: before.disabled ? '已停用' : '已启用',
      after: after.disabled ? '已停用' : '已启用',
    })
  }

  if (before.moduleVersionId !== after.moduleVersionId) {
    changes.push({
      field: 'moduleVersionId',
      label: '模块版本',
      before: before.moduleVersionId ?? '(草稿)',
      after: after.moduleVersionId ?? '(草稿)',
    })
  }

  if (before.implementationKey !== after.implementationKey) {
    changes.push({
      field: 'implementationKey',
      label: '实现键',
      before: before.implementationKey,
      after: after.implementationKey,
    })
  }

  if (JSON.stringify(before.inputBindings) !== JSON.stringify(after.inputBindings)) {
    changes.push({
      field: 'inputBindings',
      label: '输入参数映射',
      before: before.inputBindings,
      after: after.inputBindings,
    })
  }

  if (JSON.stringify(before.outputBindings) !== JSON.stringify(after.outputBindings)) {
    changes.push({
      field: 'outputBindings',
      label: '输出暴露映射',
      before: before.outputBindings,
      after: after.outputBindings,
    })
  }

  return changes
}

function compareBlocks(
  before: AuthoringBlockNode,
  after: AuthoringBlockNode,
): PropertyChange[] {
  const changes: PropertyChange[] = []

  if ((before.name ?? '') !== (after.name ?? '')) {
    changes.push({
      field: 'name',
      label: '分支名称',
      before: before.name ?? '',
      after: after.name ?? '',
    })
  }

  if (Boolean(before.disabled) !== Boolean(after.disabled)) {
    changes.push({
      field: 'disabled',
      label: '启用状态',
      before: before.disabled ? '已跳过' : '已启用',
      after: after.disabled ? '已跳过' : '已启用',
    })
  }

  if (JSON.stringify(before.control) !== JSON.stringify(after.control)) {
    changes.push({
      field: 'control',
      label: '控制条件',
      before: before.control,
      after: after.control,
    })
  }

  return changes
}

export function computeScenarioDiff(
  baselineDoc: ScenarioDocument | ScenarioAuthoringDocumentV2 | null | undefined,
  draftDoc: ScenarioDocument | ScenarioAuthoringDocumentV2 | null | undefined,
): ScenarioDiffResult {
  if (!draftDoc) {
    return {
      hasChanges: false,
      isInitialPublish: !baselineDoc,
      summary: { addedCount: 0, modifiedCount: 0, removedCount: 0 },
      nodeChanges: [],
      inputChanges: [],
      outcomeChanges: [],
    }
  }

  const draftNodes = extractNodes(draftDoc)

  // 1. 无基准历史版本，属于全新发布
  if (!baselineDoc) {
    const nodeChanges: NodeDiffItem[] = draftNodes.map((n, index) => {
      if (n.kind === 'step') return { kind: 'step_added', step: n.step, index }
      if (n.kind === 'module') return { kind: 'module_added', node: n.node, index }
      return { kind: 'block_added', node: n.node, index }
    })
    const inputChanges: InputDiffItem[] = (draftDoc.inputs ?? []).map((input) => ({
      kind: 'added',
      key: input.key,
      label: input.label,
      after: input,
    }))
    const outcomeChanges: ContractDiffItem[] = isAuthoringDocumentV2(draftDoc)
      ? (draftDoc.scenarioOutcomes ?? []).map((o) => ({
          kind: 'added',
          id: o.id,
          name: o.meaning,
          after: o,
        }))
      : []

    return {
      hasChanges: nodeChanges.length > 0 || inputChanges.length > 0 || outcomeChanges.length > 0,
      isInitialPublish: true,
      nodeChanges,
      inputChanges,
      outcomeChanges,
      summary: {
        addedCount: nodeChanges.length + inputChanges.length + outcomeChanges.length,
        modifiedCount: 0,
        removedCount: 0,
      },
    }
  }

  const baselineNodes = extractNodes(baselineDoc)
  const baselineNodeMap = new Map<string, NormalizedNode>()
  baselineNodes.forEach((n) => baselineNodeMap.set(n.id, n))

  const draftNodeMap = new Map<string, NormalizedNode>()
  draftNodes.forEach((n) => draftNodeMap.set(n.id, n))

  const nodeChanges: NodeDiffItem[] = []

  // 检查新增与修改
  for (let index = 0; index < draftNodes.length; index++) {
    const draftNode = draftNodes[index]!
    const baselineNode = baselineNodeMap.get(draftNode.id)

    if (!baselineNode) {
      if (draftNode.kind === 'step') {
        nodeChanges.push({ kind: 'step_added', step: draftNode.step, index })
      } else if (draftNode.kind === 'module') {
        nodeChanges.push({ kind: 'module_added', node: draftNode.node, index })
      } else {
        nodeChanges.push({ kind: 'block_added', node: draftNode.node, index })
      }
    } else if (draftNode.kind === 'step' && baselineNode.kind === 'step') {
      const changes = compareSteps(baselineNode.step, draftNode.step)
      if (changes.length > 0) {
        nodeChanges.push({
          kind: 'step_modified',
          stepId: draftNode.id,
          name: draftNode.name,
          changes,
        })
      }
    } else if (draftNode.kind === 'module' && baselineNode.kind === 'module') {
      const changes = compareModules(baselineNode.node, draftNode.node)
      if (changes.length > 0) {
        nodeChanges.push({
          kind: 'module_modified',
          invocationId: draftNode.id,
          name: draftNode.name,
          changes,
        })
      }
    } else if (draftNode.kind === 'block' && baselineNode.kind === 'block') {
      const changes = compareBlocks(baselineNode.node, draftNode.node)
      if (changes.length > 0) {
        nodeChanges.push({
          kind: 'block_modified',
          blockId: draftNode.id,
          name: draftNode.name,
          changes,
        })
      }
    }
  }

  // 检查删除
  for (let origIndex = 0; origIndex < baselineNodes.length; origIndex++) {
    const baselineNode = baselineNodes[origIndex]!
    if (!draftNodeMap.has(baselineNode.id)) {
      if (baselineNode.kind === 'step') {
        nodeChanges.push({
          kind: 'step_removed',
          step: baselineNode.step,
          originalIndex: origIndex,
        })
      } else if (baselineNode.kind === 'module') {
        nodeChanges.push({
          kind: 'module_removed',
          node: baselineNode.node,
          originalIndex: origIndex,
        })
      } else {
        nodeChanges.push({
          kind: 'block_removed',
          node: baselineNode.node,
          originalIndex: origIndex,
        })
      }
    }
  }

  // 比较全局 inputs
  const inputChanges: InputDiffItem[] = []
  const baseInputs = new Map((baselineDoc.inputs ?? []).map((i) => [i.key, i]))
  const draftInputs = new Map((draftDoc.inputs ?? []).map((i) => [i.key, i]))

  for (const [key, dInput] of draftInputs.entries()) {
    const bInput = baseInputs.get(key)
    if (!bInput) {
      inputChanges.push({ kind: 'added', key, label: dInput.label, after: dInput })
    } else if (JSON.stringify(bInput) !== JSON.stringify(dInput)) {
      inputChanges.push({
        kind: 'modified',
        key,
        label: dInput.label,
        before: bInput,
        after: dInput,
      })
    }
  }
  for (const [key, bInput] of baseInputs.entries()) {
    if (!draftInputs.has(key)) {
      inputChanges.push({ kind: 'removed', key, label: bInput.label, before: bInput })
    }
  }

  // 比较 outcomes (V2)
  const outcomeChanges: ContractDiffItem[] = []
  const baseOutcomes = new Map(
    isAuthoringDocumentV2(baselineDoc)
      ? (baselineDoc.scenarioOutcomes ?? []).map((o) => [o.id, o])
      : [],
  )
  const draftOutcomes = new Map(
    isAuthoringDocumentV2(draftDoc) ? (draftDoc.scenarioOutcomes ?? []).map((o) => [o.id, o]) : [],
  )

  for (const [id, dOutcome] of draftOutcomes.entries()) {
    const bOutcome = baseOutcomes.get(id)
    if (!bOutcome) {
      outcomeChanges.push({ kind: 'added', id, name: dOutcome.meaning, after: dOutcome })
    } else if (JSON.stringify(bOutcome) !== JSON.stringify(dOutcome)) {
      outcomeChanges.push({
        kind: 'modified',
        id,
        name: dOutcome.meaning,
        before: bOutcome,
        after: dOutcome,
      })
    }
  }
  for (const [id, bOutcome] of baseOutcomes.entries()) {
    if (!draftOutcomes.has(id)) {
      outcomeChanges.push({ kind: 'removed', id, name: bOutcome.meaning, before: bOutcome })
    }
  }

  let addedCount = 0
  let modifiedCount = 0
  let removedCount = 0

  for (const item of nodeChanges) {
    if (item.kind === 'step_added' || item.kind === 'module_added' || item.kind === 'block_added') addedCount++
    else if (item.kind === 'step_modified' || item.kind === 'module_modified' || item.kind === 'block_modified') modifiedCount++
    else if (item.kind === 'step_removed' || item.kind === 'module_removed' || item.kind === 'block_removed') removedCount++
  }

  for (const item of inputChanges) {
    if (item.kind === 'added') addedCount++
    else if (item.kind === 'modified') modifiedCount++
    else if (item.kind === 'removed') removedCount++
  }

  for (const item of outcomeChanges) {
    if (item.kind === 'added') addedCount++
    else if (item.kind === 'modified') modifiedCount++
    else if (item.kind === 'removed') removedCount++
  }

  const hasChanges = addedCount > 0 || modifiedCount > 0 || removedCount > 0

  return {
    hasChanges,
    isInitialPublish: false,
    nodeChanges,
    inputChanges,
    outcomeChanges,
    summary: {
      addedCount,
      modifiedCount,
      removedCount,
    },
  }
}
