import type {
  AssertExpect,
  ExecutionErrorCategory,
  LocatorBy,
  NumberCompareOp,
  RelativeAnchorScope,
} from '@cairn/shared'

export const BY_LABELS: Record<LocatorBy, string> = {
  role: '角色',
  label: '标签',
  text: '文本',
  title: '标题',
  testId: '测试标识',
  css: 'CSS',
}

export const KIND_LABELS: Record<AssertExpect['kind'], string> = {
  exists: '元素存在',
  visible: '元素可见',
  text_equals: '文本等于',
  text_contains: '文本包含',
  number_compare: '数值比较',
}

export const OP_LABELS: Record<NumberCompareOp, string> = {
  eq: '等于',
  gt: '大于',
  gte: '大于等于',
  lt: '小于',
  lte: '小于等于',
}

export const CATEGORY_LABELS: Record<ExecutionErrorCategory, string> = {
  VALIDATION: '校验',
  TIMEOUT: '超时',
  CANCELLED: '取消',
  EXECUTOR: '执行器',
  INFRASTRUCTURE: '基础设施',
  UNKNOWN: '未知',
}

export const ANCHOR_LABELS: Record<RelativeAnchorScope, string> = {
  row: '同一行',
  nearest: '最近',
}
