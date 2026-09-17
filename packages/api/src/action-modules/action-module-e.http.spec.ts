import {
  type CanActivate,
  type ExecutionContext,
  INestApplication,
  UnauthorizedException,
} from '@nestjs/common'
import { APP_FILTER, APP_GUARD, Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  RbacStore,
  TargetsStore,
  createRunWithSnapshot,
  createScenarioWithVersion,
  getScenario,
  projectModuleInvocationResults,
  publishScenarioDraft,
  saveScenarioDraft,
  type DbHandle,
} from '@cairn/db'
import { eq, expose, newId, openIsolatedDb, schemaFor } from '@cairn/db/testing'
import { compileModuleContent } from '@cairn/authoring'
import {
  PERMISSIONS,
  moduleWarningKey,
  type ModuleContent,
  type ScenarioAuthoringDocumentV2,
} from '@cairn/shared'
import { AllExceptionsFilter } from '../common/all-exceptions.filter.js'
import type { RequestAccount } from '../common/request-account.js'
import { PermissionsGuard } from '../rbac/permissions.guard.js'
import { ActionModulesController } from './action-modules.controller.js'
import { ActionModulesService } from './action-modules.service.js'
import { listenForSupertest } from '../__tests__/http-app.js'

const admin: RequestAccount = {
  id: 'acc-admin',
  displayName: 'Admin',
  email: 'admin@example.com',
  status: 'active',
  roles: [{ id: 'admin', key: 'admin', name: 'Administrator', kind: 'system' }],
  permissions: [...PERMISSIONS],
}

class StaticAuthGuard implements CanActivate {
  constructor(private readonly account: RequestAccount) {}
  canActivate(context: ExecutionContext): boolean {
    if (!this.account) throw new UnauthorizedException('未认证')
    context.switchToHttp().getRequest().account = this.account
    return true
  }
}

function echoContent(): ModuleContent {
  const stepId = newId()
  return {
    contract: {
      inputs: [{ key: 'keyword', label: '关键词', valueType: 'string', required: true }],
      outputs: [{ key: 'result', label: '结果', shape: { kind: 'scalar', type: 'string' } }],
      effectCeiling: 'READ_ONLY',
      preconditions: [],
      postconditions: [{ meaning: '有结果', verification: { kind: 'output_required', outputKey: 'result' } }],
    },
    implementations: [{
      implementationKey: 'default',
      kind: 'structured_steps',
      steps: [{
        id: stepId,
        name: '回显',
        type: 'echo',
        effectType: 'READ_ONLY',
        outputKey: 'internal',
        input: { from: 'keyword' },
      }],
      outputMapping: { result: 'internal' },
    }],
  }
}

function confirmedWarnings(content: ModuleContent) {
  return compileModuleContent(content, { mode: 'release' }).diagnostics
    .filter((item) => item.severity === 'warning')
    .map(moduleWarningKey)
}

