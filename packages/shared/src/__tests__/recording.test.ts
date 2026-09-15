import { describe, expect, it } from 'vitest'
import {
  MAX_RECORDING_EVENTS,
  MAX_RECORDING_JSON_BYTES,
  RECORDER_SOURCE_VERSION,
  assertRecordingPayloadSize,
  createRecordingBodySchema,
  normalizeRecording,
  parseJsonlSource,
  isSensitiveFill,
  recordingItemReady,
  RecordingNormalizationError,
  utf8ByteLength,
} from '../recording.js'

/**
 * 这些行的形状对齐 playwright-crx@0.15.0 JsonlLanguageGenerator：
 * `{ ...action, pageAlias, framePath, locator }`。
 * locator 对齐 JsonlLocatorFactory：`{ kind, body, options }`。
 */
const jsonlActions = {
  openBlank: { name: 'openPage', url: 'about:blank', signals: [], pageAlias: 'page', framePath: [] },
  navigateLogin: {
    name: 'navigate',
    url: 'https://shop.example/login',
    signals: [],
    pageAlias: 'page',
    framePath: [],
  },
  fillUser: {
    name: 'fill',
    selector: 'internal:label="账号"',
    text: 'ops',
    signals: [],
    pageAlias: 'page',
    framePath: [],
    locator: { kind: 'label', body: '账号', options: {} },
  },
  fillPass1: {
    name: 'fill',
    selector: 'internal:role=textbox[name="密码"i]',
    text: 'p',
    signals: [],
    pageAlias: 'page',
    framePath: [],
    locator: { kind: 'role', body: 'textbox', options: { name: '密码' } },
  },
  fillPass2: {
    name: 'fill',
    selector: 'internal:role=textbox[name="密码"i]',
    text: 'secret-pass',
    signals: [],
    pageAlias: 'page',
    framePath: [],
    locator: { kind: 'role', body: 'textbox', options: { name: '密码' } },
  },
  clickSubmit: {
    name: 'click',
    selector: 'internal:role=button[name="登录"i]',
    button: 'left',
    modifiers: 0,
    clickCount: 1,
    signals: [{ name: 'navigation', url: 'https://shop.example/orders' }],
    pageAlias: 'page',
    framePath: [],
    locator: { kind: 'role', body: 'button', options: { name: '登录' } },
  },
  fillOrder: {
    name: 'fill',
    selector: '#orderNo',
    text: 'SO-1001',
    signals: [],
    pageAlias: 'page',
    framePath: [],
    locator: { kind: 'default', body: '#orderNo', options: {} },
  },
  clickQuery: {
    name: 'click',
    selector: 'internal:role=button[name="查询"i]',
    button: 'left',
    modifiers: 0,
    clickCount: 1,
    signals: [],
    pageAlias: 'page',
    framePath: [],
    locator: { kind: 'role', body: 'button', options: { name: '查询' } },
  },
  clickIframe: {
    name: 'click',
    selector: 'internal:role=button[name="明细"i]',
    button: 'left',
    modifiers: 0,
    clickCount: 1,
    signals: [],
    pageAlias: 'page',
    framePath: ['iframe#report'],
    locator: { kind: 'role', body: 'button', options: { name: '明细' } },
  },
  assertVisible: {
    name: 'assertVisible',
    selector: 'internal:text="SO-1001"',
    signals: [],
    pageAlias: 'page',
    framePath: [],
    locator: { kind: 'text', body: 'SO-1001', options: {} },
  },
  assertText: {
    name: 'assertText',
    selector: 'internal:text="已查询"',
    text: '已查询',
    substring: false,
    signals: [],
    pageAlias: 'page',
    framePath: [],
    locator: { kind: 'text', body: '已查询', options: {} },
  },
  selectStatus: {
    name: 'select',
    selector: '#status',
    options: ['已发货'],
    signals: [],
    pageAlias: 'page',
    framePath: [],
    locator: { kind: 'default', body: '#status', options: {} },
  },
  pressEnter: {
    name: 'press',
    selector: '#orderNo',
    key: 'Enter',
    modifiers: 0,
    signals: [],
    pageAlias: 'page',
    framePath: [],
    locator: { kind: 'default', body: '#orderNo', options: {} },
  },
  setFiles: {
    name: 'setInputFiles',
    selector: 'input[type="file"]',
    files: ['invoice.pdf'],
    signals: [],
    pageAlias: 'page',
    framePath: [],
    locator: { kind: 'default', body: 'input[type="file"]', options: {} },
  },
  closePage: { name: 'closePage', signals: [], pageAlias: 'page', framePath: [] },
  popupClick: {
    name: 'click',
    selector: 'internal:role=button[name="导出"i]',
    button: 'left',
    modifiers: 0,
    clickCount: 1,
    signals: [{ name: 'popup', popupAlias: 'page1' }],
    pageAlias: 'page',
    framePath: [],
    locator: { kind: 'role', body: 'button', options: { name: '导出' } },
  },
  assertValue: {
    name: 'assertValue',
    selector: '#orderNo',
    value: 'SO-1001',
    signals: [],
    pageAlias: 'page',
    framePath: [],
    locator: { kind: 'default', body: '#orderNo', options: {} },
  },
}

