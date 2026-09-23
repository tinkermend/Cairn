import { describe, expect, it } from 'vitest'
import type { AiCommand } from '@cairn/shared'
import {
  isAriaBranchAdmitted,
  verifyCitations,
  verifyExtractionProvenance,
  tryAriaAssertBranch,
  tryAriaExtractBranch,
  tryAriaLocateBranch,
  DEFAULT_VISUAL_KEYWORDS,
} from './aria-tree-branch.js'
import { createFakeChatClient } from './midscene/model-client.js'

describe('AriaTreeBranch Unit Tests', () => {
  describe('isAriaBranchAdmitted (准入检查)', () => {
    const baseCommand: AiCommand = {
      type: 'ai_assert',
      instruction: '确认页面上有提交订单按钮',
      allowedOrigins: ['http://127.0.0.1'],
      maxCalls: 3,
      maxOutputTokens: 256,
      requestTimeoutMs: 5000,
      hangWaitMs: 1000,
    }

    it('ai_action 永不准入', () => {
      const command: AiCommand = { ...baseCommand, type: 'ai_action', instruction: '点击提交按钮' }
      const res = isAriaBranchAdmitted({ command, preferAriaTree: true })
      expect(res.admitted).toBe(false)
      expect(res.reason).toContain('step_type_unsupported')
    })

    it('策略开关关闭时拒绝准入（出厂默认）', () => {
      const res = isAriaBranchAdmitted({ command: baseCommand, preferAriaTree: false })
      expect(res.admitted).toBe(false)
      expect(res.reason).toBe('policy_disabled')
    })

    it('未设置开关时默认拒绝准入', () => {
      const res = isAriaBranchAdmitted({ command: baseCommand })
      expect(res.admitted).toBe(false)
      expect(res.reason).toBe('policy_disabled')
    })

    it('步骤包含敏感选择器时拒绝准入（PAS-P3 守卫）', () => {
      const res = isAriaBranchAdmitted({ command: baseCommand, preferAriaTree: true, hasSensitiveSelectors: true })
      expect(res.admitted).toBe(false)
      expect(res.reason).toBe('has_sensitive_selectors')
    })

    it('指令包含视觉关键词时拒绝准入', () => {
      const visualKeywords = ['位置', '颜色', '图标', '遮挡', '对齐', '红', '绿', '居中']
      for (const kw of visualKeywords) {
        const command: AiCommand = { ...baseCommand, instruction: `检查提交按钮的${kw}是否正确` }
        const res = isAriaBranchAdmitted({ command, preferAriaTree: true })
        expect(res.admitted).toBe(false)
        expect(res.reason).toContain('contains_visual_keyword')
      }
    })

    it('合法且无视觉词的 ai_assert 准入', () => {
      const res = isAriaBranchAdmitted({ command: baseCommand, preferAriaTree: true })
      expect(res.admitted).toBe(true)
      expect(res.reason).toBeUndefined()
    })

    it('合法且无视觉词的 ai_extract 准入', () => {
      const command: AiCommand = {
        ...baseCommand,
        type: 'ai_extract',
        instruction: '提取订单编号',
        outputSchema: { kind: 'scalar', type: 'string' },
      }
      const res = isAriaBranchAdmitted({ command, preferAriaTree: true })
      expect(res.admitted).toBe(true)
      expect(res.reason).toBeUndefined()
    })
  })

  describe('verifyCitations (机械核对引用行)', () => {
    const snapshot = `
- heading "订单详情" [level=1]
- text: 订单号: SO-20260920-001
- text: 状态: 已支付
- button "提交订单"
- button "取消"
`

    it('citations 包含快照中完全存在的行时核对通过', () => {
      const citations = ['- text: 状态: 已支付', '- button "提交订单"']
      expect(verifyCitations(citations, snapshot)).toBe(true)
    })

    it('citations 包含快照行的子串时核对通过', () => {
      const citations = ['已支付', '提交订单']
      expect(verifyCitations(citations, snapshot)).toBe(true)
    })

    it('citations 包含快照中不存在的行时核对失败', () => {
      const citations = ['- text: 状态: 已退款']
      expect(verifyCitations(citations, snapshot)).toBe(false)
    })

    it('citations 为空数组时核对失败', () => {
      expect(verifyCitations([], snapshot)).toBe(false)
    })

    it('citations 包含非字符串或空白字符串时核对失败', () => {
      expect(verifyCitations(['   '], snapshot)).toBe(false)
      expect(verifyCitations([123], snapshot)).toBe(false)
      expect(verifyCitations(null, snapshot)).toBe(false)
    })
  })

  describe('verifyExtractionProvenance (提取数据溯源核对)', () => {
    const snapshot = `
- heading "用户信息"
- text: 姓名: 张三
- text: 年龄: 28
- text: 订单编号: SO-9988
`

    it('提取文本和数值在快照中存在时核对通过', () => {
      expect(verifyExtractionProvenance('张三', snapshot)).toBe(true)
      expect(verifyExtractionProvenance(28, snapshot)).toBe(true)
      expect(verifyExtractionProvenance({ name: '张三', age: 28, orderId: 'SO-9988' }, snapshot)).toBe(true)
    })

    it('提取文本在快照中不存在时核对失败（捏造数据）', () => {
      expect(verifyExtractionProvenance('李四', snapshot)).toBe(false)
      expect(verifyExtractionProvenance({ name: '李四', age: 28 }, snapshot)).toBe(false)
    })

    it('提取数值在快照中不存在时核对失败', () => {
      expect(verifyExtractionProvenance(99, snapshot)).toBe(false)
      expect(verifyExtractionProvenance({ name: '张三', age: 99 }, snapshot)).toBe(false)
    })
  })

  describe('tryAriaAssertBranch 逻辑与回退', () => {
    const mockPage = {
      ariaSnapshot: async () => `
- heading "系统设置"
- text: 状态: 运行中
- button "保存配置"
`,
    } as any

    const command: AiCommand = {
      type: 'ai_assert',
      instruction: '检查状态是否为运行中',
      allowedOrigins: ['http://127.0.0.1'],
      maxCalls: 3,
      maxOutputTokens: 256,
      requestTimeoutMs: 5000,
      hangWaitMs: 1000,
    }

    it('模型判定 pass 且 citations 核对通过', async () => {
      const client = createFakeChatClient(async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                verdict: 'pass',
                citations: ['- text: 状态: 运行中'],
                reason: '快照中明确显示状态为运行中',
              }),
            },
          },
        ],
      }))

      const result = await tryAriaAssertBranch({
        page: mockPage,
        command,
        client,
        modelName: 'test-model',
        timeoutMs: 3000,
      })

      expect(result.handled).toBe(true)
      expect(result.result?.ok).toBe(true)
      expect(result.result?.output).toMatchObject({
        passed: true,
        route: 'aria_text',
        citations: ['- text: 状态: 运行中'],
      })
    })

    it('模型判定 fail 且 citations 核对通过', async () => {
      const client = createFakeChatClient(async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                verdict: 'fail',
                citations: ['- text: 状态: 运行中'],
                reason: '实际状态为运行中，而非已停止',
              }),
            },
          },
        ],
      }))

      const result = await tryAriaAssertBranch({
        page: mockPage,
        command: { ...command, instruction: '检查状态是否已停止' },
        client,
        modelName: 'test-model',
        timeoutMs: 3000,
      })

      expect(result.handled).toBe(true)
      expect(result.result?.ok).toBe(true)
      expect(result.result?.output).toMatchObject({
        passed: false,
        route: 'aria_text',
      })
    })

    it('模型判定 undecidable 时触发回退', async () => {
      const client = createFakeChatClient(async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                verdict: 'undecidable',
                reason: '快照中无法得知按钮背景色',
              }),
            },
          },
        ],
      }))

      const result = await tryAriaAssertBranch({
        page: mockPage,
        command,
        client,
        modelName: 'test-model',
        timeoutMs: 3000,
      })

      expect(result.handled).toBe(false)
      expect(result.fallbackReason).toContain('model_undecidable')
    })

    it('citations 机械核对失败时触发回退（幻觉防护）', async () => {
      const client = createFakeChatClient(async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                verdict: 'pass',
                citations: ['- text: 幻觉生成的文本行不存在于快照'],
                reason: '通过',
              }),
            },
          },
        ],
      }))

      const result = await tryAriaAssertBranch({
        page: mockPage,
        command,
        client,
        modelName: 'test-model',
        timeoutMs: 3000,
      })

      expect(result.handled).toBe(false)
      expect(result.fallbackReason).toBe('citations_verification_failed')
    })
  })

  describe('tryAriaLocateBranch 文本语义定位与回退', () => {
    const mockPage = {
      ariaSnapshot: async () => `
- heading "系统设置"
- button "保存配置"
- link "帮助中心"
`,
      getByRole: (role: string, opts?: { name?: string }) => ({
        count: async () => (role === 'button' && opts?.name === '保存配置' ? 1 : 0),
        boundingBox: async () => ({ x: 100, y: 200, width: 80, height: 40 }),
      }),
      getByText: () => ({ count: async () => 0, boundingBox: async () => null }),
      getByLabel: () => ({ count: async () => 0, boundingBox: async () => null }),
      locator: () => ({ count: async () => 0, boundingBox: async () => null }),
    } as any

    it('模型返回匹配候选且页面唯一定位成功时返回中心坐标', async () => {
      const client = createFakeChatClient(async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                verdict: 'found',
                candidate: { by: 'role', value: 'button', name: '保存配置' },
                reason: '匹配保存配置按钮',
              }),
            },
          },
        ],
      }))

      const result = await tryAriaLocateBranch({
        page: mockPage,
        prompt: '保存配置按钮',
        client,
        modelName: 'test-text-model',
        timeoutMs: 3000,
      })

      expect(result.handled).toBe(true)
      expect(result.center).toEqual([140, 220])
      expect(result.dpr).toBe(1)
    })

    it('模型返回 not_found 时触发回退到视觉路径', async () => {
      const client = createFakeChatClient(async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                verdict: 'not_found',
                reason: '无障碍树中未找到该元素',
              }),
            },
          },
        ],
      }))

      const result = await tryAriaLocateBranch({
        page: mockPage,
        prompt: '不存在的图标',
        client,
        modelName: 'test-text-model',
        timeoutMs: 3000,
      })

      expect(result.handled).toBe(false)
      expect(result.fallbackReason).toContain('aria_locate_not_found')
    })
  })
})

