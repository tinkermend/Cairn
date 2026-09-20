import { parseDemonstrationFile, sanitizeDemonstrationUrl, suggestDemonstration } from '@cairn/authoring'
import { RECORDING_NORMALIZER_VERSION, RECORDER_SOURCE_VERSION, type DemonstrationFact, type DemonstrationObservation, type DemonstrationSource } from '@cairn/shared'
import type { RecordingPreview } from './preview'
import { asLocator } from '../../vendor/playwright-isomorphic/locatorGenerators'

export const CAPTURE_GET = 'cairn.capture.get'
export const CAPTURE_RESET = 'cairn.capture.reset'
export const CAPTURE_CHANGED = 'cairn.capture.changed'
const placeholderId = '00000000-0000-4000-8000-000000000001'
type Frame = { url(): string; _page?: { mainFrame(): Frame }; _currentDocument?: { documentId?: string }; evaluateExpression(expression: string, options: { isFunction: boolean }): Promise<unknown> }
type Action = { frame: { pageAlias?: string; framePath?: string[] }; action: Record<string, unknown> }
export type CaptureState = { facts: DemonstrationFact[]; error?: string }

/** Separate from the recorder's merged actions. Only sanitized facts enter this buffer. */
export class DemonstrationCapture {
  private state: CaptureState = { facts: [] }
  private cache = new WeakMap<Frame, DemonstrationObservation>()
  private pages = new Set<string>()
  constructor(private readonly changed: (state: CaptureState) => void = () => {}) {}
  get(): CaptureState { return structuredClone(this.state) }
  reset(): void { this.state = { facts: [] }; this.cache = new WeakMap(); this.pages.clear(); this.emit() }
  private emit(): void { this.changed(this.get()) }
  private async observe(frame: Frame): Promise<DemonstrationObservation> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const epoch = frame._currentDocument?.documentId
    try {
      // Structural regional summary contains no DOM text, input values or attributes.
      const value = await Promise.race([
        frame.evaluateExpression(`() => ({ url: location.href, readyState: document.readyState,
          regionSummary: JSON.stringify({ forms: document.forms.length, buttons: document.querySelectorAll('button,[role="button"]').length,
            headings: document.querySelectorAll('h1,h2,h3,[role="heading"]').length, frames: document.querySelectorAll('iframe').length }) })`, { isFunction: true }),
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 150) }),
      ]) as { url: string; readyState: 'loading' | 'interactive' | 'complete'; regionSummary: string } | null
      if (!value) return { status: 'missing', reasonCode: 'timeout', reason: '页面观察超过 150ms，动作采集继续' }
      if (epoch !== frame._currentDocument?.documentId) return { status: 'missing', reasonCode: 'document_changed', reason: '采集期间页面发生导航，无法确认观察属于哪个文档' }
      const result: DemonstrationObservation = { status: 'captured', observedAt: new Date().toISOString(),
        url: sanitizeDemonstrationUrl(value.url), readyState: value.readyState, regionSummary: value.regionSummary,
        documentEpoch: frame._currentDocument?.documentId }
      this.cache.set(frame, result)
      return result
    } catch { return { status: 'missing', reasonCode: 'frame_unavailable', reason: '页面或 Frame 已不可访问，未采到观察' } }
    finally { clearTimeout(timer) }
  }
  async begin(frame: Frame, context: Action, mode: 'perform' | 'record'): Promise<() => void> {
    try {
      const pageId = context.frame.pageAlias ?? null
      if (this.state.facts.length + (pageId && !this.pages.has(pageId) ? 2 : 1) > 200) { this.state.error = '本段已达 200 条事实限制，请上传或清空后继续；不能上传不完整片段'; this.emit(); return () => {} }
      const epoch = frame._currentDocument?.documentId ?? null
      const input = { ...context.action, ...context.frame,
        locator: typeof context.action.selector === 'string' ? JSON.parse(asLocator('jsonl', context.action.selector)) : undefined }
      const parsed = parseDemonstrationFile({ text: JSON.stringify([input]), profile: RECORDER_SOURCE_VERSION, targetId: placeholderId, captureId: placeholderId })
      const fact = parsed.facts[0]!
      if (pageId && !this.pages.has(pageId)) {
        this.pages.add(pageId)
        const url = sanitizeDemonstrationUrl((frame._page?.mainFrame() ?? frame).url())
        if (url) {
          const initial = parseDemonstrationFile({ text: JSON.stringify([{ name: 'openPage', url, ...context.frame, framePath: [] }]), profile: RECORDER_SOURCE_VERSION, targetId: placeholderId, captureId: placeholderId }).facts[0]!
          initial.id = crypto.randomUUID(); initial.sourceIds = [initial.id]; initial.sequence = this.state.facts.length
          initial.documentEpoch = epoch
          this.state.facts.push(initial)
        }
      }
      fact.id = crypto.randomUUID(); fact.sourceIds = [fact.id]; fact.sequence = this.state.facts.length
      fact.pageId = pageId; fact.documentEpoch = epoch; fact.observedAt = new Date().toISOString(); fact.timestampPrecision = 'millisecond'
      const generation = this.state
      // Reserve order before awaiting any observation (rapid native input can overlap).
      this.state.facts.push(fact)
      if (mode === 'perform') fact.before = await this.observe(frame)
      else {
        const cached = this.cache.get(frame)
        fact.before = cached?.documentEpoch && cached.documentEpoch === epoch
          ? { ...cached, status: 'approximate', ageMs: Math.max(0, Date.now() - Date.parse(cached.observedAt!)), reason: '同一文档的最近观察；原生输入已发生，不能证明动作前态', reasonCode: 'post_action_only' }
          : { status: 'missing', reasonCode: 'post_action_only', reason: '原生输入发生后才收到通知，没有可确认的动作前观察' }
      }
      if (generation === this.state) this.emit()
      return () => { void this.observe(frame).then((observation) => {
        if (generation !== this.state) return
        fact.after = observation; this.emit()
      }) }
    } catch {
      this.state.error = '有动作未能保留为脱敏事实，请清空本段并重新录制'; this.emit()
      return () => {}
    }
  }
}

