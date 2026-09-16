import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  compileScenarioDocument,
  isAuthoringDocumentV2,
  toAuthoringDocumentV2,
  type ScenarioAuthoringDocumentV2,
  type ScenarioAuthoringNode,
  type ScenarioDocument,
  type ScenarioInputDecl,
  type Step,
} from '@cairn/shared'
import {
  focusStudioField,
  insertNode as insertDocNode,
  nodeId,
  sameDocument,
  firstAuthoringNodeId,
  tryReplaceInputs,
  tryReplaceNode,
  tryReplaceStep,
} from './studio-document'

type AuthoringDoc = ScenarioDocument | ScenarioAuthoringDocumentV2

type Baseline = { revision: number; document: AuthoringDoc }

type UndoSnapshot = { document: AuthoringDoc; selectedId: string | null }

export function useStudioDraft(
  scenarioId: string | undefined,
  server: Baseline | undefined,
  compileTarget?: { exists: boolean; status: 'active' | 'disabled' },
  executableTypes?: readonly string[],
) {
  const [baseline, setBaseline] = useState<Baseline | null>(null)
  const [candidate, setCandidate] = useState<AuthoringDoc | null>(null)
  const [stepOverlays, setStepOverlays] = useState<Record<string, Step>>({})
  const [inputOverlay, setInputOverlay] = useState<ScenarioInputDecl[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [undo, setUndo] = useState<UndoSnapshot | null>(null)
  const [conflict, setConflict] = useState(false)
  const [remoteStale, setRemoteStale] = useState(false)
  const dirtyRef = useRef(false)

  const dirty = Boolean(
    candidate &&
      baseline &&
      (Object.keys(stepOverlays).length > 0 ||
        inputOverlay !== null ||
        !sameDocument(candidate, baseline.document)),
  )
  dirtyRef.current = dirty
  const hasFieldDrafts = Object.keys(stepOverlays).length > 0 || inputOverlay !== null

  useEffect(() => {
    if (!scenarioId) return
    setBaseline(null)
    setCandidate(null)
    setStepOverlays({})
    setInputOverlay(null)
    setSelectedId(null)
    setUndo(null)
    setConflict(false)
    setRemoteStale(false)
  }, [scenarioId])

  useEffect(() => {
    if (!server) return
    if (!baseline || !candidate) {
      setBaseline(server)
      setCandidate(server.document)
      setSelectedId((current) => current ?? firstAuthoringNodeId(server.document))
      return
    }
    if (server.revision === baseline.revision) return
    if (dirtyRef.current) {
      setRemoteStale(true)
      return
    }
    setBaseline(server)
    setCandidate(server.document)
    setRemoteStale(false)
    setConflict(false)
  }, [server, baseline, candidate])

  const displayInputs = inputOverlay ?? candidate?.inputs ?? []

  const v2Document = useMemo<ScenarioAuthoringDocumentV2 | null>(() => {
    if (!candidate) return null
    return toAuthoringDocumentV2(candidate)
  }, [candidate])

  const nodes = v2Document?.nodes ?? []

  const selectedNode = useMemo(() => {
    if (!nodes || !selectedId) return null
    return nodes.find((n) => nodeId(n) === selectedId) ?? null
  }, [nodes, selectedId])

  const selected = useMemo(() => {
    if (!candidate || !selectedId) return null
    if (selectedNode?.kind === 'step') {
      return stepOverlays[selectedId] ?? selectedNode.step
    }
    if ('steps' in candidate) {
      return stepOverlays[selectedId] ?? candidate.steps.find((step) => step.id === selectedId) ?? null
    }
    return null
  }, [candidate, selectedId, selectedNode, stepOverlays])

  const selectedIndex = selectedNode && v2Document ? v2Document.nodes.findIndex((n) => nodeId(n) === selectedId) : -1

  const compile = useMemo(() => {
    if (!candidate || hasFieldDrafts) return null
    if (isAuthoringDocumentV2(candidate)) {
      if (candidate.nodes.some((node) => node.kind === 'module')) return null
      const stepNodes = candidate.nodes.filter((n) => n.kind === 'step').map((n) => n.step)
      if (stepNodes.length === 0) {
        return { ok: true, compilerVersion: 3, diagnostics: [] }
      }
      return compileScenarioDocument(
        {
          schemaVersion: 1 as const,
          inputs: candidate.inputs,
          steps: stepNodes,
        },
        {
          mode: 'release',
          target: compileTarget,
          executableTypes,
        },
      )
    }
    return compileScenarioDocument(candidate, {
      mode: 'release',
      target: compileTarget,
      executableTypes,
    })
  }, [candidate, compileTarget, executableTypes, hasFieldDrafts])

  const applyStructure = useCallback(
    (next: AuthoringDoc, nextSelected: string | null) => {
      if (!candidate) return
      setUndo({ document: candidate, selectedId })
      setCandidate(next)
      setSelectedId(nextSelected)
    },
    [candidate, selectedId],
  )

  const updateStep = useCallback(
    (next: Step) => {
      if (!candidate) return
      if (isAuthoringDocumentV2(candidate)) {
        const nextNode: ScenarioAuthoringNode = { kind: 'step', step: next }
        const committed = tryReplaceNode(candidate, nextNode)
        if (committed.ok) {
          setCandidate(committed.document)
          setStepOverlays((current) => {
            if (!(next.id in current)) return current
            const { [next.id]: _removed, ...rest } = current
            return rest
          })
          return
        }
        setStepOverlays((current) => ({ ...current, [next.id]: next }))
        return
      }
      const committed = tryReplaceStep(candidate, next)
      if (committed.ok) {
        setCandidate(committed.document)
        setStepOverlays((current) => {
          if (!(next.id in current)) return current
          const { [next.id]: _removed, ...rest } = current
          return rest
        })
        return
      }
      setStepOverlays((current) => ({ ...current, [next.id]: next }))
    },
    [candidate],
  )

  const updateNode = useCallback(
    (next: ScenarioAuthoringNode) => {
      if (!v2Document) return
      const committed = tryReplaceNode(v2Document, next)
      if (committed.ok) {
        setCandidate(committed.document)
      }
    },
    [v2Document],
  )

  const insertNode = useCallback(
    (next: ScenarioAuthoringNode, afterIndex: number) => {
      if (!v2Document) return
      setUndo({ document: v2Document, selectedId })
      const nextDoc = insertDocNode(v2Document, next, afterIndex)
      setCandidate(nextDoc)
      setSelectedId(nodeId(next))
    },
    [v2Document, selectedId],
  )

  const updateInputs = useCallback(
    (inputs: ScenarioInputDecl[]) => {
      if (!candidate) return
      const committed = tryReplaceInputs(candidate, inputs)
      if (committed.ok) {
        setCandidate(committed.document)
        setInputOverlay(null)
        return
      }
      setInputOverlay(inputs)
    },
    [candidate],
  )

  const undoStructure = useCallback(() => {
    if (!undo) return
    setCandidate(undo.document)
    setSelectedId(undo.selectedId)
    setUndo(null)
  }, [undo])

  const focusFirstDraft = useCallback(() => {
    const overlayId = Object.keys(stepOverlays)[0]
    if (overlayId) {
      const step = stepOverlays[overlayId]
      if (step?.type === 'navigate' && step.input.url.trim().length === 0) {
        focusStudioField({ stepId: overlayId, fieldPath: ['input', 'url'] })
        return
      }
      if (step && step.name.trim().length === 0) {
        focusStudioField({ stepId: overlayId, fieldPath: ['name'] })
        return
      }
      focusStudioField({ stepId: overlayId })
      return
    }
    const firstInput = inputOverlay?.[0]
    if (firstInput) document.getElementById(`studio-input-${firstInput.key}`)?.focus()
  }, [inputOverlay, stepOverlays])

  const acceptServer = useCallback(
    (next: Baseline) => {
      setBaseline(next)
      setCandidate(next.document)
      setStepOverlays({})
      setInputOverlay(null)
      setUndo(null)
      setConflict(false)
      setRemoteStale(false)
      setSelectedId((current) => {
        const nodes = isAuthoringDocumentV2(next.document)
          ? next.document.nodes
          : next.document.steps.map((step) => ({ kind: 'step' as const, step }))
        const ids = new Set(nodes.map((node) => nodeId(node)))
        return current && ids.has(current) ? current : firstAuthoringNodeId(next.document)
      })
    },
    [],
  )

  return {
    baseline,
    candidate,
    v2Document,
    nodes,
    selectedNode,
    displayInputs,
    selected,
    selectedIndex,
    selectedId,
    setSelectedId,
    dirty,
    hasFieldDrafts,
    undo,
    conflict,
    setConflict,
    remoteStale,
    compile,
    applyStructure,
    updateStep,
    updateNode,
    insertNode,
    updateInputs,
    undoStructure,
    acceptServer,
    focusFirstDraft,
  }
}
