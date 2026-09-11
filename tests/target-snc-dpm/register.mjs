#!/usr/bin/env node
/**
 * 把 SNC DPM 登记进本机识途目标系统目录（幂等：编码已存在则只打印）。
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const catalog = JSON.parse(await readFile(join(root, 'catalog.json'), 'utf8'))
const base = (process.env.CAIRN_API_BASE ?? 'http://127.0.0.1:3030').replace(/\/$/, '')
const email = process.env.CAIRN_BOOTSTRAP_ADMIN_EMAIL ?? 'admin'
const password = process.env.CAIRN_BOOTSTRAP_ADMIN_PASSWORD ?? 'cairn-admin'
const targetPassword = process.env.CAIRN_L3_DPM_PASSWORD ?? ''

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
      loginUrl: catalog.loginUrl,
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
    account: { ...catalog.account, password: targetPassword },
  }),
})
console.log(`已登记 ${created.code} ${created.id} ${created.name} 账号数=${created.accountCount}`)
