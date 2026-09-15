import assert from 'node:assert/strict'
import { session, sample, save, artifact } from './browser.mjs'
const s = await session()
const observations = []
let lastProgress = ''
const events = []
s.page.on('request', (r) => { if (r.url().includes('/events')) events.push({ url: new URL(r.url()).pathname, at: new Date().toISOString() }) })
s.page.on('response', async (response) => {
  if (/\/runs\/[^/]+\/observation(?:\?|$)/.test(response.url()) && response.ok()) {
    const value = await response.json().catch(() => null)
    if (value) { observations.push(value); const progress = `${value.run?.status}:${value.run?.stepRuns?.filter((x) => x.status === 'SUCCEEDED').length}`; if (progress !== lastProgress) { lastProgress = progress; console.log('OBSERVATION', progress) } }
  }
})
try {
  await s.page.goto(sample.url)
  await s.page.locator('[data-flow-step]').first().waitFor()
  await s.page.getByRole('button', { name: '试跑', exact: true }).click()
  const created = s.page.waitForResponse((r) => r.url().endsWith(`/scenarios/${sample.scenarioId}/trial`) && r.request().method() === 'POST', { timeout: 30000 })
  await s.page.getByRole('button', { name: '开始试跑', exact: true }).click()
  const response = await created
  const run = await response.json()
  assert.equal(response.status(), 201, JSON.stringify(run))
  await save('trial-created.json', { runId: run.id, at: new Date().toISOString() })
  console.log('TRIAL CREATED', run.id)
  // Wait on the UI's SSE-driven observation updates; no timer-based API polling.
  const already = observations.find((value) => value.run?.id === run.id && ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(value.run.status) && value.run.evidenceStatus !== 'PENDING')
  const terminal = already ?? await s.page.waitForResponse(async (r) => {
    if (!r.url().includes(`/runs/${run.id}/observation`) || !r.ok()) return false
    const value = await r.json().catch(() => null)
    return value?.run && ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(value.run.status) && value.run.evidenceStatus !== 'PENDING'
  }, { timeout: 300000 }).then((r) => r.json()).catch(async () => ({ run: await s.request(`/runs/${run.id}`), recoveryRead: true }))
  const evidence = await s.request(`/runs/${run.id}/evidence`)
  const receipt = await fetch('http://127.0.0.1:4186/lab/inspect').then((r) => r.json())
  if (terminal.run.status === 'SUCCEEDED') await save('sample.json', { ...sample, successfulRunId: run.id })
  await save(`trial-${run.id}.json`, { runId: run.id, terminal, evidence, receipt, events, errors: s.errors })
  await s.page.screenshot({ path: artifact('trial-result.png'), fullPage: true })
  console.log('RESULT', JSON.stringify({ runId: run.id, status: terminal.run.status, evidenceStatus: terminal.run.evidenceStatus, steps: terminal.run.stepRuns.map((x) => ({ type: x.type, name: x.name, status: x.status, attempts: x.attempts.map((a) => ({ status: a.status, output: a.output, error: a.error })) })), evidenceCount: evidence.items.length, events, errors: s.errors }))
} finally { await s.browser.close() }
