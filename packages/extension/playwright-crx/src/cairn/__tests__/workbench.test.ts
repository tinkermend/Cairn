import { describe, expect, it, vi } from 'vitest'
import type { Source } from '@recorder/recorderTypes'
import { CairnApiError, formatRecordingUploadError } from '../api'
import { formatTransportError, performCairnRequest } from '../api-bridge'
import { describeAttachment, shortLocation } from '../attachment'
import { canAttachRecorder, canReadTargets, canUploadRecording } from '../auth-gate'
import { CAIRN_API_ENVIRONMENTS, resolveApiEnvironment } from '../config'
import { formatPickedElement } from '../inspect'
import { RECORDING_STATUS_LABEL, recordingItemMeta } from '../labels'
import { WORKBENCH_PATH, nextRecorderPanelPath, resetRecorderPanelPath, withDeadline } from '../panel-window'
import { previewRecording } from '../preview'
import { describeStepTarget, stepDetail } from '../step-detail'
import { recordingAllowedOrigins, recordingBridgeStartSchema, recordingStudioPath } from '@cairn/shared'
import { canRecordTab, chooseRecordingTab } from '../tab-choice'
import { studioReturnUrl } from '../api'

function previewOf(sources: readonly Source[], excluded: readonly number[] = []) {
  const preview = previewRecording(sources, excluded)
  if (!preview || 'error' in preview) throw new Error(`预览应当成立，实际：${JSON.stringify(preview)}`)
  return preview
}

describe('平台环境名单', () => {
  it('本期只有本地开发环境，地址是 localhost:3030', () => {
    expect(CAIRN_API_ENVIRONMENTS).toEqual([
      { id: 'local', label: '本地开发环境', origin: 'http://localhost:3030' },
    ])
    expect(resolveApiEnvironment(undefined).origin).toBe('http://localhost:3030')
    expect(resolveApiEnvironment('missing').id).toBe('local')
  })
})

describe('插件 API 请求', () => {
  it('登录不带旧 token，避免公开接口被脏 Authorization 干扰', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      expect(headers.has('Authorization')).toBe(false)
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })
    const result = await performCairnRequest(
      { path: '/api/auth/login', method: 'POST', skipAuth: true },
      {
        loadSession: async () => ({
          apiOrigin: 'http://localhost:3030',
          accessToken: 'stale-token',
        }),
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    )
    expect(result).toEqual({ ok: true, status: 200, body: { ok: true } })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('网络失败时说明控制台登录不能代替插件登录', () => {
    expect(formatTransportError(new TypeError('Failed to fetch'), 'http://localhost:3030')).toContain(
      '连不上 http://localhost:3030',
    )
  })
})

describe('登录门禁', () => {
  it('没有 token 或账号不能挂录制器', () => {
    expect(canAttachRecorder({ accessToken: '', account: null })).toBe(false)
    expect(
      canAttachRecorder({
        accessToken: 'tok',
        account: { id: '1', displayName: 'A', permissions: [] },
      }),
    ).toBe(true)
  })

  it('viewer 不能上传，admin 可以', () => {
    expect(canUploadRecording(['workflow:read', 'target:read'])).toBe(false)
    expect(canUploadRecording(['workflow:write'])).toBe(false)
    expect(canReadTargets(['workflow:read', 'target:read'])).toBe(true)
    expect(canUploadRecording(['workflow:write', 'target:read'])).toBe(true)
    expect(canUploadRecording(['*:*'])).toBe(true)
  })

  it('上传 403 给出编写者提示，而不是通用失败', () => {
    expect(
      formatRecordingUploadError(new CairnApiError(403, 'FORBIDDEN', '缺少权限：workflow:write')),
    ).toBe('当前账号没有录制上传权限，请联系管理员分配编写者角色')
    expect(formatRecordingUploadError(new Error('连不上平台 API'))).toBe('连不上平台 API')
  })
})

