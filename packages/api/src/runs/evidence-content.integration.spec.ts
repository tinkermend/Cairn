import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NotFoundException } from '@nestjs/common'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  commitStoredObject,
  consoleAccounts,
  listRunEvidence,
  newId,
  openIsolatedDb,
  recordMissingObjectEvidence,
  recordObjectEvidence,
  reserveStoredObject,
  type DbHandle,
} from '@cairn/db'
import { OBJECT_MISSING_REASONS, type Step } from '@cairn/shared'
import { LocalObjectStore } from '@cairn/storage'
import type { RequestAccount } from '../common/request-account'
import { ScenariosService } from '../scenarios/scenarios.service'
import { TargetsService } from '../targets/targets.service'
import { credentialKeyFromEnv, LocalSecretProvider } from '../secrets/local-secret-provider'
import { DEV_CREDENTIAL_KEY } from '@cairn/shared'
import { RunsService } from './runs.service'

const SCHEMA = `cairn_test_${Date.now().toString(36)}_evc`

const echoStep: Step = {
  id: '00000000-0000-4000-8000-0000000000c1',
  name: '回显',
  type: 'echo',
  effectType: 'READ_ONLY',
  input: { value: 'hello' },
}

describe('证据正文下载（集成）', { timeout: 30_000 }, () => {
  let handle: DbHandle
  let dir: string
  let store: LocalObjectStore
  let runs: RunsService
  let actor: RequestAccount
  let runId: string
  let otherRunId: string

  beforeAll(async () => {
    handle = await openIsolatedDb(SCHEMA)
    dir = await mkdtemp(join(tmpdir(), 'cairn-api-obj-'))
    store = new LocalObjectStore(dir, 1024)
    const actorId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'evc-tester',
      email: `evc-${actorId}@example.com`,
      status: 'active',
    })
    actor = {
      id: actorId,
      displayName: 'evc-tester',
      email: `evc-${actorId}@example.com`,
      status: 'active',
      roles: [],
      permissions: ['target:write', 'workflow:write', 'run:execute', 'run:read'],
    }
    const targets = new TargetsService(handle, new LocalSecretProvider(credentialKeyFromEnv(DEV_CREDENTIAL_KEY)))
    const scenarios = new ScenariosService(handle)
    runs = new RunsService(handle, store)
    const target = await targets.createTarget(
      {
        code: `evc${SCHEMA.replace(/[^a-z0-9]/g, '').slice(-8)}`,
        name: '下载夹具',
        entryUrl: 'https://example.com',
        authMethod: 'password',
        captchaMode: 'none',
        status: 'active',
        loginFields: null,
      },
      actor,
    )
    const scenario = await scenarios.create({ targetId: target.id, name: '下载', steps: [echoStep] }, actor)
    runId = (await runs.create({ scenarioId: scenario.id }, actor)).detail.id
    otherRunId = (await runs.create({ scenarioId: scenario.id, input: { k: '1' } }, actor)).detail.id
  })

  afterAll(async () => {
    await handle?.close()
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('能取回截图正文；跨 Run 与 missing 都不吐字节', async () => {
    const body = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])
    const reserved = await reserveStoredObject(handle.db, {
      runId,
      retainUntil: new Date(Date.now() + 86_400_000),
    })
    const head = await store.put({ key: reserved.objectKey, body, contentType: 'image/png' })
    await commitStoredObject(handle.db, {
      id: reserved.id,
      contentType: 'image/png',
      byteSize: head.byteSize,
      digest: head.digest,
    })
    const evidence = await recordObjectEvidence(handle.db, {
      runId,
      type: 'screenshot',
      objectKey: reserved.objectKey,
    })

    const file = await runs.evidenceContent(runId, evidence.id)
    expect(file.contentType).toBe('image/png')
    expect(file.byteSize).toBe(body.byteLength)
    expect(file.filename).toBe('screenshot.png')
    expect(file.body).toEqual(body)

    await expect(runs.evidenceContent(otherRunId, evidence.id)).rejects.toBeInstanceOf(NotFoundException)

    const missing = await recordMissingObjectEvidence(handle.db, {
      runId,
      type: 'screenshot',
      missingReason: OBJECT_MISSING_REASONS.workerLost,
    })
    await expect(runs.evidenceContent(runId, missing.id)).rejects.toMatchObject({
      response: { code: 'EVIDENCE_NOT_AVAILABLE', message: expect.stringContaining('worker_lost') },
    })

    const listed = await listRunEvidence(handle.db, runId)
    expect(listed.items.find((item) => item.id === evidence.id)?.status).toBe('available')
  })
})
