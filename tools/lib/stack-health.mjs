/**
 * 本机进程探活的判定，不含网络 IO。
 * 探活只回答「api / worker / web 现在能不能被连上」，不代替功能或生命周期验收。
 */

export const DEFAULT_PORTS = {
  api: 3030,
  worker: 8091,
  web: 5173,
}

export const DEFAULT_HOST = '127.0.0.1'

/** @typedef {'all' | 'backend' | 'api' | 'worker' | 'web'} StackScope */

/**
 * @param {string} name
 * @returns {{ api: boolean, worker: boolean, web: boolean }}
 */
export function resolveScope(name = 'all') {
  switch (name) {
    case 'all':
      return { api: true, worker: true, web: true }
    case 'backend':
      return { api: true, worker: true, web: false }
    case 'api':
      return { api: true, worker: false, web: false }
    case 'worker':
      return { api: false, worker: true, web: false }
    case 'web':
      // 前端验收必须证明页面能转到控制面，因此 web 范围仍探 api。
      return { api: true, worker: false, web: true }
    default:
      throw new Error(`未知探活范围: ${name}（可选: all, backend, api, worker, web）`)
  }
}

/**
 * @param {unknown} text
 * @returns {{ ok: true, value: {
 *   status: 'ok' | 'degraded',
 *   service: 'cairn-api' | 'cairn-worker',
 *   uptimeSeconds: number,
 *   checks: { database: 'up' | 'down', changeHint: 'up' | 'down' | 'unused' },
 * } } | { ok: false, error: string }}
 */
export function parseHealthBody(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, error: '响应为空' }
  }
  let json
  try {
    json = JSON.parse(text)
  } catch {
    return { ok: false, error: '不是 JSON' }
  }
  if (json === null || typeof json !== 'object') {
    return { ok: false, error: '不是对象' }
  }
  if (json.status !== 'ok' && json.status !== 'degraded') {
    return { ok: false, error: 'status 非法' }
  }
  if (json.service !== 'cairn-api' && json.service !== 'cairn-worker') {
    return { ok: false, error: 'service 非法' }
  }
  if (typeof json.uptimeSeconds !== 'number' || Number.isNaN(json.uptimeSeconds) || json.uptimeSeconds < 0) {
    return { ok: false, error: 'uptime 非法' }
  }
  const checks = json.checks
  if (checks === null || typeof checks !== 'object') {
    return { ok: false, error: 'checks 缺失' }
  }
  if (checks.database !== 'up' && checks.database !== 'down') {
    return { ok: false, error: 'database 非法' }
  }
  const changeHint = checks.changeHint ?? 'unused'
  if (changeHint !== 'up' && changeHint !== 'down' && changeHint !== 'unused') {
    return { ok: false, error: 'changeHint 非法' }
  }
  return {
    ok: true,
    value: {
      status: json.status,
      service: json.service,
      uptimeSeconds: json.uptimeSeconds,
      checks: { database: checks.database, changeHint },
    },
  }
}

export function looksLikeHtml(text, status) {
  if (status !== 200) return false
  if (typeof text !== 'string') return false
  return /<!doctype html|<html[\s>]/i.test(text)
}

/**
 * @param {{
 *   requireApi: boolean,
 *   requireWorker: boolean,
 *   requireWeb: boolean,
 *   strict?: boolean,
 *   apiListen: boolean,
 *   workerListen: boolean,
 *   webListen: boolean,
 *   apiHealth?: { ok: boolean, value?: { status: string, checks: { database: string, changeHint: string } }, error?: string },
 *   webPage?: { ok: boolean, error?: string },
 *   webHealth?: { ok: boolean, error?: string },
 * }} input
 */
export function decideVerdict(input) {
  if (input.requireApi && !input.apiListen) {
    return { result: 'STACK_DOWN', fail: 'api 未监听' }
  }
  if (input.requireWorker && !input.workerListen) {
    return { result: 'STACK_DOWN', fail: 'worker 未监听' }
  }
  if (input.requireWeb && !input.webListen) {
    return { result: 'STACK_DOWN', fail: 'web 未监听' }
  }
  if (input.requireApi) {
    if (!input.apiHealth?.ok) {
      return { result: 'STACK_UNHEALTHY', fail: `api /health ${input.apiHealth?.error ?? '不可达'}` }
    }
    if (input.apiHealth.value.checks.database !== 'up') {
      return { result: 'STACK_UNHEALTHY', fail: '数据库不可用' }
    }
  }
  if (input.requireWeb) {
    if (!input.webPage?.ok) {
      return { result: 'STACK_UNHEALTHY', fail: `web 页面 ${input.webPage?.error ?? '不可达'}` }
    }
    if (!input.webHealth?.ok) {
      return { result: 'STACK_UNHEALTHY', fail: `web→api /health ${input.webHealth?.error ?? '不可达'}` }
    }
  }

  const degraded =
    input.apiHealth?.value?.status === 'degraded' ||
    input.apiHealth?.value?.checks.changeHint === 'down'
  if (degraded) {
    const note = '控制面降级（常见于 changeHint 未接通）'
    if (input.strict) return { result: 'STACK_DEGRADED', fail: note, note }
    return { result: 'STACK_DEGRADED', fail: null, note }
  }
  return { result: 'STACK_OK', fail: null }
}

export function isFailure(result, strict = false) {
  return result === 'STACK_DOWN' || result === 'STACK_UNHEALTHY' || (strict && result === 'STACK_DEGRADED')
}
