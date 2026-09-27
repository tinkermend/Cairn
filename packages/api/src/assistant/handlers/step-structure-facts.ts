import type { Step, ScenarioDocument } from '@cairn/shared'

export interface FactItem {
  citation: string
  label: string
  fact: string
}

export interface StepStructureFactsResult {
  found: boolean
  facts: FactItem[]
}

function getStepType(step: any): string {
  return String(step?.type || step?.action || 'unknown')
}

function readsKey(step: any, key: string): boolean {
  const type = getStepType(step)
  const input = step?.input ?? {}
  if (type === 'echo' || type === 'fill' || type === 'select') {
    if (input.from === key) return true
  }
  if (type === 'ai_action' && input.operation === 'input') {
    if (input.from === key) return true
  }
  if (type === 'upload' && Array.isArray(input.files)) {
    for (const f of input.files) {
      if (f?.source === 'context') {
        const from = f.from ?? f.contextKey
        if (from === key) return true
      }
    }
  }
  if (type === 'loop' && input.control) {
    if (input.control.type === 'for_each' && input.control.over?.from === key) {
      return true
    }
    if (Array.isArray(input.collect) && input.collect.some((c: any) => c?.from === key)) {
      return true
    }
  }
  if (step?.fieldRefs && typeof step.fieldRefs === 'object') {
    for (const ref of Object.values(step.fieldRefs) as any[]) {
      if (ref?.from === key) return true
    }
  }
  return false
}

function getStepInputKeys(step: any): { from: string; fromField?: string }[] {
  const type = getStepType(step)
  const input = step?.input ?? {}
  const refs: { from: string; fromField?: string }[] = []
  if (type === 'echo' || type === 'fill' || type === 'select') {
    if (input.from) {
      refs.push({ from: input.from, fromField: input.fromField })
    }
  }
  if (type === 'ai_action' && input.operation === 'input') {
    if (input.from) {
      refs.push({ from: input.from, fromField: input.fromField })
    }
  }
  if (type === 'upload' && Array.isArray(input.files)) {
    for (const f of input.files) {
      if (f?.source === 'context') {
        const from = f.from ?? f.contextKey
        if (from) refs.push({ from, fromField: f.fromField })
      }
    }
  }
  if (type === 'loop' && input.control) {
    if (input.control.type === 'for_each' && input.control.over?.from) {
      refs.push({
        from: input.control.over.from,
        fromField: input.control.over.fromField,
      })
    }
    if (Array.isArray(input.collect)) {
      for (const c of input.collect) {
        if (c?.from) refs.push({ from: c.from, fromField: c.fromField })
      }
    }
  }
  if (step?.fieldRefs && typeof step.fieldRefs === 'object') {
    for (const ref of Object.values(step.fieldRefs) as any[]) {
      if (ref?.from) refs.push({ from: ref.from, fromField: ref.fromField })
    }
  }
  return refs
}

/**
 * 递归展平或按数组提取场景步骤
 */
function extractAllSteps(scenario: { steps?: Step[]; draft?: { document?: any } }): Step[] {
  if (Array.isArray(scenario.steps) && scenario.steps.length > 0) {
    return scenario.steps
  }
  const draftDoc = scenario.draft?.document
  if (draftDoc) {
    if (Array.isArray(draftDoc.steps)) {
      return draftDoc.steps
    }
    if (Array.isArray(draftDoc.nodes)) {
      const result: Step[] = []
      const walk = (nodes: any[]) => {
        for (const node of nodes) {
          if (node.kind === 'step' && node.step) {
            result.push(node.step)
          } else if (node.kind === 'block') {
            if (Array.isArray(node.then)) walk(node.then)
            if (Array.isArray(node.else)) walk(node.else)
            if (Array.isArray(node.body)) walk(node.body)
          }
        }
      }
      walk(draftDoc.nodes)
      return result
    }
  }
  return []
}

/**
 * 选中步骤结构化事实解析引擎 (Step Structure Fact Extractor)
 *
 * 依据 packages/shared/src/step.ts 与 target-descriptor.ts 中 Step / TargetDescriptor 的真实定义，
 * 将选中步骤在场景 AST 中的结构化配置解析为可供模型精准回答、带细分 citation 索引的自然语言事实摘要。
 */
