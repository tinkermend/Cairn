#!/usr/bin/env node
/**
 * 本机 api / worker / web 进程探活。
 *
 * 只探正在跑的进程，不负责启动。测试通过不能代替本命令。
 * 本命令通过也不能代替功能验收或核心生命周期验收。
 */
import { existsSync } from 'node:fs'
import { createConnection } from 'node:net'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_HOST,
  DEFAULT_PORTS,
  WORKER_NODE_HEALTH_PATH,
  decideVerdict,
  decodeInternalSecret,
  isFailure,
  looksLikeHtml,
  parseHealthBody,
  parseWorkerNodeHealth,
  resolveScope,
  signWorkerNodeHealthHeaders,
} from './lib/stack-health.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const envFile = resolve(root, '.env')
if (existsSync(envFile)) process.loadEnvFile(envFile)

function envPort(key, fallback) {
  const raw = process.env[key]
  if (raw === undefined || raw.trim() === '') return fallback
  const port = Number(raw)
  if (!Number.isInteger(port) || port <= 0) {
    console.error(`环境变量 ${key}=${raw} 不是合法端口`)
    process.exit(2)
  }
  return port
}

function parseArgs(argv) {
  let scope = 'all'
  let strict = false
  let timeoutMs = 2000
  for (const arg of argv) {
    if (arg === '--strict') {
      strict = true
      continue
    }
    if (arg.startsWith('--timeout-ms=')) {
      timeoutMs = Number(arg.slice('--timeout-ms='.length))
      if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
        console.error('用法: pnpm check:stack [all|backend|api|worker|web] [--strict] [--timeout-ms=2000]')
        process.exit(2)
      }
      continue
    }
    if (arg.startsWith('-')) {
      console.error(`未知参数: ${arg}`)
      console.error('用法: pnpm check:stack [all|backend|api|worker|web] [--strict] [--timeout-ms=2000]')
      process.exit(2)
    }
    scope = arg
  }
  return { scope, strict, timeoutMs }
}