function sampleRecording() {
  return [
    jsonlActions.openBlank,
    jsonlActions.navigateLogin,
    jsonlActions.fillUser,
    jsonlActions.fillPass1,
    jsonlActions.fillPass2,
    jsonlActions.clickSubmit,
    jsonlActions.fillOrder,
    jsonlActions.clickQuery,
    jsonlActions.clickIframe,
    jsonlActions.assertVisible,
    jsonlActions.assertText,
    jsonlActions.selectStatus,
    jsonlActions.pressEnter,
    jsonlActions.setFiles,
    jsonlActions.closePage,
    jsonlActions.popupClick,
    jsonlActions.assertValue,
  ]
}

describe('parseJsonlSource', () => {
  it('优先读 actions，跳过 text 里头行', () => {
    const header = JSON.stringify({ browserName: 'chromium', launchOptions: {} })
    const click = JSON.stringify(jsonlActions.clickQuery)
    const fromActions = parseJsonlSource({
      text: `${header}\n${click}`,
      actions: [click],
    })
    expect(fromActions).toHaveLength(1)
    expect(fromActions[0]).toMatchObject({ name: 'click' })

    const fromText = parseJsonlSource({ text: `${header}\n${click}` })
    expect(fromText).toHaveLength(1)
    expect(fromText[0]).toMatchObject({ name: 'click', pageAlias: 'page' })
  })

  it('actions 缺省且 text 为空时得到空列', () => {
    expect(parseJsonlSource({})).toEqual([])
  })

  it('采集补全：密码定位写出 inputType，不把缺字段 click 猜成左键', () => {
    const [filled] = parseJsonlSource({
      actions: [
        JSON.stringify({
          name: 'fill',
          selector: 'internal:role=textbox[name="密码"i]',
          text: 'secret',
          locator: { kind: 'role', body: 'textbox', options: { name: '密码' } },
        }),
      ],
    })
    expect(filled).toMatchObject({ inputType: 'password' })
    expect(isSensitiveFill(filled as { name: 'fill'; inputType: string; locator: { kind: string; body: string; options: { name: string } } })).toBe(true)
    const result = normalizeRecording(
      [
        jsonlActions.navigateLogin,
        {
          name: 'click',
          selector: 'internal:role=button[name="查询"i]',
          locator: { kind: 'role', body: 'button', options: { name: '查询' } },
        },
      ],
      { sourceVersion: RECORDER_SOURCE_VERSION },
    )
    expect(result.items.some((item) => item.sourceAction === 'click' && item.status === 'unresolved')).toBe(true)
  })
})

