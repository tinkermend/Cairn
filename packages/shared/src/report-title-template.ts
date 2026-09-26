export const REPORT_TITLE_CATALOG = [
  { key: 'systemName', label: '目标系统名称', description: '运行来源的目标系统快照名称', example: '业务系统', valueType: '文本', exampleSource: '目标系统快照', sensitive: false, sources: ['RUN', 'SUITE_RUN'] },
  { key: 'scenarioName', label: '场景显示名', description: '单次运行的场景显示名；成员独立报告使用成员显示名', example: '登录检查', valueType: '文本', exampleSource: '运行快照的场景或成员显示名', sensitive: false, sources: ['RUN'] },
  { key: 'suiteName', label: '场景集名称', description: '场景集运行的名称', example: '每日巡检', valueType: '文本', exampleSource: '场景集运行快照', sensitive: false, sources: ['SUITE_RUN'] },
  { key: 'executedDate', label: '执行日期', description: '开始日期；未开始时使用创建日期，按报告时区格式化', example: '2026-09-26', valueType: '日期 YYYY-MM-DD', exampleSource: '运行开始时间或创建时间及报告时区', sensitive: false, sources: ['RUN', 'SUITE_RUN'] },
  { key: 'executedRange', label: '执行日期范围', description: '开始至结束日期；同一天或未结束时只显示一天', example: '2026-09-26', valueType: '日期范围', exampleSource: '运行开始及结束时间与报告时区', sensitive: false, sources: ['RUN', 'SUITE_RUN'] },
  { key: 'runNumber', label: '运行编号', description: 'Run 或 SuiteRun ID 的前八个字符', example: 'a1b2c3d4', valueType: '八位文本', exampleSource: 'Run 或 SuiteRun ID', sensitive: false, sources: ['RUN', 'SUITE_RUN'] },
] as const

export type ReportTitleSource = 'RUN' | 'SUITE_RUN'
export type ReportTitleKey = (typeof REPORT_TITLE_CATALOG)[number]['key']
export type ReportTitleSegment = {
  kind: 'text' | 'variable' | 'unknown' | 'unavailable' | 'incomplete' | 'invalid'
  start: number
  end: number
  raw: string
  key?: string
  message?: string
}

const catalog = new Map<string, (typeof REPORT_TITLE_CATALOG)[number]>(REPORT_TITLE_CATALOG.map((item) => [item.key, item]))

/** Offsets are UTF-16 offsets, matching input.selectionStart and String.slice. */
export function parseReportTitle(template: string, source?: ReportTitleSource): ReportTitleSegment[] {
  const segments: ReportTitleSegment[] = []
  let textStart = 0
  let index = 0
  const pushText = (end: number) => {
    if (end > textStart) segments.push({ kind: 'text', start: textStart, end, raw: template.slice(textStart, end) })
  }
  while (index < template.length) {
    const char = template[index]
    if (char === '\\' && (template[index + 1] === '{' || template[index + 1] === '}')) {
      index += 2
      continue
    }
    if (char !== '{' && char !== '}') { index++; continue }
    pushText(index)
    if (char === '}') {
      segments.push({ kind: 'invalid', start: index, end: index + 1, raw: '}', message: '多余的右大括号；字面量请写作 \\}' })
      index++
    } else {
      let end = index + 1
      while (end < template.length && template[end] !== '}' && template[end] !== '{') end++
      if (end >= template.length) {
        segments.push({ kind: 'incomplete', start: index, end, raw: template.slice(index), message: '缺少右大括号 }' })
        index = end
      } else if (template[end] === '{') {
        segments.push({ kind: 'invalid', start: index, end: end + 1, raw: template.slice(index, end + 1), message: '变量不能嵌套；字面量请使用 \\{' })
        index = end + 1
      } else {
        const key = template.slice(index + 1, end)
        const item = catalog.get(key)
        const kind = !item ? 'unknown' : source && !(item.sources as readonly string[]).includes(source) ? 'unavailable' : 'variable'
        segments.push({ kind, start: index, end: end + 1, raw: template.slice(index, end + 1), key,
          message: kind === 'unknown' ? `未知标题变量：${key || '(空)'}` : kind === 'unavailable' ? `${item?.label}不适用于${source === 'RUN' ? '单次运行' : '场景集'}` : undefined })
        index = end + 1
      }
    }
    textStart = index
  }
  pushText(template.length)
  return segments
}

export function reportTitleSources(template: string): ReportTitleSource[] {
  const segments = parseReportTitle(template)
  if (segments.some((part) => !['text', 'variable'].includes(part.kind))) return []
  return (['RUN', 'SUITE_RUN'] as const).filter((source) => parseReportTitle(template, source).every((part) => part.kind === 'text' || part.kind === 'variable'))
}

export function renderReportTitleV2(template: string, vars: Partial<Record<ReportTitleKey, string>>, source: ReportTitleSource): string {
  return parseReportTitle(template, source).map((part) => {
    if (part.kind === 'text') return part.raw.replace(/\\([{}])/g, '$1')
    if (part.kind === 'variable') return vars[part.key as ReportTitleKey] ?? part.raw
    throw new Error(part.message ?? '标题变量无效')
  }).join('')
}