describe('步骤预览', () => {
  it('从 JSONL sources 归一成与控制台相同的 IR 文案', () => {
    const sources: Source[] = [
      {
        isRecorded: true,
        id: 'javascript',
        label: 'Library',
        language: 'javascript',
        text: '',
        highlight: [],
      },
      {
        isRecorded: true,
        id: 'jsonl',
        label: 'JSONL',
        language: 'jsonl',
        text: '',
        highlight: [],
        actions: [
          JSON.stringify({
            name: 'navigate',
            url: 'https://lab.example/orders',
            signals: [],
            pageAlias: 'page',
            framePath: [],
          }),
          JSON.stringify({
            name: 'fill',
            selector: '#orderNo',
            text: 'SO-9',
            signals: [],
            pageAlias: 'page',
            framePath: [],
            locator: { kind: 'default', body: '#orderNo', options: {} },
          }),
          JSON.stringify({
            name: 'click',
            selector: 'internal:role=button[name="查询"i]',
            signals: [],
            pageAlias: 'page',
            framePath: [],
            locator: { kind: 'role', body: 'button', options: { name: '查询' } },
          }),
          JSON.stringify({
            name: 'select',
            selector: '#status',
            options: ['open'],
            signals: [],
            pageAlias: 'page',
            framePath: [],
          }),
        ],
      },
    ]

    const preview = previewOf(sources)
    expect(preview.items.map((item) => item.name)).toEqual([
      '打开 lab.example/orders',
      '填写',
      '点击',
      '选择',
    ])
    expect(preview.items.map((item) => item.status)).toEqual([
      'mapped',
      'mapped',
      'mapped',
      'unresolved',
    ])
    expect(recordingItemMeta(preview.items[0]!)).toBe('已映射 · navigate')
    expect(recordingItemMeta(preview.items[3]!)).toContain('待处理')
    expect(RECORDING_STATUS_LABEL.parameterized).toBe('待补参数')
  })

  it('没有 JSONL 时不预览', () => {
    expect(previewRecording([])).toBeNull()
  })
})

describe('步骤明细', () => {
  const preview = previewOf([
    {
      isRecorded: true,
      id: 'jsonl',
      label: 'JSONL',
      language: 'jsonl',
      text: '',
      highlight: [],
      actions: [
        JSON.stringify({
          name: 'click',
          selector: 'internal:role=button[name="查询"i]',
          signals: [],
          pageAlias: 'page',
          framePath: [],
          locator: { kind: 'role', body: 'button', options: { name: '查询' } },
        }),
        JSON.stringify({
          name: 'fill',
          selector: '#orderNo',
          text: 'SO-9',
          signals: [],
          pageAlias: 'page',
          framePath: [],
          locator: { kind: 'default', body: '#orderNo', options: {} },
        }),
        JSON.stringify({
          name: 'select',
          selector: '#status',
          options: ['open'],
          signals: [],
          pageAlias: 'page',
          framePath: [],
        }),
      ],
    },
  ])

  it('同名操作靠定位摘要区分，不是一串一样的「点击」', () => {
    expect(describeStepTarget(preview.items[0]!)).toBe('button「查询」')
    expect(describeStepTarget(preview.items[1]!)).toBe('#orderNo')
    expect(describeStepTarget(preview.items[2]!)).toBeNull()
  })

  it('展开给出与控制台草稿同一套字段，含平台定位', () => {
    const detail = stepDetail(preview.items[0]!)
    expect(detail.sourceAction).toBe('click')
    expect(detail.candidateStepType).toBe('click')
    expect(detail.input).toMatchObject({
      target: { candidates: [{ by: 'role', value: 'button', name: '查询' }] },
    })
  })
})

