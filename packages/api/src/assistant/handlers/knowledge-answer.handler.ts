import {
  type AssistantKnowledgeAnswerClaim,
  type AssistantKnowledgeAnswerMissing,
  type AssistantKnowledgeAnswerResult,
  type AssistantNextAction,
  normalizeAssistantPageContext,
  hasAllPermissions,
  stepRunFor,
} from '@cairn/shared'
import {
  DomainError,
  loadRunObservation,
  getScenario,
  getSessionDto,
  getSchedule,
  getDataset,
} from '@cairn/db'
import { z } from 'zod'
import type { AssistantCapabilityHandlerContext } from '../registry.js'
import { retrieveHelpSnippets, type HelpSnippetResult } from '../help/catalog.js'
import { requireVisibleTarget } from './common.js'

const MAX_FACT_CHARS = 12_000

interface FactItem {
  citation: string
  label: string
  fact: string
}

export async function handleKnowledgeAnswer(
  ctx: AssistantCapabilityHandlerContext,
): Promise<AssistantKnowledgeAnswerResult> {
  const { actor, slots, question, body, session, db, targets, signal, onProgress } = ctx

  if (!session) {
    throw new DomainError('forbidden', 'ASSISTANT_MODEL_DISABLED', '当前未配置或未启用 AI 模型，无法提供问答服务')
  }

  await onProgress?.('loading_facts', '正在检索相关知识与上下文事实...')

  const pageContext = normalizeAssistantPageContext(body.pageContext)
  const allowedCitations = new Set<string>()
  const factItems: FactItem[] = []
  const missingList: AssistantKnowledgeAnswerMissing[] = []
  const nextActions: AssistantNextAction[] = []

  // 1. 检索已发布的帮助文档知识片段
  const helpSnippets = retrieveHelpSnippets(question, {
    topK: 3,
    maxChars: 500,
    permissions: actor.permissions,
  })

  for (const snippet of helpSnippets) {
    allowedCitations.add(snippet.id)
    factItems.push({
      citation: snippet.id,
      label: `官方帮助 [${snippet.title}]`,
      fact: snippet.content,
    })

    if (snippet.category === 'studio') {
      nextActions.push({
        kind: 'studio.step',
        label: '前往场景工作室',
        href: snippet.pageRoute,
        citations: [],
      })
    } else if (snippet.category === 'run') {
      nextActions.push({
        kind: 'run.review',
        label: '前往运行列表复盘',
        href: snippet.pageRoute,
        citations: [],
      })
    } else if (snippet.category === 'target' || snippet.category === 'session') {
      nextActions.push({
        kind: 'target.accounts',
        label: '查看目标系统与账号',
        href: snippet.pageRoute,
        citations: [],
      })
    } else if (snippet.category === 'platform') {
      nextActions.push({
        kind: 'platform.config',
        label: '前往平台配置',
        href: snippet.pageRoute,
        citations: [],
      })
    }
  }

  // 2. 校验与装配当前页面的实体事实（零信任：服务端重新鉴权与校验）
  if (pageContext?.view?.tab) {
    allowedCitations.add('view:tab')
    factItems.push({
      citation: 'view:tab',
      label: '当前页面视图选项卡',
      fact: `当前正在查看的标签页: ${pageContext.view.tab}`,
    })
  }

  const runId = String(pageContext?.runId ?? slots.runId ?? '')
  if (runId) {
    if (hasAllPermissions(actor.permissions, ['run:read'])) {
      try {
        const obs = await loadRunObservation(db, runId)
        if (obs) {
          if (obs.run.targetId) {
            await requireVisibleTarget(actor, obs.run.targetId, targets, db)
          }
          const runCitation = `run:${obs.run.id}`
          allowedCitations.add(runCitation)
          factItems.push({
            citation: runCitation,
            label: `当前运行事实 (${obs.run.id.slice(0, 8)})`,
            fact: `运行ID: ${obs.run.id}, 场景: ${obs.run.scenarioName ?? obs.run.scenarioId}, 目标系统: ${obs.run.targetName ?? obs.run.targetId}, 状态: ${obs.run.status}, 业务结果: ${obs.run.outcomeStatus}, 证据状态: ${obs.run.evidenceStatus ?? '未知'}`,
          })

          // CQ-03: 解析所选 StepRun / Attempt 细节
          const targetStepId = String(
            pageContext?.stepId ||
              (pageContext?.view?.selectedRef?.kind === 'step' || pageContext?.view?.selectedRef?.kind === 'stepRun'
                ? pageContext.view.selectedRef.id
                : ''),
          )
          let matchedStepRun = obs.run.stepRuns.find((item) => item.id === targetStepId)
            ?? stepRunFor(obs.run.stepRuns, targetStepId)

          if (matchedStepRun) {
            const stepRunCitation = `stepRun:${matchedStepRun.id}`
            allowedCitations.add(stepRunCitation)
            factItems.push({
              citation: stepRunCitation,
              label: `步骤运行 (${matchedStepRun.name})`,
              fact: `步骤运行ID: ${matchedStepRun.id}, 步骤ID: ${matchedStepRun.stepId}, 步骤名: ${matchedStepRun.name}, 状态: ${matchedStepRun.status}, 业务结果: ${matchedStepRun.outcomeStatus}, 尝试次数: ${matchedStepRun.attempts.length}${
                matchedStepRun.attempts.some((a) => a.error)
                  ? `, 最新失败原因: ${matchedStepRun.attempts.find((a) => a.error)?.error?.safeMessage || '执行异常'}`
                  : ''
              }`,
            })
          }

          if (pageContext?.view?.selectedRef?.kind === 'attempt') {
            const targetAttemptId = pageContext.view.selectedRef.id
            const foundAttempt = obs.run.stepRuns
              .flatMap((s) => s.attempts)
              .find((a) => a.id === targetAttemptId)
            if (foundAttempt) {
              const attemptCitation = `attempt:${foundAttempt.id}`
              allowedCitations.add(attemptCitation)
              factItems.push({
                citation: attemptCitation,
                label: `尝试记录 (第 ${foundAttempt.attemptNo} 次尝试)`,
                fact: `尝试ID: ${foundAttempt.id}, 尝试序号: ${foundAttempt.attemptNo}, 状态: ${foundAttempt.status}, 开始时点: ${foundAttempt.startedAt}${
                  foundAttempt.error ? `, 失败原因: ${foundAttempt.error.safeMessage}` : ''
                }`,
              })
            } else {
              missingList.push({
                key: 'attempt',
                reason: 'not_found_or_mismatch',
                description: '当前查看的 Attempt 不属于该运行或未找到对应尝试记录',
              })
            }
          }

          if (pageContext?.stepId) {
            const ev = obs.evidence.items.find(
              (item) => item.stepRunId === pageContext.stepId || item.id === pageContext.stepId || item.stepRunId === matchedStepRun?.id,
            )
            if (ev) {
              const stepCitation = `evidence:${ev.id}`
              allowedCitations.add(stepCitation)
              factItems.push({
                citation: stepCitation,
                label: `步骤证据 (${ev.type})`,
                fact: `证据ID: ${ev.id}, 类型: ${ev.type}, 状态: ${ev.status}`,
              })
            }
          }
        }
      } catch {
        missingList.push({
          key: 'run',
          reason: 'access_denied_or_not_found',
          description: '关联的运行不存在或当前账号无权访问',
        })
      }
    } else {
      missingList.push({
        key: 'run',
        reason: 'permission_denied',
        description: '缺少 run:read 权限，无法读取当前运行事实',
      })
    }
  }

  const scenarioId = String(pageContext?.scenarioId ?? slots.scenarioId ?? '')
  if (scenarioId) {
    if (hasAllPermissions(actor.permissions, ['workflow:read'])) {
      try {
        const scenario = await getScenario(db, scenarioId)
        await requireVisibleTarget(actor, scenario.targetId, targets, db)
        const scCitation = `scenario:${scenario.id}`
        allowedCitations.add(scCitation)
        factItems.push({
          citation: scCitation,
          label: `当前场景事实 (${scenario.name})`,
          fact: `场景名称: ${scenario.name}, 目标ID: ${scenario.targetId}, 已发布版本: ${scenario.published?.versionId ?? '未发布'}, 草稿修订号: ${scenario.draft?.revision ?? '无草稿'}`,
        })

        // CQ-04: Studio 未保存草稿安全隔离标记
        if (pageContext?.draft?.isDirty) {
          const draftNoticeCitation = `scenario:${scenario.id}:draft_status`
          allowedCitations.add(draftNoticeCitation)
          factItems.push({
            citation: draftNoticeCitation,
            label: '草稿未保存提示',
            fact: `当前画布存在未保存修改；本次解答严格基于已保存定义（草稿修订号: ${scenario.draft?.revision ?? '未知'}）。未保存内容未纳入事实依据。`,
          })
        }

        // CQ-06: 场景步骤定义（Studio 问“这个步骤做什么”）
        const targetStepId = String(
          pageContext?.stepId ||
            (pageContext?.view?.selectedRef?.kind === 'step' ? pageContext.view.selectedRef.id : ''),
        )
        if (targetStepId && scenario.steps) {
          const step = scenario.steps.find((s) => s.id === targetStepId)
          if (step) {
            const stepCitation = `step:${step.id}`
            allowedCitations.add(stepCitation)
            factItems.push({
              citation: stepCitation,
              label: `场景步骤定义 (${step.name})`,
              fact: `步骤ID: ${step.id}, 步骤名: ${step.name}, 步骤类型: ${step.type}`,
            })
          }
        }
      } catch {
        missingList.push({
          key: 'scenario',
          reason: 'access_denied_or_not_found',
          description: '关联的场景不存在或当前账号无权访问',
        })
      }
    } else {
      missingList.push({
        key: 'scenario',
        reason: 'permission_denied',
        description: '缺少 workflow:read 权限，无法读取当前场景事实',
      })
    }
  }

  const targetId = String(pageContext?.targetId ?? slots.targetId ?? '')
  if (targetId) {
    if (hasAllPermissions(actor.permissions, ['target:read'])) {
      try {
        await requireVisibleTarget(actor, targetId, targets, db)
        const target = await targets.getTarget(targetId)
        const targetCitation = `target:${target.id}`
        allowedCitations.add(targetCitation)
        factItems.push({
          citation: targetCitation,
          label: `当前目标系统事实 (${target.name})`,
          fact: `目标系统: ${target.name}, 入口地址: ${target.entryUrl}, 状态: ${target.status}, 认证方式: ${target.authMethod}`,
        })
      } catch {
        missingList.push({
          key: 'target',
          reason: 'access_denied_or_not_found',
          description: '关联的目标系统不存在或当前账号无权访问',
        })
      }
    } else {
      missingList.push({
        key: 'target',
        reason: 'permission_denied',
        description: '缺少 target:read 权限，无法读取当前目标系统事实',
      })
    }
  }

  // CQ-12: Session 受管会话事实与跨账号多活实例隔离
  const sessionId = String(
    pageContext?.primaryRef?.kind === 'session'
      ? pageContext.primaryRef.id
      : pageContext?.view?.selectedRef?.kind === 'session'
        ? pageContext.view.selectedRef.id
        : slots.sessionId ?? '',
  )
  if (sessionId) {
    if (hasAllPermissions(actor.permissions, ['target:read'])) {
      try {
        const sessionDto = await getSessionDto(db, sessionId)
        if (!sessionDto) {
          missingList.push({
            key: 'session',
            reason: 'not_found',
            description: '关联的受管会话不存在',
          })
        } else {
          await requireVisibleTarget(actor, sessionDto.targetId, targets, db)
          // 检查 scopeRefs 边界（防止越权或伪造其他账号的 sessionId）
          let scopeMismatch = false
          if (Array.isArray(pageContext?.scopeRefs)) {
            for (const scope of pageContext.scopeRefs) {
              if (scope.kind === 'target' && scope.id !== sessionDto.targetId) {
                scopeMismatch = true
                break
              }
              if (
                ((scope.kind as string) === 'account' || (scope.kind as string) === 'target_account') &&
                scope.id !== sessionDto.targetAccountId
              ) {
                scopeMismatch = true
                break
              }
            }
          }
          if (scopeMismatch) {
            missingList.push({
              key: 'session',
              reason: 'scope_mismatch',
              description: '会话实例与当前目标系统或账号作用域不匹配',
            })
          } else {
            const sessionCitation = `session:${sessionDto.id}`
            allowedCitations.add(sessionCitation)
            factItems.push({
              citation: sessionCitation,
              label: `受管会话事实 (${sessionDto.id.slice(0, 8)})`,
              fact: `会话ID: ${sessionDto.id}, 目标系统ID: ${sessionDto.targetId}, 账号ID: ${sessionDto.targetAccountId}, 状态: ${sessionDto.status}, 认证状态: ${sessionDto.authState ?? '未知'}, 健康状态: ${sessionDto.health ?? '未知'}, 租约持有: ${sessionDto.ownerWorkerId ? 'Worker ' + sessionDto.ownerWorkerId : '空闲无租约'}`,
            })
            if (sessionDto.targetId && sessionDto.targetAccountId) {
              nextActions.push({
                kind: 'target.accounts',
                label: '查看当前会话与账号',
                href: `/sessions/${sessionDto.targetId}/${sessionDto.targetAccountId}`,
                citations: [sessionCitation],
              })
            }
          }
        }
      } catch {
        missingList.push({
          key: 'session',
          reason: 'access_denied_or_not_found',
          description: '关联的受管会话不存在或当前账号无权访问',
        })
      }
    } else {
      missingList.push({
        key: 'session',
        reason: 'permission_denied',
        description: '缺少 target:read 权限，无法读取当前受管会话事实',
      })
    }
  }

  // CQ-13: Schedule 调度规则事实
  const scheduleId = String(
    pageContext?.primaryRef?.kind === 'schedule'
      ? pageContext.primaryRef.id
      : pageContext?.view?.selectedRef?.kind === 'schedule'
        ? pageContext.view.selectedRef.id
        : slots.scheduleId ?? '',
  )
  if (scheduleId) {
    if (hasAllPermissions(actor.permissions, ['schedule:read'])) {
      try {
        const schedule = await getSchedule(db, scheduleId, actor.id)
        if (schedule) {
          const sId = schedule.scheduleId ?? (schedule as any).id ?? scheduleId
          const scCit = `schedule:${sId}`
          allowedCitations.add(scCit)
          factItems.push({
            citation: scCit,
            label: `调度规则事实 (${schedule.name || sId.slice(0, 8)})`,
            fact: `调度ID: ${sId}, 消费类型: ${schedule.consumerKey ?? 'scenario'}, 启用状态: ${schedule.enabled ? '已启用' : '已停用'}${
              schedule.nextDueAt ? `, 下次触发时间: ${schedule.nextDueAt}` : ''
            }`,
          })
          nextActions.push({
            kind: 'platform.config',
            label: '查看调度列表',
            href: '/schedules',
            citations: [scCit],
          })
        }
      } catch {
        missingList.push({
          key: 'schedule',
          reason: 'access_denied_or_not_found',
          description: '关联的调度规则不存在或当前账号无权访问',
        })
      }
    } else {
      missingList.push({
        key: 'schedule',
        reason: 'permission_denied',
        description: '缺少 schedule:read 权限，无法读取当前调度规则事实',
      })
    }
  }

  // CQ-14: Dataset 数据集与快照事实
  const datasetId = String(
    pageContext?.primaryRef?.kind === 'dataset'
      ? pageContext.primaryRef.id
      : pageContext?.view?.selectedRef?.kind === 'dataset'
        ? pageContext.view.selectedRef.id
        : slots.datasetId ?? '',
  )
  if (datasetId) {
    if (hasAllPermissions(actor.permissions, ['dataset:read'])) {
      try {
        const dataset = await getDataset(db, datasetId, actor.id)
        if (!dataset) {
          missingList.push({
            key: 'dataset',
            reason: 'not_found',
            description: '关联的数据集不存在',
          })
        } else {
          const dsCit = `dataset:${dataset.id}`
          allowedCitations.add(dsCit)
          factItems.push({
            citation: dsCit,
            label: `数据集与快照事实 (${dataset.name})`,
            fact: `数据集ID: ${dataset.id}, 名称: ${dataset.name}, 来源类型: ${dataset.sourceType}, 总行数: ${dataset.rowCount}, 导入时间: ${dataset.createdAt}, 更新时间: ${dataset.updatedAt}${
              dataset.selectedSheet ? `, 当前工作表: ${dataset.selectedSheet}` : ''
            }。注意：页内数据为快照抽样视图，不代表外部源系统全量实时数据。`,
          })
          nextActions.push({
            kind: 'platform.config',
            label: '查看数据集列表',
            href: '/datasets',
            citations: [dsCit],
          })
        }
      } catch {
        missingList.push({
          key: 'dataset',
          reason: 'access_denied_or_not_found',
          description: '关联的数据集不存在或当前账号无权访问',
        })
      }
    } else {
      missingList.push({
        key: 'dataset',
        reason: 'permission_denied',
        description: '缺少 dataset:read 权限，无法读取当前数据集事实',
      })
    }
  }

  // 3. 上下文预算控制 (ASSISTANT_MAX_FACT_CHARS = 12,000)
  let accumulatedChars = 0
  const boundedFacts: FactItem[] = []
  for (const item of factItems) {
    const itemLen = item.fact.length + item.label.length + 30
    if (accumulatedChars + itemLen > MAX_FACT_CHARS) {
      break
    }
    accumulatedChars += itemLen
    boundedFacts.push(item)
  }

  // 4. 若无任何可用知识片段与实体事实，诚实拒绝作答，不捏造事实
  if (boundedFacts.length === 0) {
    return {
      kind: 'knowledge_answer',
      summary: '在当前授权范围与知识库中未检索到与您提问相关的权威事实或帮助文档。',
      claims: [],
      missing: [
        {
          key: 'knowledge_base',
          reason: 'no_matching_facts',
          description: '未检索到与问题相关的已发布帮助片段或可访问实体事实。',
        },
        ...missingList,
      ],
      asOf: new Date().toISOString(),
    }
  }

  // 5. 模型生成有源解答
  await onProgress?.('generating', '正在基于已知事实与知识生成有源解答...')

  const llmResult = await session.completeJson(
    'knowledge_answer',
    z.strictObject({
      summary: z.string().min(1).max(2000),
      claims: z.array(
        z.strictObject({
          factKind: z.enum(['observed', 'human_confirmed', 'inferred']),
          text: z.string().min(1).max(500),
          citations: z.array(z.string()).default([]),
          premises: z.array(z.string()).optional(),
        }),
      ),
      missing: z
        .array(
          z.strictObject({
            key: z.string().min(1),
            reason: z.string().min(1),
            description: z.string().optional(),
          }),
        )
        .optional(),
    }),
    [
      {
        role: 'system',
        content: `你是识途平台的有源开放问答专家。你必须严格基于系统提供的【已知事实与知识片段】回答用户问题。
【核心规则】
1. 严禁捏造事实、推测未给出的平台数据或编造不存在的写操作指令。
2. 每一个 claim 必须附带 citations，且 citations 中的 key 必须存在于【可用引用键列表】中。
3. 对每个 claim 准确评定 factKind：
   - observed: 直接来自提供的实体状态或运行证据观测值；
   - human_confirmed: 来自已发布的官方帮助文档、规则或配置规范；
   - inferred: 基于已知前提所做的合理推断，必须在 premises 中列出依据的已知事实，并在 citations 中引用对应 key。
4. 如果提供的材料不足以完整回答用户的问题，必须在 missing 列表中诚实登记缺失项（key, reason, description），不能凭空臆造。
5. 保持解答专业、清晰、条理分明。`,
      },
      {
        role: 'user',
        content: JSON.stringify({
          question,
          pageContext: pageContext
            ? {
                routeKey: pageContext.routeKey,
                pageKind: pageContext.pageKind,
              }
            : null,
          availableCitations: Array.from(allowedCitations),
          contextFacts: boundedFacts,
        }),
      },
    ],
    signal,
  )

  await onProgress?.('validating', '正在校验回答的引用真实性与一致性...')

  let summary = '基于已知事实回答如下：'
  let validatedClaims: AssistantKnowledgeAnswerClaim[] = []
  const validatedMissing: AssistantKnowledgeAnswerMissing[] = [...missingList]

  if (llmResult.ok) {
    summary = llmResult.value.summary
    for (const c of llmResult.value.claims) {
      // 过滤未知引用
      const validCitations = c.citations.filter((cit) => allowedCitations.has(cit))
      if (c.factKind === 'inferred') {
        // 推理类 claim 必须有已验证前提或有效引用，缺依据则降级过滤并记录缺口 (CQ-08 / 4.3 节)
        const hasPremises = Array.isArray(c.premises) && c.premises.length > 0
        if (validCitations.length > 0 || hasPremises) {
          validatedClaims.push({
            factKind: 'inferred',
            text: c.text,
            citations: validCitations,
            premises: c.premises,
          })
        } else {
          validatedMissing.push({
            key: 'unsupported_inference',
            reason: 'missing_premises_or_citations',
            description: `推论缺乏已知事实前提或有效引用，已被系统安全过滤: ${c.text.slice(0, 100)}`,
          })
        }
      } else {
        // observed 或 human_confirmed 必须拥有至少一个合法引用
        if (validCitations.length > 0) {
          validatedClaims.push({
            factKind: c.factKind,
            text: c.text,
            citations: validCitations,
          })
        }
      }
    }
    if (llmResult.value.missing) {
      validatedMissing.push(...llmResult.value.missing)
    }
  } else {
    // LLM 调用失败或返回无效格式时的安全保底
    summary = '无法基于已知事实生成完整解答，以下为相关的已确认知识事实：'
    for (const fact of boundedFacts.slice(0, 3)) {
      validatedClaims.push({
        factKind: 'human_confirmed',
        text: `${fact.label}: ${fact.fact.slice(0, 200)}`,
        citations: [fact.citation],
      })
    }
    validatedMissing.push({
      key: 'model_inference',
      reason: 'generation_failed',
      description: '模型推理未完成或未返回合规结构',
    })
  }

  await onProgress?.('persisting', '正在整理最终回答...')

  return {
    kind: 'knowledge_answer',
    summary,
    claims: validatedClaims,
    missing: validatedMissing,
    asOf: new Date().toISOString(),
    nextActions: nextActions.slice(0, 3),
  }
}
