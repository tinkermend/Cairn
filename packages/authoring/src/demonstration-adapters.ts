import { isAlias, isCollection, isNode, isPair, parseAllDocuments } from 'yaml'
import {
  DEMONSTRATION_ADAPTER_VERSION,
  DEMONSTRATION_LIMITS,
  DEMONSTRATION_PROTOCOL,
  DEMONSTRATION_REDACTION_VERSION,
  RECORDER_SOURCE_VERSION,
  canonicalJson,
  demonstrationSourceSchema,
  isSensitiveFill,
  normalizeRecording,
  syncSha256,
  type DemonstrationFact,
  type DemonstrationObservation,
  type DemonstrationProfile,
  type DemonstrationSource,
  type RecordingEvent,
} from '@cairn/shared'

export class DemonstrationParseError extends Error {
  readonly code = 'DEMONSTRATION_INVALID'
}
function fail(message: string): never {
  throw new DemonstrationParseError(message)
}
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const string = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined
const sensitiveName =
  /password|passwd|secret|token|authorization|cookie|api[_-]?key|密码|口令|密钥|验证码/i
const sensitiveLiteral =
  /^(?:\*{3,}|•{3,}|\[REDACTED\])$|(?:Bearer\s+[\w.-]+)|(?:sk-[\w-]{16,})|(?:eyJ[\w-]+\.[\w-]+\.[\w-]+)/i
const embeddedSecret =
  /(?:password|passwd|secret|token|api[_-]?key|密码|口令|密钥)\s*(?:[:=：]|为|是)\s*[^\s,，;；]+/i
const missing = (reason: string): DemonstrationObservation => ({ status: 'missing', reason })

/** Exposed for both upload clients and the server. Never store URL credentials or fragments. */
export function sanitizeDemonstrationUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (!['https:', 'http:'].includes(url.protocol)) return undefined
    url.username = ''
    url.password = ''
    url.hash = ''
    for (const key of [...url.searchParams.keys()])
      if (sensitiveName.test(key) || sensitiveLiteral.test(url.searchParams.get(key) ?? ''))
        url.searchParams.delete(key)
    return url.toString()
  } catch {
    return undefined
  }
}

