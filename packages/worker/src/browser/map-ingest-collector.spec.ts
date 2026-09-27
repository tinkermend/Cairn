import { describe, expect, it } from 'vitest'
import { chromium } from 'playwright'
import { mapJobPolicySchema, mapMenuEntrySchema, targetAccessPolicySchema, type MapIngestPageSnapshot, type MapIngestStep } from '@cairn/shared'
import { belongsToMenuSubtree, collectMapIngestSlice, scanMenu } from './map-ingest-collector.js'

const entry = mapMenuEntrySchema.parse({
  entryId: '00000000-0000-4000-8000-000000000001', version: 1, name: '令牌',
  url: 'https://app.example/tokens', menuAnchor: { label: '令牌' },
  enabled: true, orderIndex: 0, arrivalName: '令牌',
  arrivalTarget: { framePath: [], candidates: [{ by: 'role', value: 'heading', name: '令牌' }] },
})

describe('一级菜单子树边界', () => {
  it('accepts nested nodes and segment-safe path children', () => {
    expect(belongsToMenuSubtree({ label: '详情', ancestors: ['令牌'], role: 'menuitem', hasChildren: false, expanded: false }, entry)).toBe(true)
    expect(belongsToMenuSubtree({ label: '密钥', href: 'https://app.example/tokens/keys', ancestors: [], role: 'link', hasChildren: false, expanded: false }, entry)).toBe(true)
  })

  it('rejects a sibling path and a different origin', () => {
    expect(belongsToMenuSubtree({ label: '管理', href: 'https://app.example/tokens-admin', ancestors: [], role: 'link', hasChildren: false, expanded: false }, entry)).toBe(false)
    expect(belongsToMenuSubtree({ label: '外部', href: 'https://other.example/tokens/keys', ancestors: [], role: 'link', hasChildren: false, expanded: false }, entry)).toBe(false)
  })

  it('compares SPA hash routes by whole path segment', () => {
    const spaEntry = { ...entry, url: 'https://app.example/#/tokens' }
    const node = (href: string) => ({ label: '子页', href, ancestors: [], role: 'link', hasChildren: false, expanded: false })
    expect(belongsToMenuSubtree(node('https://app.example/#/tokens/keys'), spaEntry)).toBe(true)
    expect(belongsToMenuSubtree(node('https://app.example/#/tokens-admin'), spaEntry)).toBe(false)
    expect(belongsToMenuSubtree(node('https://app.example/tokens/keys'), spaEntry)).toBe(false)
  })
})

