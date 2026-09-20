import type { ServiceScope } from '@cairn/shared'

export const SCOPE_LABELS: Record<ServiceScope, string> = {
  'run:execute': '执行已发布场景',
  'run:read': '查看本应用的运行',
  'run:cancel': '取消本应用的运行',
  'evidence:read': '读取已发布证据',
  'ai:execute': '执行 AI 步骤',
}
