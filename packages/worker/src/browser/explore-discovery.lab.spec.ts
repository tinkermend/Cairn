import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser } from 'playwright'
import {
  collectSurfaceExploration,
} from './explore-candidate-collector.js'
import { installExploreGuard } from './explore-network-guard.js'

describe('双目标实验室验证：候选发现、三级状态提取与网络守卫 (EX-D01~D03, EX-A01~A05)', () => {
  let browser: Browser

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true })
  })

  afterAll(async () => {
    await browser?.close()
  })

  it('目标 1：modelapi 中转站控制台线索提取与写操作过滤', async () => {
    const page = await browser.newPage()
    try {
      // 模拟 modelapi 控制台典型结构
      await page.setContent(`
        <!DOCTYPE html>
        <html>
        <head><title>ModelAPI 仪表盘</title></head>
        <body>
          <aside class="sidebar">
            <nav aria-label="侧边导航">
              <ul>
                <li><a href="/dashboard" class="nav-item">仪表盘</a></li>
                <li><a href="/tokens" class="nav-item">API 令牌</a></li>
                <li><a href="/models" class="nav-item">可用模型</a></li>
                <li><a href="/billing" class="nav-item">账单充值</a></li>
                <li><a href="https://external-blog.com/news" class="nav-item">外部博客</a></li>
              </ul>
              <div>
                <button id="btn-export" type="button">导出凭据</button>
                <button id="btn-delete" type="button">删除账号</button>
              </div>
            </nav>
          </aside>
          <main>
            <h1>API 令牌管理</h1>
            <button id="btn-show-docs" type="button" aria-expanded="false">展开调用文档</button>
          </main>
        </body>
        </html>
      `)

      const bundle = await collectSurfaceExploration({
        page,
        targetId: 'target-modelapi',
        allowedOrigins: ['https://modelapi.im'],
        allowlist: ['https://modelapi.im/'],
        baseUrl: 'https://modelapi.im/dashboard',
      })

      expect(bundle.candidates.length).toBeGreaterThan(0)

      // 1. 验证目标已知链接提取
      const tokensCand = bundle.candidates.find((c) => c.accessibleName === 'API 令牌')
      expect(tokensCand).toBeDefined()
      expect(tokensCand?.candidateCategory).toBe('explicit_url')
      expect(tokensCand?.canonicalTargetUrl).toBe('https://modelapi.im/tokens')
      expect(tokensCand?.rejectionReason).toBeUndefined()

      const modelsCand = bundle.candidates.find((c) => c.accessibleName === '可用模型')
      expect(modelsCand).toBeDefined()
      expect(modelsCand?.candidateCategory).toBe('explicit_url')
      expect(modelsCand?.canonicalTargetUrl).toBe('https://modelapi.im/models')

      // 2. 验证外部域名被拦截拒绝
      const externalCand = bundle.candidates.find((c) => c.accessibleName === '外部博客')
      expect(externalCand).toBeDefined()
      expect(externalCand?.rejectionReason).toContain('超出探索 allowlist 范围')

      // 3. 验证破坏性/写入动作被标记拒绝
      const deleteCand = bundle.candidates.find((c) => c.accessibleName === '删除账号')
      expect(deleteCand).toBeDefined()
      expect(deleteCand?.rejectionReason).toContain('疑似写入/危险动作')

      const exportCand = bundle.candidates.find((c) => c.accessibleName === '导出凭据')
      expect(exportCand).toBeDefined()
      expect(exportCand?.rejectionReason).toContain('疑似写入/危险动作')

      // 4. 验证展开控件被归类为 reveal
      const revealCand = bundle.candidates.find((c) => c.accessibleName === '展开调用文档')
      expect(revealCand).toBeDefined()
      expect(revealCand?.candidateCategory).toBe('reveal')
    } finally {
      await page.close()
    }
  })

  it('目标 2：智慧运维管理平台 (DPM) 数据库实例树状菜单与展开控件识别', async () => {
    const page = await browser.newPage()
    try {
      // 模拟 智慧运维管理平台 (DPM) 菜单结构
      await page.setContent(`
        <!DOCTYPE html>
        <html>
        <head><title>智慧运维管理平台</title></head>
        <body>
          <div class="ant-layout-sider">
            <ul class="ant-menu">
              <li class="ant-menu-submenu">
                <div class="ant-menu-submenu-title" role="button" aria-expanded="false">
                  <span>数据库监控</span>
                </div>
                <ul class="ant-menu-sub">
                  <li class="ant-menu-item"><a href="/front/database/allInstance">实例总览</a></li>
                  <li class="ant-menu-item"><a href="/front/database/oracle">Oracle 实例</a></li>
                  <li class="ant-menu-item"><a href="/front/database/mysql">MySQL 实例</a></li>
                  <li class="ant-menu-item"><button type="button">重启所有实例</button></li>
                </ul>
              </li>
            </ul>
          </div>
          <div class="ant-layout-content">
            <h2>实例总览列表</h2>
          </div>
        </body>
        </html>
      `)

      const bundle = await collectSurfaceExploration({
        page,
        targetId: 'target-dpm',
        allowedOrigins: ['http://61.144.35.2:18804'],
        allowlist: ['http://61.144.35.2:18804/front/'],
        baseUrl: 'http://61.144.35.2:18804/front/database/allInstance',
      })

      // 验证 Oracle 实例与 MySQL 实例提取
      const oracleCand = bundle.candidates.find((c) => c.accessibleName === 'Oracle 实例')
      expect(oracleCand).toBeDefined()
      expect(oracleCand?.candidateCategory).toBe('explicit_url')
      expect(oracleCand?.canonicalTargetUrl).toBe('http://61.144.35.2:18804/front/database/oracle')

      const mysqlCand = bundle.candidates.find((c) => c.accessibleName === 'MySQL 实例')
      expect(mysqlCand).toBeDefined()
      expect(mysqlCand?.candidateCategory).toBe('explicit_url')
      expect(mysqlCand?.canonicalTargetUrl).toBe('http://61.144.35.2:18804/front/database/mysql')

      // 验证展开菜单控件分类
      const subMenuTitle = bundle.candidates.find((c) => c.accessibleName === '数据库监控')
      expect(subMenuTitle).toBeDefined()
      expect(subMenuTitle?.candidateCategory).toBe('reveal')

      // 验证危险操作被拦截
      const restartBtn = bundle.candidates.find((c) => c.accessibleName === '重启所有实例')
      expect(restartBtn).toBeDefined()
      expect(restartBtn?.rejectionReason).toBeDefined()
    } finally {
      await page.close()
    }
  })

  it('网络守卫与弹窗自动拦截验证', async () => {
    const page = await browser.newPage()
    try {
      const guard = await installExploreGuard(page.context(), {
        allowlist: [{ origin: 'http://127.0.0.1' }],
        allowedOrigins: ['http://127.0.0.1'],
      })

      // 触发弹窗
      await page.evaluate(() => {
        try {
          window.alert('测试警告弹窗')
        } catch {}
      })

      expect(guard.wasDialogEncountered()).toBe(true)
      expect(guard.getDialogs().length).toBe(1)
      expect(guard.getDialogs()[0]?.message).toBe('测试警告弹窗')
      await guard.uninstall()
    } finally {
      await page.close()
    }
  })
})
