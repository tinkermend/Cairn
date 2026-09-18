export type RecordingUploadBinding = {
  scenarioName: string
  targetId: string
}

export type RecordingUploadMeta =
  | { ok: true; name: string; targetId: string }
  | { ok: false; error: string }

export function resolveRecordingUploadMeta(input: {
  name: string
  targetId: string
  binding?: RecordingUploadBinding | null
}): RecordingUploadMeta {
  const targetId = input.binding?.targetId.trim() || input.targetId.trim()
  const name = input.name.trim() || input.binding?.scenarioName.trim() || ''
  if (!name) return { ok: false, error: '请填写场景名称' }
  if (!targetId) return { ok: false, error: '请先选择目标系统' }
  return { ok: true, name, targetId }
}