describe('删除误录步', () => {
  const sources: Source[] = [
    {
      isRecorded: true,
      id: 'jsonl',
      label: 'JSONL',
      language: 'jsonl',
      text: '',
      highlight: [],
      actions: [
        JSON.stringify({ name: 'openPage', url: 'about:blank', signals: [], pageAlias: 'page' }),
        JSON.stringify({ name: 'navigate', url: 'https://lab.example/orders', signals: [], pageAlias: 'page' }),
        JSON.stringify({
          name: 'click',
          selector: 'internal:role=button[name="展开"i]',
          signals: [],
          pageAlias: 'page',
          locator: { kind: 'role', body: 'button', options: { name: '展开' } },
        }),
        JSON.stringify({
          name: 'fill',
          selector: '#orderNo',
          text: 'SO-9',
          signals: [],
          pageAlias: 'page',
          locator: { kind: 'default', body: '#orderNo', options: {} },
        }),
        JSON.stringify({
          name: 'fill',
          selector: '#orderNo',
          text: 'SO-90',
          signals: [],
          pageAlias: 'page',
          locator: { kind: 'default', body: '#orderNo', options: {} },
        }),
      ],
    },
  ]

  const ready = (excluded: readonly number[] = []) => previewOf(sources, excluded)

  it('删除按原始 JSONL 行下标，跳过被丢弃的空页面打开', () => {
    const preview = ready()
    expect(preview.items.map((item) => item.name)).toEqual(['打开 lab.example/orders', '点击', '填写'])
    // 第 1 行 about:blank 不产出步骤；连续两次 fill 合并成一步。
    expect(preview.sourceRows).toEqual([[1], [2], [3, 4]])
  })

  it('删掉误点的那一步，剩下的重新编号且上传包里没有它', () => {
    const preview = ready([2])
    expect(preview.items.map((item) => item.name)).toEqual(['打开 lab.example/orders', '填写'])
    expect(preview.items.map((item) => item.index)).toEqual([0, 1])
    expect(preview.events.some((event) => event.name === 'click')).toBe(false)
  })

  it('删掉合并过的填写，要把它的每一行都排除', () => {
    const preview = ready([3, 4])
    expect(preview.items.map((item) => item.name)).toEqual(['打开 lab.example/orders', '点击'])
  })

  it('删掉后一次填写时，剩下的按新的合并结果重新出列表', () => {
    const preview = ready([4])
    const fill = preview.items.find((item) => item.sourceAction === 'fill')
    expect(fill?.input).toMatchObject({ value: 'SO-9' })
  })

  it('全删光时给出可撤销的说明，而不是当成没录过', () => {
    expect(previewRecording(sources, [0, 1, 2, 3, 4])).toEqual({
      error: '这段操作都删掉了，撤销或重新录制',
    })
    expect(previewRecording([])).toBeNull()
  })

  it('给出用于高亮的原始 selector，navigate 没有就是 null', () => {
    const preview = ready()
    expect(preview.selectors[0]).toBeNull()
    expect(preview.selectors[1]).toBe('internal:role=button[name="展开"i]')
    expect(preview.selectors[2]).toBe('#orderNo')
  })
})

describe('录制上下文', () => {
  it('挂接后写出在录哪一页，未挂接说清点录制会挂当前页', () => {
    expect(
      describeAttachment({ attached: true, title: '订单管理', url: 'https://lab.example/orders' }, {
        recording: true,
        stepCount: 4,
        unresolvedCount: 0,
      }),
    ).toEqual({ head: '正在录制：订单管理', detail: 'lab.example/orders · 已记录 4 步' })

    expect(describeAttachment(null, { recording: false, stepCount: 0, unresolvedCount: 0 })).toEqual({
      head: '未挂接，点「开始录制」会挂到当前标签页',
      detail: null,
    })
  })

  it('挂着但没在录时报可导入步数与待处理数', () => {
    expect(
      describeAttachment({ attached: true, title: '', url: 'https://lab.example/orders' }, {
        recording: false,
        stepCount: 3,
        unresolvedCount: 1,
      }),
    ).toEqual({ head: '已挂接：lab.example/orders', detail: 'lab.example/orders · 3 步可导入，1 项待处理' })
  })

  it('长地址截断，不撑爆侧栏', () => {
    expect(shortLocation(`https://lab.example/${'a'.repeat(80)}`).length).toBeLessThanOrEqual(49)
  })
})

