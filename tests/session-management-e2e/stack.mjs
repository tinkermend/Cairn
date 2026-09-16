import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync, openSync, closeSync, readFileSync, cpSync, readdirSync, symlinkSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  openIsolatedDb,
  requireReachableDb,
  openNativeDatabase,
  migrateDatabase,
} from '../../packages/db/dist/test-entry.js'

export const root = resolve(import.meta.dirname, '../..')

// Restart tests must run the same build even when another task rebuilds the
// shared workspace. External installed dependencies remain read-only links.
function freezeRuntime(artifacts) {
  const runtime = resolve(artifacts, 'runtime')
  const packages = ['shared', 'db', 'map', 'secret', 'storage', 'api', 'worker']
  for (const pkg of packages) {
    const source = resolve(root, 'packages', pkg)
    const destination = resolve(runtime, pkg)
    mkdirSync(resolve(destination, 'node_modules'), { recursive: true })
    cpSync(resolve(source, 'package.json'), resolve(destination, 'package.json'))
    cpSync(resolve(source, 'dist'), resolve(destination, 'dist'), { recursive: true })
    if (pkg === 'db') {
      for (const name of readdirSync(source).filter(name => name.startsWith('migrations'))) {
        cpSync(resolve(source, name), resolve(destination, name), { recursive: true })
      }
    }
    for (const name of readdirSync(resolve(source, 'node_modules'))) {
      if (name.startsWith('.')) continue
      if (name !== '@cairn') {
        symlinkSync(resolve(source, 'node_modules', name), resolve(destination, 'node_modules', name))
        continue
      }
      mkdirSync(resolve(destination, 'node_modules', name))
      for (const dependency of readdirSync(resolve(source, 'node_modules', name))) {
        if (!packages.includes(dependency)) throw new Error(`Unfrozen workspace dependency: ${dependency}`)
        symlinkSync(resolve(runtime, dependency), resolve(destination, 'node_modules', name, dependency))
      }
    }
  }
  return runtime
}
export async function eventually(read, accept, label, timeout = 30000) {
  const end = Date.now() + timeout
  let value
  while (Date.now() < end) {
    value = await read()
    if (accept(value)) return value
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`${label}: timed out; last=${JSON.stringify(value)}`)
}
export async function firstSse(url, token, eventName, headers = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, ...headers },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`SSE ${response.status}`)
    let buffer = ''
    for await (const bytes of response.body) {
      buffer += new TextDecoder().decode(bytes)
      let split
      while ((split = buffer.indexOf('\n\n')) >= 0) {
        const packet = buffer.slice(0, split)
        buffer = buffer.slice(split + 2)
        if (packet.includes(`event: ${eventName}\n`))
          return JSON.parse(
            packet
              .split('\n')
              .find((line) => line.startsWith('data: '))
              .slice(6),
          )
      }
    }
    throw new Error('SSE closed without event')
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}
async function freePort() {
  const server = createServer()
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  await new Promise((r) => server.close(r))
  return port
}
export async function startStack() {
  const id = `cairn_session_e2e_${randomUUID().replaceAll('-', '')}`
  if (existsSync(resolve(root, '.env'))) process.loadEnvFile(resolve(root, '.env'))
  const artifacts = resolve(root, '.run/session-management-e2e', id)
  mkdirSync(artifacts, { recursive: true })
  const runtime = freezeRuntime(artifacts)
  const driver = process.env.CAIRN_E2E_DB_DRIVER ?? 'postgres'
  let env, db
  if (driver === 'postgres') {
    const baseEnv = await requireReachableDb()
    env = { ...baseEnv, CAIRN_DB_NAME: id }
    db = await openIsolatedDb(id)
  } else if (driver === 'mysql') {
    const password =
      process.env.CAIRN_TEST_MYSQL_PASSWORD ??
      readFileSync(
        process.env.CAIRN_TEST_MYSQL_ENV_FILE ??
          resolve(root, '.run/database-portability/mysql.env'),
        'utf8',
      ).match(/^MYSQL_ROOT_PASSWORD=(.+)$/m)?.[1]
    if (!password)
      throw new Error('MySQL E2E requires CAIRN_TEST_MYSQL_PASSWORD')
    const adminEnv = {
      CAIRN_DB_DRIVER: 'mysql',
      CAIRN_DB_HOST: process.env.CAIRN_TEST_MYSQL_HOST ?? '127.0.0.1',
      CAIRN_DB_PORT: Number(process.env.CAIRN_TEST_MYSQL_PORT ?? 3307),
      CAIRN_DB_USER: process.env.CAIRN_TEST_MYSQL_USER ?? 'root',
      CAIRN_DB_PASSWORD: password,
      CAIRN_DB_NAME:
        process.env.CAIRN_TEST_MYSQL_DATABASE ?? 'cairn_portability',
    }
    const admin = openNativeDatabase(adminEnv)
    await admin.raw(
      `CREATE DATABASE \`${id}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`,
    )
    env = { ...adminEnv, CAIRN_DB_NAME: id }
    const native = openNativeDatabase(env)
    const close = async () => {
      await native.close()
      try {
        await admin.raw(`DROP DATABASE \`${id}\``)
      } finally {
        await admin.close()
      }
    }
    try {
      await migrateDatabase(native, env)
    } catch (error) {
      await close()
      throw error
    }
    db = { ...native, close }
  } else {
    throw new Error(`Unsupported E2E driver: ${driver}; only postgres and mysql are supported`)
  }
  const apiPort = await freePort(),
    workerPorts = [await freePort(), await freePort()]
  const common = {
    ...process.env,
    ...Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v)])),
    CAIRN_DB_NAME: id,
    CAIRN_ENV: 'development',
    CAIRN_LOG_LEVEL: process.env.CAIRN_E2E_LOG_LEVEL ?? 'warn',
    CAIRN_OBJECT_STORE: 'local',
    CAIRN_OBJECT_STORE_DIR: resolve(artifacts, 'objects'),
    CAIRN_BROWSER_AI_ENABLED: 'false',
    CAIRN_BROWSER_HEADLESS: 'true',
    CAIRN_API_PORT: String(apiPort),
    CAIRN_WORKER_NETWORK_MODE: 'local',
    CAIRN_BOOTSTRAP_ADMIN_EMAIL: 'admin',
    CAIRN_BOOTSTRAP_ADMIN_PASSWORD: 'e2e-admin-password',
    CAIRN_WORKER_ENDPOINTS: workerPorts
      .map((p, i) => `session-e2e-${i}=http://127.0.0.1:${p}`)
      .join(','),
    CAIRN_WORKER_HEARTBEAT_MS: '1000',
    CAIRN_RUN_LEASE_TTL_SECONDS: '6',
    CAIRN_WORKER_LOST_AFTER_SECONDS: '9',
    CAIRN_SESSION_LEASE_TTL_SECONDS: '6',
    CAIRN_SESSION_HEARTBEAT_MS: '1000',
    CAIRN_SESSION_REAPER_INTERVAL_MS: '1000',
    CAIRN_BROWSER_MAX_SESSIONS: '4',
    CAIRN_WORKER_CAPACITY: '4',
  }
  const children = []
  function launch(pkg, label, extra = {}) {
    const fd = openSync(resolve(artifacts, `${label}.log`), 'a')
    const child = spawn(process.execPath, ['dist/main.js'], {
      cwd: resolve(runtime, pkg),
      env: { ...common, ...extra },
      stdio: ['ignore', fd, fd],
    })
    closeSync(fd)
    children.push(child)
    return child
  }
  let api = launch('api', 'api')
  const launchWorker = (i) =>
    launch('worker', `worker-${i}`, {
      CAIRN_WORKER_ID: `session-e2e-${i}`,
      CAIRN_WORKER_INTERNAL_PORT: String(workerPorts[i]),
      CAIRN_BROWSER_PROFILE_DIR: resolve(artifacts, `profiles-${i}`),
    })
  const workers = workerPorts.map((_, i) => launchWorker(i))
  const url = `http://127.0.0.1:${apiPort}`
  let token
  async function request(path, body, options = {}) {
    const response = await fetch(`${url}/api${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(35000),
    })
    const result = await response.json()
    if (options.status) {
      if (response.status !== options.status)
        throw new Error(
          `${path}: expected HTTP ${options.status}, got ${response.status}: ${JSON.stringify(result)}`,
        )
      return result
    }
    if (!response.ok)
      throw new Error(`${path}: ${response.status} ${JSON.stringify(result)}`)
    return result
  }
  async function close() {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGCONT')
        child.kill('SIGTERM')
      }
    await Promise.all(
      children.map((child) =>
        child.exitCode !== null || child.signalCode !== null
          ? undefined
          : Promise.race([
              new Promise((r) => child.once('exit', r)),
              new Promise((r) =>
                setTimeout(() => {
                  child.kill('SIGKILL')
                  r()
                }, 12000).unref(),
              ),
            ]),
      ),
    )
    await db.close()
  }
  async function restartWorker(index) {
    const old = workers[index]
    const stopped = new Promise((resolve) => old.once('exit', resolve))
    old.kill('SIGTERM')
    await Promise.race([
      stopped,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('Worker shutdown timeout')),
          15000,
        ).unref(),
      ),
    ])
    workers[index] = launchWorker(index)
    await eventually(
      () => request('/workers'),
      (r) =>
        r.items.some(
          (w) => w.workerId === `session-e2e-${index}` && w.status === 'READY',
        ),
      'restarted Worker READY',
    )
  }
  async function restartApi() {
    const stopped = new Promise((resolve) => api.once('exit', resolve))
    api.kill('SIGTERM')
    await stopped
    api = launch('api', 'api')
    await eventually(
      () =>
        fetch(`${url}/health`)
          .then((r) => r.ok)
          .catch(() => false),
      Boolean,
      'restarted API health',
    )
  }
  async function startWeb() {
    const port = await freePort()
    const fd = openSync(resolve(artifacts, 'web.log'), 'a')
    const child = spawn(
      process.execPath,
      [
        'node_modules/vite/bin/vite.js',
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--strictPort',
      ],
      {
        cwd: resolve(root, 'packages/web'),
        env: { ...common, CAIRN_API_ORIGIN: url },
        stdio: ['ignore', fd, fd],
      },
    )
    closeSync(fd)
    children.push(child)
    const webUrl = `http://127.0.0.1:${port}`
    await eventually(
      () =>
        fetch(webUrl)
          .then((r) => r.ok)
          .catch(() => false),
      Boolean,
      'Web ready',
    )
    return webUrl
  }
  try {
    await eventually(
      async () =>
        fetch(`${url}/health`)
          .then((r) => r.ok)
          .catch(() => false),
      Boolean,
      'API health',
      30000,
    )
    token = (
      await request('/auth/login', {
        email: 'admin',
        password: 'e2e-admin-password',
      })
    ).accessToken
    if (!token) throw new Error('Login did not return accessToken')
    await eventually(
      () => request('/workers'),
      (r) => r.items?.filter((w) => w.status === 'READY').length === 2,
      'two Workers READY',
    )
    return {
      db,
      request,
      url,
      token,
      api,
      workers,
      artifacts,
      common,
      close,
      startWeb,
      restartApi,
      restartWorker,
    }
  } catch (error) {
    await close()
    throw error
  }
}
