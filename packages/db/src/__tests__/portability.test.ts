import { afterEach, describe, expect, it } from 'vitest'
import { fork } from 'node:child_process'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import {
  RECORDER_SOURCE_VERSION,
  FACTORY_PLATFORM_CONFIG,
  canonicalJson,
  dbEnvSchema,
  createTargetBodySchema,
  createAccountBodySchema,
  type DbEnv,
  type RunGrant,
  type Step,
} from '@cairn/shared'
import * as api from '../index.js'
import { expose } from '../database.js'
import { createDb as openNative, type DbHandle } from '../client.js'
import { schemaFor, afterSeconds } from '../native.js'
import { assertSchemaReady, migrateDatabase } from '../migrate-native.js'
import { exportDatabase, importDatabase } from '../transfer.js'
import { DRIVERS, openContractDb } from './contract-fixture.js'

const echo: Step = {
  id: '00000000-0000-4000-8000-000000000061',
  name: '回显',
  type: 'echo',
  effectType: 'READ_ONLY',
  input: { value: 'hello' },
}
const passwordAdapter = {
  hash: async (s: string) => createHash('sha256').update(s).digest('hex'),
  verify: async (s: string, h: string) => createHash('sha256').update(s).digest('hex') === h,
}
const bytes = Buffer.from([0, 255, 1, 128, 64, 0, 238])
const objectBytes = Buffer.from('证据 / evidence / 🧪')
const objectDigest = `sha256:${createHash('sha256').update(objectBytes).digest('hex')}`
const transferOptions = {
  writersStopped: true as const,
  allowMillisecondPrecisionLoss: true,
  verifyObject: async (o: { digest: string; byteSize: number }) => {
    expect(o).toMatchObject({ digest: objectDigest, byteSize: objectBytes.length })
  },
}
it('driver configuration validates independently and rejects unknown backends', () => {
  expect(
    dbEnvSchema.parse({ CAIRN_DB_DRIVER: 'sqlite', CAIRN_DB_FILE: '/tmp/cairn.sqlite' }),
  ).toEqual({ CAIRN_DB_DRIVER: 'sqlite', CAIRN_DB_FILE: '/tmp/cairn.sqlite' })
  expect(dbEnvSchema.safeParse({ CAIRN_DB_DRIVER: 'unknown' }).success).toBe(false)
  expect(
    dbEnvSchema.safeParse({ CAIRN_DB_DRIVER: 'sqlite', CAIRN_DB_FILE: ':memory:' }).success,
  ).toBe(false)
  const server = {
    CAIRN_DB_HOST: 'localhost',
    CAIRN_DB_NAME: 'cairn',
    CAIRN_DB_USER: 'test',
    CAIRN_DB_PASSWORD: 'test',
  }
  expect(dbEnvSchema.parse(server).CAIRN_DB_DRIVER).toBe('postgres')
  expect(dbEnvSchema.parse({ ...server, CAIRN_DB_DRIVER: 'mysql' })).toMatchObject({
    CAIRN_DB_PORT: 3306,
  })
})

