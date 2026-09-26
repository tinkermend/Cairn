import { eq } from 'drizzle-orm'
import {
  parseTargetResolutionPolicy,
  runNeedsAiExecute,
  type PlatformConfigDocument,
  type ResolutionPolicy,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { schemaFor } from '../native.js'
import { getOrCreatePlatformConfig } from '../platform-config/store.js'

export async function loadResolutionLayers(db: Db, targetId?: string) {
  const platform = await getOrCreatePlatformConfig(db)
  let targetCeiling: ResolutionPolicy | undefined
  let targetPreference: ResolutionPolicy | undefined
  let targetPolicy: ReturnType<typeof parseTargetResolutionPolicy> = null
  if (targetId) {
    const { targets } = schemaFor(db)
    const [row] = await db
      .select({ resolutionPolicy: targets.resolutionPolicy })
      .from(targets)
      .where(eq(targets.id, targetId))
      .limit(1)
    const policy = parseTargetResolutionPolicy(row?.resolutionPolicy)
    targetPolicy = policy
    targetCeiling = policy?.ceiling
    targetPreference = policy?.preference
  }
  return {
    document: platform.document,
    revision: platform.revision,
    targetCeiling,
    targetPreference,
    targetPolicy,
  }
}

export function stepsNeedAiExecute(
  steps: readonly { id?: string; type: string; policy?: { resolution?: ResolutionPolicy } }[],
  layers: {
    document: PlatformConfigDocument
    targetCeiling?: ResolutionPolicy
    targetPreference?: ResolutionPolicy
  },
  documentResolution?: ResolutionPolicy,
): boolean {
  return runNeedsAiExecute({
    steps,
    document: layers.document,
    documentResolution,
    targetCeiling: layers.targetCeiling,
    targetPreference: layers.targetPreference,
  })
}
