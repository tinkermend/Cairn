#!/usr/bin/env node
/**
 * 识途宪法架构不变量声明式规则引擎 (Rule-based Architecture Invariant Watchdog)
 *
 * 将《识途宪法》（AGENTS.md）的核心架构红线转化为声明式规则注册表。
 * 支持单条规则独立维护、提供条款出处与精确修复指引。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function* walkFiles(dir, extensions = ['.ts', '.js']) {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.name.startsWith('.') ||
      entry.name === 'node_modules' ||
      entry.name === 'dist' ||
      entry.name === 'build'
    ) {
      continue
    }
    const full = resolve(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walkFiles(full, extensions)
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      yield full
    }
  }
}

/**
 * 声明式规则定义列表
 */
export const INVARIANT_RULES = [
  {
    id: 'INV001_ONLY_GET_POST',
    articles: [12, 18, 19],
    title: '平台 API 对外只允许 GET 与 POST',
    rationale: '识途宪法规定控制面接口仅允许 GET 查询与 POST 变更，禁止 PUT/PATCH/DELETE',
    targetDir: 'packages/api/src',
    excludeTests: false,
    check: (file, rel, content) => {
      const issues = []
      const forbiddenDecorators = /@(Put|Patch|Delete|Options|Head)\s*\(/g
      let match
      while ((match = forbiddenDecorators.exec(content)) !== null) {
        issues.push(`API 控制器严禁使用 @${match[1]}()，只允许使用 @Get() 或 @Post()`)
      }
      const forbiddenImports = /\bimport\s*\{[^}]*\b(Put|Patch|Delete|Options|Head)\b[^}]*\}\s*from\s*['"]@nestjs\/common['"]/
      const impMatch = content.match(forbiddenImports)
      if (impMatch) {
        issues.push(`API 代码严禁从 @nestjs/common 导入 ${impMatch[1]} 方法装饰器`)
      }
      return issues
    },
  },
  {
    id: 'INV002_WORKER_NO_API_CALLBACK',
    articles: [12, 19],
    title: 'Worker 执行面严禁通过 API 回调写回执行事实',
    rationale: 'Worker 是执行面，状态必须原子持久化至数据库，Worker 与 API 不得形成双向业务回调',
    targetDir: 'packages/worker/src',
    excludeTests: true,
    check: (file, rel, content) => {
      const issues = []
      const forbiddenImport = /\b(?:from|import|require)\s*\(?\s*['"](axios|ky|got|superagent)['"]/
      const impMatch = content.match(forbiddenImport)
      if (impMatch) {
        issues.push(`Worker 生产代码严禁引入 HTTP 客户端调用控制面：${impMatch[1]}`)
      }
      if (content.includes('/api/v1/') || content.includes('/api/runs')) {
        issues.push('Worker 生产代码严禁硬编码控制面 API 路由回调，执行事实应通过持久化数据库写入')
      }
      return issues
    },
  },
  {
    id: 'INV003_SNAPSHOT_IMMUTABLE',
    articles: [2, 8, 9, 18],
    title: '执行期快照绝对不可变 (Snapshot Freeze)',
    rationale: 'Run 启动后必须冻结快照，历史 Run 必须依赖自身 Snapshot 解释，严禁执行期 UPDATE 快照',
    targetDir: 'packages/db/src',
    excludeTests: true,
    check: (file, rel, content) => {
      const issues = []
      const dangerousPatterns = [
        /UPDATE\s+runs\s+SET[^;]*snapshot\s*=/i,
        /UPDATE\s+scenario_versions\s+SET[^;]*definition\s*=/i,
      ]
      for (const pattern of dangerousPatterns) {
        if (pattern.test(content)) {
          issues.push('数据库层严禁构造 UPDATE 语句覆盖或修改历史运行快照或场景版本定义')
        }
      }
      return issues
    },
  },
  {
    id: 'INV004_SECRET_REDACTION',
    articles: [15, 18, 19],
    title: '控制台身份与目标系统凭据彻底隔离，严禁明文暴露',
    rationale: '目标凭据必须通过 SecretProvider 访问，Evidence 与日志必须自动脱敏，严禁明文字段暴露',
    targetDir: 'packages/shared/src',
    excludeTests: true,
    check: (file, rel, content) => {
      const issues = []
      if (/evidenceMetadataSchema|evidencePayloadSchema/.test(content)) {
        if (/\bpassword\b:\s*z\.string\(\)/.test(content)) {
          issues.push('Evidence Schema 严禁暴露未加密或未打码的明文 password 字段')
        }
      }
      return issues
    },
  },
  {
    id: 'INV005_NO_DB_TESTING_IN_PROD',
    articles: [18],
    title: '生产业务代码严禁导入 @cairn/db/testing',
    rationale: '测试基础设施与测试夹具仅限测试使用，严禁泄露至生产发布构建中',
    targetDir: 'packages',
    excludeTests: true,
    check: (file, rel, content) => {
      const issues = []
      if (
        rel.startsWith('packages/api/src') ||
        rel.startsWith('packages/worker/src') ||
        rel.startsWith('packages/shared/src')
      ) {
        if (content.includes('@cairn/db/testing')) {
          issues.push('生产源码文件严禁导入 @cairn/db/testing 测试桩')
        }
      }
      return issues
    },
  },
  {
    id: 'INV006_WORKER_AI_ISOLATION',
    articles: [9, 16, 18],
    title: 'Engine / Runtime / WorkerModule 不得导入 Midscene 适配层',
    rationale: 'SDK 与假模型只允许留在 worker/src/ai/。Engine 只认端口契约，装配层不得把 ai/midscene 或 @midscene/ 泄漏进调度与生命周期',
    targetDir: 'packages/worker/src',
    excludeTests: true,
    check: (file, rel, content) => {
      const issues = []
      const guarded =
        rel.startsWith('packages/worker/src/engine/') ||
        rel.startsWith('packages/worker/src/runtime/') ||
        rel === 'packages/worker/src/worker.module.ts'
      if (!guarded) return issues
      const forbidden = /\b(?:from|import|require)\s*\(?\s*['"][^'"]*(?:@midscene\/|ai\/midscene)[^'"]*['"]/
      if (forbidden.test(content)) {
        issues.push('engine/、runtime/ 与 worker.module.ts 不得导入 @midscene/ 或 ai/midscene')
      }
      return issues
    },
  },
  {
    id: 'INV007_WEB_NO_WORKER_INTERNAL',
    articles: [12, 14, 18],
    title: 'Web 不得直连 Worker 内部入口或 CDP',
    rationale: '画面与认证控制必须经 API 鉴权转发，Web 不能持有 Worker 地址映射或调试串',
    targetDir: 'packages/web/src',
    excludeTests: true,
    check: (file, rel, content) => {
      const issues = []
      if (content.includes('/internal/managed-browser')) {
        issues.push('Web 生产代码严禁出现 Worker 内部路径 /internal/managed-browser')
      }
      if (content.includes('CAIRN_WORKER_ENDPOINTS')) {
        issues.push('Web 生产代码严禁包含 Worker 地址映射')
      }
      if (content.includes('chrome-devtools://') || content.includes('ws://127.0.0.1:9222')) {
        issues.push('Web 生产代码严禁包含 CDP 调试地址')
      }
      return issues
    },
  },
  {
    id: 'INV008_API_NO_PLAYWRIGHT',
    articles: [6, 7, 12],
    title: 'API 不得导入 Playwright 或持有 Page',
    rationale: '控制面只转发，正式浏览器对象只属于 Worker',
    targetDir: 'packages/api/src',
    excludeTests: true,
    check: (file, rel, content) => {
      const issues = []
      if (/\b(?:from|import|require)\s*\(?\s*['"]playwright['"]/.test(content)) {
        issues.push('API 生产代码严禁导入 playwright')
      }
      return issues
    },
  },
]

export function runInvariantChecks() {
  const violations = []

  for (const rule of INVARIANT_RULES) {
    const searchPath = resolve(root, rule.targetDir)
    if (!existsSync(searchPath)) continue

    for (const file of walkFiles(searchPath, ['.ts', '.js'])) {
      const rel = relative(root, file)
      if (rule.excludeTests) {
        if (file.includes(`${sep}__tests__${sep}`) || /\.(?:spec|test)\./.test(file)) {
          continue
        }
      }

      const content = readFileSync(file, 'utf8')
      const issues = rule.check(file, rel, content)
      if (issues && issues.length > 0) {
        for (const issue of issues) {
          violations.push({
            ruleId: rule.id,
            articles: rule.articles,
            file: rel,
            message: issue,
            rationale: rule.rationale,
          })
        }
      }
    }
  }

  return violations
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const violations = runInvariantChecks()
  if (violations.length > 0) {
    console.error('\n🚨 【识途宪法看门狗】拦截到违反架构不变量的代码变动：')
    for (const v of violations) {
      console.error(`\n❌ [${v.ruleId}] (宪法第 ${v.articles.join('/')} 条)`)
      console.error(`   文件: ${v.file}`)
      console.error(`   原因: ${v.message}`)
      console.error(`   依据: ${v.rationale}`)
    }
    console.error(`\n共发现 ${violations.length} 处违规，请立即修正后重试。\n`)
    process.exit(1)
  }

  console.log('✅ 识途宪法核心架构不变量检查通过（API GET/POST、Worker 隔离、快照冻结、凭据脱敏、规则引擎）')
}
