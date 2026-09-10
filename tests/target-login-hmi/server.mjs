import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('.', import.meta.url)))
const publicDir = join(root, 'public')
const PORT = Number(process.env.HMI_PORT ?? 4177)
const SESSION_COOKIE = 'hmi_session'
const SESSION_VALUE = 'ok'

/** 夹具账号。只存在本进程内存，不是识途 TargetAccount。 */
const ACCOUNTS = new Map([
  ['demo', 'demo123'],
  ['alice', 'alice123'],
])

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

function parseCookies(header) {
  const out = new Map()
  if (!header) return out
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx < 0) continue
    out.set(part.slice(0, idx).trim(), decodeURIComponent(part.slice(idx + 1).trim()))
  }
  return out
}

function isAuthed(req) {
  return parseCookies(req.headers.cookie).get(SESSION_COOKIE) === SESSION_VALUE
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? Buffer.from(body) : body
  res.writeHead(status, { 'Content-Length': payload.length, ...headers })
  res.end(payload)
}

function redirect(res, location, extra = {}) {
  send(res, 302, '', { Location: location, ...extra })
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

function parseForm(raw, contentType) {
  if ((contentType ?? '').includes('application/json')) {
    try {
      const json = JSON.parse(raw)
      return {
        username: typeof json.username === 'string' ? json.username : '',
        password: typeof json.password === 'string' ? json.password : '',
      }
    } catch {
      return { username: '', password: '' }
    }
  }
  const params = new URLSearchParams(raw)
  return {
    username: params.get('username') ?? '',
    password: params.get('password') ?? '',
  }
}

async function servePublic(res, urlPath) {
  const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '')
  const file = normalize(join(publicDir, relative))
  if (!file.startsWith(publicDir)) {
    send(res, 403, 'Forbidden')
    return
  }
  try {
    const info = await stat(file)
    if (!info.isFile()) {
      send(res, 404, 'Not Found')
      return
    }
    const body = await readFile(file)
    send(res, 200, body, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' })
  } catch {
    send(res, 404, 'Not Found')
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
  const path = url.pathname

  try {
    if (req.method === 'GET' && path === '/') {
      if (!isAuthed(req)) {
        redirect(res, '/login')
        return
      }
      await servePublic(res, '/')
      return
    }

    if (req.method === 'GET' && path === '/login') {
      if (isAuthed(req)) {
        redirect(res, '/')
        return
      }
      await servePublic(res, '/login.html')
      return
    }

    if (req.method === 'POST' && path === '/login') {
      const form = parseForm(await readBody(req), req.headers['content-type'])
      if (ACCOUNTS.get(form.username) === form.password) {
        redirect(res, '/', {
          'Set-Cookie': `${SESSION_COOKIE}=${SESSION_VALUE}; Path=/; HttpOnly; SameSite=Lax`,
        })
        return
      }
      redirect(res, '/login?error=1')
      return
    }

    if ((req.method === 'GET' || req.method === 'POST') && path === '/logout') {
      redirect(res, '/login', {
        'Set-Cookie': `${SESSION_COOKIE}=; Path=/; Max-Age=0`,
      })
      return
    }

    if (req.method === 'GET') {
      await servePublic(res, path)
      return
    }

    send(res, 405, 'Method Not Allowed')
  } catch (error) {
    console.error(error)
    send(res, 500, 'Internal Server Error')
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`target-login-hmi  http://127.0.0.1:${PORT}/login`)
})
