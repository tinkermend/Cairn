import { describe, expect, it } from 'vitest'
import { buildServiceCodeSnippet } from './playground'

const credentialId = '11111111-1111-4111-8111-111111111111'
const body = JSON.stringify(
  {
    scenarioId: '22222222-2222-4222-8222-222222222222',
    scenarioVersionId: '33333333-3333-4333-8333-333333333333',
    targetAccountId: '44444444-4444-4444-8444-444444444444',
    input: { orderId: 'PO-1001' },
    idempotencyKey: 'playground-order-1001',
  },
  null,
  2
)

describe('服务 API 调试台代码生成', () => {
  it.each(['curl', 'node', 'python', 'go'] as const)(
    '%s 包含调用端点、凭据占位和冻结场景版本请求体',
    (language) => {
      const code = buildServiceCodeSnippet({
        language,
        credentialId,
        body,
        baseUrl: 'https://cairn.example.test/',
      })
      expect(code).toContain('https://cairn.example.test/api/open/v1/runs')
      expect(code).toContain(`cairn_sk_${credentialId}.<SECRET>`)
      expect(code).toContain('22222222-2222-4222-8222-222222222222')
      expect(code).toContain('33333333-3333-4333-8333-333333333333')
      expect(code).toContain('orderId')
      expect(code).toContain('PO-1001')
      expect(code).not.toContain('credentialId')
    }
  )

  it('对 cURL 的单引号请求体做 shell 转义', () => {
    const code = buildServiceCodeSnippet({
      language: 'curl',
      credentialId,
      body: `{"input":{"note":"O'Reilly"}}`,
      baseUrl: 'https://cairn.example.test',
    })
    expect(code).toContain(`O'\\''Reilly`)
  })
})