describe('normalizeRecording JSONL 探针', () => {
  it('稳定取出 navigate / fill / click / frame，并列出不能映射的类型', () => {
    const result = normalizeRecording(sampleRecording(), { sourceVersion: RECORDER_SOURCE_VERSION })

    expect(result.events.some((event) => event.name === 'openPage' && event.url === 'about:blank')).toBe(true)
    expect(result.items.map((item) => [item.sourceAction, item.status, item.candidateStepType])).toEqual([
      ['navigate', 'mapped', 'navigate'],
      ['fill', 'mapped', 'fill'],
      ['fill', 'parameterized', 'fill'],
      ['click', 'mapped', 'click'],
      ['fill', 'mapped', 'fill'],
      ['click', 'mapped', 'click'],
      ['click', 'mapped', 'click'],
      ['assertVisible', 'mapped', 'assert'],
      ['assertText', 'mapped', 'assert'],
      ['select', 'mapped', 'select'],
      ['press', 'mapped', 'keyboard'],
      ['setInputFiles', 'unresolved', undefined],
      ['closePage', 'unresolved', undefined],
      ['click', 'mapped', 'click'],
      ['assertValue', 'unresolved', undefined],
    ])

    const iframe = result.items.find((item) => item.name === '点击' && item.framePath?.[0] === 'iframe#report')
    expect(iframe?.input).toMatchObject({
      target: {
        framePath: [{ selector: 'iframe#report' }],
        candidates: [{ by: 'role', value: 'button', name: '明细' }],
      },
    })

    const password = result.items.find((item) => item.sensitive)
    expect(password?.sourceIndexes).toEqual([3, 4])
    expect(password?.input).toMatchObject({ sensitive: true })
    expect(result.events.filter((event) => event.name === 'fill' && event.selector?.includes('密码'))).toEqual(
      [expect.objectContaining({ text: undefined })],
    )

    const order = result.items.find(
      (item) => item.candidateStepType === 'fill' && !item.sensitive && item.input && typeof item.input === 'object' && 'value' in item.input && item.input.value === 'SO-1001',
    )
    expect(order?.input).toMatchObject({
      target: { candidates: [{ by: 'css', value: '#orderNo' }] },
      value: 'SO-1001',
    })

    const popup = result.items.find((item) => item.diagnostics.some((line) => line.includes('弹出页')))
    expect(popup?.status).toBe('mapped')
    expect(popup?.input).toMatchObject({ pageAfter: 'popup' })
    expect(recordingItemReady(popup!)).toBe(true)

    expect(result.unresolvedCount).toBe(3)
  })

  it('连续普通填写合并为最后一次值', () => {
    const result = normalizeRecording([
      { ...jsonlActions.fillOrder, text: 'SO-1' },
      { ...jsonlActions.fillOrder, text: 'SO-1001' },
    ])
    expect(result.items).toHaveLength(1)
    expect(result.items[0]?.sourceIndexes).toEqual([0, 1])
    expect(result.items[0]?.input).toMatchObject({ value: 'SO-1001' })
  })

  it('拒绝 storage state / Cookie，空录制不能当成功', () => {
    expect(() => normalizeRecording([{ name: 'click', storageState: { cookies: [] } }])).toThrow(
      RecordingNormalizationError,
    )
    expect(() =>
      normalizeRecording([{ name: 'click', locator: { kind: 'role', body: 'button', cookies: [] } }]),
    ).toThrow(/Cookie/)
    expect(() => normalizeRecording([jsonlActions.openBlank])).toThrow(/没有可保存的业务操作/)
  })

  it('check/uncheck、locator 链、placeholder/alt、过深 iframe 不能错误降级', () => {
    const result = normalizeRecording(
      [
        {
          name: 'check',
          selector: '#agree',
          locator: { kind: 'default', body: '#agree', options: {} },
          pageAlias: 'page',
          framePath: [],
        },
        {
          name: 'uncheck',
          selector: '#agree',
          locator: { kind: 'default', body: '#agree', options: {} },
          pageAlias: 'page',
          framePath: [],
        },
        {
          name: 'click',
          locator: {
            kind: 'role',
            body: 'button',
            options: { name: '下一步' },
            next: { kind: 'text', body: '确认' },
          },
          pageAlias: 'page',
          framePath: [],
        },
        {
          name: 'fill',
          text: 'ops',
          locator: { kind: 'placeholder', body: '账号', options: {} },
          pageAlias: 'page',
          framePath: [],
        },
        {
          name: 'click',
          locator: { kind: 'alt', body: '图标', options: {} },
          pageAlias: 'page',
          framePath: [],
        },
        {
          name: 'click',
          locator: { kind: 'role', body: 'button', options: { name: '深框' } },
          pageAlias: 'page',
          framePath: ['a', 'b', 'c', 'd', 'e'],
        },
      ],
      { sourceVersion: RECORDER_SOURCE_VERSION },
    )
    expect(result.items[0]?.name).toBe('勾选')
    expect(result.items[0]?.status).toBe('mapped')
    expect(result.items[1]?.name).toBe('取消勾选')
    expect(result.items[1]?.status).toBe('mapped')
    expect(result.items.slice(2).every((item) => item.status === 'unresolved')).toBe(true)
    expect(result.items.map((item) => item.sourceAction)).toEqual([
      'check',
      'uncheck',
      'click',
      'fill',
      'click',
      'click',
    ])
  })

  it('右键 / 双击 / 修饰键分别 mapped，缺字段不猜左键', () => {
    const result = normalizeRecording(
      [
        {
          name: 'click',
          button: 'right',
          clickCount: 1,
          modifiers: 0,
          locator: { kind: 'text', body: '项目行', options: {} },
          pageAlias: 'page',
          framePath: [],
        },
        {
          name: 'click',
          button: 'left',
          clickCount: 2,
          modifiers: 0,
          locator: { kind: 'text', body: '标题', options: {} },
          pageAlias: 'page',
          framePath: [],
        },
        {
          name: 'click',
          button: 'left',
          clickCount: 1,
          modifiers: ['Control'],
          locator: { kind: 'role', body: 'button', options: { name: '查询' } },
          pageAlias: 'page',
          framePath: [],
        },
        {
          name: 'click',
          locator: { kind: 'text', body: '旧事件', options: {} },
          pageAlias: 'page',
          framePath: [],
        },
        {
          name: 'press',
          key: 'F12',
          locator: { kind: 'default', body: 'body', options: {} },
          pageAlias: 'page',
          framePath: [],
        },
      ],
      { sourceVersion: RECORDER_SOURCE_VERSION },
    )
    expect(result.items.map((item) => [item.name, item.status, item.candidateStepType])).toEqual([
      ['右键点击', 'mapped', 'click'],
      ['双击', 'mapped', 'click'],
      ['Control+点击', 'mapped', 'click'],
      ['点击', 'unresolved', undefined],
      ['按键 F12', 'unresolved', undefined],
    ])
    expect(result.items[0]?.input).toMatchObject({ button: 'right' })
    expect(result.items[1]?.input).toMatchObject({ clickCount: 2 })
    expect(result.items[2]?.input).toMatchObject({ modifiers: ['Control'] })
    expect(result.items[3]?.diagnostics.some((line) => line.includes('不能猜测'))).toBe(true)
  })

  it('导入路径遇到未知来源版本不进入可执行转换', () => {
    const result = normalizeRecording([jsonlActions.navigateLogin, jsonlActions.clickQuery], {
      sourceVersion: 'playwright-crx@9.9.9',
      forImport: true,
    })
    expect(result.items.every((item) => item.status === 'unresolved')).toBe(true)
    expect(result.diagnostics.some((line) => line.includes('不能按'))).toBe(true)
  })

  it('密码字段、autocomplete、嵌套秘密与 URL 查询秘密都被剥掉', () => {
    const result = normalizeRecording([
      {
        name: 'navigate',
        url: 'https://shop.example/login?token=abc&q=1',
        signals: [],
        pageAlias: 'page',
        framePath: [],
      },
      {
        name: 'fill',
        text: 'plain-secret',
        inputType: 'password',
        locator: { kind: 'default', body: '#x', options: {} },
        pageAlias: 'page',
        framePath: [],
      },
      {
        name: 'fill',
        text: 'otp-value',
        autocomplete: 'one-time-code',
        locator: { kind: 'default', body: '#otp', options: {} },
        pageAlias: 'page',
        framePath: [],
      },
    ])
    expect(result.events[0]?.url).toBe('https://shop.example/login?q=1')
    expect(result.events.some((event) => event.text === 'plain-secret' || event.text === 'otp-value')).toBe(false)
    expect(result.items.filter((item) => item.sensitive)).toHaveLength(2)
  })

  it('条数超限与 UTF-8 体积超限使用正确错误码', () => {
    try {
      normalizeRecording(Array.from({ length: MAX_RECORDING_EVENTS + 1 }, () => jsonlActions.clickQuery))
      throw new Error('应当拒绝过多事件')
    } catch (error) {
      expect(error).toMatchObject({ code: 'RECORDING_TOO_MANY_EVENTS' })
    }
    const oversized = '中'.repeat(MAX_RECORDING_JSON_BYTES)
    expect(utf8ByteLength(oversized)).toBeGreaterThan(MAX_RECORDING_JSON_BYTES)
    try {
      assertRecordingPayloadSize({ events: [oversized] })
      throw new Error('应当拒绝过大上传')
    } catch (error) {
      expect(error).toMatchObject({ code: 'RECORDING_TOO_LARGE' })
    }
  })
})

describe('createRecordingBodySchema', () => {
  it('不允许把 steps 或 storageState 塞进上传体', () => {
    const body = {
      targetId: '11111111-1111-4111-8111-111111111111',
      recordingId: '22222222-2222-4222-8222-222222222222',
      sourceVersion: RECORDER_SOURCE_VERSION,
      idempotencyKey: 'rec-0001-key',
      events: [jsonlActions.clickQuery],
    }
    expect(createRecordingBodySchema.parse(body).events).toHaveLength(1)
    expect(() => createRecordingBodySchema.parse({ ...body, storageState: {} })).toThrow()
    expect(() => createRecordingBodySchema.parse({ ...body, events: [] })).toThrow()
    expect(
      () =>
        createRecordingBodySchema.parse({
          ...body,
          events: Array.from({ length: MAX_RECORDING_EVENTS + 1 }, () => jsonlActions.clickQuery),
        }),
    ).toThrow()
  })
})
