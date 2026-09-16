// 动作模块前置验证靶场。仿 SNC DPM 的登录、总览、实例列表（模糊查询、同 URL 详情）、告警分析页。
// 控制接口 /lab/*（无鉴权，只给测试用）：reset、config（界面变体、查询延迟/失败、会话失效）、state。
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { ALARMS, INSTANCES } from './data.mjs'

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

function freshState() {
  return {
    sessions: new Set(),
    config: { ui: 'v1', searchDelayMs: 0, searchFail: false },
    alarms: ALARMS.map((a) => ({ ...a, status: '未处置' })),
    disposeLog: [],
    searchLog: [],
  }
}

function searchInstances(keyword) {
  const k = String(keyword ?? '').trim().toLowerCase()
  return k ? INSTANCES.filter((i) => i.name.toLowerCase().includes(k)) : INSTANCES
}

function shell({ title, crumbs, side, body }) {
  const top = [['数据库', '/front/database/allInstance'], ['告警中心', '/front/alerter/alarmAnalysis'], ['平台管理', '/front/system']]
  const sideItems = side === 'alerter'
    ? [['告警分析', '/front/alerter/alarmAnalysis']]
    : [['总览', '/front/database/allInstance'], ['数据库实例', '/front/database/dbInstance']]
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(title)}_智慧运维管理平台（靶场）</title>
<style>
body{margin:0;font:14px/1.5 system-ui,sans-serif;color:#1f2937}
header{display:flex;gap:16px;background:#1e2533;padding:10px 16px}header a{color:#fff;text-decoration:none}
.layout{display:flex}aside{width:180px;background:#111827;min-height:100vh;padding:8px}aside a{display:block;color:#e5e7eb;padding:8px;text-decoration:none}
main{flex:1;padding:16px}.el-breadcrumb{margin-bottom:12px}.el-breadcrumb__item{margin-right:6px}
table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #e5e7eb;padding:6px;text-align:left}
.el-loading-mask{padding:6px;background:#eef}.el-message{color:#b91c1c}.instance-name{color:#2563eb;cursor:pointer}
[role=dialog]{position:fixed;top:30%;left:35%;background:#fff;border:1px solid #999;padding:16px}
</style></head><body>
<header><div role="menubar">${top.map(([n, h]) => `<a href="${h}"><span role="menuitem">${n}</span></a>`).join('')}</div><span class="user">demo</span></header>
<div class="layout"><aside><div role="menubar">${sideItems.map(([n, h]) => `<a href="${h}"><span role="menuitem">${n}</span></a>`).join('')}</div></aside>
<main><nav aria-label="Breadcrumb" class="el-breadcrumb" id="crumbs">${crumbs.map((c) => `<span class="el-breadcrumb__item"><span class="el-breadcrumb__inner"><a>${esc(c)}</a></span></span>`).join('')}</nav>
${body}</main></div></body></html>`
}

function loginPage(error) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>登录_智慧运维管理平台（靶场）</title></head><body>
<form method="POST" action="/front/login" class="login">
<input class="input-account" type="text" name="username" placeholder="账号" />
<input class="input-account" type="password" name="password" placeholder="密码" />
<button class="el-button el-button--primary" type="submit">登 录</button>
<button class="el-button el-button--primary" type="button">忘记密码</button>
${error ? `<p class="el-message">${esc(error)}</p>` : ''}
</form></body></html>`
}

function overviewPage(state) {
  const systems = new Set(INSTANCES.map((i) => i.app)).size
  const warn = state.alarms.map((a) => `<li>${esc(a.resource)} 于${esc(a.firstAt)} 产生告警 ${esc(a.rule)} 【${esc(a.level)}】</li>`).join('')
  return shell({
    title: '总览', crumbs: ['数据库', '总览'], side: 'db',
    body: `<section class="summary"><div class="card-all"><span>全部</span><ul class="summary-all">
<li><p class="num">${systems}</p><p>系统数</p></li><li><p class="num">${INSTANCES.length}</p><p>实例数</p></li></ul></div></section>
<section><p>当前告警</p><ul class="warn-list">${warn}</ul></section>`,
  })
}

function instancePage(state) {
  const button = state.config.ui === 'v2' ? '查 询' : '搜 索'
  const rows = INSTANCES.map((i) => `<tr role="row"><td role="gridcell"><span class="instance-name">${esc(i.name)}</span></td><td role="gridcell">${esc(i.app)}</td><td role="gridcell">${esc(i.type)}</td><td role="gridcell">${i.sessions}</td></tr>`).join('')
  return shell({
    title: '数据库实例', crumbs: ['数据库', '数据库实例'], side: 'db',
    body: `<section id="list"><span>* 设备列表</span>
<input class="el-input__inner" placeholder="请输入设备名称" />
<button type="button" class="el-button" id="device-search">${button}</button>
<div class="el-loading-mask" hidden>加载中</div><p class="el-message" hidden></p>
<table role="grid" class="device-grid"><thead><tr role="row"><th role="columnheader">名称</th><th role="columnheader">业务系统</th><th role="columnheader">类型</th><th role="columnheader">会话数</th></tr></thead>
<tbody id="rows">${rows}</tbody></table>
<div class="el-table__empty-text" hidden>暂无数据</div>
<span class="el-pagination__total">共 ${INSTANCES.length} 条</span></section>
<section id="detail" hidden><span id="back">返回</span>
<div role="tablist"><span role="tab" aria-selected="true">数据库概览</span><span role="tab" aria-selected="false">性能分析</span></div>
<dl><dt>业务系统</dt><dd id="detail-app"></dd><dt>类型</dt><dd id="detail-type"></dd></dl></section>
<script>
const $ = (s) => document.querySelector(s)
const baseCrumbs = $('#crumbs').innerHTML
function render(list) {
  $('#rows').innerHTML = list.map((i) => '<tr role="row"><td role="gridcell"><span class="instance-name">' + i.name + '</span></td><td role="gridcell">' + i.app + '</td><td role="gridcell">' + i.type + '</td><td role="gridcell">' + i.sessions + '</td></tr>').join('')
  $('.el-table__empty-text').hidden = list.length > 0
  const total = $('.el-pagination__total')
  total.hidden = list.length === 0
  total.textContent = '共 ' + list.length + ' 条'
  window.__list = list
}
window.__list = ${JSON.stringify(INSTANCES)}
$('#device-search').addEventListener('click', async () => {
  $('.el-loading-mask').hidden = false
  $('.el-message').hidden = true
  try {
    const res = await fetch('/lab/api/instances/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keyword: $('input[placeholder="请输入设备名称"]').value }) })
    if (res.status === 401) { location.href = '/front/login'; return }
    if (!res.ok) throw new Error('查询失败')
    render((await res.json()).items)
  } catch (e) {
    $('.el-message').hidden = false
    $('.el-message').textContent = '查询失败'
  } finally {
    $('.el-loading-mask').hidden = true
  }
})
$('#rows').addEventListener('click', (ev) => {
  const el = ev.target.closest('.instance-name')
  if (!el) return
  const item = window.__list.find((i) => i.name === el.textContent)
  $('#list').hidden = true
  $('#detail').hidden = false
  $('#detail-app').textContent = item.app
  $('#detail-type').textContent = item.type
  $('#crumbs').innerHTML = baseCrumbs + '<span class="el-breadcrumb__item"><span class="el-breadcrumb__inner"><a>' + item.name + '</a></span></span>'
})
$('#back').addEventListener('click', () => { $('#detail').hidden = true; $('#list').hidden = false; $('#crumbs').innerHTML = baseCrumbs })
</script>`,
  })
}

function alarmPage(state) {
  const rows = state.alarms.map((a) => `<tr class="el-table__row" data-id="${a.id}"><td></td><td>${esc(a.resource)}</td><td>${esc(a.kind)}</td><td>${esc(a.rule)}</td><td>${esc(a.firstAt)}</td><td>${esc(a.level)}</td><td>${a.count}</td><td class="alarm-status">${esc(a.status)}</td><td><button type="button" class="dispose">处 置</button></td></tr>`).join('')
  return shell({
    title: '告警分析', crumbs: ['告警中心', '告警分析'], side: 'alerter',
    body: `<div role="tablist"><span role="tab" aria-selected="true">当前告警</span><span role="tab" aria-selected="false">历史告警</span></div>
<table class="el-table__header"><thead><tr><th></th><th>资源名称</th><th>告警类型</th><th>告警规则</th><th>首次告警时间</th><th>最高告警等级</th><th>告警事件数量</th><th>状态</th><th>操作</th></tr></thead></table>
<table class="el-table__body"><tbody>${rows}</tbody></table>
<div role="dialog" aria-label="处置告警" hidden><p>确认处置 <b id="dlg-name"></b>？</p><button type="button" id="dlg-ok">确 定</button><button type="button" id="dlg-cancel">取 消</button></div>
<script>
let pending = null
document.querySelectorAll('button.dispose').forEach((b) => b.addEventListener('click', () => {
  pending = b.closest('tr')
  document.getElementById('dlg-name').textContent = pending.children[1].textContent
  document.querySelector('[role=dialog]').hidden = false
}))
document.getElementById('dlg-cancel').addEventListener('click', () => { document.querySelector('[role=dialog]').hidden = true })
document.getElementById('dlg-ok').addEventListener('click', async () => {
  const res = await fetch('/lab/api/alarms/' + pending.dataset.id + '/dispose', { method: 'POST' })
  if (res.ok) pending.querySelector('.alarm-status').textContent = '已处置'
  document.querySelector('[role=dialog]').hidden = true
})
</script>`,
  })
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  return Buffer.concat(chunks).toString('utf8')
}

export function createModuleLab() {
  let state = freshState()
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const send = (status, body, type = 'text/html; charset=utf-8', headers = {}) => {
      res.writeHead(status, { 'Content-Type': type, ...headers })
      res.end(typeof body === 'string' ? body : JSON.stringify(body))
    }
    const json = (status, body) => send(status, body, 'application/json; charset=utf-8')

    if (url.pathname === '/lab/reset' && req.method === 'POST') {
      const { keepSessions } = JSON.parse((await readBody(req)) || '{}')
      const sessions = state.sessions
      state = freshState()
      if (keepSessions) state.sessions = sessions
      return json(200, { ok: true })
    }
    if (url.pathname === '/lab/config' && req.method === 'POST') {
      const patch = JSON.parse((await readBody(req)) || '{}')
      if (patch.expireSessions) state.sessions.clear()
      delete patch.expireSessions
      Object.assign(state.config, patch)
      return json(200, state.config)
    }
    if (url.pathname === '/lab/state') {
      return json(200, { config: state.config, sessions: state.sessions.size, disposeLog: state.disposeLog, searchLog: state.searchLog, alarms: state.alarms })
    }

    if (url.pathname === '/front/login' && req.method === 'GET') return send(200, loginPage())
    if (url.pathname === '/front/login' && req.method === 'POST') {
      const form = new URLSearchParams(await readBody(req))
      if (form.get('username') !== 'labuser' || form.get('password') !== 'labpass') return send(200, loginPage('账号或密码错误'))
      const sid = randomUUID()
      state.sessions.add(sid)
      res.writeHead(302, { Location: '/front/database/allInstance', 'Set-Cookie': `lab_sid=${sid}; Path=/; HttpOnly` })
      return res.end()
    }

    const sid = /(?:^|;\s*)lab_sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]
    const authed = sid && state.sessions.has(sid)
    if (url.pathname.startsWith('/lab/api/')) {
      if (!authed) return json(401, { code: 'UNAUTHENTICATED' })
      if (url.pathname === '/lab/api/instances/search' && req.method === 'POST') {
        const { keyword } = JSON.parse((await readBody(req)) || '{}')
        state.searchLog.push(keyword)
        if (state.config.searchDelayMs) await new Promise((r) => setTimeout(r, state.config.searchDelayMs))
        if (state.config.searchFail) return json(500, { code: 'SEARCH_FAILED' })
        return json(200, { items: searchInstances(keyword) })
      }
      const m = /^\/lab\/api\/alarms\/([^/]+)\/dispose$/.exec(url.pathname)
      if (m && req.method === 'POST') {
        const alarm = state.alarms.find((a) => a.id === m[1])
        if (!alarm) return json(404, { code: 'NOT_FOUND' })
        alarm.status = '已处置'
        state.disposeLog.push({ id: alarm.id, at: new Date().toISOString() })
        return json(200, { ok: true })
      }
      return json(404, { code: 'NOT_FOUND' })
    }

    if (url.pathname === '/' || url.pathname.startsWith('/front/')) {
      if (!authed) { res.writeHead(302, { Location: '/front/login' }); return res.end() }
      if (url.pathname === '/' || url.pathname === '/front/database/allInstance') return send(200, overviewPage(state))
      if (url.pathname === '/front/database/dbInstance') return send(200, instancePage(state))
      if (url.pathname === '/front/alerter/alarmAnalysis') return send(200, alarmPage(state))
    }
    return send(404, 'Not Found', 'text/plain; charset=utf-8')
  })
  return { server, getState: () => state }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.LAB_PORT ?? 4179)
  createModuleLab().server.listen(port, '127.0.0.1', () => console.log(`module lab http://127.0.0.1:${port}/front/login  (labuser / labpass)`))
}
