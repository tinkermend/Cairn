export type ScanBatchResult = {
  settled: number
  scanned: number
}

export function scanBatchFull(result: Pick<ScanBatchResult, 'scanned'>, limit: number): boolean {
  return result.scanned >= limit
}