export function extractStepStructureFacts(
  scenario: { steps?: Step[]; draft?: { document?: any } },
  stepId: string,
): StepStructureFactsResult {
  const steps = extractAllSteps(scenario)
  const stepIndex = steps.findIndex((s) => s.id === stepId)

  if (stepIndex === -1) {
    return { found: false, facts: [] }
  }

  const step = steps[stepIndex]
  if (!step) {
    return { found: false, facts: [] }
  }
  const stepType = getStepType(step)
  const stepName = step.name || '未命名步骤'
  const facts: FactItem[] = []

  // 0. 基础步骤定义
  facts.push({
    citation: `step:${step.id}`,
    label: `场景步骤定义 (${stepName})`,
    fact: `步骤ID: ${step.id}, 步骤名: ${stepName}, 步骤类型: ${stepType}${step.optional ? ' (已配置为可选步骤 optional=true)' : ''}`,
  })

  // 1. 定位与操作参数 (step:<id>:selector)
  const inputAny = (step.input ?? {}) as any
  const target = inputAny?.target
  const selectorParts: string[] = []

  if (stepType.startsWith('ai_')) {
    if (stepType === 'ai_action') {
      if (inputAny?.instruction) {
        // 旧版指令形状：{ instruction }
        selectorParts.push(`AI 视觉操作步骤，指令: "${inputAny.instruction}"`)
      } else if (inputAny?.operation) {
        // 新版原子操作形状：{ operation: tap/input/keyboard/scroll, targetDescription, ... }
        selectorParts.push(`AI 视觉原子操作: ${inputAny.operation}${inputAny.targetDescription ? `，目标描述: "${inputAny.targetDescription}"` : ''}`)
        if (inputAny.operation === 'input') {
          if (inputAny.from) {
            selectorParts.push(`输入来源: 引用 context 键「${inputAny.from}」${inputAny.fromField ? ` (字段: ${inputAny.fromField})` : ''}，模式: ${inputAny.mode}`)
          } else if (inputAny.value !== undefined) {
            selectorParts.push(`输入字面值: "${inputAny.value}"，模式: ${inputAny.mode}`)
          } else {
            selectorParts.push(`清空输入 (mode: ${inputAny.mode})`)
          }
        } else if (inputAny.operation === 'keyboard' && inputAny.key) {
          selectorParts.push(`按键: ${inputAny.key}`)
        } else if (inputAny.operation === 'scroll') {
          selectorParts.push(`滚动方向: ${inputAny.direction}，距离: ${inputAny.distance}`)
        }
      } else {
        selectorParts.push('AI 视觉操作步骤，指令: "未指定"')
      }
    } else if (stepType === 'ai_extract') {
      selectorParts.push(`AI 视觉抽取步骤，指令: "${inputAny?.instruction || '未指定'}"`)
    } else if (stepType === 'ai_assert') {
      selectorParts.push(`AI 智能断言步骤，校验断言: "${inputAny?.assertion || '未指定'}"`)
    }
  } else if (target) {
    if (Array.isArray(target.candidates) && target.candidates.length > 0) {
      const candidatesSummary = target.candidates
        .map((c: any) => {
          if (c.by === 'role') return `role: ${c.name ? `[${c.name}] ` : ''}${c.value}`
          if (c.by === 'css') return `css: ${c.value} (CSS 选择器定位)`
          return `${c.by}: "${c.value}"`
        })
        .join('; ')
      selectorParts.push(`定位候选 (${target.candidates.length}项): [${candidatesSummary}]`)
    }
    if (target.anchor) {
      selectorParts.push(
        `相对锚点: 邻近文本 "${target.anchor.withinText}" (范围: ${target.anchor.scope})`,
      )
    }
    if (target.semantic) {
      selectorParts.push(`自然语言语义描述: "${target.semantic}"`)
    }
    if (Array.isArray(target.framePath) && target.framePath.length > 0) {
      selectorParts.push(`嵌套 iframe 深度: ${target.framePath.length}`)
    }
  } else if (stepType === 'navigate') {
    selectorParts.push(`导航目标 URL: ${inputAny?.url || '未指定'}`)
  } else if (stepType === 'echo') {
    selectorParts.push(`回显值: ${inputAny?.value !== undefined ? JSON.stringify(inputAny.value) : '从 context 读取'}`)
  } else if (stepType === 'compute') {
    selectorParts.push(`计算表达式: ${JSON.stringify(inputAny?.expression)}`)
  } else if (stepType === 'wait') {
    selectorParts.push(`等待配置: ${JSON.stringify(inputAny)}`)
  } else if ((step as any).description) {
    selectorParts.push(`步骤描述: "${(step as any).description}"`)
  }

  if (selectorParts.length > 0) {
    facts.push({
      citation: `step:${step.id}:selector`,
      label: `步骤定位与操作参数 (${stepName})`,
      fact: selectorParts.join('; '),
    })
  }

  // 2. 变量读写依赖 (step:<id>:vars)
  const varParts: string[] = []
  const readKeys = getStepInputKeys(step)

  if (step.outputKey) {
    varParts.push(`输出变量 (outputKey): 将操作结果写入 context 键「${step.outputKey}」`)
    // 下游引用检查（1 层）
    const downstream = steps
      .slice(stepIndex + 1)
      .filter((s) => readsKey(s, step.outputKey!))
      .map((s) => `第 ${steps.indexOf(s) + 1} 步「${s.name}」(ID: ${s.id})`)
    if (downstream.length > 0) {
      varParts.push(`下游直接引用步骤: ${downstream.join(', ')}`)
    }
  }

  if (readKeys.length > 0) {
    const readSummary = readKeys
      .map((k) => `键「${k.from}」${k.fromField ? ` (字段: ${k.fromField})` : ''}`)
      .join(', ')
    varParts.push(`读取变量 (from): 引用上游 context ${readSummary}`)

    // 上游依赖源检查（1 层）
    const upstreamSteps: string[] = []
    for (const rk of readKeys) {
      const up = steps.slice(0, stepIndex).find((s) => s.outputKey === rk.from)
      if (up) {
        upstreamSteps.push(`第 ${steps.indexOf(up) + 1} 步「${up.name}」(输出「${rk.from}」)`)
      }
    }
    if (upstreamSteps.length > 0) {
      varParts.push(`上游依赖步骤: ${upstreamSteps.join(', ')}`)
    }
  }

  if (varParts.length === 0) {
    varParts.push('该步骤为独立执行单元，无变量写入 (outputKey) 亦未引用上游变量 (from)')
  }

  facts.push({
    citation: `step:${step.id}:vars`,
    label: `步骤变量读写依赖 (${stepName})`,
    fact: varParts.join('; '),
  })

  // 3. 控制流上下文 (step:<id>:flow)
  const flowParts: string[] = []
  const prevStep = stepIndex > 0 ? steps[stepIndex - 1] : null
  const nextStep = stepIndex < steps.length - 1 ? steps[stepIndex + 1] : null
  const prevType = prevStep ? getStepType(prevStep) : ''
  const nextType = nextStep ? getStepType(nextStep) : ''

  if (prevStep) {
    flowParts.push(`直接前驱步骤: 第 ${stepIndex} 步「${prevStep.name || '前序步骤'}」(ID: ${prevStep.id}, 类型: ${prevType})`)
  } else {
    flowParts.push('该步骤为场景执行首步')
  }

  if (nextStep) {
    flowParts.push(`直接后继步骤: 第 ${stepIndex + 2} 步「${nextStep.name || '后序步骤'}」(ID: ${nextStep.id}, 类型: ${nextType})`)
  } else {
    flowParts.push('该步骤为场景最后一个步骤')
  }

  if ((step.policy?.retryLimit ?? 0) > 0) {
    flowParts.push(`配置了单步自动重试 (retryLimit: ${step.policy!.retryLimit} 次)`)
  }
  if (step.policy?.timeoutMs) {
    flowParts.push(`超时上限: ${step.policy.timeoutMs}ms`)
  }

  // 紧邻的分支控制块 (decide)
  if (prevType === 'decide') {
    flowParts.push(
      `紧邻前置分支判定步骤「${prevStep!.name}」(判定条件: ${JSON.stringify((prevStep!.input as any)?.condition)})`,
    )
  }
  if (nextType === 'decide') {
    flowParts.push(
      `紧邻后置分支判定步骤「${nextStep!.name}」(判定条件: ${JSON.stringify((nextStep!.input as any)?.condition)})`,
    )
  }

  // 紧邻或所处循环块 (loop)
  if (prevType === 'loop') {
    flowParts.push(`紧邻前置循环控制步骤「${prevStep!.name}」`)
  }
  if (nextType === 'loop') {
    flowParts.push(`紧邻后置循环控制步骤「${nextStep!.name}」`)
  }

  facts.push({
    citation: `step:${step.id}:flow`,
    label: `步骤控制流上下文 (${stepName})`,
    fact: flowParts.join('; '),
  })

  // 4. 邻近断言与校验 (step:<id>:assertion)
  const assertParts: string[] = []

  if (stepType === 'assert') {
    assertParts.push(
      `当前步骤自身即为断言校验，判定目标: ${JSON.stringify(inputAny?.expect || {})}`,
    )
  } else if (stepType === 'ai_assert') {
    assertParts.push(`当前步骤自身即为 AI 智能视觉断言，校验指令: "${inputAny?.assertion || ''}"`)
  }

  if (prevType === 'assert') {
    assertParts.push(
      `前置断言: 第 ${stepIndex} 步「${prevStep!.name}」进行了校验 (${JSON.stringify((prevStep!.input as any)?.expect)})`,
    )
  }
  if (nextType === 'assert') {
    assertParts.push(
      `后置断言: 第 ${stepIndex + 2} 步「${nextStep!.name}」进行了校验 (${JSON.stringify((nextStep!.input as any)?.expect)})`,
    )
  }

  if (assertParts.length === 0) {
    assertParts.push('当前步骤自身及紧邻的前后步骤均未配置 assert 断言校验')
  }

  facts.push({
    citation: `step:${step.id}:assertion`,
    label: `步骤邻近断言与校验 (${stepName})`,
    fact: assertParts.join('; '),
  })

  return {
    found: true,
    facts,
  }
}
