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
  '.json': 'application/json; charset=utf-8',
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? Buffer.from(body) : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))
  const defaultType = typeof body === 'object' && !Buffer.isBuffer(body) ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8'
  res.writeHead(status, {
    'Content-Length': payload.length,
    'Content-Type': headers['Content-Type'] ?? defaultType,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    ...headers,
  })
  res.end(payload)
}

function readBody(req) {
  return new Promise((resolveBody) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8')
      try {
        resolveBody(JSON.parse(raw))
      } catch {
        resolveBody(raw)
      }
    })
  })
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

/**
 * 声明式动态 HTML 页面生成器
 */
function renderDynamicPage(spec) {
  const title = spec.title ?? 'Cairn Dynamic Lab'
  const elements = spec.elements ?? []
  const submitAction = spec.submitAction ?? { apiEndpoint: '/lab/api/submit', successMessage: '提交成功' }

  const htmlElements = elements
    .map((el) => {
      if (el.shadowDom) {
        return `
        <div id="${el.id ?? 'shadow-host'}" class="form-group">
          <script>
            (() => {
              const host = document.currentScript.parentElement;
              const shadow = host.attachShadow({ mode: 'open' });
              shadow.innerHTML = \`<style>
                input { padding: 8px 12px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 14px; width: 100%; box-sizing: border-box; }
                input:focus { outline: none; border-color: #3b82f6; box-shadow: 0 0 0 2px rgba(59,130,246,0.2); }
              </style>
              <input id="${el.id ? el.id + '-inner' : 'shadow-input'}" name="${el.name ?? 'shadowField'}" placeholder="${el.placeholder ?? 'Shadow DOM 内部输入框'}" />\`;
            })();
          </script>
        </div>`
      }

      if (el.tag === 'input') {
        return `
        <div class="form-group">
          ${el.label ? `<label for="${el.id ?? ''}">${el.label}</label>` : ''}
          <input id="${el.id ?? ''}" name="${el.name ?? el.id ?? ''}" type="${el.type ?? 'text'}" placeholder="${el.placeholder ?? ''}" class="lab-input" />
        </div>`
      }

      if (el.tag === 'select') {
        const options = (el.options ?? [])
          .map((opt) => `<option value="${opt.value ?? opt}">${opt.label ?? opt.value ?? opt}</option>`)
          .join('')
        return `
        <div class="form-group">
          ${el.label ? `<label for="${el.id ?? ''}">${el.label}</label>` : ''}
          <select id="${el.id ?? ''}" name="${el.name ?? el.id ?? ''}" class="lab-select">${options}</select>
        </div>`
      }

      if (el.tag === 'button') {
        return `
        <div class="form-group">
          <button id="${el.id ?? 'submit-btn'}" type="${el.type ?? 'button'}" class="lab-button">${el.text ?? '提交'}</button>
        </div>`
      }

      if (el.tag === 'iframe') {
        return `
        <div class="form-group">
          <iframe id="${el.id ?? 'lab-iframe'}" src="${el.iframeSrc ?? 'about:blank'}" style="width: 100%; height: 200px; border: 1px solid #e2e8f0; border-radius: 6px;"></iframe>
        </div>`
      }

      return `<div id="${el.id ?? ''}" class="${el.className ?? ''}">${el.text ?? ''}</div>`
    })
    .join('\n')

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>${title}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f8fafc; color: #1e293b; padding: 32px; display: flex; justify-content: center; }
    .card { background: white; border: 1px solid #e2e8f0; border-radius: 12px; padding: 24px; width: 100%; max-width: 520px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); }
    h2 { margin-top: 0; color: #0f172a; font-size: 20px; }
    .form-group { margin-bottom: 16px; }
    label { display: block; font-size: 13px; font-weight: 500; color: #64748b; margin-bottom: 6px; }
    .lab-input, .lab-select { width: 100%; padding: 8px 12px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 14px; box-sizing: border-box; }
    .lab-input:focus, .lab-select:focus { outline: none; border-color: #3b82f6; box-shadow: 0 0 0 2px rgba(59,130,246,0.2); }
    .lab-button { background: #2563eb; color: white; border: none; border-radius: 6px; padding: 10px 16px; font-size: 14px; font-weight: 500; cursor: pointer; width: 100%; }
    .lab-button:hover { background: #1d4ed8; }
    #result-banner { margin-top: 16px; padding: 12px; border-radius: 6px; display: none; font-size: 14px; }
    .success { background: #f0fdf4; border: 1px solid #bbf7d0; color: #166534; }
    .error { background: #fef2f2; border: 1px solid #fecaca; color: #991b1b; }
  </style>
</head>
<body>
  <div class="card">
    <h2 id="page-title">${title}</h2>
    <form id="dynamic-form" onsubmit="return false;">
      ${htmlElements}
      <div id="result-banner"></div>
    </form>
  </div>
  <script>
    const form = document.getElementById('dynamic-form');
    const submitBtn = document.querySelector('.lab-button');
    const banner = document.getElementById('result-banner');

    if (submitBtn) {
      submitBtn.addEventListener('click', async () => {
        const formData = {};
        const inputs = form.querySelectorAll('input, select');
        inputs.forEach(input => {
          if (input.name) formData[input.name] = input.value;
        });

        banner.style.display = 'block';
        banner.className = 'success';
        banner.innerText = '正在提交...';

        try {
          const res = await fetch('${submitAction.apiEndpoint}', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(formData)
          });
          const data = await res.json();
          banner.className = res.ok ? 'success' : 'error';
          banner.innerText = res.ok ? ('${submitAction.successMessage}: ' + JSON.stringify(data)) : '提交失败';
        } catch (e) {
          banner.className = 'error';
          banner.innerText = '请求异常: ' + e.message;
        }
      });
    }
  </script>
</body>
</html>`
}

export function createLabServer() {
  const submissions = []
  let chaosCallCount = 0

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)

    // CORS 预检
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      })
      res.end()
      return
    }

    try {
      // 1. 网络混沌模拟端点
      if (url.pathname === '/lab/chaos') {
        chaosCallCount += 1
        const status = Number(url.searchParams.get('status') ?? 200)
        const delay = Number(url.searchParams.get('delay') ?? 0)
        const flake = Number(url.searchParams.get('flake') ?? 0)

        if (delay > 0) {
          await new Promise((r) => setTimeout(r, delay))
        }

        if (flake > 0 && chaosCallCount % flake !== 0) {
          send(res, 500, { error: 'CHAOS_FLAKE', message: `Flake triggered on call ${chaosCallCount}` })
          return
        }

        send(res, status, { status, message: `Chaos response from lab on call ${chaosCallCount}` })
        return
      }

      // 2. 事实源观察与断言端点
      if (url.pathname === '/lab/inspect') {
        if (req.method === 'GET') {
          send(res, 200, { total: submissions.length, records: submissions })
          return
        }
        if (req.method === 'POST') {
          const body = await readBody(req)
          if (body && typeof body === 'object' && body.action === 'reset') {
            submissions.length = 0
            send(res, 200, { ok: true, message: 'Submissions reset' })
            return
          }
        }
      }

      // 3. 靶场表单提交 API
      if (url.pathname === '/lab/api/submit' && req.method === 'POST') {
        const body = await readBody(req)
        const record = {
          id: `sub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          timestamp: new Date().toISOString(),
          headers: req.headers,
          data: body,
        }
        submissions.push(record)
        send(res, 200, { ok: true, submissionId: record.id, echo: body })
        return
      }

      // 4. 声明式动态页面生成端点
      if (url.pathname === '/lab/dynamic') {
        let spec = {}
        if (req.method === 'GET') {
          const rawSpec = url.searchParams.get('spec')
          if (rawSpec) {
            try {
              spec = JSON.parse(decodeURIComponent(rawSpec))
            } catch {
              spec = { title: 'Dynamic Page (Invalid Spec JSON)' }
            }
          }
        } else if (req.method === 'POST') {
          const body = await readBody(req)
          spec = typeof body === 'object' ? body : {}
        }

        if (spec.delayMs && spec.delayMs > 0) {
          await new Promise((r) => setTimeout(r, spec.delayMs))
        }

        const html = renderDynamicPage(spec)
        send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8' })
        return
      }

      // 5. 默认回落到静态资源
      if (req.method === 'GET') {
        await servePublic(res, url.pathname)
        return
      }

      send(res, 405, 'Method Not Allowed')
    } catch (error) {
      console.error(error)
      send(res, 500, 'Internal Server Error')
    }
  })
}

export function startLabServer(port = 0) {
  return new Promise((resolveReady, reject) => {
    const server = createLabServer()
    server.listen(port, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to obtain lab server address'))
        return
      }
      const actualPort = address.port
      const url = `http://127.0.0.1:${actualPort}`
      resolveReady({
        server,
        port: actualPort,
        url,
        close: () =>
          new Promise((resolveClose, rejectClose) => {
            server.close((err) => (err ? rejectClose(err) : resolveClose()))
          }),
      })
    })
    server.on('error', reject)
  })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  createLabServer().listen(PORT, '127.0.0.1', () => {
    console.log(`target-surface-lab  http://127.0.0.1:${PORT}/`)
  })
}
