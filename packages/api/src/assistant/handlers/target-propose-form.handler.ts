import {
  TARGET_CONFIG_FORM_FIELDS,
  type AssistantResult,
  type TargetFormProposal,
  type TargetFormProposalChange,
  cleanAssistantQuestion,
  httpUrlSchema,
  sanitizeProposalChanges,
  targetCodeSchema,
  targetFormProposalSchema,
  targetNameSchema,
  validateTargetFormProposalChange,
} from '@cairn/shared'
import type { AssistantCapabilityHandlerContext } from '../registry.js'
import { requireVisibleTarget } from './common.js'

function slugifyTargetName(name: string): string {
  const lower = name.toLowerCase().trim()
  if (lower.includes('财务') || lower.includes('finance')) return 'finance-system'
  if (lower.includes('oa') || lower.includes('办公')) return 'oa-system'
  if (lower.includes('erp')) return 'erp-system'
  if (lower.includes('crm') || lower.includes('客户')) return 'crm-system'
  if (lower.includes('商城') || lower.includes('mall') || lower.includes('shop')) return 'mall-system'
  if (lower.includes('支付') || lower.includes('pay')) return 'payment-system'
  if (lower.includes('工单') || lower.includes('ticket')) return 'ticket-system'

  const ascii = lower.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (ascii.length >= 2 && ascii.length <= 60 && /^[a-z]/.test(ascii)) {
    return ascii
  }

  const hash = Math.abs(name.split('').reduce((acc, c) => ((acc << 5) - acc) + c.charCodeAt(0), 0))
    .toString(36)
    .slice(0, 6)
  return `target-${hash}`
}

function extractTargetNameFromQuestion(question: string): string | undefined {
  const cleaned = cleanAssistantQuestion(question)
  const createMatch =
    /(?:新建|创建|配置|添加|增加)(?:一个|个)?\s*([a-zA-Z0-9_\u4e00-\u9fa5]{2,30}?(?:系统|平台|后台|服务|应用|门户|中心)?)/.exec(cleaned)
  if (createMatch?.[1]) {
    const raw = createMatch[1].trim()
    if (!/^(?:一个|系统|目标|目标系统)$/.test(raw)) {
      return raw
    }
  }

  const editMatch = /(?:把|将)\s*([a-zA-Z0-9_\u4e00-\u9fa5]{2,30}?(?:系统|平台|后台)?)\s*的/.exec(cleaned)
  if (editMatch?.[1]) {
    const raw = editMatch[1].trim()
    if (!/^(?:这个|当前|该|本)$/.test(raw)) {
      return raw
    }
  }

  return undefined
}