export function captureSource(facts: DemonstrationFact[], targetId: string, captureId: string, bindingId?: string): DemonstrationSource {
  return { protocolVersion: 'demonstration@1', captureId, targetId, bindingId, sourceKind: 'interaction_trace',
    channel: 'extension', producerKind: 'cairn_crx', actorKind: 'human', authorship: 'human',
    importProfile: 'cairn-crx-capture@1', producerVersion: '0.15.0', detectedShape: 'cairn-crx-pre-merge',
    adapterVersion: 'demonstration-adapters@1', redactionVersion: 'demonstration-redaction@1',
    facts: facts.map((fact, sequence) => ({ ...fact, sequence })), omittedConfig: [], assetManifest: [] }
}

export function previewCapture(state: CaptureState, excluded: readonly number[]): RecordingPreview | { error: string } | null {
  if (state.error) return { error: state.error }
  if (!state.facts.length) return null
  const facts = state.facts.filter((_, i) => !excluded.includes(i))
  if (!facts.length) return { error: '本段操作均已删除，可撤销或清空后重新录制' }
  const source = captureSource(facts, placeholderId, placeholderId)
  const suggestions = suggestDemonstration(source)
  const items = suggestions.map((item, index) => ({ index, sourceIndexes: item.sourceIds.map((id) => state.facts.findIndex((fact) => fact.id === id)),
    sourceAction: item.action, name: item.step?.name ?? item.outcome?.meaning ?? item.action,
    status: item.status === 'mapped' ? 'mapped' as const : 'unresolved' as const,
    candidateStepType: item.step?.type, input: item.step?.input ?? {}, sensitive: false, diagnostics: item.diagnostics }))
  // events are only the legacy preview field; new uploads use immutable facts above.
  return { sourceVersion: RECORDER_SOURCE_VERSION, normalizerVersion: RECORDING_NORMALIZER_VERSION, events: [], sourceDigestEvents: [], eventCount: facts.length, diagnostics: [], items,
    unresolvedCount: items.filter((item) => item.status !== 'mapped').length,
    sourceRows: items.map((item) => item.sourceIndexes), selectors: items.map(() => null) } as RecordingPreview
}
