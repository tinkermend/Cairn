#!/usr/bin/env node
/**
 * 识途宪法架构不变量声明式规则引擎 (Rule-based Architecture Invariant Watchdog)
 *
 * 将《识途宪法》（AGENTS.md）的核心架构红线转化为声明式规则注册表。
 * 支持单条规则独立维护、提供条款出处与精确修复指引。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const apiRequire = createRequire(resolve(root, 'packages/api/package.json'))
const ts = apiRequire('typescript')

function* walkFiles(dir, extensions = ['.ts', '.js', '.tsx']) {
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
    articles: ['业务接口'],
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
    articles: ['执行分层', '持久化事实与调度'],
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
    articles: ['运行快照'],
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
    articles: ['目标与身份', '凭据与授权'],
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
    articles: ['可执行约束'],
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
    articles: ['AI 步骤语义', '执行分层', '可执行约束'],
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
    articles: ['执行分层', '编写与执行分离'],
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
    articles: ['执行分层'],
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
  {
    id: 'INV009_SESSION_LEASE_SINGLE_INSERT',
    articles: ['会话与租约'],
    title: 'session_leases 的 ACTIVE 插入只允许 occupancy 写入器',
    rationale: '会话 A 的占用事实只能由 claimSessionUse / transitionSessionUse 写入，禁止第二套插入器',
    targetDir: 'packages/db/src',
    excludeTests: true,
    check: (file, rel, content) => {
      const normalized = rel.replaceAll('\\', '/')
      if (normalized.endsWith('sessions/occupancy-lease.ts')) return []
      const issues = []
      if (/insertRows\s*\(\s*\w+\s*,\s*sessionLeases\b/.test(content)) {
        issues.push('生产代码禁止在 occupancy-lease.ts 以外 insertRows(..., sessionLeases)')
      }
      if (/\.insert\s*\(\s*sessionLeases\s*\)/.test(content)) {
        issues.push('生产代码禁止在 occupancy-lease.ts 以外 .insert(sessionLeases)')
      }
      return issues
    },
  },
  {
    id: 'INV010_SESSION_LEASE_NO_LEGACY_WRITERS',
    articles: ['会话与租约'],
    title: '禁止复活旧 session_leases 写入器',
    rationale: 'acquireSessionLease / expireStaleLeases 旧栈已删除，生产代码不得再引用',
    targetDir: 'packages',
    excludeTests: true,
    check: (file, rel, content) => {
      if (rel.includes(`${sep}dist${sep}`) || rel.includes(`${sep}vendor${sep}`)) return []
      const issues = []
      for (const name of [
        'acquireSessionLease',
        'renewSessionLease',
        'releaseSessionLease',
        'expireStaleLeases',
      ]) {
        if (new RegExp(`\\b${name}\\b`).test(content)) {
          issues.push(`生产代码严禁引用已删除的 ${name}`)
        }
      }
      return issues
    },
  },
  {
    id: 'INV011_SESSION_OCCUPANCY_IMPORT_ACYCLIC',
    articles: ['会话与租约'],
    title: '会话占用与维护模块禁止循环依赖',
    rationale: '事件账本是底层，occupancy 实现不得反向依赖维护请求/总览/保留',
    targetDir: 'packages/db/src/sessions',
    excludeTests: true,
    check: (file, rel, content) => {
      const normalized = rel.replaceAll('\\', '/')
      const base = normalized.split('/').pop() ?? ''
      const issues = []
      if (base === 'occupancy.ts' || base === 'maintenance.ts') {
        if (/^import\s/m.test(content)) issues.push('桶文件只许再导出，不得 import')
        if (/^(export )?(async )?function\s/m.test(content)) issues.push('桶文件不得包含函数实现')
      }
      if (base.startsWith('occupancy-') && base.endsWith('.ts')) {
        for (const forbidden of [
          'maintenance.js',
          'maintenance-request.js',
          'session-overview.js',
          'session-retention.js',
        ]) {
          if (content.includes(`from './${forbidden}'`) || content.includes(`from "./${forbidden}"`)) {
            issues.push(`occupancy-* 不得 import ${forbidden}`)
          }
        }
      }
      if (base === 'session-events.ts') {
        if (
          /from ['"]\.\/(?:occupancy|maintenance|maintenance-request|session-overview|session-retention)/.test(
            content,
          )
        ) {
          issues.push('session-events 不得依赖 occupancy/maintenance 实现')
        }
      }
      return issues
    },
  },
  {
    id: 'INV012_WORKER_INTERVALS_IN_LIFECYCLE',
    articles: ['执行分层'],
    title: 'Worker 进程级 setInterval 只允许生命周期与既有会话/录像心跳',
    rationale: '新增能力不得另起一套失管循环；领取、调度与回收都挂在 LifecycleService',
    targetDir: 'packages/worker/src',
    excludeTests: true,
    check: (file, rel, content) => {
      if (!/\bsetInterval\s*\(/.test(content)) return []
      const normalized = rel.replaceAll('\\', '/')
      const allowed = [
        'runtime/lifecycle.service.ts',
        'browser/session-manager.ts',
        'browser/run-video.ts',
      ]
      if (allowed.some((item) => normalized.endsWith(item))) return []
      return ['生产代码不得在 LifecycleService / session-manager / run-video 以外使用 setInterval']
    },
  },
  {
    id: 'INV013_MIDSCENE_CACHE_DISABLED',
    articles: ['执行分层', '证据与保留策略'],
    title: '严禁启用 Midscene 原生缓存 (cacheable: false)',
    rationale: '识途严格控制执行确定性与证据链，禁止 Midscene 内部文件缓存或跨运行缓存行为，cacheable 必须锁死 false',
    targetDir: 'packages/worker/src/ai',
    excludeTests: true,
    check: (file, rel, content) => {
      const issues = []
      if (/\bcacheable\s*:\s*true\b/.test(content)) {
        issues.push('Midscene 适配层严禁配置 cacheable: true，必须显式保持 cacheable: false')
      }
      return issues
    },
  },
  {
    id: 'INV014_AUTHORING_NODES_VIA_WALKER',
    articles: ['执行分层', '执行上下文'],
    title: '编写文档必须通过 AST 遍历器与变更器访问，严禁直接读写 .nodes',
    rationale: '控制流演进要求统一通过 walkAuthoringNodes / locateNode / authoringSteps 等 AST 遍历器与变异函数访问，禁止直接操作 .nodes 数组',
    targetDir: 'packages',
    excludeTests: true,
    check: (file, rel, content) => {
      // 仅约束 web, api, db, authoring 中的生产源码；白名单 authoring-document.ts 与 compiler.ts
      if (
        !rel.startsWith('packages/web/src') &&
        !rel.startsWith('packages/api/src') &&
        !rel.startsWith('packages/db/src') &&
        !rel.startsWith('packages/authoring/src')
      ) {
        return []
      }
      if (
        rel.includes('authoring-document.ts') ||
        rel.includes('compiler.ts')
      ) {
        return []
      }
      const issues = []
      const directNodesAccess = /\b(?:doc|document|authoringDoc|scenarioDoc|v2)\.nodes\s*(?:\.|\?\.|\b\[|\s*=)/g
      let match
      while ((match = directNodesAccess.exec(content)) !== null) {
        issues.push(`严禁直接读写编写文档的 .nodes，必须通过 walkAuthoringNodes / locateNode / authoringSteps 等统一 AST 工具访问（发现: "${match[0].trim()}"）`)
      }
      return issues
    },
  },
  {
    id: 'INV015_STEP_RUN_LOOKUP_VIA_ACCESSOR',
    articles: ['执行分层', '会话与租约'],
    title: '查找 StepRun 必须使用统一访问器，禁止直接通过 stepId 查找或构造单值 Map',
    rationale: '控制流可能在循环/分支中多次执行同一 stepId，必须通过 stepRunFor / stepRunsOf / stepRunMapByStep 访问，禁止假设 stepId 唯一性直接查找',
    targetDir: 'packages',
    excludeTests: true,
    check: (file, rel, content) => {
      if (rel.includes('run-api.ts')) return []
      const issues = []
      const forbiddenFind = /\bstepRuns\s*\.\s*find\s*\(\s*(?:\([^)]*\)|[a-zA-Z0-9_$]+)\s*=>[^)]*\bstepId\s*===/g
      let match
      while ((match = forbiddenFind.exec(content)) !== null) {
        issues.push('禁止直接使用 stepRuns.find 查找 stepId，必须使用 stepRunFor(stepRuns, stepId) 或 stepRunsOf(stepRuns, stepId) 统一访问器')
      }
      const forbiddenMap = /\bnew\s+Map\s*<[^>]*>\s*\(\s*[^)]*stepRuns[^)]*\.stepId/g
      while ((match = forbiddenMap.exec(content)) !== null) {
        issues.push('禁止通过 stepRuns 构造单值 stepId 的 Map，必须使用 stepRunMapByStep 或 groupStepRunsByStep')
      }
      return issues
    },
  },
  {
    id: 'INV016_NO_READ_SNAPSHOT_CONTENT_IN_API',
    articles: ['执行分层', '安全'],
    title: 'API 包严禁引用 readSessionStateSnapshotContent',
    rationale: '读取登录态全文仅允许 Worker 执行面调用，API 只读摘要列，禁止泄漏登录态全文',
    targetDir: 'packages/api/src',
    excludeTests: false,
    check: (file, rel, content) => {
      const issues = []
      if (content.includes('readSessionStateSnapshotContent')) {
        issues.push('API 生产代码严禁引用 readSessionStateSnapshotContent，只允许读取快照摘要')
      }
      return issues
    },
  },
  {
    id: 'INV017_CHROMIUM_LAUNCH_RESTRICTED',
    articles: ['执行分层'],
    title: 'Chromium 启动只允许 runtime.ts 与 host-pool.ts',
    rationale: '浏览器必须统一由 Runtime / HostPool 纳管，禁止在其它位置启动 Chromium 进程',
    targetDir: 'packages/worker/src',
    excludeTests: true,
    check: (file, rel, content) => {
      const normalized = rel.replaceAll('\\', '/')
      if (
        normalized.endsWith('browser/runtime.ts') ||
        normalized.endsWith('browser/host-pool.ts')
      ) {
        return []
      }
      const issues = []
      if (/\b(?:chromium\s*\.\s*launch|launchPersistentContext)\s*\(/.test(content)) {
        issues.push('Chromium 启动只允许在 browser/runtime.ts 与 browser/host-pool.ts，严禁在其它位置启动进程')
      }
      return issues
    },
  },
  {
    id: 'INV018_API_RUN_READ_ACTOR_SCOPE',
    articles: ['安全', '目标范围'],
    title: 'API 读取运行详情与证据必须显式传入 actorId',
    rationale: 'Guard 无法从所有新路由参数推断目标；DB 读取必须显式绑定当前账号，避免按主键读取外目标数据',
    targetDir: 'packages/api/src',
    excludeTests: true,
    check: (file, rel, content) => {
      const guarded = new Set(['getRun', 'loadRunDetail', 'listRunEvidence', 'getEvidenceForRun', 'listRuns', 'loadRunObservation', 'getRunSessionOwner'])
      const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
      const issues = []
      const dbNamespaces = new Set()
      const collectDbNamespaces = (node) => {
        if (ts.isImportDeclaration(node)
          && node.moduleSpecifier.text === '@cairn/db'
          && node.importClause?.namedBindings
          && ts.isNamespaceImport(node.importClause.namedBindings)) {
          dbNamespaces.add(node.importClause.namedBindings.name.text)
        }
        if (ts.isVariableDeclaration(node)) {
          const initializer = node.initializer
          const imported = initializer && ts.isAwaitExpression(initializer) ? initializer.expression : initializer
          if (ts.isIdentifier(node.name)
            && imported
            && ts.isCallExpression(imported)
            && imported.expression.kind === ts.SyntaxKind.ImportKeyword
            && imported.arguments[0]?.text === '@cairn/db') {
            dbNamespaces.add(node.name.text)
          }
        }
        ts.forEachChild(node, collectDbNamespaces)
      }
      collectDbNamespaces(source)
      const visit = (node) => {
        const name = ts.isCallExpression(node) && ts.isIdentifier(node.expression)
          ? node.expression.text
          : ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
            && ts.isIdentifier(node.expression.expression)
            && dbNamespaces.has(node.expression.expression.text)
            ? node.expression.name.text
            : undefined
        if (ts.isCallExpression(node) && name && guarded.has(name)) {
          // Browser session owner resolution uses session:read/session:view and a session-scoped Guard.
          // It only uses the linked run's status and session placement, not a public run response.
          let enclosing = node.parent
          while (enclosing && !ts.isMethodDeclaration(enclosing)) enclosing = enclosing.parent
          const sessionOwnerLookup = rel === 'packages/api/src/browser-sessions/browser-sessions.service.ts'
            && name === 'getRunSessionOwner'
            && node.getText(source) === 'getRunSessionOwner(this.handle, ownerId)'
            && enclosing?.name?.getText(source) === 'resolveRunOwner'
          const actor = node.arguments[2]
          if (!sessionOwnerLookup && (name === 'getRunSessionOwner' || !actor || actor.getText(source) === 'undefined' || actor.getText(source) === 'null')) {
            const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
            issues.push(`${name} 第 ${line} 行必须传当前 actorId；可信内部读取需单独设计并接受审查`)
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
      return issues
    },
  },
]

export function runInvariantChecks() {
  const violations = []

  for (const rule of INVARIANT_RULES) {
    const searchPath = resolve(root, rule.targetDir)
    if (!existsSync(searchPath)) continue

    for (const file of walkFiles(searchPath, ['.ts', '.js', '.tsx'])) {
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
      console.error(`\n❌ [${v.ruleId}] (宪法「${v.articles.join('」「')}」)`)
      console.error(`   文件: ${v.file}`)
      console.error(`   原因: ${v.message}`)
      console.error(`   依据: ${v.rationale}`)
    }
    console.error(`\n共发现 ${violations.length} 处违规，请立即修正后重试。\n`)
    process.exit(1)
  }

  console.log('✅ 识途宪法核心架构不变量检查通过（API GET/POST、Worker 隔离、快照冻结、凭据脱敏、规则引擎）')
}
