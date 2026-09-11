import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('.', import.meta.url)))
const publicDir = join(root, 'public')
const PORT = Number(process.env.LAB_PORT ?? 4178)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? Buffer.from(body) : body
  res.writeHead(status, { 'Content-Length': payload.length, ...headers })
  res.end(payload)
}

async function servePublic(res, urlPath) {
  const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '')
  const file = normalize(join(publicDir, relative.endsWith('.html') || extname(relative) ? relative : `${relative}.html`))
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

export function createLabServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
    if (req.method !== 'GET') {
      send(res, 405, 'Method Not Allowed')
      return
    }
    try {
      await servePublic(res, url.pathname)
    } catch (error) {
      console.error(error)
      send(res, 500, 'Internal Server Error')
    }
  })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  createLabServer().listen(PORT, '127.0.0.1', () => {
    console.log(`target-surface-lab  http://127.0.0.1:${PORT}/`)
  })
}