function probeListen(host, port, timeoutMs) {
  return new Promise((resolveListen) => {
    const socket = createConnection({ host, port })
    const finish = (ok) => {
      socket.removeAllListeners()
      socket.destroy()
      resolveListen(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

async function fetchText(url, timeoutMs, headers) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
      headers,
    })
    const text = await res.text()
    return { status: res.status, text }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { status: 0, text: '', error: reason }
  }
}

function mark(ok) {
  return ok ? 'pass' : 'fail'
}

const { scope: scopeName, strict, timeoutMs } = parseArgs(process.argv.slice(2))
let scope
try {
  scope = resolveScope(scopeName)
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(2)
}

const host = DEFAULT_HOST
const ports = {
  api: envPort('CAIRN_API_PORT', DEFAULT_PORTS.api),
  worker: envPort('CAIRN_WORKER_INTERNAL_PORT', DEFAULT_PORTS.worker),
  web: envPort('CAIRN_WEB_PORT', DEFAULT_PORTS.web),
}

const [apiListen, workerListen, webListen] = await Promise.all([
  scope.api ? probeListen(host, ports.api, timeoutMs) : Promise.resolve(false),
  scope.worker ? probeListen(host, ports.worker, timeoutMs) : Promise.resolve(false),
  scope.web ? probeListen(host, ports.web, timeoutMs) : Promise.resolve(false),
])

const apiUrl = `http://${host}:${ports.api}/health`
const webUrl = `http://${host}:${ports.web}/`
const webHealthUrl = `http://${host}:${ports.web}/health`

let apiHealth
if (scope.api && apiListen) {
  const res = await fetchText(apiUrl, timeoutMs)
  if (res.error) {
    apiHealth = { ok: false, error: res.error }
  } else if (res.status !== 200) {
    apiHealth = { ok: false, error: `HTTP ${res.status}` }
  } else {
    apiHealth = parseHealthBody(res.text)
  }
} else if (scope.api) {
  apiHealth = { ok: false, error: '未监听' }
}

let workerHealth
if (scope.worker && workerListen) {
  const secret = decodeInternalSecret(process.env.CAIRN_INTERNAL_AUTH_SECRET ?? '')
  const workerId = (process.env.CAIRN_WORKER_ID ?? '').trim() || 'local-worker'
  if (!secret) {
    workerHealth = { ok: false, error: '缺少可用的 CAIRN_INTERNAL_AUTH_SECRET，禁止回退 TCP' }
  } else {
    const headers = signWorkerNodeHealthHeaders(secret, workerId, Math.floor(Date.now() / 1000) + 20)
    const res = await fetchText(`http://${host}:${ports.worker}${WORKER_NODE_HEALTH_PATH}`, timeoutMs, headers)
    if (res.error) {
      workerHealth = { ok: false, error: res.error }
    } else if (res.status !== 200) {
      workerHealth = { ok: false, error: `HTTP ${res.status}` }
    } else {
      workerHealth = parseWorkerNodeHealth(res.text)
    }
  }
} else if (scope.worker) {
  workerHealth = { ok: false, error: '未监听' }
}

let webPage
let webHealth
if (scope.web && webListen) {
  const page = await fetchText(webUrl, timeoutMs)
  webPage = page.error
    ? { ok: false, error: page.error }
    : looksLikeHtml(page.text, page.status)
      ? { ok: true }
      : { ok: false, error: page.status ? `HTTP ${page.status} 且不是 HTML` : '不可达' }

  const proxied = await fetchText(webHealthUrl, timeoutMs)
  if (proxied.error) {
    webHealth = { ok: false, error: proxied.error }
  } else if (proxied.status !== 200) {
    webHealth = { ok: false, error: `HTTP ${proxied.status}` }
  } else {
    const parsed = parseHealthBody(proxied.text)
    webHealth = parsed.ok ? { ok: true, value: parsed.value } : { ok: false, error: parsed.error }
  }
} else if (scope.web) {
  webPage = { ok: false, error: '未监听' }
  webHealth = { ok: false, error: '未监听' }
}

const verdict = decideVerdict({
  requireApi: scope.api,
  requireWorker: scope.worker,
  requireWeb: scope.web,
  strict,
  apiListen,
  workerListen,
  webListen,
  apiHealth,
  workerHealth,
  webPage,
  webHealth,
})

const s1 = [
  scope.api ? `api:${mark(apiListen)} :${ports.api}` : 'api:skip',
  scope.worker ? `worker:${mark(workerListen)} :${ports.worker}` : 'worker:skip',
  scope.web ? `web:${mark(webListen)} :${ports.web}` : 'web:skip',
].join('  ')

const healthDetail = apiHealth?.ok
  ? `status=${apiHealth.value.status} database=${apiHealth.value.checks.database} changeHint=${apiHealth.value.checks.changeHint}`
  : apiHealth?.error ?? 'skip'

const workerDetail = workerHealth?.ok
  ? `service=${workerHealth.value.service} loopAlive=${workerHealth.value.loopAlive}`
  : workerHealth?.error ?? 'skip'
const s2 = [
  scope.api ? `api:${mark(Boolean(apiHealth?.ok && apiHealth.value?.checks.database === 'up'))} ${healthDetail}` : 'api:skip',
  scope.worker ? `worker:${mark(Boolean(workerHealth?.ok && workerHealth.value?.loopAlive === true))} ${workerDetail}` : 'worker:skip',
].join('  ')
const s3 = scope.web
  ? `page:${mark(Boolean(webPage?.ok))}  proxy:${mark(Boolean(webHealth?.ok))}`
  : 'web:skip'

console.log(`# cairn stack scale`)
console.log(`scope: ${scopeName}${strict ? ' --strict' : ''}`)
console.log(`S1 listen     ${s1}`)
console.log(`S2 health     ${s2}`)
console.log(`S3 wire       ${s3}`)
console.log(`RESULT        ${verdict.result}${verdict.fail ? `  ${verdict.fail}` : verdict.note ? `  ${verdict.note}` : ''}`)

if (verdict.result === 'STACK_DOWN') {
  console.error('下一步：先看已有终端是否在跑 pnpm dev / pnpm start；没有再启动，然后重跑 pnpm check:stack。不要把测试通过写成服务正常。')
} else if (verdict.result === 'STACK_UNHEALTHY') {
  console.error('进程在听，但健康检查或前后端接线失败。先看 logs/ 或对应 dev 终端，不要宣称服务正常。')
} else if (verdict.result === 'STACK_DEGRADED') {
  console.error('进程可访问，但控制面处于降级。功能验收可以继续，不得把状态写成全部正常。')
}

if (isFailure(verdict.result, strict)) process.exit(1)
