import type {
  EvidenceCaptureMode,
  PlatformSessionReusePolicy,
} from '@cairn/shared'

export const CAPTURE_MODE_LABELS: Record<EvidenceCaptureMode, string> = {
  off: '关闭',
  on_failure: '失败时',
  always: '始终',
}

export const SESSION_REUSE_LABELS: Record<PlatformSessionReusePolicy, string> =
  {
    NEW_PAGE: '健康会话内换页',
    REUSE_PAGE: '复用当前页',
  }

export const SOURCE_LABELS = {
  bootstrap: '初始化',
  update: '保存',
  restore: '恢复',
} as const

export function inheritCaptureLabel(
  mode: string | undefined,
  fallback: string
) {
  if (mode === 'off' || mode === 'on_failure' || mode === 'always') {
    return `继承平台默认（${CAPTURE_MODE_LABELS[mode]}）`
  }
  return fallback
}