function boundTree(value: unknown, depth = 0, budget = { nodes: 0 }): void {
  if (++budget.nodes > 100_000 || depth > DEMONSTRATION_LIMITS.depth) fail('文件结构过深或节点过多')
  if (typeof value === 'string' && /\$\{|\{\{|<%/.test(value)) fail('本期不支持模板或环境变量展开')
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('文件含对象保留键')
    boundTree(child, depth + 1, budget)
  }
}

function parseYaml(text: string): unknown {
  const docs = parseAllDocuments(text, { schema: 'core', uniqueKeys: true, strict: true })
  if (docs.length !== 1 || docs[0]!.errors.length) fail('需要一个合法 YAML 文档；不允许重复键')
  function check(node: unknown, depth: number): void {
    if (depth > DEMONSTRATION_LIMITS.depth) fail('YAML 嵌套过深')
    if (isAlias(node) || (isNode(node) && (node.anchor || node.tag)))
      fail('YAML 不支持 alias、anchor 或显式 tag')
    if (isCollection(node)) node.items.forEach((child) => check(child, depth + 1))
    else if (isPair(node)) {
      check(node.key, depth + 1)
      check(node.value, depth + 1)
    }
  }
  check(docs[0]!.contents, 0)
  return docs[0]!.toJS({ maxAliasCount: 0 })
}

function fact(sequence: number, action: string, id = `event-${sequence}`): DemonstrationFact {
  return {
    id,
    sourceIds: [id],
    sequence,
    kind: 'action',
    action,
    pageId: null,
    documentEpoch: null,
    framePath: null,
    timestampPrecision: 'unknown',
    data: {},
    before: missing('来源未提供动作前观察'),
    after: missing('来源未提供动作后观察'),
    diagnostics: [],
  }
}

function setValue(event: DemonstrationFact, value: unknown, sensitive = false): void {
  if (sensitive || (typeof value === 'string' && sensitiveLiteral.test(value))) {
    event.data.value = {
      state: 'redacted',
      reason: '敏感或掩码值已移除；需移除登录步骤或人工重新编写',
    }
    event.diagnostics.push('敏感值不作为普通参数或默认值保存')
  } else if (typeof value === 'string' || typeof value === 'number') {
    event.data.value = { state: 'literal', text: String(value) }
  } else {
    event.data.value = { state: 'missing', reason: '来源没有提供输入值' }
  }
}

function crxFacts(raw: unknown): DemonstrationFact[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > DEMONSTRATION_LIMITS.actions)
    fail('CRX 必须包含 1–200 条结构化事件')
  return raw.map((item, sequence) => {
    const input = record(item)
    if (!string(input.name)) fail(`第 ${sequence + 1} 条不是 CRX 事件`)
    const out = fact(sequence, input.name as string)
    out.pageId = string(input.pageAlias) ?? null
    out.framePath =
      Array.isArray(input.framePath) && input.framePath.every((v) => typeof v === 'string')
        ? (input.framePath as string[])
        : null
    if (out.action === 'openPage' && (!input.url || input.url === 'about:blank')) {
      out.kind = 'observation'
      out.diagnostics.push('空白页创建是观察，不生成导航')
      return out
    }
    // A single-event call applies the existing whitelist and locator parser without merging facts.
    const normalized = normalizeRecording([input], { sourceVersion: RECORDER_SOURCE_VERSION })
    const mapped = normalized.items[0]
    const data = record(mapped?.input)
    if (data.target) out.data.target = data.target as DemonstrationFact['data']['target']
    if (string(input.url)) out.data.url = sanitizeDemonstrationUrl(input.url as string)
    if (out.action === 'fill') setValue(out, input.text, isSensitiveFill(input as RecordingEvent))
    if (out.action === 'press') out.data.key = string(input.key)
    if (out.action === 'click') {
      if (['left', 'right', 'middle'].includes(String(data.button)))
        out.data.button = data.button as 'left' | 'right' | 'middle'
      if (data.clickCount === 1 || data.clickCount === 2) out.data.clickCount = data.clickCount
      if (Array.isArray(data.modifiers))
        out.data.modifiers = data.modifiers as NonNullable<DemonstrationFact['data']['modifiers']>
    }
    if (out.action === 'select') {
      out.data.selectBy = data.by as 'value' | 'label' | 'index'
      if (typeof data.index === 'number') out.data.selectIndex = data.index
      if (data.value !== undefined) setValue(out, data.value)
    }
    if (mapped?.candidateStepType === 'assert' && data.expect)
      out.data.assertion = {
        kind: 'deterministic',
        target: out.data.target,
        expect: data.expect as Extract<
          NonNullable<DemonstrationFact['data']['assertion']>,
          { kind: 'deterministic' }
        >['expect'],
      }
    if (mapped?.status === 'unresolved') out.diagnostics.push(...mapped.diagnostics)
    return out
  })
}

function midsceneFacts(raw: unknown): DemonstrationFact[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > DEMONSTRATION_LIMITS.actions)
    fail('Midscene recorder JSON 必须是 1–200 条事件的裸数组')
  return raw.map((entry, sequence) => {
    const item = record(entry)
    if (!string(item.type) || !string(item.hashId) || !Object.keys(record(item.pageInfo)).length)
      fail(`第 ${sequence + 1} 条不符合 Midscene recorder 事件格式`)
    const out = fact(sequence, String(item.type), String(item.hashId))
    if (Array.isArray(item.mergedHashIds))
      out.sourceIds = [
        ...new Set([
          out.id,
          ...item.mergedHashIds.filter((v): v is string => typeof v === 'string'),
        ]),
      ]
    if (
      typeof item.timestamp === 'number' &&
      Number.isFinite(item.timestamp) &&
      item.timestamp >= 0 &&
      item.timestamp < 8.64e15
    ) {
      out.observedAt = new Date(item.timestamp).toISOString()
      out.timestampPrecision = 'millisecond'
    }
    const semantic = record(item.semantic)
    out.semanticSource = ['aiDescribe', 'recorderAI', 'heuristic'].includes(String(semantic.source))
      ? (semantic.source as 'aiDescribe' | 'recorderAI' | 'heuristic')
      : 'unknown'
    out.data.targetDescription =
      string(semantic.elementDescription) ?? string(item.elementDescription)
    const rawPayload = record(item.rawPayload)
    if (item.url) out.data.url = sanitizeDemonstrationUrl(String(item.url))
    if (out.action === 'navigation') {
      if (item.actionType === 'NavigationChanged') {
        out.kind = 'observation'
        out.diagnostics.push('导航变化是上一动作的效果，不重复发出导航')
      } else if (item.actionType && !['Navigate', 'Goto', 'Open'].includes(String(item.actionType)))
        out.diagnostics.push(`不支持导航动作 ${String(item.actionType).slice(0, 64)}`)
    }
    if (out.action === 'input') {
      setValue(
        out,
        item.value,
        sensitiveName.test(out.data.targetDescription ?? '') || rawPayload.inputType === 'password',
      )
      out.data.mode = 'replace'
      if (rawPayload.mode && rawPayload.mode !== 'replace')
        out.diagnostics.push('录制输入带有未确认模式，需人工修正')
    }
    if (out.action === 'keydown') out.data.key = string(item.value)
    if (out.action === 'scroll') {
      setValue(out, item.value)
      out.diagnostics.push('来源是绝对滚动坐标；缺少起点和容器，不能转换成相对滚动')
    }
    for (const [key, phase] of [
      ['screenshotBefore', 'before'],
      ['screenshotAfter', 'after'],
    ] as const) {
      if (item[key])
        out[phase] = { status: 'omitted', reason: '截图默认不上传；需本地遮罩、检查并确认' }
    }
    if (item.screenshotAsset) out.after = missing('截图仅为外部引用；未读取本地路径或远程资源')
    return out
  })
}

