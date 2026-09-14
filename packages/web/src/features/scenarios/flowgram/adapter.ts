import type { ScenarioDocument } from '@cairn/shared'
import type { FlowDocumentJSON } from '@flowgram.ai/fixed-layout-editor'

/** View projection only. The platform document remains the executable source. */
export function toFlowgram(document: ScenarioDocument): FlowDocumentJSON {
  return {
    nodes: document.steps.map((step) => ({
      id: step.id,
      type: 'cairn-step',
      data: { step: structuredClone(step) },
    })),
  }
}

/** Accept a permutation of known IDs, never another execution model or hidden node. */
export function applyFlowgramOrder(
  document: ScenarioDocument,
  graph: FlowDocumentJSON
): ScenarioDocument {
  const nodes = graph.nodes
  const byId = new Map(document.steps.map((step) => [step.id, step]))
  if (
    nodes.length !== document.steps.length ||
    new Set(nodes.map((node) => node.id)).size !== nodes.length ||
    nodes.some(
      (node) =>
        !byId.has(node.id) ||
        node.type !== 'cairn-step' ||
        (node.blocks?.length ?? 0) > 0
    )
  )
    throw new Error('画布结构与场景不一致，请重新加载画布。')
  // Use the latest Step values, including policies, outputs and provenance.
  return { ...document, steps: nodes.map((node) => byId.get(node.id)!) }
}
