import { readFileSync } from 'node:fs'
import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  buildPlatformAiChatBody,
  isPlatformAiPresetBaseUrl,
  isPlatformAiPresetModel,
  nextPlatformAiBaseUrl,
  nextPlatformAiModel,
  platformAiDefaultModel,
  platformAiBaseUrlsEquivalent,
  platformAiChatCompletionsUrl,
  platformAiConnectionReady,
  PLATFORM_AI_OUTPUT_LIMIT,
  PLATFORM_AI_OUTPUT_LIMIT_CODE,
  PLATFORM_AI_PROVIDER_PRESETS,
  PLATFORM_AI_THINKING_UNSUPPORTED,
  postPlatformAiChatCompletion,
  readPlatformAiChatResult,
} from '../platform-ai-provider.js'
import { FACTORY_PLATFORM_AI, PLATFORM_AI_PROVIDERS, platformAiConfigSchema } from '../platform-config.js'

const messages = [{ role: 'user' as const, content: 'ping' }]

describe('平台 AI 提供商拼装与读回', () => {
  it('思考关：glm / deepseek / minimax 不带思考字段，千问显式关闭', () => {
    for (const provider of ['glm', 'deepseek', 'minimax'] as const) {
      const body = buildPlatformAiChatBody({
        provider,
        thinkingMode: 'off',
        model: 'demo',
        messages,
        maxTokens: 16,
        json: true,
      })
      expect(body).toEqual({
        model: 'demo',
        messages,
        max_tokens: 16,
        temperature: 0,
        response_format: { type: 'json_object' },
      })
      expect(body).not.toHaveProperty('thinking')
      expect(body).not.toHaveProperty('enable_thinking')
    }
    expect(
      buildPlatformAiChatBody({
        provider: 'qwen',
        thinkingMode: 'off',
        model: 'qwen-plus',
        messages,
        maxTokens: 16,
      }),
    ).toMatchObject({ enable_thinking: false, model: 'qwen-plus' })
  })

  it('思考开：glm / deepseek 带开启字段；千问 / MiniMax 拒绝且不产生 body', () => {
    expect(
      buildPlatformAiChatBody({
        provider: 'glm',
        thinkingMode: 'on',
        model: 'glm-4.5',
        messages,
        maxTokens: 8,
      }),
    ).toMatchObject({ thinking: { type: 'enabled' } })
    expect(
      buildPlatformAiChatBody({
        provider: 'deepseek',
        thinkingMode: 'on',
        model: 'deepseek-reasoner',
        messages,
        maxTokens: 8,
      }),
    ).toMatchObject({ thinking: { type: 'enabled' } })
    for (const provider of ['qwen', 'minimax'] as const) {
      expect(() =>
        buildPlatformAiChatBody({
          provider,
          thinkingMode: 'on',
          model: 'demo',
          messages,
          maxTokens: 8,
        }),
      ).toThrowError(
        expect.objectContaining({ code: PLATFORM_AI_THINKING_UNSUPPORTED }),
      )
    }
  })

  it('连通测试不带 response_format；业务空正文失败，探测空正文成功', () => {
    const probeBody = buildPlatformAiChatBody({
      provider: 'deepseek',
      thinkingMode: 'off',
      model: 'deepseek-flash',
      messages,
      maxTokens: 1,
    })
    expect(probeBody).not.toHaveProperty('response_format')
    const reasoningOnly = {
      choices: [{ message: { reasoning_content: 'thinking' } }],
      model: 'demo',
    }
    expect(() => readPlatformAiChatResult(reasoningOnly, 'business')).toThrowError(/推理内容不能作为结果/)
    expect(readPlatformAiChatResult(reasoningOnly, 'probe')).toEqual({
      text: '',
      reasoningText: 'thinking',
      model: 'demo',
      usage: undefined,
    })
    expect(
      readPlatformAiChatResult(
        { choices: [{ message: { content: [{ type: 'text', text: 'part' }] } }] },
        'probe',
      ),
    ).toEqual({ text: '', usage: undefined })
    expect(() =>
      readPlatformAiChatResult(
        { choices: [{ message: { content: [{ type: 'text', text: 'part' }] } }] },
        'business',
      ),
    ).toThrowError(/没有返回可用文本/)
  })

  it('助手、分析与连通测试共用拼装，调用方不再手写 completion JSON', () => {
    for (const relative of [
      '../../../api/src/assistant/model-client.ts',
      '../../../worker/src/runtime/analysis-executor.ts',
      '../../../api/src/platform-config/platform-config.service.ts',
    ]) {
      const source = readFileSync(new URL(relative, import.meta.url), 'utf8')
      expect(source).toContain('buildPlatformAiChatBody')
      expect(source).toContain('postPlatformAiChatCompletion')
      expect(source).not.toMatch(/JSON\.stringify\(\s*\{\s*model/)
    }
  })

  it('闸门要求地址、模型、Secret 与提供商齐全', () => {
    expect(
      platformAiConnectionReady({
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-flash',
        secretRef: { secretId: '00000000-0000-4000-8000-000000000001' },
        provider: 'deepseek',
      }),
    ).toBe(true)
    expect(
      platformAiConnectionReady({
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-flash',
        secretRef: { secretId: '00000000-0000-4000-8000-000000000001' },
      }),
    ).toBe(false)
  })

  it('默认地址比较忽略尾斜杠和主机大小写，自定义 path 不覆盖', () => {
    expect(
      platformAiBaseUrlsEquivalent(
        'https://API.deepseek.com/',
        PLATFORM_AI_PROVIDER_PRESETS.deepseek.defaultBaseUrl,
      ),
    ).toBe(true)
    expect(isPlatformAiPresetBaseUrl('deepseek', 'https://api.deepseek.com/v1')).toBe(false)
    expect(
      nextPlatformAiBaseUrl({
        previousProvider: 'deepseek',
        currentUrl: 'https://api.deepseek.com/',
        nextProvider: 'qwen',
      }),
    ).toBe(PLATFORM_AI_PROVIDER_PRESETS.qwen.defaultBaseUrl)
    expect(
      nextPlatformAiBaseUrl({
        previousProvider: 'deepseek',
        currentUrl: 'https://proxy.example/v1',
        nextProvider: 'qwen',
      }),
    ).toBe('https://proxy.example/v1')
    expect(
      nextPlatformAiBaseUrl({
        currentUrl: undefined,
        nextProvider: 'glm',
      }),
    ).toBe(PLATFORM_AI_PROVIDER_PRESETS.glm.defaultBaseUrl)
    expect(
      nextPlatformAiBaseUrl({
        currentUrl: 'https://proxy.example/v1',
        nextProvider: '' as never,
      }),
    ).toBe('https://proxy.example/v1')
  })

  it('补尾斜杠后再拼 chat/completions，避免吃掉 /v1', () => {
    expect(platformAiChatCompletionsUrl('https://api.example/v1')).toBe(
      'https://api.example/v1/chat/completions',
    )
  })
})

describe('平台 AI 传输', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('使用 redirect:error，并在超过 256KB 时停止读取', async () => {
    const read = vi.fn()
      .mockResolvedValueOnce({
        done: false,
        value: new Uint8Array(PLATFORM_AI_OUTPUT_LIMIT + 1),
      })
      .mockResolvedValue({ done: true, value: undefined })
    const cancel = vi.fn(async () => undefined)
    const fetcher = vi.fn(async () => ({
      ok: true,
      body: { getReader: () => ({ read, cancel }) },
    }))
    vi.stubGlobal('fetch', fetcher)
    await expect(
      postPlatformAiChatCompletion({
        baseUrl: 'https://api.example/v1',
        apiKey: 'k',
        body: { model: 'demo' },
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({ code: PLATFORM_AI_OUTPUT_LIMIT_CODE })
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error', method: 'POST' })
    expect(cancel).toHaveBeenCalled()
  })
})

describe('平台 AI 提供商模型候选', () => {
  it('每家都有官方地址与至少一个候选模型，模型名不重复', () => {
    for (const provider of PLATFORM_AI_PROVIDERS) {
      const preset = PLATFORM_AI_PROVIDER_PRESETS[provider]
      expect(preset.defaultBaseUrl).toMatch(/^https:\/\//)
      expect(preset.models.length).toBeGreaterThan(0)
      const ids = preset.models.map((item) => item.id)
      expect(new Set(ids).size).toBe(ids.length)
      expect(platformAiDefaultModel(provider)).toBe(ids[0])
    }
  })

  it('切换提供商：空值与上一家的候选换成新默认，手填的自定义模型名保留', () => {
    expect(nextPlatformAiModel({ nextProvider: 'qwen' })).toBe('qwen3.8-flash')
    expect(
      nextPlatformAiModel({ previousProvider: 'deepseek', currentModel: 'deepseek-v4-pro', nextProvider: 'qwen' }),
    ).toBe('qwen3.8-flash')
    expect(
      nextPlatformAiModel({ previousProvider: 'deepseek', currentModel: 'my-relay-alias', nextProvider: 'qwen' }),
    ).toBe('my-relay-alias')
    // 没有上一家（旧配置无 provider）时不敢替用户改模型名
    expect(nextPlatformAiModel({ currentModel: 'deepseek-chat', nextProvider: 'glm' })).toBe('deepseek-chat')
    expect(isPlatformAiPresetModel('qwen', 'qwen3.7-plus')).toBe(true)
    expect(isPlatformAiPresetModel('qwen', 'deepseek-flash')).toBe(false)
    expect(isPlatformAiPresetModel('qwen', undefined)).toBe(false)
  })

  it('出厂预填与该提供商预设一致，且只缺密钥：不含 secretRef、默认未启用', () => {
    const preset = PLATFORM_AI_PROVIDER_PRESETS[FACTORY_PLATFORM_AI.provider]
    expect(FACTORY_PLATFORM_AI.baseUrl).toBe(preset.defaultBaseUrl)
    expect(isPlatformAiPresetModel(FACTORY_PLATFORM_AI.provider, FACTORY_PLATFORM_AI.model)).toBe(true)
    expect(FACTORY_PLATFORM_AI.enabled).toBe(false)
    expect('secretRef' in FACTORY_PLATFORM_AI).toBe(false)

    const withoutKey = platformAiConfigSchema.safeParse({ ...FACTORY_PLATFORM_AI, enabled: true })
    expect(withoutKey.success).toBe(false)
    if (!withoutKey.success) {
      expect(withoutKey.error.issues.map((issue) => issue.path.join('.'))).toEqual(['secretRef'])
    }
    expect(
      platformAiConfigSchema.safeParse({
        ...FACTORY_PLATFORM_AI,
        enabled: true,
        secretRef: { provider: 'local', secretId: '00000000-0000-4000-8000-000000000001' },
      }).success,
    ).toBe(true)
  })
})
