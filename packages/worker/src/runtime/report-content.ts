import type { JsonValue, ReportDocument } from '@cairn/shared'

export type ReportLine = { text: string; level: 'title' | 'heading' | 'body' }
const labels: Record<string, string> = {
  QUEUED: '排队中', RUNNING: '执行中', SUCCEEDED: '执行成功', FAILED: '执行失败', CANCELLED: '已取消',
  NEEDS_REVIEW: '待核查', WAITING_FOR_AUTH: '等待认证', HOLDING: '已暂停', RECOVERING: '恢复中',
  COMPLETED: '已完成', WAITING: '等待中', PASS: '通过', FAIL: '异常', WARN: '提示', UNKNOWN: '未知', NOT_EVALUATED: '未评估',
  PENDING: '待处理', ACTIVE: '执行中', SETTLED: '已结束', SKIPPED: '已跳过', COMPLETE: '完整', INCOMPLETE: '不完整',
  disabled: '已停用', fallback_not_selected: '未采用的备选', fallback_abandoned: '备选已放弃',
  run_halted: '前序失败未执行', condition_not_met: '条件不满足', optional_absent: '未出现', loop_empty: '循环未执行任何项',
  all_pass: '全部通过', pass_with_warnings: '通过但有提示', anomalies_found: '发现异常', incomplete: '结论不完整',
  failure_policy_stop: '按失败策略停止', suite_cancelled: '集合已取消', deadline_elapsed: '超过运行期限',
  available: '可用', missing: '缺失', screenshot: '截图',
  NORMAL: '正常', WARNING: '警告', ANOMALOUS: '异常',
  EXCELLENT: '优', GOOD: '良', FAIR: '中', POOR: '差',
  INFO: '信息', HIGH: '高危', FATAL: '严重',
}
const text = (value: JsonValue | undefined): string => value == null ? '未记录' : labels[String(value)] ?? String(value)
const record = (value: JsonValue | undefined): Record<string, JsonValue> => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const records = (value: JsonValue | undefined) => Array.isArray(value) ? value.map(record) : []

