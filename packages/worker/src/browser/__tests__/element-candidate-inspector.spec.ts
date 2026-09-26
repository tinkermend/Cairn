import { describe, expect, it } from 'vitest'
import { inspectElementCandidate } from '../element-candidate-inspector.js'

describe('inspectElementCandidate 单元测试', () => {
  it('非目标动作直接返回 not_applicable', async () => {
    const fakePage = {} as any
    const res1 = await inspectElementCandidate({
      page: fakePage,
      actionName: 'Navigate',
      point: { x: 100, y: 100 },
    })
    expect(res1.status).toBe('not_applicable')
    expect(res1.candidates).toEqual([])

    const res2 = await inspectElementCandidate({
      page: fakePage,
      actionName: 'Sleep',
    })
    expect(res2.status).toBe('not_applicable')
  })

  it('缺少坐标时返回 unbound (NO_COORDINATES_PROVIDED)', async () => {
    const fakePage = {} as any
    const res = await inspectElementCandidate({
      page: fakePage,
      actionName: 'Tap',
      point: null,
    })
    expect(res.status).toBe('unbound')
    expect(res.reason).toBe('NO_COORDINATES_PROVIDED')
  })

  it('坐标处无元素时返回 unbound (NO_ELEMENT_AT_POINT)', async () => {
    const fakePage = {
      evaluateHandle: async () => ({
        asElement: () => null,
        dispose: async () => {},
      }),
    } as any

    const res = await inspectElementCandidate({
      page: fakePage,
      actionName: 'Tap',
      point: { x: 500, y: 500 },
    })
    expect(res.status).toBe('unbound')
    expect(res.reason).toBe('NO_ELEMENT_AT_POINT')
  })

  it('识别真实元素并完成等价比对，不产生 DOM 修改', async () => {
    // 模拟一个带有 data-testid 的按钮元素
    const fakeElement = {
      tagName: 'BUTTON',
      getAttribute: (attr: string) => {
        if (attr === 'data-testid') return 'submit-btn'
        if (attr === 'role') return 'button'
        return null
      },
      computedRole: () => 'button',
      computedName: () => '提交',
      closest: () => null,
      childNodes: [{ nodeType: 3, textContent: '提交' }],
      innerText: '提交',
    }

    const elementHandle = {
      evaluateHandle: async (fn: any, arg: any) => ({
        evaluateHandle: async () => ({ asElement: () => null }),
        evaluate: async () => false,
        dispose: async () => {},
      }),
      evaluate: async (fn: any) => fn(fakeElement),
      asElement: () => elementHandle,
      dispose: async () => {},
    }

    const candidateHandle = {
      dispose: async () => {},
    }

    const fakePage = {
      evaluateHandle: async () => ({
        asElement: () => elementHandle,
      }),
      evaluate: async (fn: any, args: any[]) => {
        // 比对 a === b
        return true
      },
      getByTestId: () => ({
        count: async () => 1,
        elementHandle: async () => candidateHandle,
      }),
      getByRole: () => ({
        count: async () => 1,
        elementHandle: async () => candidateHandle,
      }),
    } as any

    const res = await inspectElementCandidate({
      page: fakePage,
      actionName: 'Tap',
      point: { x: 100, y: 200 },
    })

    expect(res.status).toBe('bound')
    expect(res.candidates.length).toBeGreaterThan(0)
    expect(res.candidates.some((c) => c.by === 'testId' && c.value === 'submit-btn')).toBe(true)
    expect(res.candidates.some((c) => c.by === 'css')).toBe(false)
    expect(res.fingerprint?.tag).toBe('BUTTON')
    expect(res.fingerprint?.role).toBe('button')
  })

  it('敏感目标（密码框/验证码/sensitiveSelectors）直接返回 SENSITIVE_TARGET 且不采集候选与指纹', async () => {
    const fakePwdElement = {
      tagName: 'INPUT',
      getAttribute: (attr: string) => (attr === 'type' ? 'password' : null),
    }

    const elementHandle = {
      evaluateHandle: async () => ({
        evaluateHandle: async () => ({ asElement: () => null }),
        evaluate: async () => false,
        dispose: async () => {},
      }),
      evaluate: async (fn: any, args: any) => fn(fakePwdElement, args),
      asElement: () => elementHandle,
      dispose: async () => {},
    }

    const fakePage = {
      evaluateHandle: async () => ({
        asElement: () => elementHandle,
      }),
    } as any

    const res = await inspectElementCandidate({
      page: fakePage,
      actionName: 'Input',
      point: { x: 100, y: 200 },
      sensitiveSelectors: ['.secret-field'],
    })

    expect(res.status).toBe('unbound')
    expect(res.reason).toBe('SENSITIVE_TARGET')
    expect(res.candidates).toEqual([])
    expect(res.fingerprint).toBeUndefined()
  })

  it('候选池严格不生成 css 定位器', async () => {
    const fakeElement = {
      tagName: 'BUTTON',
      id: 'my-unique-id',
      getAttribute: (attr: string) => (attr === 'id' ? 'my-unique-id' : null),
      childNodes: [{ nodeType: 3, textContent: '按钮' }],
      innerText: '按钮',
    }

    const elementHandle = {
      evaluateHandle: async () => ({
        evaluateHandle: async () => ({ asElement: () => null }),
        evaluate: async () => false,
        dispose: async () => {},
      }),
      evaluate: async (fn: any) => fn(fakeElement),
      asElement: () => elementHandle,
      dispose: async () => {},
    }

    const candidateHandle = { dispose: async () => {} }

    const fakePage = {
      evaluateHandle: async () => ({
        asElement: () => elementHandle,
      }),
      evaluate: async () => true,
      getByText: () => ({
        count: async () => 1,
        elementHandle: async () => candidateHandle,
      }),
    } as any

    const res = await inspectElementCandidate({
      page: fakePage,
      actionName: 'Tap',
      point: { x: 100, y: 200 },
    })

    expect(res.candidates.every((c) => c.by !== 'css')).toBe(true)
  })
})
