import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = resolve(fileURLToPath(new URL('.', import.meta.url)))
const port = Number(process.env.HMI_PORT ?? 4178)
const origin = `http://127.0.0.1:${port}`

const child = spawn(process.execPath, ['server.mjs'], {
  cwd: root,
  env: { ...process.env, HMI_PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let ready = false
child.stdout.on('data', (chunk) => {
  if (String(chunk).includes('target-login-hmi')) ready = true
})
child.stderr.on('data', (chunk) => {
  process.stderr.write(chunk)
})

try {
  const deadline = Date.now() + 4000
  while (!ready && Date.now() < deadline) await delay(50)
  assert.ok(ready, 'HMI 服务未在超时前就绪')

  const loginPage = await fetch(`${origin}/login`)
  assert.equal(loginPage.status, 200)
  const html = await loginPage.text()
  assert.match(html, /id="username"/)
  assert.match(html, /name="username"/)
  assert.match(html, /autocomplete="username"/)
  assert.match(html, /id="password"/)
  assert.match(html, /name="password"/)
  assert.match(html, /autocomplete="current-password"/)
  assert.match(html, /id="login-submit"/)
  assert.match(html, /type="submit"/)
  assert.doesNotMatch(html, /选择器|录制插件/)

  const failed = await fetch(`${origin}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'demo', password: 'wrong' }),
    redirect: 'manual',
  })
  assert.equal(failed.status, 302)
  assert.equal(failed.headers.get('location'), '/login?error=1')

  const ok = await fetch(`${origin}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'demo', password: 'demo123' }),
    redirect: 'manual',
  })
  assert.equal(ok.status, 302)
  assert.equal(ok.headers.get('location'), '/')
  const cookie = ok.headers.get('set-cookie') ?? ''
  assert.match(cookie, /hmi_session=ok/)

  const home = await fetch(`${origin}/`, { headers: { cookie: 'hmi_session=ok' } })
  assert.equal(home.status, 200)
  assert.match(await home.text(), /1 号场站总览/)

  console.log('target-login-hmi check ok')
} finally {
  child.kill('SIGTERM')
}
