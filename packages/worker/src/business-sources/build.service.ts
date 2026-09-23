import { Inject, Injectable, Logger } from '@nestjs/common'
import {
  claimBusinessSourceBuildJob,
  commitBusinessSourceBatch,
  finishBusinessSourceBuild,
  getDatasetRows,
  type DbHandle,
} from '@cairn/db'
import type { ValidationSummary } from '@cairn/shared'
import { DB_HANDLE } from '../db/db.module'
import { config } from '../config/env'
import { CHANGE_HINT } from '../observe/change-hint.module'
import type { ChangeHintBus } from '@cairn/db'

const SENSITIVE_COLUMN_PATTERN = /password|secret|token|otp|\bpin\b|密码|口令|验证码|私钥|bank_account|credit_card/i

@Injectable()
export class BusinessSourceBuildService {
  private readonly logger = new Logger(BusinessSourceBuildService.name)
  private running = false

  constructor(
    @Inject(DB_HANDLE) private readonly handle: DbHandle,
    @Inject(CHANGE_HINT) private readonly bus: ChangeHintBus,
  ) {}

  async tick(limit = 2): Promise<{ processed: number }> {
    if (this.running) return { processed: 0 }
    this.running = true
    let processed = 0
    try {
      for (let i = 0; i < limit; i++) {
        const candidate = await claimBusinessSourceBuildJob(this.handle, config.CAIRN_WORKER_ID, 30_000)
        if (!candidate) break

        await this.processCandidate(candidate)
        processed++
      }
      return { processed }
    } catch (err) {
      this.logger.error(err instanceof Error ? err.message : err, '业务数据源候选构建异常')
      return { processed }
    } finally {
      this.running = false
    }
  }

  async processCandidate(candidate: {
    id: string
    targetId: string
    entityType: string
    datasetId: string
    mappingConfig: {
      keyColumn: string
      displayNameColumn: string
      statusColumn?: string
      fieldWhitelist: string[]
      sensitiveFields?: string[]
    }
  }): Promise<void> {
    const { mappingConfig } = candidate
    const sensitiveSet = new Set((mappingConfig.sensitiveFields ?? []).map((s) => s.toLowerCase().trim()))

    // 1. Verify whitelist
    for (const col of mappingConfig.fieldWhitelist) {
      const lower = col.toLowerCase().trim()
      if (sensitiveSet.has(lower) || SENSITIVE_COLUMN_PATTERN.test(lower)) {
        await finishBusinessSourceBuild(this.handle, candidate.id, {
          status: 'rejected',
          summary: {
            totalRows: 0,
            validCount: 0,
            rejectedCount: 0,
            issues: [{ rowIndex: 0, reason: `白名单列 "${col}" 属于敏感阻断字段` }],
          },
        })
        return
      }
    }

    // 2. Scan and validate rows
    let cursor: string | undefined
    let totalRows = 0
    let validCount = 0
    let rejectedCount = 0
    const seenKeys = new Set<string>()
    const issues: Array<{ rowIndex: number; recordKey?: string; reason: string }> = []
    let isRejected = false

    const batchRecordsToInsert: Array<{
      targetId: string
      entityType: string
      recordKey: string
      displayName: string
      recordStatus?: string
      originalDatasetId: string
      datasetRowId: string
      datasetRowIndex: number
      payload: Record<string, unknown>
    }> = []

    const MAX_ROWS = 10_000

    while (totalRows < MAX_ROWS) {
      const page = await getDatasetRows(this.handle, candidate.datasetId, { limit: 200, cursor })
      if (page.items.length === 0) break

      for (const row of page.items) {
        totalRows++
        const rawData = (row.rowData ?? {}) as Record<string, unknown>
        const rawKey = rawData[mappingConfig.keyColumn]
        const recordKey = rawKey != null ? String(rawKey).trim() : ''
        const rawName = rawData[mappingConfig.displayNameColumn]
        const displayName = rawName != null ? String(rawName).trim() : ''
        const recordStatus = mappingConfig.statusColumn ? String(rawData[mappingConfig.statusColumn] ?? '').trim() : undefined

        let rowValid = true
        let rowReason = ''

        if (!recordKey) {
          rowValid = false
          rowReason = `业务主键列 "${mappingConfig.keyColumn}" 在第 ${row.rowIndex + 1} 行为空`
        } else if (seenKeys.has(recordKey)) {
          rowValid = false
          rowReason = `业务主键 "${recordKey}" 出现重复`
        } else {
          seenKeys.add(recordKey)
        }

        if (rowValid && !displayName) {
          rowValid = false
          rowReason = `显示名称列 "${mappingConfig.displayNameColumn}" 在第 ${row.rowIndex + 1} 行为空`
        }

        if (!rowValid) {
          rejectedCount++
          isRejected = true
          if (issues.length < 5) {
            issues.push({
              rowIndex: row.rowIndex,
              recordKey: recordKey || undefined,
              reason: rowReason,
            })
          }
        } else {
          validCount++
          const payload: Record<string, unknown> = {}
          for (const col of mappingConfig.fieldWhitelist) {
            payload[col] = rawData[col]
          }
          batchRecordsToInsert.push({
            targetId: candidate.targetId,
            entityType: candidate.entityType,
            recordKey,
            displayName,
            recordStatus,
            originalDatasetId: candidate.datasetId,
            datasetRowId: row.id,
            datasetRowIndex: row.rowIndex,
            payload,
          })
        }
      }

      if (batchRecordsToInsert.length >= 200 && !isRejected) {
        await commitBusinessSourceBatch(this.handle, candidate.id, [...batchRecordsToInsert])
        batchRecordsToInsert.length = 0
      }

      if (!page.nextCursor) break
      cursor = page.nextCursor
    }

    if (batchRecordsToInsert.length > 0 && !isRejected) {
      await commitBusinessSourceBatch(this.handle, candidate.id, [...batchRecordsToInsert])
      batchRecordsToInsert.length = 0
    }

    const summary: ValidationSummary = {
      totalRows,
      validCount,
      rejectedCount,
      issues,
    }

    const finalStatus = isRejected ? 'rejected' : 'ready'
    await finishBusinessSourceBuild(this.handle, candidate.id, {
      status: finalStatus,
      summary,
    })

    try {
      await this.bus.publish({
        type: 'target_business_source',
        targetId: candidate.targetId,
        candidateId: candidate.id,
        status: finalStatus,
      } as any)
    } catch {
      // Best effort notification
    }
  }
}