const handles: DbHandle[] = []
afterEach(async () => {
  for (const h of handles.splice(0).reverse()) await h.close()
})
async function fixture(driver: (typeof DRIVERS)[number]) {
  const h = await openContractDb(driver)
  handles.push(h)
  const db = expose(h)
  const rbac = new api.RbacStore(db, passwordAdapter)
  const actor = await rbac.createAccount(
    createAccountBodySchema.parse({
      email: 'portable-admin',
      displayName: '管理员',
      password: 'secret-password',
    }),
    null,
  )
  const targets = new api.TargetsStore(db, () => Buffer.from(bytes))
  const target = await targets.createTarget(
    createTargetBodySchema.parse({
      code: 'portable-test',
      name: '目标 🧪',
      entryUrl: 'https://example.com',
      account: { username: 'User', displayName: '账号', password: 'hidden-value' },
    }),
    actor,
  )
  const account = (await targets.listAccounts(target.id)).items[0]!
  const scenario = await api.createScenarioWithVersion(db, {
    targetId: target.id,
    name: '历史场景',
    steps: [echo],
    actor,
  })
  return { h, db, rbac, actor, targets, target, account, scenario }
}
async function finish(f: Awaited<ReturnType<typeof fixture>>) {
  const created = await api.createRunWithSnapshot(f.db, {
    scenarioId: f.scenario.id,
    actor: f.actor,
  })
  const worker = { workerId: api.newId(), instanceId: api.newId() }
  await api.registerWorker(f.db, { ...worker, capacity: 2, lostAfterSeconds: 60 })
  const grant = (await api.claimRun(f.db, { ...worker, leaseTtlSeconds: 60 }))!
  const attempt = (await api.startAttempt(f.db, {
    runId: grant.runId,
    stepRunId: created.detail.stepRuns[0]!.id,
    inputPayload: {},
    grant,
  }))!
  await api.finishAttempt(f.db, {
    runId: grant.runId,
    attemptId: attempt.attemptId,
    attemptStatus: 'SUCCEEDED',
    output: { text: '中文 🧪', nullable: null },
    stepRunStatus: 'SUCCEEDED',
    runStatus: 'SUCCEEDED',
    grant,
  })
  const object = await api.reserveStoredObject(f.db, {
    runId: grant.runId,
    retainUntil: new Date(Date.now() + 3600_000),
  })
  await api.commitStoredObject(f.db, {
    id: object.id,
    contentType: 'image/png',
    byteSize: objectBytes.length,
    digest: objectDigest,
  })
  await api.recordObjectEvidence(f.db, {
    runId: grant.runId,
    stepRunId: created.detail.stepRuns[0]!.id,
    attemptId: attempt.attemptId,
    type: 'screenshot',
    objectKey: object.objectKey,
  })
  await api.markWorkerStopped(f.db, worker.workerId, worker.instanceId)
  return { runId: grant.runId, object }
}
function childClaims(
  env: DbEnv,
  worker: { workerId: string; instanceId: string },
): Promise<RunGrant[]> {
  return new Promise((resolveClaims, reject) => {
    const child = fork(resolve(import.meta.dirname, 'claim-child.mjs'), { silent: true })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += String(chunk)
    })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('Claim child timed out'))
    }, 20_000)
    child.once('error', reject)
    child.once('message', (message: { grants?: RunGrant[]; error?: string }) => {
      clearTimeout(timer)
      if (message.error) reject(new Error(message.error))
      else resolveClaims(message.grants!)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (code) reject(new Error(`Claim child exit ${code}${stderr ? `: ${stderr.trim()}` : ''}`))
    })
    child.send({ env, worker })
  })
}

