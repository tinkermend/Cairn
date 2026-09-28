import { TARGET_CONFIG_FORM_FIELDS } from '@cairn/shared'

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
  occurrence: '触发记录',
  dataset: '数据集',
  incident: '可靠性事件',
  help: '帮助资料',
  platform: '平台规则',
}

const STEP_SUB_LABELS: Record<string, string> = {
  selector: '步骤定位',
  vars: '步骤变量',
  flow: '控制流程',
  assertion: '步骤断言',
}

const HELP_DOC_LABELS: Record<string, string> = {
  'studio-retry': '步骤重试',
  'studio-steps': '场景步骤',
  'run-review': '运行复盘',
  'run-failures': '失败诊断',
  'target-lifecycle': '目标系统',
  'session-lease': '会话租约',
  'schedule-cron': '周期调度',
  'dataset-snapshots': '数据集快照',
  'platform-architecture': '平台架构',
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

  if (kind === 'platform') return '平台规则'

  if (kind === 'help' && entityId) {
    if (entityId.startsWith('target-config-')) {
      const fieldId = entityId.slice('target-config-'.length)
      const field = TARGET_CONFIG_FORM_FIELDS.find((f) => f.id === fieldId)
      return field ? `字段说明 · ${field.label}` : `字段说明 · ${fieldId}`
    }
    if (HELP_DOC_LABELS[entityId]) {
      return `帮助 · ${HELP_DOC_LABELS[entityId]}`
    }
    return `帮助 · ${entityId}`
  }

  const label = CITATION_LABELS[kind] ?? '来源记录'
  return entityId ? `${label} · ${entityId.slice(0, 8)}` : label
}
