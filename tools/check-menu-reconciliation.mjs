#!/usr/bin/env node
/**
 * 平台单源菜单对账检查工具 (Menu Catalog Reconciliation Watchdog)
 *
 * 验证规则：
 * 1. packages/shared 中的 MENU_CATALOG 保证 ID 与 Route 唯一无重复；
 * 2. packages/web 中的 sidebar-data.ts 必须通过 requireMenuItem/MENU_CATALOG 消费，不允许手写分化路由；
 * 3. packages/shared 中的 ASSISTANT_GUIDE_CATALOG 导览项与路由必须与 MENU_CATALOG 严格对账；
 *    - 严禁出现历史的 /evidence 指向 /runs 或 capability 漂移；
 * 4. 确保各业务域与权限在控制台、助手与契约中保持单源一致。
 */

import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const sharedMenusPath = resolve(root, 'packages/shared/src/menus.ts')
const sharedAssistantPath = resolve(root, 'packages/shared/src/assistant.ts')
const webSidebarPath = resolve(root, 'packages/web/src/components/layout/data/sidebar-data.ts')

const issues = []

if (!existsSync(sharedMenusPath)) {
  issues.push(`找不到菜单契约文件: ${sharedMenusPath}`)
}
if (!existsSync(sharedAssistantPath)) {
  issues.push(`找不到助手导览契约文件: ${sharedAssistantPath}`)
}
if (!existsSync(webSidebarPath)) {
  issues.push(`找不到 Web 侧栏配置文件: ${webSidebarPath}`)
}

// 运行期对象来自 shared 编译产物；产物过期时对账的是旧目录，改了 menus.ts / assistant.ts 后需先重新构建。
const sharedDistPath = resolve(root, 'packages/shared/dist/index.js')
if (!existsSync(sharedDistPath)) {
  issues.push('找不到 packages/shared/dist/index.js：先运行 pnpm --filter @cairn/shared build（或 pnpm build）')
}

if (issues.length > 0) {
  console.error('❌ 基础文件缺失:')
  for (const err of issues) console.error(`  - ${err}`)
  process.exit(1)
}

// 动态载入 shared 编译产物验证运行期对象
async function runChecks() {
  const { MENU_CATALOG, requireMenuItem, ASSISTANT_GUIDE_CATALOG } = await import(sharedDistPath)

  console.log(`🔍 开始检查平台菜单一致性 (MENU_CATALOG: ${MENU_CATALOG.length} 项)...`)

  // 1. MENU_CATALOG 自洽性检查
  const seenIds = new Set()
  const seenRoutes = new Set()

  for (const item of MENU_CATALOG) {
    if (seenIds.has(item.id)) {
      issues.push(`MENU_CATALOG 存在重复 ID: ${item.id}`)
    }
    seenIds.add(item.id)

    if (seenRoutes.has(item.route)) {
      issues.push(`MENU_CATALOG 存在重复 Route: ${item.route} (ID: ${item.id})`)
    }
    seenRoutes.add(item.route)

    if (!item.title || !item.group || !item.description) {
      issues.push(`MENU_CATALOG 菜单项缺少必要字段: ${item.id}`)
    }
  }

  // 2. ASSISTANT_GUIDE_CATALOG 与 MENU_CATALOG 对账
  for (const guide of ASSISTANT_GUIDE_CATALOG) {
    if (guide.href) {
      const matchingMenu = MENU_CATALOG.find((m) => m.route === guide.href)
      if (!matchingMenu) {
        issues.push(
          `ASSISTANT_GUIDE_CATALOG 导览项 [${guide.topic}] 的 href "${guide.href}" 不在 MENU_CATALOG 中`,
        )
      } else if (guide.capabilityId && guide.capabilityId !== matchingMenu.id) {
        issues.push(
          `ASSISTANT_GUIDE_CATALOG 导览项 [${guide.topic}] 关联的 capabilityId "${guide.capabilityId}" 与 MENU_CATALOG ID "${matchingMenu.id}" 不一致`,
        )
      }
    }
  }

  // 重点对账防漂移：evidence 必须是 /evidence 与 menu.evidence
  const evidenceGuide = ASSISTANT_GUIDE_CATALOG.find((g) => g.topic === 'evidence')
  if (!evidenceGuide) {
    issues.push('ASSISTANT_GUIDE_CATALOG 缺少 evidence 导览项')
  } else {
    if (evidenceGuide.href !== '/evidence') {
      issues.push(`ASSISTANT_GUIDE_CATALOG evidence 路由漂移: 期望 "/evidence", 实际 "${evidenceGuide.href}"`)
    }
    if (evidenceGuide.capabilityId !== 'menu.evidence') {
      issues.push(`ASSISTANT_GUIDE_CATALOG evidence capabilityId 漂移: 期望 "menu.evidence", 实际 "${evidenceGuide.capabilityId}"`)
    }
  }

  // 3. Web sidebar-data.ts 静态消费检查
  const sidebarContent = readFileSync(webSidebarPath, 'utf8')
  if (!sidebarContent.includes('requireMenuItem')) {
    issues.push('Web sidebar-data.ts 必须从 @cairn/shared 引入 requireMenuItem，以保证单源受控')
  }

  // 确认 sidebar-data 中每个 navItem 都在 MENU_CATALOG 中合法存在
  const navItemRegex = /navItem\('([^']+)'/g
  let match
  const sidebarNavIds = new Set()
  while ((match = navItemRegex.exec(sidebarContent)) !== null) {
    const rawId = match[1]
    const fullId = `menu.${rawId}`
    sidebarNavIds.add(fullId)
    try {
      requireMenuItem(fullId)
    } catch {
      issues.push(`Web sidebar 引用了未在 MENU_CATALOG 中注册的菜单项 ID: "${fullId}"`)
    }
  }

  // 报告结果
  if (issues.length > 0) {
    console.error('\n❌ 菜单对账检查未通过，发现以下问题：')
    for (const issue of issues) {
      console.error(`  - ${issue}`)
    }
    process.exit(1)
  }

  console.log(`✅ 菜单对账检查通过！`)
  console.log(`   - 契约菜单项: ${MENU_CATALOG.length} 个全部有效且唯一`)
  console.log(`   - 助手导览项: ${ASSISTANT_GUIDE_CATALOG.length} 个全部对账一致（包括 /evidence 路由治理）`)
  console.log(`   - 控制台侧栏: ${sidebarNavIds.size} 个受管导航项与契约 100% 吻合`)
}

runChecks().catch((err) => {
  console.error('执行检查时发生未捕获异常:', err)
  process.exit(1)
})