const semanticKeys = new Set([
  'aiContexts',
  'aiActContext',
  'aiActionContext',
  'context',
  'instruction',
  'locate',
  'xpath',
  'deepLocate',
  'images',
  'fileChooserAccept',
  'inputStrategy',
  'keyboardTypeDelay',
  'continueOnError',
])
const actionKeys = new Set([
  'ai',
  'aiAct',
  'aiAction',
  'aiTap',
  'aiInput',
  'aiKeyboardPress',
  'aiScroll',
  'aiAssert',
  'aiQuery',
  'sleep',
  'aiWaitFor',
  'javascript',
  'js',
])

function yamlFacts(raw: unknown): { facts: DemonstrationFact[]; omittedConfig: string[] } {
  const doc = record(raw)
  if (!Array.isArray(doc.tasks) || !doc.tasks.length)
    fail('仅支持包含 tasks[].flow[] 的 Midscene Web YAML')
  if (['browser', 'android', 'ios', 'computer', 'harmony'].some((k) => k in doc))
    fail('仅支持单一 Web 目标的 flow 方言')
  const targets = ['web', 'page', 'target'].filter((key) => key in doc)
  if (targets.length !== 1) fail('YAML 必须且只能声明一个 page/web/target')
  const target = record(doc[targets[0]!])
  if (target.platformId && target.platformId !== 'web') fail('仅支持 Web 目标')
  const settings = targets[0] === 'target' ? record(target.values) : target
  const entryUrl = sanitizeDemonstrationUrl(String(settings.url ?? target.url ?? ''))
  if (!entryUrl) fail('Web 目标缺少有效 HTTP(S) URL')
  const facts: DemonstrationFact[] = [fact(0, 'navigate', 'entry')]
  facts[0]!.data.url = entryUrl
  const omittedConfig: string[] = []
  const globalSemantics = [...Object.keys(doc), ...Object.keys(settings)].filter((k) =>
    semanticKeys.has(k),
  )
  for (const [scope, object, allowed] of [
    ['root', doc, ['tasks', ...targets]],
    ['target', settings, ['url']],
  ] as const) {
    for (const key of Object.keys(object))
      if (!(allowed as readonly string[]).includes(key) && !semanticKeys.has(key))
        omittedConfig.push(`${scope}.${key}`)
  }
  for (const [taskIndex, rawTask] of doc.tasks.entries()) {
    const task = record(rawTask)
    if (!Array.isArray(task.flow)) fail(`任务 ${taskIndex + 1} 缺少 flow；不支持 Test DSL`)
    const inherited = [
      ...globalSemantics,
      ...Object.keys(task).filter((key) => key !== 'name' && key !== 'flow'),
    ]
    for (const [flowIndex, rawStep] of task.flow.entries()) {
      const step = record(rawStep)
      const keys = Object.keys(step).filter((key) => actionKeys.has(key))
      if (keys.length > 1) fail(`任务 ${taskIndex + 1} 第 ${flowIndex + 1} 项有多个动作键`)
      const action = keys[0] ?? Object.keys(step)[0] ?? 'unknown'
      const out = fact(facts.length, action, `task-${taskIndex}-flow-${flowIndex}`)
      const allowed: Record<string, string[]> = {
        ai: ['ai'],
        aiAct: ['aiAct'],
        aiTap: ['aiTap'],
        aiInput: ['aiInput', 'value', 'mode'],
        aiKeyboardPress: ['aiKeyboardPress', 'keyName'],
        aiScroll: ['aiScroll', 'direction', 'distance', 'scrollType'],
        aiAssert: ['aiAssert'],
        aiQuery: ['aiQuery'],
        sleep: ['sleep'],
      }
      const unknown = [
        ...inherited,
        ...Object.keys(step).filter((key) => !(allowed[action] ?? [action]).includes(key)),
      ]
      if (unknown.length)
        out.diagnostics.push(
          `存在未支持且会影响语义的配置：${[...new Set(unknown)].join('、').slice(0, 400)}`,
        )
      if (['ai', 'aiAct', 'aiAssert', 'aiQuery'].includes(action))
        out.data.instruction = string(step[action])
      if (['aiTap', 'aiInput', 'aiKeyboardPress', 'aiScroll'].includes(action))
        out.data.targetDescription = string(step[action])
      if (action === 'aiInput') {
        const mode = step.mode ?? 'replace'
        if (['replace', 'typeOnly', 'append', 'clear'].includes(String(mode)))
          out.data.mode =
            mode === 'typeOnly' || mode === 'append' ? 'type_only' : (mode as 'replace' | 'clear')
        else out.diagnostics.push('不支持的输入模式')
        if (mode !== 'clear')
          setValue(out, step.value, sensitiveName.test(out.data.targetDescription ?? ''))
        else if (step.value !== undefined && step.value !== '')
          out.diagnostics.push('clear 不能携带非空输入值')
      }
      if (action === 'aiKeyboardPress') out.data.key = string(step.keyName)
      if (action === 'aiScroll') {
        if (['up', 'down', 'left', 'right'].includes(String(step.direction)))
          out.data.direction = step.direction as 'down'
        if (typeof step.distance === 'number') out.data.distance = step.distance
        out.data.scrollType = String(step.scrollType ?? 'singleAction')
      }
      if (action === 'sleep' && typeof step.sleep === 'number') out.data.durationMs = step.sleep
      if (action === 'aiAssert' && flowIndex === 0)
        out.diagnostics.push('任务开头的断言没有可表达的前序业务动作；需人工放置')
      if (typeof step[action] === 'object' && step[action] !== null)
        out.diagnostics.push('动作的定位对象或嵌套配置不在本期方言中')
      facts.push(out)
    }
  }
  if (facts.length > DEMONSTRATION_LIMITS.actions) fail('一次最多 200 条操作（含入口导航）')
  return { facts, omittedConfig: [...new Set(omittedConfig)] }
}

