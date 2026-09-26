#!/usr/bin/env node
/**
 * 路由助手声明对账检查工具 (Route Assistant Metadata Reconciliation Watchdog - CQ-01)
 *
 * 验证规则：
 * 1. 核心受保护叶路由必须在 staticData.assistant 中声明结构化元数据；
 * 2. pageKind 必须在 @cairn/shared 的 ASSISTANT_PAGE_KINDS 白名单内；
 * 3. 核心实体详情页（Run、Scenario/Studio、Target）严禁声明为 other 或 none，且必须提供 primaryObject 声明；
 * 4. 纯重定向叶路由显式豁免；
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const routesDir = resolve(root, 'packages/web/src/routes/_authenticated')

const VALID_PAGE_KINDS = new Set([
  'run',
  'studio',
  'scenario',
  'target',
  'session',
  'schedule',
  'dataset',
  'home',
  'navigation',
  'platform-config',
  'other',
])

// 核心必验叶路由清单 (CQ-01)
const CORE_PROTECTED_LEAF_ROUTES = [
  'index.tsx',
  'runs/index.tsx',
  'runs/$runId/index.tsx',
  'scenarios/index.tsx',
  'scenarios/$scenarioId/index.tsx',
  'targets/index.tsx',
  'targets/$targetId/index.tsx',
  'targets/$targetId/map/index.tsx',
  'platform-config/index.tsx',
  'sessions/index.tsx',
  'sessions/$targetId/index.tsx',
  'sessions/$targetId/$accountId/index.tsx',
  'schedules/index.tsx',
  'datasets/index.tsx',
]

const issues = []

console.log('🔍 开始检查受保护叶路由的助手元数据声明 (CQ-01)...')

for (const relPath of CORE_PROTECTED_LEAF_ROUTES) {
  const fullPath = resolve(routesDir, relPath)
  if (!existsSync(fullPath)) {
    issues.push(`核心叶路由文件不存在: ${relPath}`)
    continue
  }

  const content = readFileSync(fullPath, 'utf-8')

  // 1. 必须声明 staticData.assistant
  if (!content.includes('staticData:') || !content.includes('assistant:')) {
    issues.push(`叶路由 ${relPath} 缺少 staticData.assistant 助手元数据声明`)
    continue
  }

  // 2. 提取 routeKey 与 pageKind
  const routeKeyMatch = content.match(/routeKey:\s*['"]([^'"]+)['"]/)
  const pageKindMatch = content.match(/pageKind:\s*['"]([^'"]+)['"]/)

  if (!routeKeyMatch) {
    issues.push(`叶路由 ${relPath} 的 assistant 声明缺少有效的 routeKey`)
  }

  if (!pageKindMatch) {
    issues.push(`叶路由 ${relPath} 的 assistant 声明缺少有效的 pageKind`)
  } else {
    const pageKind = pageKindMatch[1]
    if (!VALID_PAGE_KINDS.has(pageKind)) {
      issues.push(`叶路由 ${relPath} 的 pageKind "${pageKind}" 不在 ASSISTANT_PAGE_KINDS 白名单内`)
    }

    // 3. 核心实体详情页不能为 other 或 none，且必须有 primaryObject
    if (relPath.includes('$runId')) {
      if (pageKind !== 'run') {
        issues.push(`运行详情路由 ${relPath} 不能标记为 "${pageKind}"，必须为 "run"`)
      }
      if (!content.includes('primaryObject:')) {
        issues.push(`运行详情路由 ${relPath} 必须声明 primaryObject: { kind: 'run', idParam: 'runId' }`)
      }
    } else if (relPath.includes('$scenarioId')) {
      if (pageKind !== 'studio' && pageKind !== 'scenario') {
        issues.push(`场景详情路由 ${relPath} 不能标记为 "${pageKind}"，必须为 "studio" 或 "scenario"`)
      }
      if (!content.includes('primaryObject:')) {
        issues.push(`场景详情路由 ${relPath} 必须声明 primaryObject: { kind: 'scenario', idParam: 'scenarioId' }`)
      }
    } else if (relPath.includes('$targetId')) {
      if (pageKind !== 'target' && pageKind !== 'session') {
        issues.push(`目标/会话相关路由 ${relPath} 不能标记为 "${pageKind}"`)
      }
      if (!content.includes('primaryObject:')) {
        issues.push(`详情路由 ${relPath} 必须声明 primaryObject`)
      }
      if (relPath.includes('$accountId') && !content.includes('scopeRefs:')) {
        issues.push(`复合会话路由 ${relPath} 必须声明 scopeRefs 表达父级 Target 范围`)
      }
    }
  }
}

if (issues.length > 0) {
  console.error('❌ 路由助手元数据检查未通过 (CQ-01):')
  for (const err of issues) {
    console.error(`  - ${err}`)
  }
  process.exit(1)
}

console.log(`✅ 路由助手元数据检查通过：${CORE_PROTECTED_LEAF_ROUTES.length} 个核心叶路由声明均合规。`)
