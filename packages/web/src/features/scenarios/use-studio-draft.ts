import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { compileScenarioDocument, type ScenarioDocument, type ScenarioInputDecl, type Step } from '@cairn/shared'
import {
  focusStudioField,
  sameDocument,
  tryReplaceInputs,
  tryReplaceStep,
} from './studio-document'

type Baseline = { revision: number; document: ScenarioDocument }

type UndoSnapshot = { document: ScenarioDocument; selectedId: string | null }

export function useStudioDraft(
  scenarioId: string | undefined,
  server: Baseline | undefined,
  compileTarget?: { exists: boolean; status: 'active' | 'disabled' },
  executableTypes?: readonly string[],
) {
  const [baseline, setBaseline] = useState<Baseline | null>(null)
  const [candidate, setCandidate] = useState<ScenarioDocument | null>(null)
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
      setSelectedId((current) => current ?? server.document.steps[0]?.id ?? null)
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

  const selected = useMemo(() => {
    if (!candidate || !selectedId) return null
    return stepOverlays[selectedId] ?? candidate.steps.find((step) => step.id === selectedId) ?? null
  }, [candidate, selectedId, stepOverlays])

  const selectedIndex = selected && candidate ? candidate.steps.findIndex((step) => step.id === selected.id) : -1

  const compile = useMemo(() => {
    if (!candidate || hasFieldDrafts) return null
    return compileScenarioDocument(candidate, {
      mode: 'release',
      target: compileTarget,
      executableTypes,
    })
  }, [candidate, compileTarget, executableTypes, hasFieldDrafts])

  const applyStructure = useCallback(
    (next: ScenarioDocument, nextSelected: string | null) => {
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
      setSelectedId((current) =>
        current && next.document.steps.some((step) => step.id === current)
          ? current
          : (next.document.steps[0]?.id ?? null),
      )
    },
    [],
  )

  return {
    baseline,
    candidate,
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
    updateInputs,
    undoStructure,
    acceptServer,
    focusFirstDraft,
  }
}
