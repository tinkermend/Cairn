import {
  EVIDENCE_AVAILABILITY_FILTER_LABELS,
  EVIDENCE_SEARCH_VIEW_LABELS,
  EVIDENCE_TYPE_LABELS,
  type EvidenceAvailabilityFilter,
  type EvidenceType,
} from '@cairn/shared'
import {
  ATTEMPT_STATUS_LABELS,
  RUN_EVIDENCE_STATUS_LABELS,
  RUN_STATUS_LABELS,
  STEP_RUN_STATUS_LABELS,
} from '@/features/runs/labels'
import { OUTCOME_STATUS_LABELS } from './labels'
import { csvList, toggleCsv, type EvidencePageSearch } from './search-state'

export type ActiveFilter = {
  /** 稳定的键，用作列表 key 与测试定位。 */
  id: string
  /** 给人看的完整文案，如“类型：截图”。 */
  label: string
  /** 清除这一项要写回地址的字段。游标由页面在写回时统一重置。 */
  clear: Partial<EvidencePageSearch>
}

/** ID 对应的当前显示名；查不到（列表未加载完或已删除）时页面回退到 ID 前 8 位。 */
export type FilterNames = {
  targets?: ReadonlyMap<string, string>
  accounts?: ReadonlyMap<string, string>
  scenarios?: ReadonlyMap<string, string>
}

const DEFAULT_TIME_PRESET = '7d'

const TIME_PRESET_LABELS: Record<string, string> = {
  '24h': '最近 24 小时',
  '7d': '最近 7 天',
  '30d': '最近 30 天',
  custom: '自定义',
}

function shortId(id: string): string {
  return id.slice(0, 8)
}

function named(map: ReadonlyMap<string, string> | undefined, id: string): string {
  return map?.get(id) ?? shortId(id)
}

function dateLabel(value: string | undefined): string {
  if (!value) return '不限'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '不限' : date.toLocaleDateString()
}

function multi(
  out: ActiveFilter[],
  field: keyof EvidencePageSearch,
  title: string,
  raw: string | undefined,
  labels: Record<string, string>,
) {
  for (const value of csvList(raw) ?? []) {
    out.push({
      id: `${field}:${value}`,
      label: `${title}：${labels[value] ?? value}`,
      clear: { [field]: toggleCsv(raw, value) } as Partial<EvidencePageSearch>,
    })
  }
}

/**
 * 把地址里的结构化筛选展开成逐项可清除的清单。
 * 默认的“最近 7 天”不是用户加的筛选，不列出；多选字段每个取值单独一项。
 */
export function buildActiveFilters(search: EvidencePageSearch, names: FilterNames = {}): ActiveFilter[] {
  const out: ActiveFilter[] = []
  const clearTime = { timePreset: undefined, createdFrom: undefined, createdTo: undefined }

  if (search.view) {
    out.push({
      id: 'view',
      label: `视图：${EVIDENCE_SEARCH_VIEW_LABELS[search.view]}`,
      clear: { view: undefined },
    })
  }
  if (search.createdFrom || search.createdTo) {
    out.push({
      id: 'time',
      label: `时间：${dateLabel(search.createdFrom)} – ${dateLabel(search.createdTo)}`,
      clear: clearTime,
    })
  } else if (search.timePreset && search.timePreset !== DEFAULT_TIME_PRESET) {
    out.push({
      id: 'time',
      label: `时间：${TIME_PRESET_LABELS[search.timePreset] ?? search.timePreset}`,
      clear: clearTime,
    })
  }
  if (search.targetId) {
    out.push({
      id: 'targetId',
      label: `目标：${named(names.targets, search.targetId)}`,
      // 账号属于目标，目标清除后账号筛选不再成立。
      clear: { targetId: undefined, targetAccountId: undefined },
    })
  }
  if (search.targetAccountId) {
    out.push({
      id: 'targetAccountId',
      label: `账号：${named(names.accounts, search.targetAccountId)}`,
      clear: { targetAccountId: undefined },
    })
  }
  if (search.scenarioId) {
    out.push({
      id: 'scenarioId',
      label: `场景：${named(names.scenarios, search.scenarioId)}`,
      // 版本属于场景。
      clear: { scenarioId: undefined, scenarioVersionId: undefined },
    })
  }
  if (search.scenarioVersionId) {
    out.push({
      id: 'scenarioVersionId',
      label: `场景版本：${shortId(search.scenarioVersionId)}`,
      clear: { scenarioVersionId: undefined },
    })
  }
  if (search.isTrial != null) {
    out.push({
      id: 'isTrial',
      label: `运行种类：${search.isTrial ? '试跑' : '正式运行'}`,
      clear: { isTrial: undefined },
    })
  }
  const ids: [keyof EvidencePageSearch, string, string | undefined][] = [
    ['runId', '运行', search.runId],
    ['suiteId', '场景集', search.suiteId],
    ['suiteRunId', '集合运行', search.suiteRunId],
    ['memberId', '集合成员', search.memberId],
    ['evidenceId', '证据', search.evidenceId],
    ['stepRunId', '步骤运行', search.stepRunId],
    ['attemptId', '尝试', search.attemptId],
  ]
  for (const [field, title, value] of ids) {
    if (value) {
      out.push({
        id: field,
        label: `${title}：${shortId(value)}`,
        clear: { [field]: undefined } as Partial<EvidencePageSearch>,
      })
    }
  }
  multi(out, 'types', '类型', search.types, EVIDENCE_TYPE_LABELS as Record<EvidenceType, string>)
  multi(
    out,
    'availability',
    '可用性',
    search.availability,
    EVIDENCE_AVAILABILITY_FILTER_LABELS as Record<EvidenceAvailabilityFilter, string>,
  )
  multi(out, 'runStatuses', '运行状态', search.runStatuses, RUN_STATUS_LABELS)
  multi(out, 'stepRunStatuses', '步骤状态', search.stepRunStatuses, STEP_RUN_STATUS_LABELS)
  multi(out, 'attemptStatuses', '尝试状态', search.attemptStatuses, ATTEMPT_STATUS_LABELS)
  multi(out, 'outcomeStatuses', '业务结果', search.outcomeStatuses, OUTCOME_STATUS_LABELS)
  multi(out, 'runEvidenceStatuses', '运行证据完整性', search.runEvidenceStatuses, RUN_EVIDENCE_STATUS_LABELS)
  if (search.released != null) {
    out.push({
      id: 'released',
      label: search.released ? '对外发布：已发布' : '对外发布：未发布',
      clear: { released: undefined },
    })
  }
  return out
}
