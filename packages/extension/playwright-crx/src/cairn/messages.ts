import type { Mode } from '@recorder/recorderTypes'

export const CAIRN_ATTACH = 'cairnAttach'
export const CAIRN_DETACH = 'cairnDetach'
export const CAIRN_STATUS = 'cairnStatus'
export const CAIRN_OPEN_TARGET = 'cairnOpenTarget'

export type CairnAttachStatus = {
  attached: boolean
  title: string
  url: string
}

export type CairnAttachMode = Extract<Mode, 'recording' | 'inspecting' | 'recording-inspecting' | 'standby'>

export function requestAttach(mode: CairnAttachMode): Promise<{ ok: boolean; error?: string }> {
  return chrome.runtime.sendMessage({ event: CAIRN_ATTACH, mode })
}

export function requestDetach(): Promise<{ ok: boolean; error?: string }> {
  return chrome.runtime.sendMessage({ event: CAIRN_DETACH })
}

/** 按需查询，只在挂载、模式变化、步骤变化时问一次，不做定时轮询。 */
export function requestStatus(): Promise<CairnAttachStatus> {
  return chrome.runtime.sendMessage({ event: CAIRN_STATUS })
}
