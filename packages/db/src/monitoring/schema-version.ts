import type { DbHandle } from '../client.js'
import { latestLogicalVersion, latestLogicalVersionForDriver } from '../migrate.js'

export type AppliedSchemaVersion = {
  expectedLogicalVersion: string
  expectedPrefix: string
  appliedPrefix: string | null
  schemaConsistency: 'consistent' | 'mismatch' | 'unknown'
}

export async function readAppliedSchemaPrefix(handle: DbHandle): Promise<string | null> {
  const rows =
    handle.driver === 'mysql'
      ? await handle.raw("SELECT MAX(prefix) AS prefix FROM _migrations WHERE state = 'complete'")
      : await handle.raw('SELECT MAX(prefix) AS prefix FROM _migrations')
  const prefix = rows[0]?.prefix
  return prefix == null || prefix === '' ? null : String(prefix)
}

export async function readSchemaVersion(handle: DbHandle): Promise<AppliedSchemaVersion> {
  const expectedLogicalVersion = latestLogicalVersion()
  const expectedPrefix = latestLogicalVersionForDriver(handle.driver)
  const appliedPrefix = await readAppliedSchemaPrefix(handle)
  return {
    expectedLogicalVersion,
    expectedPrefix,
    appliedPrefix,
    schemaConsistency:
      appliedPrefix == null
        ? 'unknown'
        : appliedPrefix === expectedPrefix
          ? 'consistent'
          : 'mismatch',
  }
}
