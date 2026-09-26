export interface PublishedHelpItem {
  id: string
  title: string
  category: 'studio' | 'run' | 'target' | 'session' | 'schedule' | 'dataset' | 'platform'
  tags: string[]
  keywords: string[]
  content: string
  requiredPermissions: string[]
  pageRoute: string
  anchor?: string
}

export const PUBLISHED_HELP_CATALOG: readonly PublishedHelpItem[] = [
  {
    id: 'help:studio-retry',
    title: 'Studio 步骤重试策略配置',
    category: 'studio',
    tags: ['studio', 'retry', 'step', '重试', '步骤'],
    keywords: ['重试', 'retry', '最大次数', '间隔', '退避', '重试策略', '步骤重试'],
    content:
      '在场景工作室（Studio）中，每个确定性步骤均可配置重试策略。支持最大重试次数（maxAttempts）、初始退避延迟与最大退避延迟。遇到瞬态异常时，运行时将根据策略自动重试当前 Attempt；当重试成功后，后续步骤继续执行，证据轴中会完整保留重试过程中的所有 Attempt 记录。',
    requiredPermissions: ['ai:assist'],
    pageRoute: '/scenarios',
    anchor: 'step-retry',
  },
  {
    id: 'help:studio-steps',
    title: 'Studio 场景步骤编排与类型',
    category: 'studio',
    tags: ['studio', 'steps', 'orchestration', '场景', '步骤'],
    keywords: ['步骤', '编排', '导航', '点击', '输入', '断言', '提取', '步骤类型'],
    content:
      '识途场景由有序的步骤列表组成。确定性步骤包括页面导航（navigate）、元素点击（click）、表单填充（fill）、内容提取（extract）与业务断言（assert）。每个步骤通过统一 Execution Context 传递输出供后续步骤引用。草稿未保存时仅在画布生效，保存后方可作为发布版本或试跑输入。',
    requiredPermissions: ['ai:assist'],
    pageRoute: '/scenarios',
    anchor: 'scenario-steps',
  },
  {
    id: 'help:run-review',
    title: 'Run 执行复盘与三轴状态',
    category: 'run',
    tags: ['run', 'review', 'status', '运行', '状态', '证据'],
    keywords: ['运行', '执行状态', '业务结果', '证据状态', '三轴', '复盘', 'runStatus'],
    content:
      '每个 Run 拥有相互解耦的三轴状态表达：执行生命周期（PENDING / RUNNING / COMPLETED / FAILED）、业务结果判定（SUCCESS / FAILED / UNCERTAIN）以及证据完整性（COMPLETE / INCOMPLETE / ABSENT）。只有在必要证据齐全时才判定为完整交付，排查问题时可通过时序轴与 Attempt 证据直接溯源。',
    requiredPermissions: ['ai:assist', 'run:read'],
    pageRoute: '/runs',
    anchor: 'run-lifecycle',
  },
  {
    id: 'help:run-failures',
    title: 'Run 失败诊断与原因定位',
    category: 'run',
    tags: ['run', 'diagnose', 'failure', '失败', '诊断', '报错'],
    keywords: ['失败', '报错', '卡住', '超时', '异常', '定位', '诊断'],
    content:
      '运行失败时，平台记录首个失败步骤及其关联的 Attempt 错误详情、错误类型、现场截图与控制台日志。助手可结合执行上下文与证据链路自动诊断根因（如元素定位失效、网络响应超时、会话失效或认证过期），并给出重试或修复建议。重试成功的步骤不会冲刷历史失败 Attempt。',
    requiredPermissions: ['ai:assist', 'run:read'],
    pageRoute: '/runs',
    anchor: 'run-diagnose',
  },
  {
    id: 'help:target-lifecycle',
    title: 'Target 目标系统与凭据管理',
    category: 'target',
    tags: ['target', 'credential', 'auth', '目标系统', '账号', '凭据'],
    keywords: ['目标系统', 'Target', '账号', '凭据', '健康检查', '登录', '认证状态'],
    content:
      'Target 定义受管目标业务系统的基础配置（如域名、协议与认证入口）。Target 纳管所属账号与凭据资产，保障安全存储与权限隔离。正式执行时受管运行时自动调度健康凭据进行会话登录与维护，禁止直接向外部透传明文凭据，未授权的账号对无权使用者全程不可见。',
    requiredPermissions: ['ai:assist', 'target:read'],
    pageRoute: '/targets',
    anchor: 'target-auth',
  },
  {
    id: 'help:session-lease',
    title: 'Session 受管会话与租约并发规则',
    category: 'session',
    tags: ['session', 'lease', 'exclusive', 'concurrent', '会话', '租约'],
    keywords: ['受管会话', 'Session', '租约', 'Lease', '排他', '并发', 'exclusive', 'concurrent'],
    content:
      'Session 与 Run 生命周期解耦。默认 exclusive 模式下一个账号至多持有一条活跃会话；支持 concurrent 目标配置多活会话，但同一会话在任一时点至多拥有一条 ACTIVE 租约。执行、维护与人工接管共用租约约束，旧持有者超时或失联被回收后丧失操作权，严禁失管浏览器会话操作业务。',
    requiredPermissions: ['ai:assist'],
    pageRoute: '/targets',
    anchor: 'session-lease',
  },
  {
    id: 'help:schedule-cron',
    title: 'Schedule 周期调度与 Cron 触发预览',
    category: 'schedule',
    tags: ['schedule', 'cron', 'trigger', '调度', '周期', '定时'],
    keywords: ['调度', 'Schedule', 'Cron', '触发', '定时', '时区', '预览'],
    content:
      'Schedule 纳管场景或集合的周期性自动化调度。支持标准 5 字段 Cron 表达式与目标时区绑定。系统通过领域规则预先计算未来触发时间序列，支持随时暂停、恢复或手动触发试跑。修改 Cron 表达式后生成新定义修订，旧调度执行记录严格与触发时的修订版本关联。',
    requiredPermissions: ['ai:assist'],
    pageRoute: '/scenarios',
    anchor: 'schedule-config',
  },
  {
    id: 'help:dataset-snapshots',
    title: 'Dataset 业务数据集与快照管理',
    category: 'dataset',
    tags: ['dataset', 'snapshot', 'cursor', '数据集', '快照'],
    keywords: ['数据集', 'Dataset', '快照', 'Snapshot', '游标', '409', '记录'],
    content:
      'Dataset 纳管外部业务系统的结构化记录。采用物理分表与快照版本化管理，快照记录包含导出时点与导入时点。通过游标进行分页消费，当快照失效或被新版本替代时触发 409 游标失效机制以确保数据一致性，数据样本不能直接充当全量业务判断。',
    requiredPermissions: ['ai:assist'],
    pageRoute: '/platform-config',
    anchor: 'dataset-snapshots',
  },
  {
    id: 'help:platform-architecture',
    title: '识途平台架构与纯 AI 原生原则',
    category: 'platform',
    tags: ['platform', 'architecture', 'pure-ai-native', '平台', '架构'],
    keywords: ['平台架构', 'AI原生', '模型配置', '二元可用', 'Engine', 'Worker', 'API'],
    content:
      '识途平台遵循纯 AI 原生原则：助手在模型可用时提供全功能服务，无模型时彻底禁用并提示配置，绝不退化为伪可用规则问答。架构分层上，API 负责鉴权与编排，Worker 负责执行与持久化运行事实，Engine 管生命周期，Runtime 纳管浏览器会话，Web 仅通过受控接口展示与交互。',
    requiredPermissions: ['ai:assist'],
    pageRoute: '/platform-config',
    anchor: 'platform-overview',
  },
]

