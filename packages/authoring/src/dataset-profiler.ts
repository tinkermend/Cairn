import {
  type DatasetProfile,
  type DatasetColumnProfile,
  type ScenarioInputType,
} from '@cairn/shared'

export interface ComputeDatasetProfileOptions {
  datasetId: string
  rows: Record<string, unknown>[]
  columns?: string[]
  maxSampleRows?: number
}

/**
 * Deterministically computes column statistics, null rates, length distributions,
 * and detects data anomalies without LLM hallucinations.
 */
export function computeDatasetProfile(options: ComputeDatasetProfileOptions): DatasetProfile {
  const { datasetId, rows, maxSampleRows = 5000 } = options
  const totalRows = rows.length
  const isSampled = totalRows > maxSampleRows
  const analyzedRows = isSampled ? rows.slice(0, maxSampleRows) : rows
  const analyzedCount = analyzedRows.length

  // Discover all column names if not provided
  let columnNames = options.columns
  if (!columnNames || columnNames.length === 0) {
    const colSet = new Set<string>()
    for (const row of analyzedRows) {
      if (row && typeof row === 'object') {
        for (const k of Object.keys(row)) {
          colSet.add(k)
        }
      }
    }
    columnNames = Array.from(colSet).sort()
  }

  const columnProfiles: DatasetColumnProfile[] = []

  for (const colName of columnNames) {
    let nullCount = 0
    let minLength: number | undefined
    let maxLength: number | undefined
    const distinctValues = new Set<string>()
    const anomalies: string[] = []

    let numberTypeCount = 0
    let booleanTypeCount = 0
    let stringTypeCount = 0
    let whitespaceIssueCount = 0

    for (let rIndex = 0; rIndex < analyzedCount; rIndex++) {
      const val = analyzedRows[rIndex]?.[colName]

      if (val === null || val === undefined || val === '') {
        nullCount++
        continue
      }

      const strVal = String(val)
      distinctValues.add(strVal)

      const len = strVal.length
      minLength = minLength === undefined ? len : Math.min(minLength, len)
      maxLength = maxLength === undefined ? len : Math.max(maxLength, len)

      // Type inspection
      if (typeof val === 'number') {
        numberTypeCount++
      } else if (typeof val === 'boolean') {
        booleanTypeCount++
      } else {
        stringTypeCount++
        // Check if string could be parsed as number
        if (!isNaN(Number(strVal)) && strVal.trim() !== '') {
          // Check for preserved leading zero
          if (strVal.length > 1 && strVal.startsWith('0') && !strVal.startsWith('0.')) {
            if (!anomalies.includes('检测到带前导零的长编号，已保护原始字符串语义')) {
              anomalies.push('检测到带前导零的长编号，已保护原始字符串语义')
            }
          }
        }
        if (strVal !== strVal.trim()) {
          whitespaceIssueCount++
        }
      }
    }

    if (whitespaceIssueCount > 0) {
      anomalies.push(`发现 ${whitespaceIssueCount} 行存在首尾空格`)
    }

    // Determine inferred type
    let inferredType: ScenarioInputType = 'string'
    const nonNullCount = analyzedCount - nullCount
    if (nonNullCount > 0) {
      if (numberTypeCount === nonNullCount) {
        inferredType = 'number'
      } else if (booleanTypeCount === nonNullCount) {
        inferredType = 'boolean'
      } else if (numberTypeCount > 0 && stringTypeCount > 0) {
        anomalies.push('存在数字与字符串混合数据类型')
      }
    }

    const nullRate = analyzedCount > 0 ? Number((nullCount / analyzedCount).toFixed(4)) : 0

    columnProfiles.push({
      name: colName,
      inferredType,
      nullCount,
      nullRate,
      distinctCount: distinctValues.size,
      minLength,
      maxLength,
      sampleAnomalies: anomalies.slice(0, 5),
    })
  }

  return {
    datasetId,
    totalRows,
    analyzedRows: analyzedCount,
    isSampled,
    columns: columnProfiles,
    algorithmVersion: 'dataset-profiler@1.0',
    createdAt: new Date().toISOString(),
  }
}
