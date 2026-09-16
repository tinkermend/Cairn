import {
  isAuthoringDocumentV2,
  type ScenarioDocument,
  type ScenarioAuthoringDocumentV2,
} from '@cairn/shared'
import type { FlowDocumentJSON } from '@flowgram.ai/fixed-layout-editor'
import { nodeId } from '../studio-document'

/** View projection only. The platform document remains the executable source. */
export function toFlowgram(document: ScenarioDocument | ScenarioAuthoringDocumentV2): FlowDocumentJSON {
  if (isAuthoringDocumentV2(document)) {
    return {
      nodes: document.nodes.map((node) => {
        const id = nodeId(node)
        if (node.kind === 'step') {
          return {
            id,
            type: 'cairn-step',
            data: { step: structuredClone(node.step), nodeKind: 'step' },
          }
        }
        return {
          id,
          type: 'cairn-step',
          data: {
            nodeKind: 'module',
            step: {
              id,
              name: `模块 · ${node.name || node.moduleId}`,
              type: 'module_invocation',
              effectType: 'SIDE_EFFECT',
              input: {},
            },
          },
        }
      }),
    }
  }

  return {
    nodes: document.steps.map((step) => ({
      id: step.id,
      type: 'cairn-step',
      data: { step: structuredClone(step) },
    })),
  }
}

/** Accept a permutation of known IDs, never another execution model or hidden node. */
export function applyFlowgramOrder<T extends ScenarioDocument | ScenarioAuthoringDocumentV2>(
  document: T,
  graph: FlowDocumentJSON,
): T {
  const nodes = graph.nodes
  if (isAuthoringDocumentV2(document)) {
    const byId = new Map(document.nodes.map((node) => [nodeId(node), node]))
    if (
      nodes.length !== document.nodes.length ||
      new Set(nodes.map((node) => node.id)).size !== nodes.length ||
      nodes.some(
        (node) =>
          !byId.has(node.id) ||
          node.data?.step?.name === undefined ||
          (node.data?.nodeKind === 'module'
            ? byId.get(node.id)?.kind !== 'module'
            : byId.get(node.id)?.kind !== 'step'),
      )
    ) {
      return document
    }
    return {
      ...document,
      nodes: nodes.map((node) => byId.get(node.id)!),
    }
  }

  const byId = new Map(document.steps.map((step) => [step.id, step]))
  if (
    nodes.length !== document.steps.length ||
    new Set(nodes.map((node) => node.id)).size !== nodes.length ||
    nodes.some(
      (node) =>
        !byId.has(node.id) ||
        node.type !== 'cairn-step' ||
        (node.blocks?.length ?? 0) > 0,
    )
  )
    throw new Error('画布结构与场景不一致，请重新加载画布。')
  // Use the latest Step values, including policies, outputs and provenance.
  return { ...document, steps: nodes.map((node) => byId.get(node.id)!) } as T
}
