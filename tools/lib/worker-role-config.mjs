export const WORKER_ROLE_NAMES = ['executor', 'scheduler', 'analyst', 'maintenance']

const DEFAULT_PORTS = {
  executor: 8092,
  scheduler: 8093,
  analyst: 8094,
  maintenance: 8095,
}

function parsePort(raw, fallback, key, allowZero = false) {
  if (raw === undefined || raw.trim() === '') return fallback
  const port = Number(raw)
  if (!Number.isInteger(port) || port < (allowZero ? 0 : 1) || port > 65535) {
    throw new Error(`${key} 必须是 ${allowZero ? '0–65535' : '1–65535'} 的端口`)
  }
  return port
}

/** Resolve the four local role processes from one shared environment. */
export function resolveWorkerRoleConfig(env = process.env) {
  const prefix = env.CAIRN_WORKER_ROLE_ID_PREFIX?.trim() || 'local-worker'
  const globalAdvertiseUrl = env.CAIRN_WORKER_ADVERTISE_URL?.trim() || ''
  const roles = WORKER_ROLE_NAMES.map((role) => {
    const upper = role.toUpperCase()
    const id = env[`CAIRN_WORKER_${upper}_ID`]?.trim() || `${prefix}-${role}`
    const port = parsePort(env[`CAIRN_WORKER_${upper}_PORT`], DEFAULT_PORTS[role], `CAIRN_WORKER_${upper}_PORT`)
    const configuredAdvertiseUrl = env[`CAIRN_WORKER_${upper}_ADVERTISE_URL`]?.trim() || ''
    if (!/^[a-zA-Z0-9._:-]+$/.test(id)) {
      throw new Error(`CAIRN_WORKER_${upper}_ID 只能包含字母、数字、点、下划线、冒号和短横线`)
    }
    if (globalAdvertiseUrl && !configuredAdvertiseUrl) {
      throw new Error(`CAIRN_WORKER_ADVERTISE_URL 已设置；分角色启动需分别配置 CAIRN_WORKER_${upper}_ADVERTISE_URL`)
    }
    const advertiseUrl = configuredAdvertiseUrl || `http://127.0.0.1:${port}`
    return { role, id, port, advertiseUrl }
  })

  const unique = (values) => new Set(values).size === values.length
  if (!unique(roles.map(({ id }) => id))) throw new Error('分角色 Worker ID 必须互不相同')
  if (!unique(roles.map(({ port }) => port))) throw new Error('分角色 Worker 端口必须互不相同')
  if (!unique(roles.map(({ advertiseUrl }) => advertiseUrl ? new URL(advertiseUrl).origin : '').filter(Boolean))) {
    throw new Error('分角色 Worker 广告 URL 必须互不相同')
  }

  for (const [key, fallback] of [
    ['CAIRN_WORKER_INTERNAL_PORT', 8091],
    ['CAIRN_API_PORT', 3030],
    ['CAIRN_WEB_PORT', 5173],
  ]) {
    const reservedPort = parsePort(env[key], fallback, key, key === 'CAIRN_WORKER_INTERNAL_PORT')
    if (reservedPort > 0 && roles.some(({ port }) => port === reservedPort)) {
      throw new Error(`分角色 Worker 端口不能与 ${key}=${reservedPort} 冲突`)
    }
  }
  return roles
}