export function sanitizeDemonstrationSource(raw: unknown): DemonstrationSource {
  const source = demonstrationSourceSchema.parse(raw)
  for (const event of source.facts) {
    for (const observation of [event.before, event.after])
      if (observation.url) observation.url = sanitizeDemonstrationUrl(observation.url)
    if (event.data.url) event.data.url = sanitizeDemonstrationUrl(event.data.url)
    const text = `${event.data.targetDescription ?? ''} ${canonicalJson(event.data.target ?? {})}`
    if (event.data.value?.state === 'literal')
      setValue(event, event.data.value.text, sensitiveName.test(text))
    for (const key of ['instruction', 'targetDescription'] as const) {
      if (
        event.data[key] &&
        (sensitiveLiteral.test(event.data[key]!) || embeddedSecret.test(event.data[key]!))
      ) {
        delete event.data[key]
        event.diagnostics.push('语义文本包含敏感值，已移除，需重新编写')
      }
    }
    if (
      event.data.target &&
      (sensitiveLiteral.test(canonicalJson(event.data.target)) ||
        embeddedSecret.test(canonicalJson(event.data.target)))
    ) {
      delete event.data.target
      delete event.data.assertion
      event.diagnostics.push('定位信息包含敏感值，已移除，需重新编写')
    }
    if (event.data.assertion && sensitiveName.test(text)) {
      delete event.data.assertion
      event.diagnostics.push('敏感字段不保存录制断言值')
    }
    event.diagnostics = [...new Set(event.diagnostics)]
  }
  if (new TextEncoder().encode(canonicalJson(source)).length > DEMONSTRATION_LIMITS.envelopeBytes)
    fail('脱敏后结构化内容超过 1 MiB')
  return demonstrationSourceSchema.parse(source)
}