describe('Ant 弹出子菜单只读采集', () => {
  it('入口页面延迟挂载菜单时等待就绪后侦测', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      await page.route('**/*', route => route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><html><head><meta charset="utf-8"></head><body>
        <aside id="sidebar"></aside><script>setTimeout(() => {
          document.getElementById('sidebar').innerHTML = '<nav><a href="/tokens">令牌</a></nav>'
        }, 300)</script></body></html>` }))
      const result = await collectMapIngestSlice({
        page, step: { jobId: '00000000-0000-4000-8000-000000000016', startUrl: 'https://app.example/',
          scope: 'detect_top_menus', entries: [], cursor: null,
          policy: mapJobPolicySchema.parse({ schemaVersion: 1, policyVersion: 1,
            manualJobsEnabled: true, ingestSettleTimeoutSeconds: 2 }),
          allowedSpaHashPrefixes: ['#/'], sliceWorkSeconds: 10 },
        targetId: '00000000-0000-4000-8000-000000000004',
        targetAccountId: '00000000-0000-4000-8000-000000000005',
        accessPolicy: targetAccessPolicySchema.parse({ schemaVersion: 1, policyVersion: 1,
          rules: [{ origin: 'https://app.example', purpose: 'business_surface', effect: 'allow' }] }),
        guard: { getBlockedRequests: () => [], getInferredReadPosts: () => [], getDialogs: () => [], wasDialogEncountered: () => false,
          uninstall: async () => {} },
        signal: new AbortController().signal,
        onProgress: async () => {},
      })
      expect(result.detectedMenus).toEqual([expect.objectContaining({ label: '令牌', url: 'https://app.example/tokens' })])
      expect(result.nodes).toEqual([])
    } finally { await browser.close() }
  })

  it('显式 URL 的页面延迟渲染时仍记录可见元素', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      await page.route('**/*', route => route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html>
        <html><head><meta charset="utf-8"><title>令牌</title></head><body>
        <nav><a href="/tokens">令牌</a></nav><div class="content-wrapper" id="root"></div>
        <script>setTimeout(() => {document.getElementById('root').innerHTML =
          '<main><h1>令牌</h1><button>新建令牌</button></main>'}, 300)</script>
        </body></html>` }))
      const snapshots: MapIngestPageSnapshot[] = []
      const result = await collectMapIngestSlice({
        page, step: { jobId: '00000000-0000-4000-8000-000000000017', startUrl: 'https://app.example/',
          scope: 'entries', entries: [entry], cursor: null,
          policy: mapJobPolicySchema.parse({ schemaVersion: 1, policyVersion: 1,
            manualJobsEnabled: true, ingestSettleTimeoutSeconds: 2 }),
          allowedSpaHashPrefixes: ['#/'], sliceWorkSeconds: 10 },
        targetId: '00000000-0000-4000-8000-000000000004',
        targetAccountId: '00000000-0000-4000-8000-000000000005',
        accessPolicy: targetAccessPolicySchema.parse({ schemaVersion: 1, policyVersion: 1,
          rules: [{ origin: 'https://app.example', purpose: 'business_surface', effect: 'allow' }] }),
        guard: { getBlockedRequests: () => [], getInferredReadPosts: () => [], getDialogs: () => [], wasDialogEncountered: () => false,
          uninstall: async () => {} },
        signal: new AbortController().signal,
        onProgress: async (_cursor, snapshot) => { if (snapshot) snapshots.push(snapshot) },
      })
      expect(result.nodes.some(node => node.code === 'collected')).toBe(true)
      expect(snapshots[0]?.elements).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'heading', name: '令牌' }),
        expect.objectContaining({ role: 'button', name: '新建令牌' }),
      ]))
    } finally { await browser.close() }
  })

  it('ping 与已核实的非内容请求保留审计，未知 fetch 仍标记 partial', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      for (const resourceType of ['ping', 'fetch', 'verified_fetch']) {
        const page = await browser.newPage()
        const blockedRequests: Array<{ url: string; method: string; resourceType: string; reason: string; timestamp: string; impactBasis?: 'verified_non_content_rule' }> = []
        await page.route('**/*', route => {
          const url = new URL(route.request().url())
          if (url.pathname === '/tokens') blockedRequests.push({
            url: url.origin + '/telemetry', method: 'POST', resourceType: resourceType === 'verified_fetch' ? 'fetch' : resourceType,
            reason: 'POST 未命中只读规则', timestamp: new Date().toISOString(),
            ...(resourceType === 'verified_fetch' ? { impactBasis: 'verified_non_content_rule' as const } : {}),
          })
          return route.fulfill({ status: 200, contentType: 'text/html', body:
            '<!doctype html><html><head><meta charset="utf-8"><title>令牌</title></head><body>'
            + '<nav><a href="/tokens">令牌</a></nav><main><h1>令牌</h1></main></body></html>' })
        })
        const snapshots: MapIngestPageSnapshot[] = []
        const result = await collectMapIngestSlice({
          page, step: { jobId: '00000000-0000-4000-8000-000000000019', startUrl: 'https://app.example/',
            scope: 'entries', entries: [entry], cursor: null,
            policy: mapJobPolicySchema.parse({ schemaVersion: 1, policyVersion: 1,
              manualJobsEnabled: true, ingestSettleTimeoutSeconds: 1 }),
            allowedSpaHashPrefixes: ['#/'], sliceWorkSeconds: 10 },
          targetId: '00000000-0000-4000-8000-000000000004',
          targetAccountId: '00000000-0000-4000-8000-000000000005',
          accessPolicy: targetAccessPolicySchema.parse({ schemaVersion: 1, policyVersion: 1,
            rules: [{ origin: 'https://app.example', purpose: 'business_surface', effect: 'allow' }] }),
          guard: { getBlockedRequests: () => blockedRequests, getInferredReadPosts: () => [], getDialogs: () => [], wasDialogEncountered: () => false,
            uninstall: async () => {} },
          signal: new AbortController().signal,
          onProgress: async (_cursor, snapshot) => { if (snapshot) snapshots.push(snapshot) },
        })
        expect(result.blockedRequests.some(request => request.resourceType === (resourceType === 'verified_fetch' ? 'fetch' : resourceType))).toBe(true)
        expect(result.blockedImpactCounts[resourceType === 'ping' ? 'unreadable_ping'
          : resourceType === 'verified_fetch' ? 'verified_non_content_rule' : 'unclassified']).toBe(1)
        expect(snapshots[0]?.completeness).toBe(resourceType === 'fetch' ? 'partial' : 'complete')
        await page.close()
      }
    } finally { await browser.close() }
  })

  it('页面有顶栏和侧栏两处导航时优先选中含授权菜单的容器', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      await page.setContent(`<header><nav><a href="/home">首页</a><a href="/help">帮助</a></nav></header>
        <aside><nav><a href="/tokens">令牌</a><a href="/tokens/keys">密钥</a><a href="/roles">角色</a></nav></aside>`)
      const scan = await scanMenu(page, ['令牌'])
      expect(scan.nodes.map(node => node.label)).toEqual(['令牌', '密钥', '角色'])
    } finally { await browser.close() }
  })

  it('独立二级菜单只加入同一入口路径下的节点', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      await page.route('**/*', route => route.fulfill({ status: 200, contentType: 'text/html', body: `<meta charset="utf-8">
        <nav id="primary"><a href="/tokens">令牌</a><a href="/roles">角色</a></nav>
        <nav id="secondary"><a href="/tokens/keys">密钥</a><a href="/roles/audit">角色审计</a></nav>` }))
      await page.goto('https://app.example/tokens')
      const scan = await scanMenu(page, ['令牌'], 'https://app.example/tokens')
      expect(scan.nodes).toEqual(expect.arrayContaining([
        expect.objectContaining({ label: '密钥', ancestors: ['令牌'] }),
      ]))
      expect(scan.nodes.some(node => node.label === '角色审计')).toBe(false)
    } finally { await browser.close() }
  })

  it('入口和子页重定向后不会把已尝试的菜单链接反复加入队列', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      await page.route('**/*', route => {
        const path = new URL(route.request().url()).pathname
        return route.fulfill({ status: 200, contentType: 'text/html', body: `<meta charset="utf-8">
          <nav><a href="/tokens">令牌</a><a href="/tokens/keys">密钥</a></nav>
          <main><h1>令牌</h1><button>查看令牌</button></main>
          ${path === '/tokens' ? '<script>history.replaceState(null, "", "/tokens/list")</script>' : ''}
          ${path === '/tokens/keys' ? '<script>history.replaceState(null, "", "/tokens/license")</script>' : ''}` })
      })
      const result = await collectMapIngestSlice({
        page, step: { jobId: '00000000-0000-4000-8000-000000000018', startUrl: 'https://app.example/',
          scope: 'entries', entries: [entry], cursor: null,
          policy: mapJobPolicySchema.parse({ schemaVersion: 1, policyVersion: 1,
            manualJobsEnabled: true, ingestSettleTimeoutSeconds: 1 }),
          allowedSpaHashPrefixes: ['#/'], sliceWorkSeconds: 10 },
        targetId: '00000000-0000-4000-8000-000000000004',
        targetAccountId: '00000000-0000-4000-8000-000000000005',
        accessPolicy: targetAccessPolicySchema.parse({ schemaVersion: 1, policyVersion: 1,
          rules: [{ origin: 'https://app.example', purpose: 'business_surface', effect: 'allow' }] }),
        guard: { getBlockedRequests: () => [], getInferredReadPosts: () => [], getDialogs: () => [], wasDialogEncountered: () => false,
          uninstall: async () => {} },
        signal: new AbortController().signal,
        onProgress: async () => {},
      })
      expect(result.cursor.entryIndex).toBe(1)
      expect(result.cursor.processedNodes).toBe(2)
      expect(result.cursor.attemptedNodeKeys).toHaveLength(2)
      expect(result.nodes).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'collected' }),
      ]))
    } finally { await browser.close() }
  })

  it('配置忽略的易变查询参数不会把同一菜单页重复采集', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      await page.route('**/*', route => route.fulfill({ status: 200, contentType: 'text/html',
        body: '<!doctype html><html><head><meta charset="utf-8"><title>令牌</title></head><body>'
          + '<nav><a href="/tokens?nonce=two">令牌</a></nav><main><h1>令牌</h1></main></body></html>' }))
      const snapshots: MapIngestPageSnapshot[] = []
      const result = await collectMapIngestSlice({
        page, step: { jobId: '00000000-0000-4000-8000-000000000020', startUrl: 'https://app.example/',
          scope: 'entries', entries: [{ ...entry, url: 'https://app.example/tokens?nonce=one' }], cursor: null,
          policy: mapJobPolicySchema.parse({ schemaVersion: 1, policyVersion: 1,
            manualJobsEnabled: true, ingestSettleTimeoutSeconds: 1 }),
          allowedSpaHashPrefixes: ['#/'], ignoreQueryParams: ['nonce'], sliceWorkSeconds: 10 },
        targetId: '00000000-0000-4000-8000-000000000004',
        targetAccountId: '00000000-0000-4000-8000-000000000005',
        accessPolicy: targetAccessPolicySchema.parse({ schemaVersion: 1, policyVersion: 1,
          rules: [{ origin: 'https://app.example', purpose: 'business_surface', effect: 'allow' }] }),
        guard: { getBlockedRequests: () => [], getInferredReadPosts: () => [], getDialogs: () => [], wasDialogEncountered: () => false,
          uninstall: async () => {} },
        signal: new AbortController().signal,
        onProgress: async (_cursor, snapshot) => { if (snapshot) snapshots.push(snapshot) },
      })
      expect(result.cursor.entryIndex).toBe(1)
      expect(result.cursor.visitedPageKeys).toHaveLength(1)
      expect(snapshots).toHaveLength(1)
    } finally { await browser.close() }
  })

  it('只进入受控 popup 的子项，记录内容区按钮但不点击', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      let writes = 0
      let contentLinkNavigations = 0
      const html = (path: string) => `<!doctype html><html><head><meta charset="utf-8"><title>夹具</title></head><body>
        <ul class="ant-menu" role="menu"><li role="menuitem" data-menu-id="menu-admin" aria-controls="menu-admin-popup" aria-expanded="false" onclick="document.getElementById('menu-admin-popup').style.display='block';this.setAttribute('aria-expanded','true')">管理</li></ul>
        <div class="ant-menu-submenu-popup" id="menu-admin-popup" style="display:none"><ul class="ant-menu" role="menu"><li role="menuitem"><a href="/tokens">令牌</a></li><li role="menuitem"><a href="/roles">角色</a></li></ul></div>
        <main><h1>${path === '/tokens' ? '令牌列表' : path === '/roles' ? '角色列表' : '首页'}</h1><a href="/tokens-admin">内容区链接</a>
        <button onclick="fetch('/api/delete',{method:'POST'})">删除配置</button></main></body></html>`
      await page.route('**/*', async route => {
        const url = new URL(route.request().url())
        if (route.request().method() === 'POST') { writes++; await route.fulfill({ status: 200, body: '{}' }); return }
        if (url.pathname === '/tokens-admin') contentLinkNavigations++
        await route.fulfill({ status: 200, contentType: 'text/html', body: html(url.pathname) })
      })
      await page.goto('https://app.example/')
      const initial = await scanMenu(page)
      expect(initial.nodes.map(node => node.label)).toContain('管理')
      expect(await page.getByRole('menuitem', { name: '管理', exact: true }).count()).toBe(1)
      expect(initial.nodes.some(node => node.label === '内容区链接')).toBe(false)
      const snapshots: MapIngestPageSnapshot[] = []
      const menu = mapMenuEntrySchema.parse({
        entryId: '00000000-0000-4000-8000-000000000002', version: 1, name: '管理',
        menuAnchor: { label: '管理' }, enabled: true, orderIndex: 0,
        arrivalName: '管理', arrivalTarget: { framePath: [], candidates: [{ by: 'role', value: 'menuitem', name: '管理' }] },
      })
      const policy = targetAccessPolicySchema.parse({ schemaVersion: 1, policyVersion: 1,
        rules: [{ origin: 'https://app.example', purpose: 'business_surface', effect: 'allow' }] })
      const abort = new AbortController()
      const step: MapIngestStep['input'] = {
        jobId: '00000000-0000-4000-8000-000000000003', startUrl: 'https://app.example/',
        scope: 'full', entries: [menu], cursor: null,
        policy: mapJobPolicySchema.parse({ schemaVersion: 1, policyVersion: 1, manualJobsEnabled: true }),
        allowedSpaHashPrefixes: ['#/'],
        sliceWorkSeconds: 10,
      }
      const collection = {
        page,
        step,
        targetId: '00000000-0000-4000-8000-000000000004',
        targetAccountId: '00000000-0000-4000-8000-000000000005',
        accessPolicy: policy,
        guard: { getBlockedRequests: () => [], getInferredReadPosts: () => [], getDialogs: () => [], wasDialogEncountered: () => false,
          uninstall: async () => {} },
        signal: abort.signal,
        onProgress: async (_cursor: unknown, snapshot?: MapIngestPageSnapshot) => {
          if (snapshot) { snapshots.push(snapshot); abort.abort() }
        },
      }
      const first = await collectMapIngestSlice(collection)
      expect(first.cursor.entryIndex).toBe(0)
      expect(first.cursor.queue).toHaveLength(1)
      const second = await collectMapIngestSlice({
        ...collection,
        step: { ...collection.step, cursor: first.cursor },
        signal: new AbortController().signal,
        onProgress: async (_cursor, snapshot) => { if (snapshot) snapshots.push(snapshot) },
      })
      expect(second.cursor.entryIndex).toBe(1)
      expect(snapshots).toHaveLength(2)
      expect(snapshots[0]!.elements).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'heading', name: '令牌列表', locatorUnique: true }),
        expect.objectContaining({ role: 'button', name: '删除配置', unsafeAction: true }),
      ]))
      expect(snapshots[1]!.elements).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'heading', name: '角色列表' }),
      ]))
      expect(writes).toBe(0)
      expect(contentLinkNavigations).toBe(0)
    } finally { await browser.close() }
  }, 20_000)

  it('菜单无法识别时只采显式 URL 入口一次，并标记结果为部分完成', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      await page.route('**/*', route => route.fulfill({ status: 200, contentType: 'text/html',
        body: '<!doctype html><html><head><meta charset="utf-8"><title>入口</title></head><body><main><h1>入口页面</h1></main></body></html>' }))
      const urlEntry = mapMenuEntrySchema.parse({ ...entry, entryId: '00000000-0000-4000-8000-000000000010',
        url: 'https://app.example/entry', name: '入口', menuAnchor: { label: '入口' } })
      const anchorEntry = mapMenuEntrySchema.parse({ ...entry, entryId: '00000000-0000-4000-8000-000000000011',
        url: undefined, name: '其他', menuAnchor: { label: '其他' } })
      const snapshots: MapIngestPageSnapshot[] = []
      const result = await collectMapIngestSlice({
        page, step: { jobId: '00000000-0000-4000-8000-000000000012', startUrl: 'https://app.example/',
          scope: 'full', entries: [urlEntry, anchorEntry], cursor: null,
          policy: mapJobPolicySchema.parse({ schemaVersion: 1, policyVersion: 1,
            manualJobsEnabled: true, ingestSettleTimeoutSeconds: 1 }),
          allowedSpaHashPrefixes: ['#/'],
          sliceWorkSeconds: 10 },
        targetId: '00000000-0000-4000-8000-000000000004',
        targetAccountId: '00000000-0000-4000-8000-000000000005',
        accessPolicy: targetAccessPolicySchema.parse({ schemaVersion: 1, policyVersion: 1,
          rules: [{ origin: 'https://app.example', purpose: 'business_surface', effect: 'allow' }] }),
        guard: { getBlockedRequests: () => [], getInferredReadPosts: () => [], getDialogs: () => [], wasDialogEncountered: () => false,
          uninstall: async () => {} },
        signal: new AbortController().signal,
        onProgress: async (_cursor, snapshot) => { if (snapshot) snapshots.push(snapshot) },
      })
      expect(result.cursor.entryIndex).toBe(2)
      expect(result.nodes.filter(node => node.code === 'menu_container_unresolved')).toHaveLength(2)
      expect(snapshots).toHaveLength(1)
      expect(snapshots[0]?.urlPattern).toBe('https://app.example/entry')
    } finally { await browser.close() }
  })

  it('只展开内容区安全折叠面板读取字段，随后恢复关闭状态', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      await page.route('**/*', route => route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><html><head><meta charset="utf-8"><title>筛选页</title></head><body><main>
        <h1>令牌列表</h1>
        <button aria-expanded="false" aria-controls="filters" onclick="const p=document.getElementById('filters');p.hidden=!p.hidden;this.setAttribute('aria-expanded',String(!p.hidden))">展开更多筛选</button>
        <div id="filters" hidden><label>状态 <select><option>已启用</option><option>已停用</option></select></label></div>
        <button aria-expanded="false" aria-controls="danger" onclick="window.dangerClicks=(window.dangerClicks||0)+1">删除配置</button>
      </main></body></html>` }))
      const snapshots: MapIngestPageSnapshot[] = []
      const result = await collectMapIngestSlice({
        page, step: { jobId: '00000000-0000-4000-8000-000000000012', startUrl: 'https://app.example/',
          scope: 'full', entries: [entry], cursor: null,
          policy: mapJobPolicySchema.parse({ schemaVersion: 1, policyVersion: 1, manualJobsEnabled: true }),
          allowedSpaHashPrefixes: ['#/'], sliceWorkSeconds: 10 },
        targetId: '00000000-0000-4000-8000-000000000004',
        targetAccountId: '00000000-0000-4000-8000-000000000005',
        accessPolicy: targetAccessPolicySchema.parse({ schemaVersion: 1, policyVersion: 1,
          rules: [{ origin: 'https://app.example', purpose: 'business_surface', effect: 'allow' }] }),
        guard: { getBlockedRequests: () => [], getInferredReadPosts: () => [], getDialogs: () => [], wasDialogEncountered: () => false,
          uninstall: async () => {} },
        signal: new AbortController().signal,
        onProgress: async (_cursor, snapshot) => { if (snapshot) snapshots.push(snapshot) },
      })
      expect(result.cursor.entryIndex).toBe(1)
      expect(snapshots).toHaveLength(1)
      expect(snapshots[0]!.elements).toEqual(expect.arrayContaining([
        expect.objectContaining({ category: 'input', name: '状态', options: ['已启用', '已停用'] }),
      ]))
      expect(await page.getByRole('button', { name: '展开更多筛选' }).getAttribute('aria-expanded')).toBe('false')
      expect(await page.evaluate(() => (window as any).dangerClicks ?? 0)).toBe(0)
    } finally { await browser.close() }
  }, 20_000)

  it('内容区展开触发确认弹窗后停止该页面剩余交互并标记部分完成', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      const dialogs: Array<{ type: string; message: string; timestamp: string }> = []
      page.on('dialog', dialog => {
        dialogs.push({ type: dialog.type(), message: dialog.message(), timestamp: new Date().toISOString() })
        void dialog.dismiss()
      })
      await page.route('**/*', route => route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><html><head><meta charset="utf-8"><title>令牌</title></head><body><main>
        <h1>令牌</h1>
        <button aria-expanded="false" aria-controls="first" onclick="alert('确认')">展开筛选</button>
        <button aria-expanded="false" aria-controls="second" onclick="window.secondClicks=(window.secondClicks||0)+1">展开更多</button>
      </main></body></html>` }))
      const snapshots: MapIngestPageSnapshot[] = []
      const result = await collectMapIngestSlice({
        page, step: { jobId: '00000000-0000-4000-8000-000000000015', startUrl: 'https://app.example/',
          scope: 'full', entries: [entry], cursor: null,
          policy: mapJobPolicySchema.parse({ schemaVersion: 1, policyVersion: 1, manualJobsEnabled: true }),
          allowedSpaHashPrefixes: ['#/'], sliceWorkSeconds: 10 },
        targetId: '00000000-0000-4000-8000-000000000004',
        targetAccountId: '00000000-0000-4000-8000-000000000005',
        accessPolicy: targetAccessPolicySchema.parse({ schemaVersion: 1, policyVersion: 1,
          rules: [{ origin: 'https://app.example', purpose: 'business_surface', effect: 'allow' }] }),
        guard: { getBlockedRequests: () => [], getInferredReadPosts: () => [], getDialogs: () => dialogs,
          wasDialogEncountered: () => dialogs.length > 0, uninstall: async () => {} },
        signal: new AbortController().signal,
        onProgress: async (_cursor, snapshot) => { if (snapshot) snapshots.push(snapshot) },
      })
      expect(result.nodes.some(node => node.code === 'dialog_dismissed')).toBe(true)
      expect(snapshots[0]).toMatchObject({ completeness: 'partial', reasons: ['dialog_dismissed'] })
      expect(await page.evaluate(() => (window as any).secondClicks ?? 0)).toBe(0)
    } finally { await browser.close() }
  }, 20_000)

  it('优先使用一级菜单定位描述，到达标志不符但路由匹配时仅保留部分页面事实', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      await page.route('**/*', route => route.fulfill({ status: 200, contentType: 'text/html',
        body: `<!doctype html><html><head><meta charset="utf-8"><title>应用</title></head><body>
          <nav><a data-testid="tokens-menu" href="/tokens">令牌新版</a></nav>
          <main><h1>${new URL(route.request().url()).pathname === '/tokens' ? '令牌页面' : '首页'}</h1></main>
        </body></html>` }))
      const menu = mapMenuEntrySchema.parse({ ...entry, menuAnchor: { label: '旧令牌',
        locator: { framePath: [], candidates: [{ by: 'testId', value: 'tokens-menu' }] } },
        arrivalName: '令牌页面', arrivalTarget: { framePath: [],
          candidates: [{ by: 'role', value: 'heading', name: '令牌页面' }] } })
      const snapshots: MapIngestPageSnapshot[] = []
      const base = {
        page, targetId: '00000000-0000-4000-8000-000000000004',
        targetAccountId: '00000000-0000-4000-8000-000000000005',
        accessPolicy: targetAccessPolicySchema.parse({ schemaVersion: 1, policyVersion: 1,
          rules: [{ origin: 'https://app.example', purpose: 'business_surface', effect: 'allow' }] }),
        guard: { getBlockedRequests: () => [], getInferredReadPosts: () => [], getDialogs: () => [], wasDialogEncountered: () => false,
          uninstall: async () => {} }, signal: new AbortController().signal,
        onProgress: async (_cursor: unknown, snapshot?: MapIngestPageSnapshot) => { if (snapshot) snapshots.push(snapshot) },
      }
      const step = { jobId: '00000000-0000-4000-8000-000000000012', startUrl: 'https://app.example/',
        scope: 'full' as const, entries: [menu], cursor: null,
        policy: mapJobPolicySchema.parse({ schemaVersion: 1, policyVersion: 1,
          manualJobsEnabled: true, ingestSettleTimeoutSeconds: 1 }),
        allowedSpaHashPrefixes: ['#/'], sliceWorkSeconds: 10 }
      const result = await collectMapIngestSlice({ ...base, step })
      expect(result.nodes.some(node => node.code === 'anchor_unresolved')).toBe(false)
      expect(snapshots).toHaveLength(1)
      snapshots.length = 0
      const blockedMenu = { ...menu, arrivalName: '不存在的页面',
        arrivalTarget: { framePath: [], candidates: [{ by: 'role' as const, value: 'heading', name: '不存在的页面' }] } }
      const blocked = await collectMapIngestSlice({ ...base, step: { ...step,
        jobId: '00000000-0000-4000-8000-000000000013', entries: [blockedMenu] } })
      expect(blocked.nodes.some(node => node.code === 'anchor_unresolved')).toBe(true)
      expect(snapshots).toHaveLength(1)
      expect(snapshots[0]).toMatchObject({ completeness: 'partial', reasons: ['anchor_unresolved'] })
    } finally { await browser.close() }
  }, 20_000)

  it('无显式导航语义时只信任跨页面稳定的侧栏，不进入内容区链接', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      let contentVisits = 0
      await page.route('**/*', route => {
        const path = new URL(route.request().url()).pathname
        if (path === '/tokens/admin') contentVisits++
        return route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><html><head><meta charset="utf-8"><title>令牌</title></head><body>
          <aside><a href="/tokens">令牌</a><a href="/tokens/keys">密钥</a><a href="/other">其他</a>
            <button aria-expanded="false" aria-controls="sidebar-group" onclick="window.sidebarClicks=(window.sidebarClicks||0)+1">菜单分组</button>
            <button role="combobox" onclick="window.sidebarClicks=(window.sidebarClicks||0)+1">菜单筛选</button>
            <button role="tab" aria-selected="true">侧栏一</button><button role="tab" aria-selected="false" onclick="window.sidebarClicks=(window.sidebarClicks||0)+1">侧栏二</button>
          </aside>
          <main><h1>令牌</h1><a href="/tokens/admin">内容区链接</a></main>
        </body></html>` })
      })
      const snapshots: MapIngestPageSnapshot[] = []
      const result = await collectMapIngestSlice({
        page, step: { jobId: '00000000-0000-4000-8000-000000000014', startUrl: 'https://app.example/',
          scope: 'full', entries: [entry], cursor: null,
          policy: mapJobPolicySchema.parse({ schemaVersion: 1, policyVersion: 1, manualJobsEnabled: true }),
          allowedSpaHashPrefixes: ['#/'], sliceWorkSeconds: 10 },
        targetId: '00000000-0000-4000-8000-000000000004',
        targetAccountId: '00000000-0000-4000-8000-000000000005',
        accessPolicy: targetAccessPolicySchema.parse({ schemaVersion: 1, policyVersion: 1,
          rules: [{ origin: 'https://app.example', purpose: 'business_surface', effect: 'allow' }] }),
        guard: { getBlockedRequests: () => [], getInferredReadPosts: () => [], getDialogs: () => [], wasDialogEncountered: () => false,
          uninstall: async () => {} },
        signal: new AbortController().signal,
        onProgress: async (_cursor, snapshot) => { if (snapshot) snapshots.push(snapshot) },
      })
      expect(result.cursor.entryIndex).toBe(1)
      expect(snapshots.map(snapshot => snapshot.urlPattern)).toEqual([
        'https://app.example/tokens', 'https://app.example/tokens/keys',
      ])
      expect(contentVisits).toBe(0)
      expect(await page.evaluate(() => (window as any).sidebarClicks ?? 0)).toBe(0)
    } finally { await browser.close() }
  }, 20_000)
})
