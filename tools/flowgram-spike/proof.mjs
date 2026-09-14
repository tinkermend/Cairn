import assert from 'node:assert/strict'
import { mkdir, writeFile, copyFile } from 'node:fs/promises'
import { session, sample, artifact, save } from './browser.mjs'
const s = await session()
try {
  const run = await s.request(`/runs/${sample.successfulRunId}`)
  const evidence = await s.request(`/runs/${run.id}/evidence`)
  const receipt = await fetch('http://127.0.0.1:4186/lab/inspect').then((response) => response.json())
  assert.equal(run.status, 'SUCCEEDED')
  assert.equal(run.evidenceStatus, 'COMPLETE')
  assert.equal(run.stepRuns.length, 10)
  assert.ok(run.stepRuns.every((step) => step.status === 'SUCCEEDED' && step.attempts.length === 1))
  assert.ok(evidence.items.every((item) => item.status === 'available'))
  for (const step of run.stepRuns) {
    for (const type of ['input', 'output']) assert.ok(evidence.items.some((item) => item.attemptId === step.attempts[0].id && item.stepRunId === step.id && item.type === type))
  }
  const logs = evidence.items.filter((item) => item.payload?.kind === 'ai_call')
  assert.ok(logs.length > 0)
  assert.ok(logs.every((item) => item.payload.model === run.snapshot.aiExecution.modelName))
  const records = receipt.records.filter((item) => item.data?.sample === 'flowgram-sequence-spike' && Date.parse(item.timestamp) >= Date.parse(run.startedAt) && Date.parse(item.timestamp) <= Date.parse(run.finishedAt))
  assert.equal(records.length, 1)
  const record = records[0]
  assert.deepEqual(record.data, { sample: 'flowgram-sequence-spike', orderNo: 'FG-2026-0108', amount: '1280.00', customer: '华东设备有限公司' })
  const summary = { runId: run.id, scenarioId: sample.scenarioId, status: run.status, evidenceStatus: run.evidenceStatus, elapsedMs: Date.parse(run.finishedAt) - Date.parse(run.startedAt), startedAt: run.startedAt, finishedAt: run.finishedAt, evidenceCount: evidence.items.length, model: run.snapshot.aiExecution.modelName, aiCallCount: logs.length, inputTokens: logs.reduce((sum, item) => sum + (item.payload.inputTokens ?? 0), 0), outputTokens: logs.reduce((sum, item) => sum + (item.payload.outputTokens ?? 0), 0), cost: null, steps: run.stepRuns.map((step) => ({ id: step.stepId, name: step.name, type: step.type, status: step.status, output: step.attempts[0].output })), receipt: { id: record.id, timestamp: record.timestamp, data: record.data } }
  await save('verified-proof.json', summary)
  const dir = new URL('../../docs/reviews/assets/2026-09-14-flowgram/', import.meta.url)
  await mkdir(dir, { recursive: true })
  await writeFile(new URL('evidence-summary.json', dir), JSON.stringify(summary, null, 2))
  await s.page.goto(`${sample.url}&runId=${run.id}`)
  await s.page.locator('[data-flow-step]').first().waitFor()
  await s.page.getByRole('button', { name: '步骤列表', exact: true }).click()
  await s.page.getByRole('button', { name: /AI 提取订单号与应付金额/ }).first().click()
  await s.page.getByRole('button', { name: '流程画布', exact: true }).click()
  await s.page.locator('[data-flow-step]').first().waitFor()
  await s.page.waitForTimeout(800)
  await s.page.screenshot({ path: artifact('final-desktop.png'), fullPage: true })
  await copyFile(artifact('final-desktop.png'), new URL('desktop.png', dir))
  await s.page.setViewportSize({ width: 390, height: 1000 })
  await s.page.goto(`${sample.url}&runId=${run.id}`)
  await s.page.locator('[data-flow-step]').first().waitFor()
  await s.page.waitForTimeout(300)
  assert.ok(await s.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await s.page.screenshot({ path: artifact('final-mobile.png'), fullPage: true })
  await copyFile(artifact('final-mobile.png'), new URL('mobile.png', dir))
  assert.deepEqual(s.errors, [])
  console.log(JSON.stringify({ ...summary, steps: undefined, receipt: summary.receipt }))
} finally { await s.browser.close() }
