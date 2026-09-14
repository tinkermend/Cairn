import {
  recordingBridgeAckSchema,
  recordingBridgeStartSchema,
  type RecordingBindingCreated,
  type RecordingBridgeAck,
} from '@cairn/shared'

type ChromeRuntime = {
  sendMessage: (
    extensionId: string,
    message: unknown,
    callback?: (response: unknown) => void,
  ) => void
  lastError?: { message?: string }
}

function chromeRuntime(): ChromeRuntime | undefined {
  const chrome = (globalThis as { chrome?: { runtime?: ChromeRuntime } }).chrome
  return chrome?.runtime
}

export function configuredExtensionId(): string {
  return String(import.meta.env.VITE_CAIRN_EXTENSION_ID ?? '').trim()
}

export async function notifyExtensionStart(created: RecordingBindingCreated): Promise<RecordingBridgeAck | null> {
  const extensionId = configuredExtensionId()
  const runtime = chromeRuntime()
  if (!extensionId || !runtime) return null
  const message = recordingBridgeStartSchema.parse({
    version: 1,
    type: 'cairn.recording.start',
    bindingId: created.binding.id,
    ticket: created.ticket,
  })
  return new Promise((resolve) => {
    try {
      runtime.sendMessage(extensionId, message, (response) => {
        if (runtime.lastError) {
          resolve(null)
          return
        }
        const parsed = recordingBridgeAckSchema.safeParse(response)
        resolve(parsed.success ? parsed.data : null)
      })
    } catch {
      resolve(null)
    }
  })
}
