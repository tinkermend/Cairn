import { inArray } from 'drizzle-orm'
import { EXPORT_ARTIFACTS_PROTOCOL, SUITE_ADMISSION_PROTOCOL, registrationRequiresOccupancy } from '@cairn/shared'
import type { Db } from '../client.js'
import { schemaFor } from '../native.js'
import { conflict } from '../runs/errors.js'

export async function assertReportDeploymentReady(db: Db, suite = false) {
  const { workers } = schemaFor(db), now = Date.now()
  const rows = await db.select().from(workers).where(inArray(workers.status, ['READY', 'DRAINING']))
  const incompatible = rows.some((row) => {
    const live = row.heartbeatExpiresAt ? row.heartbeatExpiresAt.getTime() > now : row.heartbeatAt.getTime() + (row.lostAfterSeconds ?? 60) * 1000 > now
    if (!live) return false
    const protocols = row.protocolCapabilities
    return protocols.some((protocol) => protocol.startsWith('export-artifacts@')) && !protocols.includes(EXPORT_ARTIFACTS_PROTOCOL)
      || suite && registrationRequiresOccupancy(protocols) && !protocols.includes(SUITE_ADMISSION_PROTOCOL)
  })
  if (incompatible) throw conflict('REPORT_DEPLOYMENT_NOT_READY', '仍有旧版本运行节点，请排空并升级后再创建集合或报告产物')
}
