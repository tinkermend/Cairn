import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { JwtService } from '@nestjs/jwt'
import request from 'supertest'
import { chromium } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { openIsolatedDb, type DbHandle } from '@cairn/db/testing'
import {
  RbacStore,
  TargetsStore,
  createScenarioWithVersion,
  listScenarioVersions,
  newId,
} from '@cairn/db'
import { createTargetBodySchema } from '@cairn/shared'
import { AppModule } from '../app.module'
import { DB_HANDLE } from '../db/db.module'
import { CHANGE_HINT } from '../observe/change-hint.module'
import { listenForSupertest, unusedChangeHint } from '../__tests__/http-app'
import { configureBodyParsers } from '../config/body-parsers'
import { gzipSync } from 'node:zlib'
let peer: INestApplication
let app: INestApplication,
  db: DbHandle,
  jwt: string,
  key: string,
  callerId: string,
  credentialId: string,
  targetId: string
let body: {
  scenarioId: string
  scenarioVersionId: string
  targetAccountId: string
  input: object
  idempotencyKey: string
}
beforeAll(async () => {
  db = await openIsolatedDb(`service_http_${Date.now()}`)
  const rbac = new RbacStore(db, { hash: async (s) => s, verify: async (s, hash) => s === hash })
  const roles = await rbac.listRoles()
  const actor = await rbac.createAccount(
    {
      email: 'service-http-admin',
      displayName: '服务管理员',
      password: 'test-password',
      roleIds: [roles.items.find((r) => r.key === 'admin')!.id],
    },
    null,
  )
  const targets = new TargetsStore(db, () => Buffer.from('encrypted'))
  const target = await targets.createTarget(
    createTargetBodySchema.parse({
      code: 'http-target',
      name: '接口测试目标',
      entryUrl: 'https://example.com',
      account: { username: 'test', displayName: '目标账号', password: 'hidden-target-secret' },
    }),
    actor,
  )
  targetId = target.id
  const account = (await targets.listAccounts(target.id)).items[0]!
  const scenario = await createScenarioWithVersion(db, {
    targetId,
    name: '公开测试场景',
    actor,
    steps: [
      {
        id: newId(),
        name: 'echo',
        type: 'echo',
        effectType: 'READ_ONLY',
        input: { value: 'hello' },
      },
    ],
  })
  body = {
    scenarioId: scenario.id,
    scenarioVersionId: (await listScenarioVersions(db, scenario.id)).items[0]!.id,
    targetAccountId: account.id,
    input: {},
    idempotencyKey: 'http-retry-key',
  }
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DB_HANDLE)
    .useValue(db)
    .overrideProvider(CHANGE_HINT)
    .useValue(unusedChangeHint)
    .compile()
  app = moduleRef.createNestApplication({ logger: false })
  app.setGlobalPrefix('api', { exclude: ['health'] })
  configureBodyParsers(app)
  await listenForSupertest(app)
  const peerModule = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DB_HANDLE)
    .useValue(db)
    .overrideProvider(CHANGE_HINT)
    .useValue(unusedChangeHint)
    .compile()
  peer = peerModule.createNestApplication({ logger: false })
  peer.setGlobalPrefix('api', { exclude: ['health'] })
  configureBodyParsers(peer)
  await listenForSupertest(peer)
  jwt = await app.get(JwtService).signAsync({ sub: actor.id })
  const caller = await request(app.getHttpServer())
    .post('/api/services')
    .auth(jwt, { type: 'bearer' })
    .send({ name: '接口调用方', owner: '测试', maxOutstandingRuns: 2 })
    .expect(201)
  callerId = caller.body.caller.id
  const issued = await request(app.getHttpServer())
    .post(`/api/services/${callerId}/credentials`)
    .auth(jwt, { type: 'bearer' })
    .send({
      name: 'API Key',
      scopes: ['run:execute', 'run:read', 'run:cancel', 'evidence:read'],
      grants: [{ targetId, accountIds: [account.id] }],
    })
    .expect(201)
  expect(issued.headers['cache-control']).toBe('no-store')
  key = issued.body.token
  credentialId = issued.body.credential.id
})
afterAll(async () => {
  await peer?.close()
  await app?.close()
})
it('real global guards separate console JWT from service credentials and expose only declared GET/POST execution routes', async () => {
  await request(app.getHttpServer()).get('/api/open/v1/targets').expect(401)
  await request(app.getHttpServer())
    .get('/api/open/v1/targets')
    .auth(jwt, { type: 'bearer' })
    .expect(401)
  for (const path of ['/api/me', '/api/rbac/roles', '/api/services', '/api/targets', '/api/runs']) {
    const response = await request(app.getHttpServer()).get(path).auth(key, { type: 'bearer' })
    expect(response.status).toBe(401)
    expect(JSON.stringify(response.body)).not.toContain(key)
  }
  const targets = await request(app.getHttpServer())
    .get('/api/open/v1/targets')
    .auth(key, { type: 'bearer' })
    .expect(200)
  expect(targets.body.items[0]).toMatchObject({
    id: targetId,
    accounts: [{ id: body.targetAccountId }],
  })
  expect(JSON.stringify(targets.body)).not.toMatch(/secret|password|loginFields|username/)
  const list = await request(app.getHttpServer())
    .get(`/api/services/${callerId}`)
    .auth(jwt, { type: 'bearer' })
    .expect(200)
  expect(JSON.stringify(list.body)).not.toContain(key)
  expect(JSON.stringify(list.body)).not.toContain('secretDigest')
})
it('concurrent HTTP retries create one persistent Run, keep request IDs, whitelist output and reject malformed/unbounded bodies', async () => {
  const responses = await Promise.all(
    Array.from({ length: 5 }, (_, n) =>
      request((n % 2 ? peer : app).getHttpServer())
        .post('/api/open/v1/runs')
        .auth(key, { type: 'bearer' })
        .set('X-Cairn-Request-Id', `service-request-${n}`)
        .send(body),
    ),
  )
  expect(responses.filter((r) => r.status === 201)).toHaveLength(1)
  expect(responses.every((r) => [200, 201].includes(r.status))).toBe(true)
  expect(new Set(responses.map((r) => r.body.id)).size).toBe(1)
  expect(responses[0]!.body).not.toHaveProperty('snapshot')
  expect(responses[0]!.body).not.toHaveProperty('context')
  const id = responses[0]!.body.id
  await request(peer.getHttpServer())
    .get(`/api/open/v1/runs/${id}`)
    .auth(key, { type: 'bearer' })
    .expect(200)
  await request(app.getHttpServer())
    .post('/api/open/v1/runs')
    .auth(key, { type: 'bearer' })
    .send({ ...body, policy: { retries: 99 } })
    .expect(400)
  await request(app.getHttpServer())
    .post('/api/open/v1/runs')
    .auth(key, { type: 'bearer' })
    .send({ ...body, input: { x: 'a'.repeat(65536) } })
    .expect(413)
  await request(app.getHttpServer())
    .get(`/api/open/v1/runs/${newId()}`)
    .auth(key, { type: 'bearer' })
    .expect(404)
  await request(app.getHttpServer())
    .get(`/api/open/v1/runs/${id}/evidence`)
    .auth(key, { type: 'bearer' })
    .expect(200, { items: [] })
  await request(app.getHttpServer())
    .post(`/api/open/v1/runs/${id}/cancel`)
    .auth(key, { type: 'bearer' })
    .expect(200)
  await request(app.getHttpServer())
    .get(`/api/open/v1/runs/${id}/browser`)
    .auth(key, { type: 'bearer' })
    .expect(404)
  await request(app.getHttpServer())
    .post(`/api/open/v1/runs/${id}/resume-auth`)
    .auth(key, { type: 'bearer' })
    .send({})
    .expect(404)
})
it('production parsers bound raw and inflated service bodies before parsing', async () => {
  const json = JSON.stringify({ ...body, idempotencyKey: 'body-boundary-key' })
  const exact = ' '.repeat(65536 - Buffer.byteLength(json)) + json
  const url = `${await app.getUrl()}/api/open/v1/runs`
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
  const accepted = await fetch(url, { method: 'POST', headers, body: exact })
  expect(accepted.status).toBe(201)
  await accepted.arrayBuffer()
  for (const [payload, extra] of [
    [' ' + exact, {}],
    [gzipSync(' ' + exact), { 'Content-Encoding': 'gzip' }],
    ['input=' + '%20'.repeat(30000), { 'Content-Type': 'application/x-www-form-urlencoded' }],
  ] as const) {
    const response = await fetch(url, { method: 'POST', headers: { ...headers, ...extra }, body: payload })
    expect(response.status).toBe(413)
    await response.arrayBuffer()
  }
})
it('rate limits include failed validation; Retry-After is returned; revocation prevents new requests', async () => {
  await request(app.getHttpServer())
    .post(`/api/services/${callerId}/update`)
    .auth(jwt, { type: 'bearer' })
    .send({ name: '接口调用方', owner: '测试', requestsPerMinute: 1 })
    .expect(200)
  const limit = await request(app.getHttpServer())
    .get('/api/open/v1/targets')
    .auth(key, { type: 'bearer' })
    .expect(429)
  expect(Number(limit.headers['retry-after'])).toBeGreaterThan(0)
  await request(app.getHttpServer())
    .post(`/api/services/${callerId}/credentials/${credentialId}/revoke`)
    .auth(jwt, { type: 'bearer' })
    .expect(200)
  await request(app.getHttpServer())
    .get('/api/open/v1/targets')
    .auth(key, { type: 'bearer' })
    .expect(401)
})