export function constructRuleBasedProposal(
  question: string,
  mode: 'create' | 'edit',
  targetId?: string,
): AssistantResult | null {
  const cleaned = cleanAssistantQuestion(question)
  const rawName = extractTargetNameFromQuestion(cleaned)
  const urlMatch = /(https?:\/\/[^\s"'<>，。]+)/i.exec(cleaned)
  const timeoutMatch =
    /(?:提交后等待离开登录页|登录页停留超时|登录超时|超时)[^\d]{0,10}?(\d+)\s*秒?/i.exec(cleaned) ??
    /(?:改成|设为|设置成|为)\s*(\d+)\s*秒?/i.exec(cleaned)
  const settleTimeoutMatch = /(?:整理预算|整理超时)[^\d]{0,10}?(\d+)\s*秒?/i.exec(cleaned)
  const settleMatch = /(?:不整理|关闭整理|按平台整理|强整理)/.exec(cleaned)

  const changes: TargetFormProposalChange[] = []

  // L1 & L2: name & code
  if (rawName && targetNameSchema.safeParse(rawName).success) {
    changes.push({ fieldId: 'name', value: rawName })
    if (mode === 'create') {
      const code = slugifyTargetName(rawName)
      if (targetCodeSchema.safeParse(code).success) {
        changes.push({ fieldId: 'code', value: code })
      }
    }
  }

  // L1: entryUrl
  if (urlMatch?.[1]) {
    changes.push({ fieldId: 'entryUrl', value: urlMatch[1] })
  }

  // L2: timeout
  if (timeoutMatch?.[1]) {
    changes.push({ fieldId: 'loginLeaveTimeoutSeconds', value: timeoutMatch[1] })
  } else if (mode === 'create' && changes.length > 0) {
    changes.push({ fieldId: 'loginLeaveTimeoutSeconds', value: '30' })
  }

  // Settle timeout
  if (settleTimeoutMatch?.[1]) {
    changes.push({ fieldId: 'landingSettleTimeoutSeconds', value: settleTimeoutMatch[1] })
  }

  // Settle mode
  if (settleMatch?.[0]) {
    const val = /不|关闭/.test(settleMatch[0]) ? 'off' : 'default'
    changes.push({ fieldId: 'landingSettleMode', value: val })
  }

  // Auth method
  if (/无密码|免密/i.test(cleaned)) {
    changes.push({ fieldId: 'authMethod', value: 'none' })
  } else if (/用户名密码|账号密码|密码登录/i.test(cleaned)) {
    changes.push({ fieldId: 'authMethod', value: 'password' })
  }

  // Captcha mode
  if (/无验证码|关闭验证码|不使用验证码/i.test(cleaned)) {
    changes.push({ fieldId: 'captchaMode', value: 'none' })
  }

  // Gatekeeper: if no fields extracted, return clarify
  if (changes.length === 0) {
    return {
      kind: 'clarify',
      question: '请问您想要新建什么系统？请提供系统名称（例如：财务系统、CRM客户管理）。',
      missingFields: ['name'],
    }
  }

  const { cleanChanges, detectedPendingFields } = sanitizeProposalChanges(changes, mode)
  if (cleanChanges.length === 0) {
    return {
      kind: 'clarify',
      question: '未能提取出有效的表单字段，请提供系统名称（例如：财务系统）。',
      missingFields: ['name'],
    }
  }

  const nameVal = cleanChanges.find((c) => c.fieldId === 'name')?.value ?? '目标系统'
  const isPendingUrl = detectedPendingFields.includes('entryUrl')

  const summary = isPendingUrl
    ? `已为您规划好「${nameVal}」的基础配置与推荐超时，但目前缺少最关键的入口地址。`
    : `已为您规划好「${nameVal}」的${mode === 'create' ? '新建' : '配置修改'}建议。`

  return {
    kind: 'target_form',
    mode,
    targetId: targetId || undefined,
    summary,
    changes: cleanChanges,
    pendingFields: detectedPendingFields,
    clarifyPrompt: isPendingUrl ? '请提供系统的业务入口地址（URL）：' : undefined,
  }
}

export async function handleTargetProposeForm(
  ctx: AssistantCapabilityHandlerContext,
): Promise<AssistantResult> {
  const { question, slots, body, session, actor, targets, db, signal, onProgress } = ctx

  // 1. RBAC Guard: requires target:write
  if (!actor.permissions.includes('target:write')) {
    return {
      kind: 'unsupported',
      reasonCode: 'PERMISSION_DENIED',
      message: '需要 target:write 权限才能生成目标配置提案。',
    }
  }

  await onProgress?.('loading_facts', '正在装配目标配置契约与当前事实...')

  // 2. Multi-turn continuation handling
  if (slots.continuation && slots.previousProposal) {
    const prev = slots.previousProposal as TargetFormProposal
    const cleaned = cleanAssistantQuestion(question)

    // Check if user provided an entry URL
    const urlMatch = /(https?:\/\/[^\s"'<>，。]+)/i.exec(cleaned)
    let candidateUrl = urlMatch?.[1]?.trim()
    if (!candidateUrl && (cleaned.startsWith('www.') || (cleaned.includes('.') && !cleaned.includes(' ')))) {
      candidateUrl = cleaned.startsWith('http') ? cleaned : `http://${cleaned}`
    }

    if (candidateUrl && httpUrlSchema.safeParse(candidateUrl).success) {
      const updatedChanges: TargetFormProposalChange[] = [
        ...prev.changes.filter((c) => c.fieldId !== 'entryUrl'),
        { fieldId: 'entryUrl', value: candidateUrl },
      ]
      const { cleanChanges, detectedPendingFields } = sanitizeProposalChanges(
        updatedChanges,
        prev.mode
      )

      await onProgress?.('generating', '已成功补齐入口地址，正在生成完整提案...')

      return {
        kind: 'target_form',
        mode: prev.mode,
        targetId: prev.targetId,
        summary: `已成功补齐入口地址，并保留了此前的配置规划。`,
        changes: cleanChanges,
        pendingFields: detectedPendingFields,
        clarifyPrompt:
          detectedPendingFields.length > 0
            ? '请提供系统的业务入口地址（URL）：'
            : undefined,
      }
    }

    // Two-round circuit breaker: user didn't give a URL (e.g. "我不知道" or "先建了再说")
    await onProgress?.('generating', '正在生成预设草稿...')
    return {
      kind: 'target_form',
      mode: prev.mode,
      targetId: prev.targetId,
      summary: `已为您预设好基础配置，未识别到有效入口地址，请在表单中稍后手动填入。`,
      changes: prev.changes,
      pendingFields: prev.pendingFields ?? ['entryUrl'],
      clarifyPrompt: undefined,
    }
  }

  // 3. Determine mode and targetId
  const activeForm = body.pageContext?.activeForm as
    | { formId?: string; mode?: 'create' | 'edit'; targetId?: string; draftValues?: Record<string, string> }
    | undefined
  const mode: 'create' | 'edit' =
    (slots.mode as 'create' | 'edit') ??
    activeForm?.mode ??
    (/(?:修改|调整|编辑)/.test(question) && !/(?:新建|创建)/.test(question)
      ? 'edit'
      : 'create')

  const targetId: string | undefined =
    (slots.targetId as string | undefined) ??
    activeForm?.targetId ??
    body.pageContext?.targetId

  const draftValues: Record<string, string> =
    (slots.draftValues as Record<string, string> | undefined) ??
    activeForm?.draftValues ??
    {}

  // Load current values if in edit mode
  const currentValues: Record<string, string | undefined> = { ...draftValues }
  if (mode === 'edit' && targetId) {
    try {
      const target = await requireVisibleTarget(actor, targetId, targets, db)
      if (target) {
        if (!currentValues.name && target.name) currentValues.name = target.name
        if (!currentValues.code && target.code) currentValues.code = target.code
        if (!currentValues.entryUrl && target.entryUrl) currentValues.entryUrl = target.entryUrl
        if (!currentValues.loginUrl && target.loginUrl) currentValues.loginUrl = target.loginUrl
        if (
          !currentValues.loginLeaveTimeoutSeconds &&
          target.loginLeaveTimeoutMs !== undefined &&
          target.loginLeaveTimeoutMs !== null
        ) {
          currentValues.loginLeaveTimeoutSeconds = String(Math.round(target.loginLeaveTimeoutMs / 1000))
        }
        if (!currentValues.landingSettleMode && target.landingSettleMode) {
          currentValues.landingSettleMode = target.landingSettleMode
        }
        if (
          !currentValues.landingSettleTimeoutSeconds &&
          target.landingSettleTimeoutMs !== undefined &&
          target.landingSettleTimeoutMs !== null
        ) {
          currentValues.landingSettleTimeoutSeconds = String(Math.round(target.landingSettleTimeoutMs / 1000))
        }
        if (!currentValues.authMethod && target.authMethod) {
          currentValues.authMethod = target.authMethod
        }
        if (!currentValues.captchaMode && target.captchaMode) {
          currentValues.captchaMode = target.captchaMode
        }
        if (!currentValues.status && target.status) {
          currentValues.status = target.status
        }
      }
    } catch {
      // Tolerant to target loading errors
    }
  }

  // 4. If AI session is not available, execute rule-based extraction
  if (!session) {
    const fallback = constructRuleBasedProposal(question, mode, targetId)
    if (fallback) return fallback
    return {
      kind: 'unsupported',
      reasonCode: 'MODEL_UNAVAILABLE',
      message: '平台 AI 服务未就绪，未能从自然语言中识别出受支持的目标配置修改',
    }
  }

  await onProgress?.('generating', '正在调用大模型生成表单配置修改提案...')

  const fieldDescriptions = TARGET_CONFIG_FORM_FIELDS.map((f) => {
    const choices =
      'choiceLabels' in f && f.choiceLabels
        ? ` 可选值Key: [${Object.keys(f.choiceLabels).join(', ')}]`
        : ''
    const readOnly = 'readOnlyOnEdit' in f && f.readOnlyOnEdit ? ' (编辑模式不可修改)' : ''
    return `- ${f.id} (${f.label}, 别名: [${f.aliases.join(', ')}]): ${f.help}${choices}${readOnly}`
  }).join('\n')

  const systemPrompt = `你是识途平台（Cairn）的目标系统配置专家。
用户正在查看或填写目标系统配置表单（${mode === 'edit' ? '编辑模式' : '新建模式'}）。
请根据用户在自然语言中表达的意图，从合法字段中提取需要修改或填充的字段项，输出符合结构的 JSON 提案。

【表单字段契约定义】
${fieldDescriptions}

【当前已有值参考 (Current Values)】
${JSON.stringify(currentValues, null, 2)}

【严格字段分级与输出约束】
1. L1 核心字段（入口 URL）：若用户未明确提供，严禁编造任何假 URL！绝不能输出 example.com、test.com 或占位符号。
2. L2 默认字段：若用户仅给出名称，请自动生成系统编码（code，小写字母开头，英文短语或拼音 slug，如 finance-system），超时建议默认设为 "30"；严禁向用户询问“你要几秒超时”。
3. L3 高级字段：验证码与整理策略默认不开启，严禁主动询问“是否需要验证码”。
4. 在编辑模式 (mode: 'edit') 下，编码 (code) 是严格只读字段，绝对不可生成对 code 的修改变更！
5. 秒数字段必须输出纯正整数秒数字符串 (例如 "30")，不要带汉字单位。
6. 必须遵守如下 JSON 契约：
{
  "kind": "target_form",
  "mode": "${mode}",
  ${targetId ? `"targetId": "${targetId}",` : ''}
  "summary": "简要说明（如：已为您规划好基础配置，缺少入口地址）",
  "changes": [
    {
      "fieldId": "合法的字段ID",
      "value": "字符串值"
    }
  ],
  "pendingFields": ["entryUrl"], // 若缺少入口地址填入此数组，否则留空 []
  "clarifyPrompt": "若有 pendingFields，写一句话提示用户补充；否则留空"
}`

  const messages: Array<{ role: 'system' | 'user'; content: string }> = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: question },
  ]

  const response = await session.completeJson(
    'target_form_proposal',
    targetFormProposalSchema,
    messages,
    signal,
  )

  if (!response.ok) {
    const fallback = constructRuleBasedProposal(question, mode, targetId)
    if (fallback) return fallback
    return {
      kind: 'unsupported',
      reasonCode: 'MODEL_GENERATION_FAILED',
      message: response.message || '生成表单配置建议失败',
    }
  }

  await onProgress?.('validating', '正在验证生成的表单字段合法性...')

  const candidate = response.value
  const { cleanChanges, detectedPendingFields } = sanitizeProposalChanges(
    candidate.changes,
    mode
  )

  if (cleanChanges.length === 0) {
    const fallback = constructRuleBasedProposal(question, mode, targetId)
    if (fallback) return fallback
    return {
      kind: 'clarify',
      question: '请提供系统名称（例如：财务系统）。',
      missingFields: ['name'],
    }
  }

  // Merge pending fields
  const allPending = Array.from(
    new Set([...(candidate.pendingFields ?? []), ...detectedPendingFields])
  )

  return {
    kind: 'target_form',
    mode,
    targetId: targetId || undefined,
    summary: candidate.summary || `已生成目标配置建议`,
    changes: cleanChanges,
    pendingFields: allPending,
    clarifyPrompt: allPending.length > 0 ? (candidate.clarifyPrompt ?? '请提供系统的业务入口地址（URL）：') : undefined,
  }
}