describe.each(DRIVERS)('%s public persistence contract', (driver) => {
  it('schema initialization is repeatable; incomplete and unknown versions block startup', async () => {
    const h = await openContractDb(driver)
    handles.push(h)
    expect((await migrateDatabase(h, h.env)).applied).toEqual([])
    await assertSchemaReady(h, h.env)
    if (driver !== 'postgres') {
      await h.raw("UPDATE _migrations SET state = 'running'")
      await expect(assertSchemaReady(h, h.env)).rejects.toThrow('incompatible')
      await expect(migrateDatabase(h, h.env)).rejects.toThrow('incomplete')
      await h.raw("UPDATE _migrations SET state = 'complete'")
      await h.raw(
        "INSERT INTO _migrations VALUES ('9999', '9999_future.sql', 'unknown', 'complete')",
      )
      await expect(migrateDatabase(h, h.env)).rejects.toThrow('Unknown database schema')
    } else {
      const env = { ...h.env, CAIRN_DB_SCHEMA: 'alternate' } as Extract<
        DbEnv,
        { CAIRN_DB_DRIVER: 'postgres' }
      >
      const alternate = openNative(env)
      handles.push(alternate)
      await migrateDatabase(alternate, env)
      const { targets } = schemaFor(alternate.db)
      await alternate.db
        .insert(targets)
        .values({ code: 'alternate', name: '隔离 schema', entryUrl: 'https://example.com' })
      expect(await alternate.db.select().from(targets)).toHaveLength(1)
      expect(await h.db.select().from(schemaFor(h.db).targets)).toHaveLength(0)
    }
  })

  it('CRUD, Unicode, case-sensitive keys, encrypted bytes, constraint errors and RBAC', async () => {
    const f = await fixture(driver)
    expect(Object.keys(f.db).sort()).toEqual(['close', 'driver', 'ping'])
    const { secrets } = schemaFor(f.h.db)
    expect((await f.h.db.select().from(secrets))[0]!.ciphertext).toEqual(bytes)
    await expect(
      f.targets.createTarget(
        createTargetBodySchema.parse({
          code: f.target.code,
          name: '重复',
          entryUrl: 'https://example.com',
        }),
        f.actor,
      ),
    ).rejects.toMatchObject({ code: 'TARGET_CODE_CONFLICT' })
    await f.targets.createAccount(
      f.target.id,
      { username: 'user', displayName: 'case-sensitive', status: 'active' },
      f.actor,
    )
    await expect(
      f.targets.createAccount(
        f.target.id,
        { username: 'User', displayName: 'duplicate', status: 'active' },
        f.actor,
      ),
    ).rejects.toMatchObject({ code: 'TARGET_ACCOUNT_CONFLICT' })
    await expect(
      f.targets.deleteTarget(f.target.id, f.actor, { expectedCounts: { targetAccounts: 0 } }),
    ).rejects.toMatchObject({
      code: 'DELETE_SCOPE_EXPANDED',
    })
    await expect(
      f.rbac.createRole(
        { key: 'forbidden-grant', name: 'forbidden', permissions: ['target:write'] },
        { ...f.actor, permissions: [] },
      ),
    ).rejects.toMatchObject({ kind: 'forbidden' })
    await f.rbac.changePassword(f.actor.id, {
      currentPassword: 'secret-password',
      newPassword: 'updated-password',
    })
    const identity = (await api.findLocalIdentity(f.db, 'PORTABLE-ADMIN'))!
    expect(await passwordAdapter.verify('updated-password', identity.secret!)).toBe(true)
    await f.targets.updateAccount(f.target.id, f.account.id, { clearPassword: true }, f.actor)
    expect(await f.h.db.select().from(secrets)).toHaveLength(0)
  })

  it('target referenced only by a recording cascades soft delete to recordings', async () => {
    const f = await fixture(driver)
    const target = await f.targets.createTarget(
      createTargetBodySchema.parse({
        code: 'recording-only',
        name: '录制目标',
        entryUrl: 'https://example.com',
      }),
      f.actor,
    )
    const draft = await api.createRecordingDraft(
      f.db,
      {
        targetId: target.id,
        recordingId: api.newId(),
        sourceVersion: RECORDER_SOURCE_VERSION,
        idempotencyKey: 'recording-only-key',
        events: [
          {
            name: 'navigate',
            url: 'https://example.com',
            signals: [],
            pageAlias: 'page',
            framePath: [],
          },
        ],
      },
      f.actor,
    )
    await f.targets.deleteTarget(target.id, f.actor)
    await expect(f.targets.getTarget(target.id)).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' })
    await expect(api.getRecordingDraft(f.db, draft.detail.id, f.actor.id)).rejects.toMatchObject({
      code: 'RECORDING_NOT_FOUND',
    })
  })

  it('simultaneous first worker registrations return one owner and stable conflicts', async () => {
    const h = await openContractDb(driver)
    handles.push(h)
    const database = expose(h)
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        api.registerWorker(database, {
          workerId: 'same-worker',
          instanceId: api.newId(),
          capacity: 1,
          lostAfterSeconds: 60,
        }),
      ),
    )
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    for (const result of results)
      if (result.status === 'rejected') {
        expect(result.reason).toMatchObject({ code: 'WORKER_ID_CONFLICT', kind: 'conflict' })
      }
  })

  it('nested transactions preserve savepoint and outer rollback semantics', async () => {
    const h = await openContractDb(driver)
    handles.push(h)
    const { targets } = schemaFor(h.db)
    const values = (code: string) => ({
      id: api.newId(),
      code,
      name: code,
      entryUrl: 'https://example.com',
    })
    await h.db.transaction(async (outer) => {
      await outer.insert(targets).values(values('outer'))
      await expect(
        outer.transaction(async (inner) => {
          await inner.insert(targets).values(values('rolled-back-inner'))
          throw new Error('inner failure')
        }),
      ).rejects.toThrow('inner failure')
      await outer.transaction(async (inner) => {
        await inner.insert(targets).values(values('committed-inner'))
      })
    })
    expect((await h.db.select().from(targets)).map((row) => row.code).sort()).toEqual([
      'committed-inner',
      'outer',
    ])
    await expect(
      h.db.transaction(async (outer) => {
        await outer.transaction(async (inner) => {
          await inner.insert(targets).values(values('rolled-back-outer'))
        })
        throw new Error('outer failure')
      }),
    ).rejects.toThrow('outer failure')
    expect(await h.db.select().from(targets)).toHaveLength(2)
  })

  it('independent processes claim once, obey capacity and fence expired owners', async () => {
    const f = await fixture(driver)
    const runs = await Promise.all(
      Array.from({ length: 12 }, () =>
        api.createRunWithSnapshot(f.db, { scenarioId: f.scenario.id, actor: f.actor }),
      ),
    )
    const workers = [
      { workerId: 'worker-one', instanceId: api.newId() },
      { workerId: 'worker-two', instanceId: api.newId() },
    ]
    for (const w of workers)
      await api.registerWorker(f.db, { ...w, capacity: 6, lostAfterSeconds: 60 })
    const grants = (
      await Promise.all(workers.flatMap((w) => [childClaims(f.h.env, w), childClaims(f.h.env, w)]))
    ).flat()
    expect(grants).toHaveLength(12)
    expect(new Set(grants.map((g) => g.runId)).size).toBe(12)
    for (const w of workers)
      expect(grants.filter((g) => g.holderWorkerId === w.workerId)).toHaveLength(6)
    const old = grants[0]!
    const { runLeases } = schemaFor(f.h.db)
    await f.h.db
      .update(runLeases)
      .set({ expiresAt: afterSeconds(f.h.db, -1) })
      .where(eq(runLeases.id, old.leaseId))
    expect(await api.renewRunLease(f.db, old, 60)).toBeNull()
    await api.expireStaleRunLeases(f.db, { limit: 20, maxRecoveries: 3 })
    const next = await api.claimRun(f.db, {
      ...workers.find((w) => w.workerId === old.holderWorkerId)!,
      leaseTtlSeconds: 60,
    })
    expect(next?.runId).toBe(old.runId)
    expect(next?.fencingToken).toBe(2)
    const stepRunId = runs.find((r) => r.detail.id === old.runId)!.detail.stepRuns[0]!.id
    expect(
      await api.startAttempt(f.db, { runId: old.runId, stepRunId, grant: old, inputPayload: {} }),
    ).toBeNull()
    expect(
      await api.claimRun(f.db, {
        workerId: workers[0]!.workerId,
        instanceId: api.newId(),
        leaseTtlSeconds: 60,
      }),
    ).toBeNull()
  })

  it('migration rejects live resources, corrupt archives and nonempty targets', async () => {
    const f = await fixture(driver)
    await api.createRunWithSnapshot(f.db, { scenarioId: f.scenario.id, actor: f.actor })
    await expect(exportDatabase(f.db, f.h.env, transferOptions)).rejects.toThrow(
      'Runs must be settled',
    )
    const row = (await api.listRuns(f.db)).items[0]!
    await api.requestRunCancel(f.db, row.id, f.actor)
    const archive = await exportDatabase(f.db, f.h.env, transferOptions)
    await expect(
      importDatabase(f.db, f.h.env, { ...archive, digest: '0'.repeat(64) }, transferOptions),
    ).rejects.toThrow('digest mismatch')
    await expect(importDatabase(f.db, f.h.env, archive, transferOptions)).rejects.toThrow(
      'not empty',
    )
    expect((await f.targets.listTargets()).items).toHaveLength(1)
    const empty = await openContractDb(driver)
    handles.push(empty)
    const invalid = structuredClone(archive)
    invalid.tables.scenarios![0]!.targetId = api.newId()
    const { digest: _, ...body } = invalid
    invalid.digest = createHash('sha256').update(canonicalJson(body)).digest('hex')
    await expect(
      importDatabase(expose(empty), empty.env, invalid, transferOptions),
    ).rejects.toThrow()
    expect(await empty.db.select().from(schemaFor(empty.db).consoleAccounts)).toHaveLength(0)
    expect(await empty.db.select().from(schemaFor(empty.db).consoleRoles)).toHaveLength(4)
  })

  it('completed history, secrets and evidence migrate in both outgoing directions', async () => {
    const source = await fixture(driver)
    const legacyId = api.newId()
    await api.registerStandaloneSecret(source.db, { id: legacyId, ciphertext: bytes })
    const initialConfig = await api.getOrCreatePlatformConfig(source.db, { document: {
      ...FACTORY_PLATFORM_CONFIG,
      browserAi: { ...FACTORY_PLATFORM_CONFIG.browserAi, baseUrl: 'https://legacy.example/v1',
        secretRef: { provider: 'local', secretId: legacyId } },
    }, reason: '迁移前的旧密钥引用' })
    const boundId = api.newId()
    await api.registerPlatformAiSecret(source.db, { id: boundId,
      baseUrl: 'https://MODEL.example:443/v1', ciphertext: bytes, actor: source.actor })
    const platform = await api.updatePlatformConfig(source.db, { expectedRevision: initialConfig.revision,
      actor: source.actor, reason: '登记新密钥', document: {
        ...FACTORY_PLATFORM_CONFIG, browserAi: { ...FACTORY_PLATFORM_CONFIG.browserAi,
          baseUrl: 'https://model.example/v1', secretRef: { provider: 'local', secretId: boundId } },
      } })
    const { runId } = await finish(source)
    await api.appendScenarioVersion(source.db, source.scenario.id, {
      steps: [{ ...echo, input: { value: 'new definition' } }],
      actor: source.actor,
    })
    const before = await api.getRun(source.db, runId)
    const archive = await exportDatabase(source.db, source.h.env, transferOptions)
    expect(archive.logicalVersion).toBe('0030')
    expect(archive.tables.scenarioDrafts).toHaveLength(1)
    for (const targetDriver of DRIVERS.filter((d) => d !== driver)) {
      const target = await openContractDb(targetDriver)
      handles.push(target)
      const targetDb = expose(target)
      const result = await importDatabase(targetDb, target.env, archive, transferOptions)
      expect(result.counts.runs).toBe(1)
      expect(result.counts.scenarioDrafts).toBe(1)
      expect(result.counts.platformAiSecretBindings).toBe(1)
      expect(result.counts.platformConfigRevisions).toBe(2)
      expect(await api.getPlatformConfig(targetDb)).toEqual(platform)
      expect(await api.loadPlatformAiSecret(targetDb, boundId)).toMatchObject({
        modelOrigin: 'https://model.example', ciphertext: bytes,
      })
      expect(await api.loadPlatformAiSecret(targetDb, legacyId)).toMatchObject({
        modelOrigin: 'https://legacy.example', ciphertext: bytes,
      })
      expect(await api.getScenario(targetDb, source.scenario.id)).toEqual(
        await api.getScenario(source.db, source.scenario.id),
      )
      expect(await api.getRun(targetDb, runId)).toEqual(before)
      expect((await target.db.select().from(schemaFor(target.db).secrets))[0]!.ciphertext).toEqual(
        bytes,
      )
      expect(
        (await api.listRunEvidence(targetDb, runId)).items.some((e) => e.type === 'screenshot'),
      ).toBe(true)
      const fresh = await api.createRunWithSnapshot(targetDb, {
        scenarioId: source.scenario.id,
        actor: source.actor,
      })
      expect(fresh.detail.snapshot.steps[0]!.input).toEqual({ value: 'new definition' })
    }
    expect(await api.getRun(source.db, runId)).toEqual(before)
  })
})
