#!/usr/bin/env node
/**
 * 把 SNC DPM 登记进本机识途目标系统目录（幂等：编码已存在则只更新登录定位）。
 * 入口 URL、账号、口令只从环境变量或本机 catalog.local.json 读取，不进仓库。
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const catalog = JSON.parse(await readFile(join(root, 'catalog.json'), 'utf8'))
const local = await loadLocalOverlay()
const base = (process.env.CAIRN_API_BASE ?? 'http://127.0.0.1:3030').replace(/\/$/, '')
const email = process.env.CAIRN_BOOTSTRAP_ADMIN_EMAIL ?? 'admin'
const password = process.env.CAIRN_BOOTSTRAP_ADMIN_PASSWORD ?? 'cairn-admin'
const entryUrl = firstNonEmpty(process.env.CAIRN_L3_DPM_URL, local.entryUrl)
const loginUrl = firstNonEmpty(process.env.CAIRN_L3_DPM_LOGIN_URL, local.loginUrl)
const username = firstNonEmpty(process.env.CAIRN_L3_DPM_USERNAME, local.account?.username)
const targetPassword = firstNonEmpty(process.env.CAIRN_L3_DPM_PASSWORD, local.account?.password)

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

async function loadLocalOverlay() {
  try {
    return JSON.parse(await readFile(join(root, 'catalog.local.json'), 'utf8'))
  } catch (error) {
    if (error && error.code === 'ENOENT') return {}
    throw error
  }
}

function requireOverlay() {
  const missing = [
    ['CAIRN_L3_DPM_URL', entryUrl],
    ['CAIRN_L3_DPM_LOGIN_URL', loginUrl],
    ['CAIRN_L3_DPM_USERNAME', username],
    ['CAIRN_L3_DPM_PASSWORD', targetPassword],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name)
  if (missing.length === 0) return
  throw new Error(
    `缺少 ${missing.join('、')}。写到环境变量，或复制本机 docs/targets 到 tests/target-snc-dpm/catalog.local.json（该文件已 gitignore）。`,
  )
}

async function json(path, init = {}) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(`${res.status} ${path}: ${JSON.stringify(body)}`)
  }
  return body
}

requireOverlay()

const login = await json('/api/auth/login', {
  method: 'POST',
  body: JSON.stringify({ email, password }),
})
const auth = { authorization: `Bearer ${login.accessToken}` }

const list = await json('/api/targets', { headers: auth })
const existing = (list.items ?? []).find((item) => item.code === catalog.code)
if (existing) {
  const updated = await json(`/api/targets/${existing.id}`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      entryUrl,
      loginUrl,
      loginFields: catalog.loginFields,
    }),
  })
  console.log(`已更新登录定位 ${updated.code} ${updated.id} ${updated.name}`)
  process.exit(0)
}

const created = await json('/api/targets', {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({
    ...catalog,
    entryUrl,
    loginUrl,
    account: { ...catalog.account, username, password: targetPassword },
  }),
})
console.log(`已登记 ${created.code} ${created.id} ${created.name} 账号数=${created.accountCount}`)
