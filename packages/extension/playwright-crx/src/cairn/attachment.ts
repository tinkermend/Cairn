import type { CairnAttachStatus } from './messages'

export type AttachmentLine = {
  head: string
  detail: string | null
}

const MAX_TITLE = 32
const MAX_LOCATION = 48

function shortTitle(title: string): string {
  const text = title.trim()
  return text.length > MAX_TITLE ? `${text.slice(0, MAX_TITLE)}…` : text
}

/** 去掉协议，够用户认出是哪一页就行，不要撑爆 380px 侧栏。 */
export function shortLocation(url: string): string {
  const withoutProtocol = url.trim().replace(/^https?:\/\//i, '')
  return withoutProtocol.length > MAX_LOCATION
    ? `${withoutProtocol.slice(0, MAX_LOCATION)}…`
    : withoutProtocol
}

/** 面板必须写清在录哪一页：用户切了标签页就不该再靠猜。 */
export function describeAttachment(
  status: CairnAttachStatus | null,
  options: { recording: boolean; stepCount: number; unresolvedCount: number },
): AttachmentLine {
  const { recording, stepCount, unresolvedCount } = options
  const page = status?.attached ? shortTitle(status.title) || shortLocation(status.url) : ''
  const location = status?.attached ? shortLocation(status.url) : ''
  const counted = recording
    ? `已记录 ${stepCount} 步`
    : stepCount
      ? `${stepCount} 步可导入${unresolvedCount ? `，${unresolvedCount} 项待处理` : ''}`
      : ''

  if (recording) {
    return {
      head: page ? `正在录制：${page}` : '正在录制当前标签页',
      detail: [location, counted].filter(Boolean).join(' · ') || null,
    }
  }
  if (!status?.attached) {
    return {
      head: '未挂接，点「开始录制」会挂到当前标签页',
      detail: counted || null,
    }
  }
  return {
    head: `已挂接：${page}`,
    detail: [location, counted].filter(Boolean).join(' · ') || null,
  }
}
