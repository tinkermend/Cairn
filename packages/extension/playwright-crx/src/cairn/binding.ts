import {
  recordingAllowedOrigins,
  recordingBridgeStartSchema,
  urlAllowedForRecording,
  type RecordingBindingDto,
  type RecordingBridgeStart,
} from '@cairn/shared'
import { CairnApiError, claimRecordingBinding, fetchOpenRecordingBinding } from './api'
import { loadCairnSession } from './session'

const PENDING_KEY = 'cairnPendingBinding'

export async function savePendingBridge(message: RecordingBridgeStart): Promise<void> {
  await chrome.storage.session.set({ [PENDING_KEY]: message })
}

export async function loadPendingBridge(): Promise<RecordingBridgeStart | null> {
  const stored = await chrome.storage.session.get(PENDING_KEY)
  const parsed = recordingBridgeStartSchema.safeParse(stored[PENDING_KEY])
  return parsed.success ? parsed.data : null
}

export async function clearPendingBridge(): Promise<void> {
  await chrome.storage.session.remove(PENDING_KEY)
}

export async function resolveStudioBinding(): Promise<RecordingBindingDto | null> {
  const session = await loadCairnSession()
  if (!session.accessToken) return null
  const pending = await loadPendingBridge()
  if (pending) {
    try {
      const claimed = await claimRecordingBinding({
        ticket: pending.ticket,
        bindingId: pending.bindingId,
        apiOrigin: session.apiOrigin,
      })
      await clearPendingBridge()
      return claimed
    } catch (error) {
      await clearPendingBridge()
      if (!(error instanceof CairnApiError) || error.code !== 'RECORDING_BINDING_CLAIMED') {
        throw error
      }
    }
  }
  const open = await fetchOpenRecordingBinding()
  if (!open || open.status === 'closed') return null
  if (open.status === 'issued') {
    return claimRecordingBinding({ bindingId: open.id, apiOrigin: session.apiOrigin })
  }
  return open
}

export function bindingTargetUrl(binding: RecordingBindingDto): string | undefined {
  const allowed = recordingAllowedOrigins(binding.entryUrl, binding.loginUrl)
  const preferred = binding.loginUrl || binding.entryUrl
  return urlAllowedForRecording(preferred, allowed) ? preferred : undefined
}