describe('AM-E HTTP → 真实库', { timeout: 30_000 }, () => {
  let handle: Awaited<ReturnType<typeof openIsolatedDb>>
  let db: DbHandle
  let account: RequestAccount
  let app: INestApplication
  let targetId: string

  beforeAll(async () => {
    handle = await openIsolatedDb(`cairn_ame_http_${newId().replaceAll('-', '')}`)
    db = expose(handle)
    const rbac = new RbacStore(db, { hash: async (v) => v, verify: async (v, h) => v === h })
    const role = (await rbac.listRoles()).items.find((r) => r.key === 'admin')!
    const created = await rbac.createAccount({
      email: 'ame-http@example.test',
      displayName: 'AM-E HTTP',
      password: 'Fixture-password-123',
      roleIds: [role.id],
    }, null)
    account = { ...admin, id: created.id }
    const targets = new TargetsStore(db, () => Buffer.from('fixture'))
    targetId = (await targets.createTarget({
      loginFields: null, authMethod: 'manual', captchaMode: 'none', status: 'active',
      name: 'AM-E HTTP 目标',
      code: `ame-http-${newId().slice(0, 8)}`,
      entryUrl: 'https://example.test',
    }, account)).id

    const moduleRef = await Test.createTestingModule({
      controllers: [ActionModulesController],
      providers: [
        Reflector,
        { provide: ActionModulesService, useValue: new ActionModulesService(db) },
        { provide: APP_GUARD, useValue: new StaticAuthGuard(account) },
        { provide: APP_GUARD, useClass: PermissionsGuard },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
    }).compile()
    app = moduleRef.createNestApplication({ logger: false })
    await listenForSupertest(app)
  })

  afterAll(async () => {
    await app?.close()
    await handle?.close()
  })

  async function publishModule(key: string) {
    const content = echoContent()
    const created = await request(app.getHttpServer()).post('/action-modules').send({
      targetId, key, name: '查询订单', idempotencyKey: newId(),
    }).expect(201)
    const path = `/action-modules/${created.body.id}`
    await request(app.getHttpServer()).post(`${path}/draft`).send({ baseRevision: 0, content }).expect(200)
    await request(app.getHttpServer()).post(`${path}/publish`).send({
      expectedRevision: 1,
      confirmedWarnings: confirmedWarnings(content),
      idempotencyKey: newId(),
    }).expect(200)
    const versions = await request(app.getHttpServer()).get(`${path}/versions`).expect(200)
    return { id: created.body.id as string, versionId: versions.body.items[0].id as string, content }
  }

  async function markSucceeded(runId: string) {
    const native = handle.db
    const { runs, stepRuns, attempts } = schemaFor(native)
    const now = new Date()
    const steps = await native.select().from(stepRuns).where(eq(stepRuns.runId, runId))
    for (const step of steps) {
      await native.update(stepRuns).set({
        status: 'SUCCEEDED',
        startedAt: now,
        finishedAt: now,
      }).where(eq(stepRuns.id, step.id))
      await native.insert(attempts).values({
        id: newId(),
        stepRunId: step.id,
        attemptNo: 1,
        status: 'SUCCEEDED',
        startedAt: now,
        finishedAt: now,
        output: 'ok',
        error: null,
      })
    }
    await native.update(runs).set({
      status: 'SUCCEEDED',
      finishedAt: now,
      updatedAt: now,
      eventSeq: 3,
      context: { result: 'ok' },
    }).where(eq(runs.id, runId))
  }

  it('空态质量接口返回 unknown，非法窗口 400，列表可附健康摘要', async () => {
    const published = await publishModule(`ameempty${newId().replaceAll('-', '').slice(0, 8)}`)
    const quality = await request(app.getHttpServer())
      .get(`/action-modules/${published.id}/quality`)
      .expect(200)
    expect(quality.body.health.signal).toBe('unknown')
    expect(quality.body.overall.calls).toBe(0)
    expect(quality.body.trial.calls).toBe(0)
    expect(quality.body.configRevision).toBeGreaterThan(0)

    await request(app.getHttpServer())
      .get(`/action-modules/${published.id}/quality`)
      .query({ window: 14 })
      .expect(400)

    const invocations = await request(app.getHttpServer())
      .get(`/action-modules/${published.id}/invocations`)
      .expect(200)
    expect(invocations.body.items).toEqual([])

    const listed = await request(app.getHttpServer()).get('/action-modules').query({ targetId }).expect(200)
    const row = listed.body.items.find((item: { id: string }) => item.id === published.id)
    expect(row?.health?.signal).toBe('unknown')
  })

  it('投影后调用列表带 invocation 深链；健康信号不阻止再发布', async () => {
    const published = await publishModule(`ameproj${newId().replaceAll('-', '').slice(0, 8)}`)
    const scenario = await createScenarioWithVersion(db, {
      targetId,
      name: `AM-E 场景 ${newId()}`,
      steps: [{ id: newId(), name: '占位', type: 'delay', effectType: 'READ_ONLY', input: { durationMs: 10 } }],
      actor: { id: account.id },
    })
    const invocationId = newId()
    const draft: ScenarioAuthoringDocumentV2 = {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [],
      nodes: [{
        kind: 'module',
        invocationId,
        moduleId: published.id,
        moduleVersionId: published.versionId,
        implementationKey: 'default',
        inputBindings: { keyword: { kind: 'literal', value: 'SO123' } },
        outputBindings: { result: 'result' },
      }],
    }
    const saved = await saveScenarioDraft(db, scenario.id, {
      revision: 1,
      document: draft,
      actor: { id: account.id },
    })
    await publishScenarioDraft(db, scenario.id, {
      revision: saved.draft?.revision ?? 2,
      actor: { id: account.id },
    })
    const current = await getScenario(db, scenario.id)
    const created = await createRunWithSnapshot(db, {
      scenarioId: current.id,
      actor: { id: account.id },
    })
    await markSucceeded(created.detail.id)
    await projectModuleInvocationResults(db, created.detail.id)

    const invocations = await request(app.getHttpServer())
      .get(`/action-modules/${published.id}/invocations`)
      .expect(200)
    expect(invocations.body.total).toBe(1)
    expect(invocations.body.items[0].runHref).toBe(`/runs/${created.detail.id}?invocation=${invocationId}`)
    expect(invocations.body.items[0].outcome).toBe('VERIFIED')

    const quality = await request(app.getHttpServer())
      .get(`/action-modules/${published.id}/quality`)
      .query({ window: 7, groupBy: 'account' })
      .expect(200)
    expect(quality.body.overall.calls).toBe(1)
    expect(quality.body.health.signal).toBe('unknown')
    expect(quality.body.accounts?.length).toBeGreaterThan(0)

    const listed = await request(app.getHttpServer()).get('/action-modules').query({ targetId }).expect(200)
    const row = listed.body.items.find((item: { id: string }) => item.id === published.id)
    expect(row?.health).toMatchObject({
      signal: quality.body.health.signal,
      sampleCount: quality.body.health.sampleCount,
      verifiedRate: quality.body.health.verifiedRate,
      windowDays: quality.body.health.windowDays,
      configRevision: quality.body.health.configRevision,
      verificationInsufficient: quality.body.health.verificationInsufficient,
    })

    const republish = await request(app.getHttpServer())
      .post(`/action-modules/${published.id}/draft`)
      .send({ baseRevision: 1, content: published.content })
      .expect(200)
    await request(app.getHttpServer())
      .post(`/action-modules/${published.id}/publish`)
      .send({
        expectedRevision: republish.body.draftRevision,
        confirmedWarnings: confirmedWarnings(published.content),
        idempotencyKey: newId(),
      })
      .expect(200)
  })
})
