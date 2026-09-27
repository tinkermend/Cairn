const CITATION_LABELS: Record<string, string> = {
  run: '运行记录',
  stepRun: '步骤执行',
  attempt: '执行尝试',
  evidence: '执行证据',
  step: '场景步骤',
  scenario: '场景事实',
  target: '目标系统',
  session: '会话记录',
  schedule: '调度配置',
  dataset: '数据集',
  help: '帮助资料',
}

const STEP_SUB_LABELS: Record<string, string> = {
  selector: '步骤定位',
  vars: '步骤变量',
  flow: '控制流程',
  assertion: '步骤断言',
}

export function citationDisplayLabel(citation: string): string {
  const parts = citation.split(':')
  if (parts.length < 2) return '来源记录'

  const kind = parts[0]
  const entityId = parts[1]
  const subKind = parts[2]

  if (kind === 'step' && subKind && STEP_SUB_LABELS[subKind]) {
    return `${STEP_SUB_LABELS[subKind]} · ${entityId.slice(0, 8)}`
  }

  if (kind === 'scenario' && subKind === 'draft_status') {
    return `草稿状态 · ${entityId.slice(0, 8)}`
  }

  const label = CITATION_LABELS[kind] ?? '来源记录'
  return entityId ? `${label} · ${entityId.slice(0, 8)}` : label
}