export function parseDemonstrationFile(input: {
  text: string
  profile: DemonstrationProfile
  targetId: string
  captureId: string
}): DemonstrationSource {
  if (new TextEncoder().encode(input.text).length > DEMONSTRATION_LIMITS.fileBytes)
    fail('来源文件超过 32 MiB')
  if (input.profile === 'cairn-crx-capture@1') {
    let source: unknown
    try {
      source = JSON.parse(input.text)
    } catch {
      return fail('不是合法的识途采集档案')
    }
    boundTree(source)
    const parsed = sanitizeDemonstrationSource(source)
    if (parsed.targetId !== input.targetId) fail('采集 Target 与导入 Target 不一致')
    return parsed
  }
  let raw: unknown
  try {
    raw =
      input.profile === 'midscene-yaml-flow@1'
        ? parseYaml(input.text)
        : input.profile === RECORDER_SOURCE_VERSION && !input.text.trimStart().startsWith('[')
          ? input.text
              .split(/\r?\n/)
              .filter((line) => line.trim())
              .map((line) => JSON.parse(line))
          : JSON.parse(input.text)
  } catch (error) {
    if (error instanceof DemonstrationParseError) throw error
    return fail('文件格式无效；不支持 JS/TS、执行报告或缓存文件')
  }
  boundTree(raw)
  const yaml = input.profile === 'midscene-yaml-flow@1' ? yamlFacts(raw) : undefined
  const facts =
    yaml?.facts ?? (input.profile === RECORDER_SOURCE_VERSION ? crxFacts(raw) : midsceneFacts(raw))
  const studio =
    Array.isArray(raw) && raw.some((event) => record(event).source === 'studio-preview')
  return sanitizeDemonstrationSource({
    protocolVersion: DEMONSTRATION_PROTOCOL,
    captureId: input.captureId,
    targetId: input.targetId,
    sourceKind: yaml
      ? 'script'
      : input.profile === RECORDER_SOURCE_VERSION
        ? 'legacy_normalized'
        : 'interaction_trace',
    channel: 'file',
    producerKind: yaml
      ? 'unknown'
      : input.profile === RECORDER_SOURCE_VERSION
        ? 'cairn_crx'
        : studio
          ? 'studio_preview'
          : 'chrome_recorder',
    actorKind: yaml || studio ? 'unknown' : 'human',
    authorship: yaml ? 'unknown' : studio ? 'unknown' : 'human',
    importProfile: input.profile,
    producerVersion: input.profile === RECORDER_SOURCE_VERSION ? '0.15.0' : null,
    detectedShape: yaml
      ? 'single-web/tasks/flow'
      : input.profile === RECORDER_SOURCE_VERSION
        ? 'crx-events'
        : 'midscene-event-array',
    adapterVersion: DEMONSTRATION_ADAPTER_VERSION,
    redactionVersion: DEMONSTRATION_REDACTION_VERSION,
    facts,
    omittedConfig: yaml?.omittedConfig ?? [],
    assetManifest: [],
  })
}

export function demonstrationFactDigest(source: DemonstrationSource): string {
  // Hash the stored contract, not a future redaction/normalization rule's reinterpretation.
  return syncSha256(canonicalJson(demonstrationSourceSchema.parse(source)))
}
