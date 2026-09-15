import { describe, expect, it } from 'vitest'
import {
  authoringCapabilitiesSchema,
  debugActionSchema,
  debugCheckpointSchema,
  debugModeSchema,
  debugOverlaySchema,
  keyComboSchema,
  normalizeAuthoringObservation,
  observationShowsFragileCss,
  observeGrantSchema,
  pageIdentityChanged,
  targetDescriptorFromInspectSelector,
  observeOperationSchema,
  originsFromTargetUrls,
  RUN_STATUSES,
  stepSchema,
  targetObservationOutcomeSchema,
  targetObservationSchema,
  urlBelongsToTargetOrigins,
} from '../index.js'

describe('Authoring & Observation Contracts', () => {
  it('RUN_STATUSES 包含 HOLDING，debugModeSchema 包含三种试跑/执行模式', () => {
    expect(RUN_STATUSES).toContain('HOLDING')
    expect(debugModeSchema.parse('holdOnFailure')).toBe('holdOnFailure')
    expect(debugModeSchema.parse('holdAfterEach')).toBe('holdAfterEach')
    expect(debugModeSchema.parse('runThrough')).toBe('runThrough')
    expect(() => debugModeSchema.parse('invalid')).toThrow()
  })

  it('select 步骤 schema 校验', () => {
    const validByLabel = stepSchema.parse({
      id: '00000000-0000-4000-8000-000000000001',
      name: '选择城市',
      type: 'select',
      effectType: 'SIDE_EFFECT',
      input: {
        target: {
          candidates: [{ by: 'role', value: 'combobox', name: '城市' }],
        },
        by: 'label',
        value: '北京',
      },
    })
    expect(validByLabel.type).toBe('select')

    const validByIndex = stepSchema.parse({
      id: '00000000-0000-4000-8000-000000000002',
      name: '选择第一项',
      type: 'select',
      effectType: 'SIDE_EFFECT',
      input: {
        target: {
          candidates: [{ by: 'css', value: 'select#city' }],
        },
        by: 'index',
        index: 0,
      },
    })
    expect(validByIndex.type).toBe('select')

    // by=index 缺少 index 必须抛错
    expect(() =>
      stepSchema.parse({
        id: '00000000-0000-4000-8000-000000000003',
        name: '非法选择',
        type: 'select',
        effectType: 'SIDE_EFFECT',
        input: {
          target: { candidates: [{ by: 'css', value: 'select' }] },
          by: 'index',
        },
      }),
    ).toThrow()
  })

  it('keyboard 步骤与 keyComboSchema 封闭枚举', () => {
    expect(keyComboSchema.parse('Enter')).toBe('Enter')
    expect(keyComboSchema.parse('Tab')).toBe('Tab')
    expect(keyComboSchema.parse('Escape')).toBe('Escape')
    expect(keyComboSchema.parse('Control+s')).toBe('Control+s')
    expect(keyComboSchema.parse('Shift+Tab')).toBe('Shift+Tab')
    expect(keyComboSchema.parse('Alt+ArrowDown')).toBe('Alt+ArrowDown')
    expect(() => keyComboSchema.parse('F12')).toThrow()
    expect(() => keyComboSchema.parse('Ctrl+s')).toThrow() // 须是 Control

    const validKeyboard = stepSchema.parse({
      id: '00000000-0000-4000-8000-000000000004',
      name: '回车搜索',
      type: 'keyboard',
      effectType: 'SIDE_EFFECT',
      input: {
        keys: ['Enter'],
      },
    })
    expect(validKeyboard.type).toBe('keyboard')
  })

  it('wait 步骤 schema 校验', () => {
    const validWaitTime = stepSchema.parse({
      id: '00000000-0000-4000-8000-000000000005',
      name: '等待加载',
      type: 'wait',
      effectType: 'READ_ONLY',
      input: {
        kind: 'time',
        durationMs: 2000,
      },
    })
    expect(validWaitTime.type).toBe('wait')

    const validWaitVisible = stepSchema.parse({
      id: '00000000-0000-4000-8000-000000000006',
      name: '等待弹窗可见',
      type: 'wait',
      effectType: 'READ_ONLY',
      input: {
        kind: 'visible',
        target: { candidates: [{ by: 'role', value: 'dialog' }] },
      },
    })
    expect(validWaitVisible.type).toBe('wait')

    // time 缺少 durationMs 必须抛错
    expect(() =>
      stepSchema.parse({
        id: '00000000-0000-4000-8000-000000000007',
        name: '非法等待',
        type: 'wait',
        effectType: 'READ_ONLY',
        input: {
          kind: 'time',
        },
      }),
    ).toThrow()
  })

  it('click 步骤支持 button、clickCount 与 modifiers', () => {
    const rightClick = stepSchema.parse({
      id: '00000000-0000-4000-8000-000000000008',
      name: '右键点击',
      type: 'click',
      effectType: 'SIDE_EFFECT',
      input: {
        target: { candidates: [{ by: 'text', value: '项目行' }] },
        button: 'right',
        clickCount: 1,
        modifiers: ['Control'],
      },
    })
    expect(rightClick.type).toBe('click')
    if (rightClick.type === 'click') {
      expect(rightClick.input.button).toBe('right')
      expect(rightClick.input.modifiers).toEqual(['Control'])
    }
  })

  it('DebugCheckpoint 与 DebugOverlay schema 校验', () => {
    const checkpoint = debugCheckpointSchema.parse({
      mode: 'holdOnFailure',
      reason: 'step_failed',
      stepId: '00000000-0000-4000-8000-000000000010',
      stepOrdinal: 2,
      contextKeys: ['userId', 'orderId'],
      sessionGeneration: 1,
      fencingToken: 'f-12345',
      overlayRevision: 0,
    })
    expect(checkpoint.reason).toBe('step_failed')

    const overlay = debugOverlaySchema.parse({
      revision: 1,
      stepOverrides: {
        '00000000-0000-4000-8000-000000000010': {
          target: {
            candidates: [{ by: 'css', value: 'button#retry' }],
          },
        },
      },
    })
    expect(overlay.revision).toBe(1)
  })

  it('TargetObservation 与 ObserveGrant schema 校验', () => {
    const obs = targetObservationSchema.parse({
      outcome: 'FOUND',
      target: { candidates: [{ by: 'testId', value: 'submit-btn' }] },
      page: { url: 'https://app.example.com', title: 'Example App' },
      preview: { box: { x: 100, y: 200, width: 80, height: 32 }, tag: 'button', text: '提交' },
      diagnostics: {
        outcome: 'FOUND',
        candidatesTried: [{ by: 'testId', value: 'submit-btn', index: 0, matches: 1 }],
      },
      source: 'managed',
      assist: { explanation: '唯一匹配 testId=submit-btn', suggestedStepName: '点击提交按钮' },
    })
    expect(obs.outcome).toBe('FOUND')
    expect(obs.target?.candidates[0]?.by).toBe('testId')

    const grant = observeGrantSchema.parse({
      runId: '00000000-0000-4000-8000-000000000020',
      sessionGeneration: 2,
      pageRef: {
        sessionId: '00000000-0000-4000-8000-000000000030',
        sessionGeneration: 2,
        pageId: '00000000-0000-4000-8000-000000000040',
        documentEpoch: 1,
      },
      epoch: 1,
    })
    expect(grant.epoch).toBe(1)

    const action = debugActionSchema.parse({
      action: 'retry_current',
      targetOverride: { candidates: [{ by: 'role', value: 'button', name: '重试' }] },
    })
    expect(action.action).toBe('retry_current')

    const caps = authoringCapabilitiesSchema.parse({
      indicate: 'open',
      highlight: 'open',
      debugHold: 'open',
      assist: 'closed',
      stepTypesExtra: ['select', 'keyboard', 'wait'],
    })
    expect(caps.stepTypesExtra).toContain('keyboard')
  })

  it('插件观察规范化：css 只能在最后一档，不把坐标写进目标', () => {
    const observation = normalizeAuthoringObservation({
      targetId: '00000000-0000-4000-8000-000000000020',
      url: 'https://shop.example.com/orders',
      title: '订单',
      target: {
        framePath: [],
        candidates: [
          { by: 'css', value: 'div:nth-child(3) button' },
          { by: 'testId', value: 'submit' },
          { by: 'label', value: '查询' },
        ],
      },
    })
    expect(observation.outcome).toBe('FOUND')
    expect(observation.source).toBe('extension')
    expect(observation.target?.candidates.map((item) => item.by)).toEqual(['testId', 'label', 'css'])
    expect(observation.target?.candidates.at(-1)?.by).toBe('css')
    expect(JSON.stringify(observation)).not.toMatch(/clientX|pageX|pageY/)
  })

  it('观察页必须与 Target 入口同源，拒绝 file / 跨站地址', () => {
    const allowed = originsFromTargetUrls('https://shop.example.com/orders', 'https://shop.example.com/login')
    expect(urlBelongsToTargetOrigins('https://shop.example.com/orders/1', allowed)).toBe(true)
    expect(urlBelongsToTargetOrigins('https://evil.example/orders', allowed)).toBe(false)
    expect(urlBelongsToTargetOrigins('file:///tmp/x.html', allowed)).toBe(false)
  })

  it('插件观察沿用 isSensitiveFill，密码候选不会写进目标', () => {
    const observation = normalizeAuthoringObservation({
      targetId: '00000000-0000-4000-8000-000000000020',
      url: 'https://shop.example.com/login',
      target: {
        framePath: [],
        candidates: [
          { by: 'label', value: '密码' },
          { by: 'role', value: 'textbox', name: '账号' },
        ],
      },
    })
    expect(observation.target?.candidates).toEqual([{ by: 'role', value: 'textbox', name: '账号' }])
  })

  it('检查点页变与脆弱 css 诊断可判定', () => {
    const pageRef = {
      sessionId: '00000000-0000-4000-8000-000000000030',
      sessionGeneration: 1,
      pageId: '00000000-0000-4000-8000-000000000040',
      documentEpoch: 1,
    }
    expect(pageIdentityChanged({ pageRef, url: 'https://a.example/' }, { pageRef, url: 'https://a.example/' })).toBe(false)
    expect(
      pageIdentityChanged({ pageRef, url: 'https://a.example/' }, { pageRef: { ...pageRef, documentEpoch: 2 }, url: 'https://b.example/' }),
    ).toBe(true)
    expect(pageIdentityChanged({ pageRef }, null)).toBe(false)
    expect(
      observationShowsFragileCss({
        diagnostics: { framePathResolved: ['main', 'fragile-css'] },
      }),
    ).toBe(true)
    expect(targetDescriptorFromInspectSelector('internal:role=button[name="查询"i]')?.candidates[0]).toEqual({
      by: 'role',
      value: 'button',
      name: '查询',
    })
  })
})
