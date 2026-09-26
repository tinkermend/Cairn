import type { RunSnapshot, Step } from '@cairn/shared'

/** 调试覆盖只影响当前尝试，Run 的原始冻结快照仍保留供复盘。 */
export function snapshotForDebugStep(snapshot: RunSnapshot, stepId: string, editedStep?: Step): RunSnapshot {
  const frozen = snapshot.resolution
  const order = editedStep?.policy?.locatorPlan?.order
  if (!order || frozen?.protocol !== 'snapshot.resolution@2') return snapshot
  if (!frozen.steps[stepId]) throw new Error('当前步骤没有冻结的定位计划，请重新创建试跑')
  for (const route of order) {
    if (!frozen.allowed.includes(route)) throw new Error('本次运行冻结的定位能力不允许所选路线，请重新创建试跑')
    if (route === 'text_ai' && !snapshot.aiExecution?.platformAi) {
      throw new Error('本次运行未冻结文本模型配置，请重新创建试跑')
    }
    if (route === 'vision_ai' && !snapshot.aiExecution?.visionEnabled) {
      throw new Error('本次运行未冻结视觉模型配置，请重新创建试跑')
    }
  }
  return {
    ...snapshot,
    resolution: {
      ...frozen,
      steps: {
        ...frozen.steps,
        [stepId]: { requested: [...order], actual: [...order], skipped: [], source: 'step' },
      },
    },
  }
}
