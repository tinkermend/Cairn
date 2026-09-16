import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

/** A real cookie-authenticated target; fault injection changes the server, never Cairn's facts. */
export async function startSessionTarget() {
  const state = {
    sessions: new Map(),
    logins: [],
    probes: 0,
    reads: [],
    commits: [],
    verifyStatus: null,
    loginReject: false,
    loginDelayMs: 0,
    forceIdentity: null,
    users: new Map([
      ['alice', 'lab-password'],
      ['bob', 'lab-password'],
    ]),
    verifyFault: null,
    loginDropUsers: new Set(),
  }
  let nextProbe, nextCommit, nextLoginPage
  const barriers = new Set()
  function barrier(kind) {
    let entered, release
    const arrived = new Promise((resolve) => {
      entered = resolve
    })
    const pending = new Promise((resolve) => {
      release = resolve
    })
    const gate = {
      entered,
      pending,
      release: () => {
        barriers.delete(gate)
        release()
      },
    }
    barriers.add(gate)
    if (kind === 'probe') nextProbe = gate
    else if (kind === 'commit') nextCommit = gate
    else nextLoginPage = gate
    return { arrived, release: gate.release }
  }
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname
    const sid = /(?:^|;\s*)session_lab=([^;]+)/.exec(
      req.headers.cookie ?? '',
    )?.[1]
    const identity = state.forceIdentity ?? state.sessions.get(sid)
    const json = (code, value) => {
      res.writeHead(code, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      })
      res.end(JSON.stringify(value))
    }
    if (path === '/api/me') {
      state.probes++
      const gate = nextProbe
      nextProbe = undefined
      if (gate) {
        gate.entered({ identity })
        await gate.pending
      }
      if (state.verifyFault === 'disconnect') return req.socket.destroy()
      if (state.verifyFault === 'hang') return
      if (state.verifyFault === 'invalid-json') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end('{"ok":true, BROKEN')
      }
      if (state.verifyStatus)
        return json(state.verifyStatus, {
          error: 'injected infrastructure fault',
        })
      return json(
        identity ? 200 : 401,
        identity ? { ok: true, user: identity } : { ok: false },
      )
    }
    if (path === '/login' && req.method === 'POST') {
      let raw = ''
      for await (const chunk of req) raw += chunk
      const form = new URLSearchParams(raw)
      const user = form.get('username')
      state.logins.push({ user, at: Date.now() })
      if (state.loginDelayMs)
        await new Promise((r) => setTimeout(r, state.loginDelayMs))
      if (
        state.loginReject ||
        !state.users.has(user) ||
        form.get('password') !== state.users.get(user)
      ) {
        res.writeHead(302, { location: '/login?error=credentials' })
        return res.end()
      }
      const token = randomUUID()
      state.sessions.set(token, user)
      if (state.loginDropUsers.has(user)) return req.socket.destroy()
      res.writeHead(302, {
        location: '/app',
        'set-cookie': `session_lab=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600`,
      })
      return res.end()
    }
    if (path === '/login') {
      const gate = nextLoginPage
      nextLoginPage = undefined
      if (gate) {
        gate.entered({ identity })
        await gate.pending
      }
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      })
      return res.end(`<!doctype html><html><body style="font:20px sans-serif"><h1>会话验证靶场</h1>
        <form method="POST" action="/login"><label>账号<input autofocus name="username" style="display:block;width:240px;height:32px"></label>
        <label>密码<input name="password" type="password" style="display:block;width:240px;height:32px"></label>
        <button type="submit" style="height:40px">登录</button></form></body></html>`)
    }
    if (!identity) {
      res.writeHead(302, { location: '/login' })
      return res.end()
    }
    if (
      ['/commit', '/commit-drop', '/commit-hold'].includes(path) &&
      req.method === 'POST'
    ) {
      state.commits.push({ user: identity, path, at: Date.now() })
      if (path === '/commit-drop') return req.socket.destroy()
      if (path === '/commit-hold') {
        const gate = nextCommit
        nextCommit = undefined
        if (gate) {
          gate.entered({ identity })
          await gate.pending
        }
        return json(200, { committed: true })
      }
      state.sessions.clear()
      res.writeHead(302, { location: '/login' })
      return res.end()
    }
    state.reads.push({ user: identity, path, at: Date.now() })
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(`<!doctype html><html><body><h1>业务工作台</h1><p id="identity">${identity}</p>
      <a href="/read">只读查询</a><form method="POST" action="/commit"><button id="commit">提交一次业务操作</button></form>
      <form method="POST" action="/commit-drop"><button id="commit-drop">提交后丢失响应</button></form>
      <form method="POST" action="/commit-hold"><button id="commit-hold">提交后挂起响应</button></form>
      <input id="draft" name="draft"><p id="result">只读数据</p></body></html>`)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return {
    state,
    releaseBarriers: () => { for (const gate of [...barriers]) gate.release() },
    url: `http://127.0.0.1:${server.address().port}`,
    holdNextProbe: () => barrier('probe'),
    holdNextCommit: () => barrier('commit'),
    holdNextLoginPage: () => barrier('login'),
    close: () => {
      for (const gate of barriers) gate.release()
      server.closeAllConnections()
      return new Promise((r) => server.close(r))
    },
  }
}
