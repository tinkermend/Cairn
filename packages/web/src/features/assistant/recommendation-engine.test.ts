import { describe, expect, it } from 'vitest'
import type { AssistantCapabilitiesResponse } from '@cairn/shared'
import { resolveContextRecommendations } from './recommendation-engine'

function mockCapabilities(
  available: string[] = [
    'scenario.explain',
    'scenario.propose-step',
    'run.diagnose',
    'run.compare',
    'platform.guide',
    'knowledge.answer',
  ],
  modelEnabled = true,
): AssistantCapabilitiesResponse {
  return {
    modelEnabled,
    items: [
      'scenario.explain',
      'scenario.propose-step',
      'run.diagnose',
      'run.compare',
      'platform.guide',
      'knowledge.answer',
    ].map((id) => ({
      id,
      label: id,
      available: available.includes(id),
      missingPermissions: [],
      requiredContext: [],
    })) as AssistantCapabilitiesResponse['items'],
  }
}

describe('resolveContextRecommendations (M2 - 全域上下文智能推荐解析引擎)', () => {
  const defaultPermissions = {
    canAssist: true,
    canWrite: true,
    canReadTarget: true,
    canReadSession: true,
  }

  it('闸门拦截：当全局未启用模型或用户缺少 ai:assist 权限时，严格返回空列表', () => {
    // 1. 模型未启用
    const resNoModel = resolveContextRecommendations({
      boundContext: { page: 'studio' },
      pageContext: null,
      capabilities: mockCapabilities([], false),
      permissions: defaultPermissions,
    })
    expect(resNoModel).toEqual([])

    // 2. 缺少 ai:assist 权限
    const resNoPerm = resolveContextRecommendations({
      boundContext: { page: 'studio' },
      pageContext: null,
      capabilities: mockCapabilities(),
      permissions: { ...defaultPermissions, canAssist: false },
    })
    expect(resNoPerm).toEqual([])
  })

  it('场景编排（Studio 全局未选中单步）：推荐解释场景、检查完整性与测试分支', () => {
    const chips = resolveContextRecommendations({
      boundContext: { page: 'studio', isDirty: false },
      pageContext: { page: 'studio', scenarioId: 'sc-1' },
      capabilities: mockCapabilities(),
      permissions: defaultPermissions,
    })

    expect(chips.map((c) => c.label)).toEqual([
      '💡 解释场景全貌',
      '🔍 检查逻辑完整性',
      '➕ 建议测试分支',
    ])
  })

  it('场景编排（草稿未保存态）：不推荐助手无法看到的本地改动分析', () => {
    const chips = resolveContextRecommendations({
      boundContext: { page: 'studio', isDirty: true },
      pageContext: { page: 'studio', scenarioId: 'sc-1' },
      capabilities: mockCapabilities(),
      permissions: defaultPermissions,
    })

    expect(chips.map((c) => c.label)).toEqual([
      '💡 解释场景全貌',
      '🔍 检查逻辑完整性',
      '➕ 建议测试分支',
    ])
    expect(chips.some((chip) => chip.id === 'studio-draft-diff')).toBe(false)
  })

  it('场景编排（单步聚焦）：推荐修改建议、解释单步与断言', () => {
    const chips = resolveContextRecommendations({
      boundContext: {
        page: 'studio',
        selectedStepId: 'step-1',
        hasCssSelector: false,
      },
      pageContext: { page: 'studio', scenarioId: 'sc-1', stepId: 'step-1' },
      capabilities: mockCapabilities(),
      permissions: defaultPermissions,
    })

    expect(chips.map((c) => c.label)).toEqual([
      '✏️ 修改建议',
      '📖 解释此步骤',
      '🛡️ 补充断言',
    ])
  })

  it('场景编排（单步聚焦含 CSS 候选）：推荐诊断选择器稳定性', () => {
    const chips = resolveContextRecommendations({
      boundContext: {
        page: 'studio',
        selectedStepId: 'step-1',
        hasCssSelector: true,
      },
      pageContext: { page: 'studio', scenarioId: 'sc-1', stepId: 'step-1' },
      capabilities: mockCapabilities(),
      permissions: defaultPermissions,
    })

    // 优先级：修改建议 (110) > 解释此步骤 (100) > 诊断选择器稳定性 (85) [优于补充断言 (80)]
    expect(chips.map((c) => c.label)).toEqual([
      '✏️ 修改建议',
      '📖 解释此步骤',
      '🎯 诊断选择器稳定性',
    ])
  })

  it('RBAC 闸门：当用户缺少 workflow:write 权限时，自动剔除 scenario.propose-step 相关提议', () => {
    const chips = resolveContextRecommendations({
      boundContext: {
        page: 'studio',
        selectedStepId: 'step-1',
        hasCssSelector: true,
      },
      pageContext: { page: 'studio', scenarioId: 'sc-1', stepId: 'step-1' },
      capabilities: mockCapabilities(),
      permissions: { ...defaultPermissions, canWrite: false },
    })

    // 修改建议、诊断选择器与补充断言均被过滤，保留解释此步骤
    expect(chips.some((c) => c.capabilityHint === 'scenario.propose-step')).toBe(false)
    expect(chips.map((c) => c.label)).toEqual(['📖 解释此步骤'])
  })

  it('运行详情（失败复盘）：推荐排查本次失败与对比上一次运行', () => {
    const chips = resolveContextRecommendations({
      boundContext: {
        page: 'run',
        statusTone: 'error',
      },
      pageContext: { page: 'run', runId: 'run-1' },
      capabilities: mockCapabilities(),
      permissions: defaultPermissions,
    })

    expect(chips.map((c) => c.label)).toEqual([
      '🚨 排查本次失败',
      '🔄 对比上一次运行',
    ])
    expect(chips.find((c) => c.capabilityHint === 'run.compare')?.question)
      .toBe('这次运行和上一次相比有什么变化？')
  })

  it('运行详情（选中具体报错步骤）：置顶推荐当前步骤报错诊断', () => {
    const chips = resolveContextRecommendations({
      boundContext: {
        page: 'run',
        selectedStepId: 'step-err',
        selectedStepFailed: true,
        statusTone: 'error',
      },
      pageContext: { page: 'run', runId: 'run-1', stepId: 'step-err' },
      capabilities: mockCapabilities(),
      permissions: defaultPermissions,
    })

    expect(chips.map((c) => c.label)).toEqual([
      '🔎 排查当前步骤报错',
      '🚨 排查本次失败',
      '🔄 对比上一次运行',
    ])
  })

  it('运行详情（成功运行）：推荐分析耗时瓶颈', () => {
    const chips = resolveContextRecommendations({
      boundContext: {
        page: 'run',
        statusTone: 'success',
      },
      pageContext: { page: 'run', runId: 'run-success' },
      capabilities: mockCapabilities(),
      permissions: defaultPermissions,
    })

    expect(chips.map((c) => c.label)).toEqual(['⏱️ 分析耗时瓶颈'])
  })

  it('目标系统与凭据：有 target:read 权限时推荐检查账号与地图覆盖，无权限时安全回退全局', () => {
    // 1. 有 target:read 权限
    const chipsWithTarget = resolveContextRecommendations({
      boundContext: { page: 'target', entityId: 'tgt-1' },
      pageContext: { page: 'target', targetId: 'tgt-1' },
      capabilities: mockCapabilities(),
      permissions: defaultPermissions,
    })
    expect(chipsWithTarget.map((c) => c.label)).toEqual([
      '🔑 检查账号健康度',
      '🗺️ 目标菜单地图覆盖',
    ])
    expect(chipsWithTarget[0]?.capabilityHint).toBe('knowledge.answer')

    const chipsNoSession = resolveContextRecommendations({
      boundContext: { page: 'target', entityId: 'tgt-1' },
      pageContext: { page: 'target', targetId: 'tgt-1' },
      capabilities: mockCapabilities(),
      permissions: { ...defaultPermissions, canReadSession: false },
    })
    expect(chipsNoSession.map((c) => c.label)).toEqual(['🗺️ 目标菜单地图覆盖'])

    // 2. 缺少 target:read 权限 -> 安全回退全局引导
    const chipsNoTarget = resolveContextRecommendations({
      boundContext: { page: 'target', entityId: 'tgt-1' },
      pageContext: { page: 'target', targetId: 'tgt-1' },
      capabilities: mockCapabilities(),
      permissions: { ...defaultPermissions, canReadTarget: false },
    })
    expect(chipsNoTarget.map((c) => c.label)).toEqual([
      '🚀 快速上手编排',
      '📊 查看近期异常运行',
      '📋 常用功能导航',
    ])
  })

  it('能力下线过滤：若后端能力声明不可用，则严格过滤对应推荐项', () => {
    // 模拟后端下线了 scenario.propose-step
    const capsWithoutPropose = mockCapabilities([
      'scenario.explain',
      'platform.guide',
    ])

    const chips = resolveContextRecommendations({
      boundContext: {
        page: 'studio',
        selectedStepId: 'step-1',
      },
      pageContext: { page: 'studio', scenarioId: 'sc-1', stepId: 'step-1' },
      capabilities: capsWithoutPropose,
      permissions: defaultPermissions,
    })

    expect(chips.some((c) => c.capabilityHint === 'scenario.propose-step')).toBe(false)
    expect(chips.map((c) => c.label)).toEqual(['📖 解释此步骤'])
  })

  it('列表页推荐修正：运行列表页缺少 runId 时安全回退全局，不展示单次运行推荐 (Acceptance Criterion 3)', () => {
    // 列表页仅有 routeContext（page: 'run'，无 runId）
    const chips = resolveContextRecommendations({
      boundContext: { page: 'run' },
      pageContext: { page: 'run' },
      capabilities: mockCapabilities(),
      permissions: defaultPermissions,
    })

    expect(chips.some((c) => c.id === 'run-perf-bottleneck')).toBe(false)
    expect(chips.some((c) => c.id === 'run-diagnose-rca')).toBe(false)
    expect(chips.map((c) => c.label)).toEqual([
      '🚀 快速上手编排',
      '📊 查看近期异常运行',
      '📋 常用功能导航',
    ])
  })

  it('列表页推荐修正：目标列表页缺少 targetId 时安全回退全局，不展示单个目标推荐 (Acceptance Criterion 3)', () => {
    // 列表页仅有 routeContext（page: 'target'，无 targetId / entityId）
    const chips = resolveContextRecommendations({
      boundContext: { page: 'target' },
      pageContext: { page: 'target' },
      capabilities: mockCapabilities(),
      permissions: defaultPermissions,
    })

    expect(chips.some((c) => c.id === 'target-account-health')).toBe(false)
    expect(chips.some((c) => c.id === 'target-menu-map')).toBe(false)
    expect(chips.map((c) => c.label)).toEqual([
      '🚀 快速上手编排',
      '📊 查看近期异常运行',
      '📋 常用功能导航',
    ])
  })

  it('调度聚焦：有 scheduleId 且有 schedule:read 权限时展示调度排查推荐', () => {
    const chips = resolveContextRecommendations({
      boundContext: { page: 'schedule', entityId: 'sched-1' },
      pageContext: { page: 'schedule' },
      capabilities: mockCapabilities(),
      permissions: { ...defaultPermissions, canReadSchedule: true },
    })

    expect(chips.map((c) => c.id)).toEqual(['schedule-why-not-run', 'schedule-recent-summary'])
    expect(chips.map((c) => c.label)).toEqual(['⏱️ 为什么没按时运行', '📋 最近触发情况汇总'])
    expect(chips[0].capabilityHint).toBe('knowledge.answer')
  })

  it('V2 页面上下文提供调度引用时，即使绑定上下文没有实体 ID 也能给出调度推荐', () => {
    const chips = resolveContextRecommendations({
      boundContext: { page: 'schedule' },
      pageContext: {
        version: 2,
        routeKey: 'schedules.detail',
        pageKind: 'schedule',
        page: 'schedule',
        primaryRef: { kind: 'schedule', id: '11111111-1111-4111-8111-111111111111' },
      },
      capabilities: mockCapabilities(),
      permissions: { ...defaultPermissions, canReadSchedule: true },
    })

    expect(chips.map((chip) => chip.id)).toEqual(['schedule-why-not-run', 'schedule-recent-summary'])
  })

  it('调度权限闸门：无 schedule:read 权限或缺少 scheduleId 时不展示调度排查推荐', () => {
    // 缺少权限
    const chipsNoPerm = resolveContextRecommendations({
      boundContext: { page: 'schedule', entityId: 'sched-1' },
      pageContext: { page: 'schedule' },
      capabilities: mockCapabilities(),
      permissions: { ...defaultPermissions, canReadSchedule: false },
    })
    expect(chipsNoPerm.some((c) => c.id.startsWith('schedule-'))).toBe(false)
    expect(chipsNoPerm.map((c) => c.label)).toEqual([
      '🚀 快速上手编排',
      '📊 查看近期异常运行',
      '📋 常用功能导航',
    ])

    // 列表页无 scheduleId
    const chipsNoId = resolveContextRecommendations({
      boundContext: { page: 'schedule' },
      pageContext: { page: 'schedule' },
      capabilities: mockCapabilities(),
      permissions: { ...defaultPermissions, canReadSchedule: true },
    })
    expect(chipsNoId.some((c) => c.id.startsWith('schedule-'))).toBe(false)
  })

  it('会话聚焦：在 session 页面且具备 targetId 与 canReadTarget 权限时展示会话排查卡片', () => {
    const chips = resolveContextRecommendations({
      boundContext: { page: 'session', targetId: 'tgt-1', targetAccountId: 'acc-1' },
      pageContext: { page: 'session' },
      capabilities: mockCapabilities(),
      permissions: { ...defaultPermissions, canReadTarget: true },
    })

    expect(chips.map((c) => c.id)).toEqual([
      'session-auth-failure-reason',
      'session-occupied-by-whom',
      'session-queue-waiting-reason',
    ])
    expect(chips.map((c) => c.label)).toEqual([
      '🔑 为什么登录失效',
      '🔒 会话被谁占用',
      '⌛ 为什么开跑一直在等会话',
    ])
    expect(chips[0].capabilityHint).toBe('knowledge.answer')
  })

  it('会话聚焦权限闸门：无 canReadTarget 权限时不展示会话排查卡片', () => {
    const chips = resolveContextRecommendations({
      boundContext: { page: 'session', targetId: 'tgt-1' },
      pageContext: { page: 'session' },
      capabilities: mockCapabilities(),
      permissions: { ...defaultPermissions, canReadTarget: false },
    })

    expect(chips.some((c) => c.id.startsWith('session-'))).toBe(false)
  })

  it('场景工作区未选中步骤时：具备 canReadRun 权限推荐「📉 这个场景最近为什么老失败」', () => {
    const chips = resolveContextRecommendations({
      boundContext: { page: 'studio', scenarioId: 'sc-1' },
      pageContext: { page: 'studio' },
      capabilities: mockCapabilities(),
      permissions: { ...defaultPermissions, canReadRun: true },
    })

    expect(chips.some((c) => c.id === 'studio-scenario-failure-history')).toBe(true)
    const failureChip = chips.find((c) => c.id === 'studio-scenario-failure-history')
    expect(failureChip?.label).toBe('📉 这个场景最近为什么老失败')
    expect(failureChip?.capabilityHint).toBe('knowledge.answer')

    // 无 canReadRun 时不展示
    const chipsNoRunPerm = resolveContextRecommendations({
      boundContext: { page: 'studio', scenarioId: 'sc-1' },
      pageContext: { page: 'studio' },
      capabilities: mockCapabilities(),
      permissions: { ...defaultPermissions, canReadRun: false },
    })
    expect(chipsNoRunPerm.some((c) => c.id === 'studio-scenario-failure-history')).toBe(false)
  })

  it('运行列表排查：无 runId 且具备 canReadRun 权限时推荐「🧩 这些失败是同一个原因吗」', () => {
    const chips = resolveContextRecommendations({
      boundContext: { page: 'run', filters: { status: 'FAILED' } },
      pageContext: { page: 'run' },
      capabilities: mockCapabilities(),
      permissions: { ...defaultPermissions, canReadRun: true },
    })

    expect(chips.some((c) => c.id === 'run-list-failure-digest')).toBe(true)
    const failureChip = chips.find((c) => c.id === 'run-list-failure-digest')
    expect(failureChip?.label).toBe('🧩 这些失败是同一个原因吗')
    expect(failureChip?.capabilityHint).toBe('knowledge.answer')

    // 无 canReadRun 时不展示
    const chipsNoRunPerm = resolveContextRecommendations({
      boundContext: { page: 'run', filters: { status: 'FAILED' } },
      pageContext: { page: 'run' },
      capabilities: mockCapabilities(),
      permissions: { ...defaultPermissions, canReadRun: false },
    })
    expect(chipsNoRunPerm.some((c) => c.id === 'run-list-failure-digest')).toBe(false)
  })

  it('V2 页面筛选可触发运行列表排查，V1 运行详情仍保留 runId', () => {
    const listChips = resolveContextRecommendations({
      boundContext: null,
      pageContext: {
        version: 2,
        routeKey: 'runs.list',
        pageKind: 'run',
        page: 'run',
        view: { filters: { status: 'FAILED', limit: 20 } },
      },
      capabilities: mockCapabilities(),
      permissions: { ...defaultPermissions, canReadRun: true },
    })
    expect(listChips.map((chip) => chip.id)).toContain('run-list-failure-digest')

    const legacyDetailChips = resolveContextRecommendations({
      boundContext: null,
      pageContext: { page: 'run', runId: '11111111-1111-4111-8111-111111111111' },
      capabilities: mockCapabilities(),
      permissions: { ...defaultPermissions, canReadRun: true },
    })
    expect(legacyDetailChips.map((chip) => chip.id)).toContain('run-perf-bottleneck')
    expect(legacyDetailChips.map((chip) => chip.id)).not.toContain('run-list-failure-digest')
  })

  it('运行列表排查：只在筛选结果里确实有失败时展示归并推荐', () => {
    const resolve = (bound: Parameters<typeof resolveContextRecommendations>[0]['boundContext']) =>
      resolveContextRecommendations({
        boundContext: bound,
        pageContext: { page: 'run' },
        capabilities: mockCapabilities(),
        permissions: { ...defaultPermissions, canReadRun: true },
      }).some((c) => c.id === 'run-list-failure-digest')

    // 未按状态筛选：取决于当前列表里有没有失败运行
    expect(resolve({ page: 'run', filters: {}, listHasFailures: true })).toBe(true)
    expect(resolve({ page: 'run', filters: {}, listHasFailures: false })).toBe(false)
    // 按其他状态筛选：即使列表标记有失败也不展示
    expect(resolve({ page: 'run', filters: { status: 'SUCCEEDED' }, listHasFailures: true })).toBe(false)
  })

  it('表单上下文感知：激活目标配置表单时推荐字段解释与配置规则 Chips', () => {
    const chips = resolveContextRecommendations({
      boundContext: {
        page: 'target',
        activeForm: {
          formId: 'target-config',
          mode: 'create',
        },
      },
      pageContext: { page: 'target' },
      capabilities: mockCapabilities(),
      permissions: defaultPermissions,
    })

    expect(chips.map((c) => c.label)).toEqual([
      '⏱️ 登录超时不填会怎样',
      '🧹 登录后整理规则',
      '📝 目标编码与命名规则',
    ])
  })

  it('表单上下文感知：激活目标配置表单且具备写权限时推荐表单修改 Chips', () => {
    const caps = mockCapabilities()
    caps.items.push({
      id: 'target.propose-form',
      label: '目标配置建议',
      available: true,
      missingPermissions: [],
      requiredContext: [],
    })
    const chips = resolveContextRecommendations({
      boundContext: {
        page: 'target',
        activeForm: {
          formId: 'target-config',
          mode: 'edit',
        },
      },
      pageContext: { page: 'target' },
      capabilities: caps,
      permissions: { ...defaultPermissions, canWrite: true },
    })

    expect(chips.map((c) => c.label)).toEqual([
      '⏱️ 将登录等待设为30秒',
      '🧹 开启自动整理欢迎层',
      '⏱️ 登录超时不填会怎样',
    ])
    expect(chips[0].capabilityHint).toBe('target.propose-form')
    expect(chips[1].capabilityHint).toBe('target.propose-form')
  })

  it('表单上下文感知：用户无 workflow:write 但具备 canWriteTarget 时依然能看到修改建议 Chips', () => {
    const caps = mockCapabilities()
    caps.items.push({
      id: 'target.propose-form',
      label: '目标配置建议',
      available: true,
      missingPermissions: [],
      requiredContext: [],
    })
    const chips = resolveContextRecommendations({
      boundContext: {
        page: 'target',
        activeForm: {
          formId: 'target-config',
          mode: 'create',
        },
      },
      pageContext: { page: 'target' },
      capabilities: caps,
      permissions: { ...defaultPermissions, canWrite: false, canWriteTarget: true },
    })

    expect(chips.map((c) => c.label)).toContain('⏱️ 将登录等待设为30秒')
    expect(chips.map((c) => c.label)).toContain('🧹 开启自动整理欢迎层')
  })
})
