import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
const require = createRequire(new URL('../../packages/web/package.json', import.meta.url))
const { chromium } = require('playwright')
export const sample = JSON.parse(await readFile(new URL('../../.artifacts/flowgram-spike/sample.json', import.meta.url), 'utf8'))
export const artifact = (name) => new URL(`../../.artifacts/flowgram-spike/${name}`, import.meta.url).pathname
export async function session(viewport = { width: 1440, height: 1100 }) {
  const api = process.env.CAIRN_API_ORIGIN ?? 'http://127.0.0.1:3030'
  const login = await fetch(`${api}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: process.env.CAIRN_BOOTSTRAP_ADMIN_EMAIL ?? 'admin', password: process.env.CAIRN_BOOTSTRAP_ADMIN_PASSWORD ?? 'cairn-admin' }) })
  if (!login.ok) throw new Error(`Login: ${login.status}`)
  const auth = await login.json()
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport })
  await context.addCookies([{ name: 'thisisjustarandomstring', value: JSON.stringify(auth.accessToken), url: new URL(sample.url).origin }])
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  async function request(path, body) {
    const response = await fetch(`${api}/api${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${auth.accessToken}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
    const result = await response.json()
    if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(result)}`)
    return result
  }
  return { browser, context, page, errors, request }
}
export async function save(name, value) { await writeFile(artifact(name), JSON.stringify(value, null, 2)) }
