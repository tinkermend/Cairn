import { z } from 'zod'

export const SUITE_VERDICTS = ['all_pass', 'pass_with_warnings', 'anomalies_found', 'incomplete'] as const
export type SuiteVerdict = (typeof SUITE_VERDICTS)[number]
export const suiteVerdictSchema = z.enum(SUITE_VERDICTS)

export const SUITE_VERDICT_LABELS: Record<SuiteVerdict, string> = {
  all_pass: '全部通过',
  pass_with_warnings: '通过但有提示',
  anomalies_found: '发现异常',
  incomplete: '无法完整判断',
}