export interface HelpSnippetResult {
  id: string
  title: string
  category: string
  content: string
  pageRoute: string
  anchor?: string
  score: number
}

export function retrieveHelpSnippets(
  query: string,
  options?: {
    topK?: number
    maxChars?: number
    permissions?: string[]
  },
): HelpSnippetResult[] {
  const topK = options?.topK ?? 3
  const maxChars = options?.maxChars ?? 500
  const userPermissions = options?.permissions ? new Set(options.permissions) : null

  if (!query || typeof query !== 'string' || query.trim() === '') {
    return []
  }

  const queryNormalized = query.toLowerCase().trim()
  const queryTokens = queryNormalized.split(/\s+/).filter(Boolean)

  const candidates: HelpSnippetResult[] = []

  for (const item of PUBLISHED_HELP_CATALOG) {
    // 权限检查
    if (userPermissions && item.requiredPermissions.length > 0) {
      const hasPerm = item.requiredPermissions.every((p) => userPermissions.has(p))
      if (!hasPerm) {
        continue
      }
    }

    let score = 0
    const titleLower = item.title.toLowerCase()
    const contentLower = item.content.toLowerCase()

    // 关键词与标签匹配
    for (const kw of item.keywords) {
      const kwLower = kw.toLowerCase()
      if (queryNormalized.includes(kwLower)) {
        score += 5
      }
    }
    for (const tag of item.tags) {
      const tagLower = tag.toLowerCase()
      if (queryNormalized.includes(tagLower)) {
        score += 4
      }
    }

    // 标题与正文匹配
    if (titleLower.includes(queryNormalized)) {
      score += 6
    }
    for (const token of queryTokens) {
      if (titleLower.includes(token)) {
        score += 3
      }
      if (contentLower.includes(token)) {
        score += 1
      }
    }

    if (score > 0) {
      const truncatedContent =
        item.content.length > maxChars ? `${item.content.slice(0, maxChars)}...` : item.content

      candidates.push({
        id: item.id,
        title: item.title,
        category: item.category,
        content: truncatedContent,
        pageRoute: item.pageRoute,
        anchor: item.anchor,
        score,
      })
    }
  }

  candidates.sort((a, b) => b.score - a.score)
  return candidates.slice(0, topK)
}