it(
  'real console UI persists caller/grants, shows a key once, rotates/revokes, and fits desktop and narrow screens',
  { timeout: 120_000 },
  async () => {
    const { spawn } = await import('node:child_process')
    const { mkdirSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const { createServer } = await import('node:net')
    const repo = resolve(__dirname, '../../../..')
    const socket = createServer().listen(0, '127.0.0.1')
    await new Promise<void>((r) => socket.once('listening', r))
    const port = (socket.address() as { port: number }).port
    await new Promise<void>((r) => socket.close(() => r()))
    const apiPort = (app.getHttpServer().address() as { port: number }).port
    const vite = spawn(
      process.execPath,
      [
        resolve(repo, 'packages/web/node_modules/vite/bin/vite.js'),
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--strictPort',
      ],
      {
        cwd: resolve(repo, 'packages/web'),
        env: { ...process.env, CAIRN_API_ORIGIN: `http://127.0.0.1:${apiPort}` },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    const viteReady = new Promise<void>((ready, reject) => {
      const timer = setTimeout(() => reject(new Error('Vite startup timeout')), 20000)
      vite.once('exit', () => {
        clearTimeout(timer)
        reject(new Error('Vite exited'))
      })
      vite.stdout.on('data', (data) => {
        if (String(data).includes('Local:')) {
          clearTimeout(timer)
          ready()
        }
      })
    })
    const browser = await chromium.launch({ headless: true })
    const origin = `http://127.0.0.1:${port}`,
      artifacts = resolve(repo, '.run/service-access/ui')
    mkdirSync(artifacts, { recursive: true })
    try {
      await viteReady
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
      await context.addCookies([
        { name: 'thisisjustarandomstring', value: JSON.stringify(jwt), url: origin },
      ])
      const page = await context.newPage(),
        errors: string[] = []
      page.on('pageerror', (e) => errors.push(e.message))
      // Exercise the empty-state presentation against a deterministic empty list.
      await page.route(
        '**/api/services?limit=20',
        (route) =>
          route.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' }),
        { times: 1 },
      )
      await page.goto(`${origin}/services`)
      await page.getByText('还没有服务调用方', { exact: true }).waitFor()
      await page.getByRole('button', { name: '新建调用方' }).focus()
      await page.keyboard.press('Enter')
      await page.getByLabel('应用名称', { exact: true }).fill('外部巡检应用 · 受控执行验收')
      await page.getByLabel('负责人', { exact: true }).fill('平台联调负责人')
      await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click()
      await page.getByRole('button', { name: '签发凭据', exact: true }).click()
      await page.getByLabel('凭据名称', { exact: true }).fill('巡检 Key')
      await page.getByLabel('接口测试目标', { exact: true }).check()
      await page.getByLabel('目标账号 (test)', { exact: true }).check()
      await page.screenshot({ path: resolve(artifacts, 'grants-desktop.png'), fullPage: true })
      await page.getByRole('button', { name: '签发 Key', exact: true }).click()
      const raw = await page.getByTestId('issued-service-token').textContent()
      expect(raw).toMatch(/^cairn_sk_/)
      await page.getByRole('button', { name: '已保存，关闭' }).click()
      expect(await page.getByTestId('issued-service-token').count()).toBe(0)
      expect(await page.evaluate<string>('JSON.stringify(localStorage)')).not.toContain(raw!)
      await request(app.getHttpServer())
        .get('/api/open/v1/targets')
        .auth(raw!, { type: 'bearer' })
        .expect(200)
      await page.getByRole('button', { name: '编辑授权', exact: true }).click()
      await page.getByLabel('查看本应用的运行', { exact: true }).uncheck()
      await page.getByRole('button', { name: '保存授权', exact: true }).click()
      await page.getByRole('dialog').waitFor({ state: 'hidden' })
      await request(app.getHttpServer())
        .get('/api/open/v1/runs')
        .auth(raw!, { type: 'bearer' })
        .expect(403)
      await page.getByRole('button', { name: '轮换', exact: true }).click()
      await page.getByRole('button', { name: '签发 Key', exact: true }).click()
      const rotated = await page.getByTestId('issued-service-token').textContent()
      await page.getByRole('button', { name: '已保存，关闭' }).click()
      await page.getByRole('button', { name: '吊销', exact: true }).first().click()
      await page.getByRole('alertdialog').getByRole('button', { name: '吊销', exact: true }).click()
      await page.getByRole('alertdialog').waitFor({ state: 'hidden' })
      await request(app.getHttpServer())
        .get('/api/open/v1/targets')
        .auth(raw!, { type: 'bearer' })
        .expect(401)
      await request(app.getHttpServer())
        .get('/api/open/v1/targets')
        .auth(rotated!, { type: 'bearer' })
        .expect(200)
      await page.screenshot({ path: resolve(artifacts, 'services-desktop.png'), fullPage: true })
      await page.setViewportSize({ width: 390, height: 844 })
      await page.screenshot({ path: resolve(artifacts, 'services-narrow.png'), fullPage: true })
      expect(
        await page.evaluate<boolean>('document.documentElement.scrollWidth <= innerWidth'),
      ).toBe(true)
      await page.getByRole('button', { name: '编辑调用方', exact: true }).click()
      await page.getByRole('combobox', { name: /^服务状态/ }).selectOption('disabled')
      // Deliberate transport failure: verify the form preserves data and allows retry.
      await page.route(
        '**/api/services/*/update',
        (route) =>
          route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({
              code: 'UNAVAILABLE',
              message: '测试：服务暂不可用',
              requestId: 'test-ui-failure',
            }),
          }),
        { times: 1 },
      )
      await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click()
      await page.getByRole('alert').filter({ hasText: '测试：服务暂不可用' }).waitFor()
      expect(await page.getByLabel('负责人', { exact: true }).inputValue()).toBe('平台联调负责人')
      await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click()
      await page.getByRole('dialog').waitFor({ state: 'hidden' })
      await request(app.getHttpServer())
        .get('/api/open/v1/targets')
        .auth(rotated!, { type: 'bearer' })
        .expect(401)
      expect(errors).toEqual([])
      const rbac = new RbacStore(db, {
        hash: async (s) => s,
        verify: async (s, hash) => s === hash,
      })
      const viewerRole = (await rbac.listRoles()).items.find((r) => r.key === 'viewer')!
      const viewer = await rbac.createAccount(
        {
          email: 'service-ui-viewer',
          displayName: '只读验收',
          password: 'test-password',
          roleIds: [viewerRole.id],
        },
        null,
      )
      const viewerJwt = await app.get(JwtService).signAsync({ sub: viewer.id })
      await request(app.getHttpServer())
        .get('/api/services')
        .auth(viewerJwt, { type: 'bearer' })
        .expect(403)
      await context.clearCookies()
      await context.addCookies([
        { name: 'thisisjustarandomstring', value: JSON.stringify(viewerJwt), url: origin },
      ])
      await page.goto(`${origin}/services`)
      await page.waitForURL('**/403')
      expect(await page.getByRole('button', { name: '新建调用方' }).count()).toBe(0)
    } finally {
      await browser.close()
      vite.kill('SIGTERM')
    }
  },
)