describe('侧栏挂接', () => {
  it('每次 show 都换一个路径，否则侧栏不重载、端口不重连、按钮看着没反应', () => {
    resetRecorderPanelPath()
    const first = nextRecorderPanelPath()
    const second = nextRecorderPanelPath()
    expect(first).not.toBe(second)
    expect(first.startsWith(`${WORKBENCH_PATH}?`)).toBe(true)
  })

  it('挂接等待有上限，超时给出可执行原因', async () => {
    await expect(withDeadline(Promise.resolve(1), 50, '超时')).resolves.toBe(1)
    await expect(
      withDeadline(new Promise(() => {}), 10, '侧栏没有接上录制器，请关掉侧栏再重新打开'),
    ).rejects.toThrow('侧栏没有接上录制器')
  })
})

describe('挂哪个标签页', () => {
  const panel = { id: 1, url: 'chrome-extension://abc/index.html', active: true }
  const blank = { id: 2, url: 'about:blank' }
  const page = { id: 3, url: 'https://lab.example/orders' }

  it('优先录用户正看的那一页', () => {
    expect(chooseRecordingTab([blank, { ...page, active: true }])?.id).toBe(3)
  })

  it('活动页是侧栏或 chrome:// 时退回记住的标签页', () => {
    expect(chooseRecordingTab([panel, blank], page)?.id).toBe(3)
  })

  it('没有记住的页时挑真实页面，不挑空白页', () => {
    expect(chooseRecordingTab([panel, blank, page])?.id).toBe(3)
    expect(canRecordTab(panel)).toBe(false)
    expect(canRecordTab(page)).toBe(true)
  })
})

describe('平台录制握手', () => {
  it('只接受带票据的 start 信封，并用受信 origin 构造返回地址', () => {
    const start = recordingBridgeStartSchema.parse({
      version: 1,
      type: 'cairn.recording.start',
      bindingId: '11111111-1111-4111-8111-111111111111',
      ticket: 'a'.repeat(64),
    })
    expect(start.ticket).toHaveLength(64)
    expect(() =>
      recordingBridgeStartSchema.parse({
        version: 1,
        type: 'cairn.recording.start',
        bindingId: start.bindingId,
        ticket: 'short',
      }),
    ).toThrow()
    expect(recordingStudioPath(start.bindingId, '22222222-2222-4222-8222-222222222222')).toBe(
      `/scenarios/${start.bindingId}?import=22222222-2222-4222-8222-222222222222`,
    )
    expect(recordingAllowedOrigins('https://shop.example.com', 'https://sso.example.com/login')).toEqual([
      'https://shop.example.com',
      'https://sso.example.com',
    ])
    expect(
      studioReturnUrl('http://localhost:3030', {
        id: start.bindingId,
        scenarioId: '33333333-3333-4333-8333-333333333333',
        scenarioName: '打开商城',
        targetId: '11111111-1111-4111-8111-111111111111',
        targetName: '演示商城',
        entryUrl: 'https://shop.example.com',
        loginUrl: null,
        draftRevision: 1,
        insertAnchor: { kind: 'start' },
        status: 'claimed',
        apiOrigin: 'http://localhost:3030',
        expiresAt: '2026-09-14T00:05:00.000Z',
        uploadExpiresAt: '2026-09-14T02:00:00.000Z',
        recordingDraftId: '22222222-2222-4222-8222-222222222222',
        createdAt: '2026-09-14T00:00:00.000Z',
        claimedAt: '2026-09-14T00:00:01.000Z',
        closedAt: null,
      }),
    ).toBe('http://localhost:5173/scenarios/33333333-3333-4333-8333-333333333333?import=22222222-2222-4222-8222-222222222222')
  })
})

describe('元素读数', () => {
  it('从 Playwright internal selector 抽出角色和名字', () => {
    expect(formatPickedElement({ selector: 'internal:role=button[name="查询"i]' })).toBe(
      'button · 查询',
    )
    expect(formatPickedElement({ selector: '' })).toBe('未识别到元素')
  })
})
