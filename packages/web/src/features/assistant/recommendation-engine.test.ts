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

  it('场景编排（草稿未保存态）：优先置顶审查草稿改动', () => {
    const chips = resolveContextRecommendations({
      boundContext: { page: 'studio', isDirty: true },
      pageContext: { page: 'studio', scenarioId: 'sc-1' },
      capabilities: mockCapabilities(),
      permissions: defaultPermissions,
    })

    // 优先级：解释场景全貌 (100) > 审查未保存改动 (95) > 检查逻辑完整性 (90)
    expect(chips.map((c) => c.label)).toEqual([
      '💡 解释场景全貌',
      '📝 审查未保存改动',
      '🔍 检查逻辑完整性',
    ])
    expect(chips[1].id).toBe('studio-draft-diff')
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

  it('运行详情（失败复盘）：推荐诊断失败根因与对比上次成功运行', () => {
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
      '🚨 诊断失败根因',
      '🔄 对比上次成功运行',
    ])
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
      '📸 诊断当前步骤报错',
      '🚨 诊断失败根因',
      '🔄 对比上次成功运行',
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
})