/** Both renderers consume this ordered, human-readable view of the sealed document. */
export function reportLines(document: ReportDocument): ReportLine[] {
  const lines: ReportLine[] = []
  let textSize = 0
  const add = (value: string, level: ReportLine['level'] = 'body') => {
    textSize += value.length
    if (lines.length >= 20_000 || textSize > 4 * 1024 * 1024) throw new Error('报告内容超过渲染上限')
    lines.push({ text: value, level })
  }
  const date = (value: JsonValue | undefined) => {
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return text(value)
    return new Intl.DateTimeFormat('zh-CN', { timeZone: document.timeZone, dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(value))
  }
  add(document.title, 'title')
  if (document.subtitle) add(document.subtitle)
  add(`报告类型：${document.stage === 'phase' ? '阶段报告' : '终稿'}`)
  if (document.organization) add(`组织：${document.organization}`)
  if (document.authorDisplayName) add(`作者：${document.authorDisplayName}`)
  add(`数据截至：${date(document.asOf)}（${document.timeZone}）`)
  add(`生成时间：${date(document.generatedAt)}`)
  if (document.identity) add(`报告编号：${document.identity.reportId}；修订 ${document.identity.revisionNo}（${document.identity.revisionId}）`)
  const source = document.source
  add('运行概况', 'heading')
  add(`目标系统：${text(source.targetName)}`)
  add(`${source.kind === 'SUITE_RUN' ? '场景集' : '场景'}：${text(source.suiteName ?? source.scenarioName)}`)
  add(`执行状态：${text(source.status)}；业务结论：${text(source.verdict ?? source.outcomeStatus)}；证据：${text(source.evidenceStatus)}`)
  add(`开始：${date(source.startedAt ?? source.createdAt)}；结束：${date(source.finishedAt)}`)
  add(`运行编号：${text(source.suiteRunId ?? source.runId)}`)
  const renderSteps = (run: Record<string, JsonValue>, details: boolean, includeSuccess: boolean) => {
    if (run.targetAccountName) add(`执行账号：${text(run.targetAccountName)}（生成时显示名称）`)
    for (const step of records(run.stepRuns)) {
      const attempts = records(step.attempts)
      const hasUnsuccessfulAttempt = attempts.some((attempt) => attempt.status !== 'SUCCEEDED' || record(attempt.error).message)
      if ((!details || !includeSuccess) && step.status === 'SUCCEEDED' && step.outcomeStatus === 'PASS' && !hasUnsuccessfulAttempt) continue
      const statusText = step.status === 'SKIPPED'
        ? `跳过（${step.skipReason ? text(step.skipReason) : '已跳过'}）`
        : text(step.status)
      add(`${text(step.name)}：${statusText}；业务结果：${text(step.outcomeStatus)}`)
      const loop = records(run.loops).find((item) => item.headerStepRunId === step.id)
      if (loop) {
        const flags = [loop.stoppedEarly ? '提前结束' : '', loop.limitReached ? '达到上限' : ''].filter(Boolean).join('、')
        add(`${loop.kind === 'repeat' ? '重复执行' : '逐项处理'} ${text(loop.total)} 项：成功 ${text(loop.succeeded)}；失败 ${text(loop.failed)}；未执行 ${text(loop.skipped)}${flags ? `（${flags}）` : ''}`)
        for (const failure of records(loop.failures)) {
          add(`第 ${text(failure.index)} 项${failure.item ? `（${text(failure.item)}）` : ''}：${failure.stepName ? `步骤「${text(failure.stepName)}」` : ''}失败${failure.code ? `，${text(failure.code)} / ${text(failure.message)}` : ''}`)
        }
      }
      for (const attempt of attempts) {
        const error = record(attempt.error)
        if (error.message) add(`尝试 ${text(attempt.id)}：${text(error.code)} / ${text(error.message)}`)
        else if ((details && includeSuccess && includeAttemptHistory) || attempt.status !== 'SUCCEEDED') add(`尝试 ${text(attempt.id)}：${text(attempt.status)}`)
      }
      for (const result of records(run.outcomeResults).filter((item) => item.stepRunId === step.id)) add(`断言：${text(result.meaning)}；结论：${text(result.verdict)}；尝试：${text(result.attemptId)}${result.evidenceId ? `；证据：${text(result.evidenceId)}` : ''}`)
    }
    const evidence = records(run.evidence)
    if (details && includeEvidenceIndex && evidence.length) {
      add('证据索引', 'heading')
      for (const item of evidence) add(`${text(item.type)} · ${text(item.status)} · 编号 ${text(item.evidenceId)}${item.missingReason ? `；缺项：${text(item.missingReason)}` : ''}`)
    }
  }
  const resultBlock = document.sections.flatMap((section) => section.blocks).find((block) => block.type === 'result')
  const detailed = resultBlock?.detailLevel !== 'summary'
  const includeSuccess = resultBlock?.includeSuccessDetails !== false
  const includeEvidenceIndex = resultBlock?.includeEvidenceIndex !== false
  const includeAttemptHistory = resultBlock?.includeAttemptHistory !== false
  if (source.kind === 'SUITE_RUN') {
    const suiteSummary = document.sections
      .flatMap((section) => section.blocks)
      .find((block) => block.type === 'suite_business_summary') as Record<string, JsonValue> | undefined

    if (suiteSummary) {
      add('【决策与执行总览】', 'heading')
      const grade = text(suiteSummary.healthGrade)
      add(`系统整体健康度：${suiteSummary.healthScore}分（${grade}） · 覆盖模块：${suiteSummary.totalCount} · 正常：${suiteSummary.normalCount} · 警告：${suiteSummary.warningCount} · 异常：${suiteSummary.anomalousCount} · 跳过：${suiteSummary.skippedCount}`)
      const wallSec = (Number(suiteSummary.wallClockMs ?? 0) / 1000).toFixed(1)
      const childSec = (Number(suiteSummary.childDurationMs ?? 0) / 1000).toFixed(1)
      const saved = Number(suiteSummary.savedPercent ?? 0)
      add(`真实总耗时：${wallSec} 秒（累计执行耗时：${childSec} 秒${saved > 0 ? `，并发节约耗时 ${saved}%` : ''}）`)

      const gridRows = records(suiteSummary.gridRows)
      if (gridRows.length) {
        add('【核心业务巡检对照总表】', 'heading')
        for (const row of gridRows) {
          const ord = Number(row.ordinal ?? 0) + 1
          add(`${ord}. [${text(row.status)}] ${text(row.displayName)} (${text(row.scenarioName)})`, 'heading')
          if (row.summary) add(`• 结论摘要：${text(row.summary)}`)
          const metrics = record(row.metrics)
          const mKeys = Object.keys(metrics)
          if (mKeys.length) {
            add(`• 核心业务指标：${mKeys.map((k) => `${k}: ${metrics[k]}`).join('；')}`)
          }
          const dataRow = record(row.dataRow)
          const dKeys = Object.keys(dataRow)
          if (dKeys.length) {
            add(`• 业务数据：${dKeys.map((k) => `${k}: ${typeof dataRow[k] === 'object' ? JSON.stringify(dataRow[k]) : String(dataRow[k])}`).join('；')}`)
          }
        }
      }

      const findings = records(suiteSummary.aggregatedFindings)
      if (findings.length) {
        add('【异常归因与证据穿透】', 'heading')
        for (const finding of findings) {
          add(`[${text(finding.displayName)}] ${text(finding.title)}（严重级别：${text(finding.severity)}）`, 'heading')
          if (finding.detail) add(`• 异常归因：${text(finding.detail)}`)
          if (finding.evidenceId) add(`• 现场证据编号：${text(finding.evidenceId)}`)
        }
      }

      add('【技术明细与执行追溯】', 'heading')
    } else {
      add('成员结果汇总', 'heading')
    }

    const counts = record(source.counts)
    add(`计划 ${text(counts.planned)}；执行成功 ${text(counts.succeeded)}；执行失败 ${text(counts.failed)}；取消 ${text(counts.cancelled)}；跳过 ${text(counts.skipped)}`)
    if ('wallClockMs' in source) add(`集合整次耗时：${source.wallClockMs === null ? '尚未结算' : `${Number(source.wallClockMs) / 1000} 秒`}；子运行耗时合计：${source.childDurationMs === null ? '尚未结算' : `${Number(source.childDurationMs) / 1000} 秒`}`)
    if (source.suiteVersionId) add(`场景集版本：${text(source.suiteVersionId)}`)
    const members = records(source.items), groups = records(source.groups)
    const groupKeys = [...new Set([...groups.map((group) => String(group.id)), ...members.map((member) => String(member.groupId ?? ''))])]
    for (const key of groupKeys) {
      const entries = members.filter((member) => String(member.groupId ?? '') === key)
      if (!entries.length) continue
      if (groups.length || key) add(`分组：${key ? text(groups.find((group) => group.id === key)?.name ?? key) : '未分组'}`, 'heading')
      for (const member of entries) {
        add(`${Number(member.ordinal ?? 0) + 1}. ${text(member.displayName)} [${text(member.memberId)}]`, 'heading')
        add(`成员状态：${text(member.admission)}；执行：${text(member.runStatus)}；业务结果：${text(member.outcomeStatus)}`)
        add(`子运行：${text(member.childRunId)}；场景版本：${text(member.scenarioVersionId)}`)
        if (member.skipReason) add(`跳过原因：${text(member.skipReason)}`)
        renderSteps(record(member.run), detailed, includeSuccess)
      }
    }
  } else {
    add('场景执行结果', 'heading')
    add(`场景版本：${text(source.scenarioVersionId)}`)
    renderSteps(source, detailed, includeSuccess)
  }
  if (document.gaps.length) {
    add('缺项说明', 'heading')
    for (const gap of document.gaps) add(gap)
  }
  return lines
}
