import {
  type ScenarioAuthoringDocument,
  type ScenarioAuthoringNode,
  type ScenarioDocument,
  type ScenarioInputDecl,
  type Step,
  isAuthoringDocumentV2,
  isSensitiveFillInput,
} from '@cairn/shared'

export interface SlicedAuthoringResult {
  nodes: ScenarioAuthoringNode[]
  inputs: ScenarioInputDecl[]
  redactedFieldCount: number
  targetNodeId: string
  totalOriginalNodes: number
}

const SENSITIVE_FILL_HINT = /(password|pwd|secret|token|credential|api_key|auth|pin|cvv)/i

/**
 * Projects a concise dependency slice around a target node (step or module invocation)
 * for an AuthoringDocument V2 or ScenarioDocument.
 * Filters out irrelevant downstream steps and unrelated parallel steps, preserving
 * only upstream causal dependencies to avoid leaking context or exceeding context windows.
 */
export function buildV2AuthoringSlice(
  document: ScenarioAuthoringDocument | ScenarioDocument,
  targetNodeId: string,
): SlicedAuthoringResult {
  // Normalize to authoring nodes
  let allNodes: ScenarioAuthoringNode[] = []
  let inputs: ScenarioInputDecl[] = []

  if (isAuthoringDocumentV2(document)) {
    allNodes = [...document.nodes]
    inputs = [...(document.inputs ?? [])]
  } else if ('steps' in document && Array.isArray(document.steps)) {
    allNodes = document.steps.map((step: Step) => ({
      kind: 'step',
      step,
    }))
    inputs = [...(document.inputs ?? [])]
  } else {
    throw new Error('INVALID_DOCUMENT_FORMAT: 无法识别的场景文档格式')
  }

  // Find target node index
  const targetIndex = allNodes.findIndex((node) => {
    if (node.kind === 'step') return node.step.id === targetNodeId
    if (node.kind === 'module') return node.invocationId === targetNodeId
    return false
  })

  if (targetIndex === -1) {
    throw new Error(`TARGET_NODE_NOT_FOUND: 指定节点不存在于文档中: ${targetNodeId}`)
  }

  const targetNode = allNodes[targetIndex]!

  // Map of contextKeys produced by each node
  const producedContextKeys = new Map<string, string>() // contextKey -> nodeId
  for (const node of allNodes) {
    if (node.kind === 'step') {
      const step = node.step
      // Variable produced by step
      const stepInput = (step.input ?? {}) as Record<string, unknown>
      if (typeof stepInput.variable === 'string' && stepInput.variable) {
        producedContextKeys.set(stepInput.variable, step.id)
      }
      if (typeof stepInput.as === 'string' && stepInput.as) {
        producedContextKeys.set(stepInput.as, step.id)
      }
      if (step.name) {
        producedContextKeys.set(step.name, step.id)
      }
    } else if (node.kind === 'module') {
      for (const sceneKey of Object.values(node.outputBindings ?? {})) {
        if (typeof sceneKey === 'string' && sceneKey) {
          producedContextKeys.set(sceneKey, node.invocationId)
        }
      }
    }
  }

  // Upstream dependency tracking
  const upstreamNodeIds = new Set<string>()
  const queue: string[] = []

  function scanNodeDependencies(node: ScenarioAuthoringNode) {
    const rawStr = JSON.stringify(node)
    // 1. Scan for explicit "from" references
    const fromMatches = rawStr.matchAll(/"from"\s*:\s*"([a-zA-Z0-9_-]+)"/g)
    for (const match of fromMatches) {
      const ref = match[1]!
      const producerId = producedContextKeys.get(ref)
      if (producerId && producerId !== getNodeId(node) && !upstreamNodeIds.has(producerId)) {
        upstreamNodeIds.add(producerId)
        queue.push(producerId)
      }
    }

    // 2. Scan for ${key} interpolation in strings
    const interpMatches = rawStr.matchAll(/\$\{([a-zA-Z0-9_.-]+)\}/g)
    for (const match of interpMatches) {
      const ref = match[1]!.split('.')[0]!
      const producerId = producedContextKeys.get(ref)
      if (producerId && producerId !== getNodeId(node) && !upstreamNodeIds.has(producerId)) {
        upstreamNodeIds.add(producerId)
        queue.push(producerId)
      }
    }

    // 3. Scan module inputBindings
    if (node.kind === 'module' && node.inputBindings) {
      for (const rawBinding of Object.values(node.inputBindings)) {
        const binding = rawBinding as { kind?: string; key?: string } | undefined
        if (binding && binding.kind === 'from' && binding.key) {
          const producerId = producedContextKeys.get(binding.key)
          if (producerId && producerId !== node.invocationId && !upstreamNodeIds.has(producerId)) {
            upstreamNodeIds.add(producerId)
            queue.push(producerId)
          }
        }
      }
    }
  }

  scanNodeDependencies(targetNode)

  while (queue.length > 0) {
    const nextId = queue.shift()!
    const nextNode = allNodes.find((n) => getNodeId(n) === nextId)
    if (nextNode) {
      scanNodeDependencies(nextNode)
    }
  }

  // Filter nodes in original order
  const slicedNodes = allNodes.filter((node) => {
    const id = getNodeId(node)
    return id === targetNodeId || upstreamNodeIds.has(id)
  })

  // Redact sensitive values
  let redactedFieldCount = 0
  const redactedNodes: ScenarioAuthoringNode[] = slicedNodes.map((node) => {
    if (node.kind === 'step') {
      const step = node.step
      if (step.type === 'fill') {
        const fillInput = (step.input ?? {}) as Record<string, unknown>
        const isSensitive =
          isSensitiveFillInput(step.input) ||
          Boolean(fillInput.sensitive) ||
          SENSITIVE_FILL_HINT.test(JSON.stringify(fillInput.target ?? ''))

        if (isSensitive) {
          redactedFieldCount++
          return {
            ...node,
            step: {
              ...step,
              input: {
                ...fillInput,
                value: '[REDACTED]',
              } as any,
            },
          }
        }
      }
    }
    return node
  })

  return {
    nodes: redactedNodes,
    inputs,
    redactedFieldCount,
    targetNodeId,
    totalOriginalNodes: allNodes.length,
  }
}

function getNodeId(node: ScenarioAuthoringNode): string {
  return node.kind === 'step' ? node.step.id : node.invocationId
}
