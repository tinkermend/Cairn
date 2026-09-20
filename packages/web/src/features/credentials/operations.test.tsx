import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { CredentialBatch, CredentialBatchCreateBody } from '@cairn/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import * as api from '@/lib/credentials-api'
import { BatchDialog } from './batch-dialog'
import { CredentialEditor } from './editor'
import { excelFile } from './excel'
import { credentialFixture } from './test-fixture'

vi.mock('@/lib/credentials-api', () => ({
  fetchCredential: vi.fn(),
  fetchCredentialOwners: vi.fn(),
  updateCredentialMetadata: vi.fn(),
  replaceCredential: vi.fn(),
  clearCredential: vi.fn(),
  createCredentialBatch: vi.fn(),
  fetchCredentialBatch: vi.fn(),
  submitCredentialBatchItem: vi.fn(),
  resolveCredentialImport: vi.fn(),
}))
vi.mock('@/lib/targets-api', () => ({ updateTargetAccount: vi.fn() }))
const wrap = (element: React.ReactNode) => (
  <QueryClientProvider
    client={
      new QueryClient({
        defaultOptions: {
          queries: { retry: false },
          mutations: { retry: false },
        },
      })
    }
  >
    {element}
  </QueryClientProvider>
)

describe('凭据真实组件操作契约', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionStorage.clear()
  })
  it('关闭后恢复待提交项，重新填密码仍使用原批次和条目，已成功项不重做', async () => {
    const item = credentialFixture()
    const done = credentialFixture(2)
    const body: CredentialBatchCreateBody = {
      kind: 'password_replace',
      source: 'selection',
      idempotencyKey: crypto.randomUUID(),
      items: [item, done].map((i) => ({
        itemId: crypto.randomUUID(),
        credentialId: i.id,
        expectedRevision: 1,
      })),
    }
    const batch: CredentialBatch = {
      batchId: crypto.randomUUID(),
      kind: body.kind,
      createdAt: '2026-01-01T00:00:00.000Z',
      items: body.items.map((i, index) => ({
        ...i,
        targetId: item.targetId,
        targetAccountId: i.credentialId,
        status: index ? 'succeeded' : 'pending_material',
        errorCode: null,
        errorMessage: null,
        resultRevision: index ? 2 : null,
      })),
    }
    sessionStorage.setItem(
      'credential-batch-receipts:undefined',
      JSON.stringify([
        {
          batchId: batch.batchId,
          body,
          lines: body.items.map((i, index) => ({
            itemId: i.itemId,
            line: index + 8,
          })),
        },
      ])
    )
    vi.mocked(api.fetchCredentialBatch).mockResolvedValue(batch)
    vi.mocked(api.fetchCredential).mockImplementation(async (id) => ({
      ...(id === item.id ? item : done),
      notes: null,
      purpose: null,
      tags: [],
      expiryReminderLeadDays: 14,
      policyRevision: 1,
      currentVersion: null,
      domainHref: '/targets/t',
      sessionHref: null,
    }))
    vi.mocked(api.submitCredentialBatchItem).mockResolvedValue({
      ...batch,
      items: batch.items.map((i) => ({
        ...i,
        status: 'succeeded',
        resultRevision: 2,
      })),
    })
    const view = await render(
      wrap(<BatchDialog open onOpenChange={vi.fn()} items={[]} />)
    )
    await view.getByRole('button', { name: '查看最近提交结果' }).click()
    await expect
      .element(view.getByText('成功 1', { exact: true }))
      .toBeInTheDocument()
    await view.getByRole('button', { name: '补填待提交密码' }).click()
    await view.getByLabelText('第8行新密码').fill(' recovery-secret ')
    await view.getByRole('button', { name: '预览 1 条更新' }).click()
    await view.getByRole('button', { name: '确认提交 1 条' }).click()
    await expect
      .element(view.getByText('成功 1', { exact: true }))
      .toBeInTheDocument()
    expect(api.createCredentialBatch).not.toHaveBeenCalled()
    expect(api.submitCredentialBatchItem).toHaveBeenCalledExactlyOnceWith(
      batch.batchId,
      body.items[0]!.itemId,
      {
        idempotencyKey: body.items[0]!.itemId,
        password: ' recovery-secret ',
        validity: { mode: 'permanent' },
      }
    )
    expect(JSON.stringify(sessionStorage)).not.toContain('recovery-secret')
  })
  it('120 行真实 XLSX 经 Worker 匹配、预览后拆成三个批次，匹配不传密码', async () => {
    const items = Array.from({ length: 120 }, (_, i) =>
      credentialFixture(i + 1)
    )
    const batches = new Map<string, CredentialBatch>()
    vi.mocked(api.fetchCredential).mockImplementation(async (id) => ({
      ...items.find((i) => i.id === id)!,
      notes: null,
      purpose: null,
      tags: [],
      expiryReminderLeadDays: 14,
      policyRevision: 1,
      currentVersion: null,
      domainHref: '/targets/t',
      sessionHref: null,
    }))
    vi.mocked(api.resolveCredentialImport).mockImplementation(async (body) => ({
      rows: body.rows.map((r, i) => ({
        row: r.row,
        item: items[i]!,
        error: null,
      })),
    }))
    vi.mocked(api.createCredentialBatch).mockImplementation(async (body) => {
      const result: CredentialBatch = {
        batchId: crypto.randomUUID(),
        kind: body.kind,
        createdAt: '2026-01-01T00:00:00.000Z',
        items: body.items.map((i) => ({
          itemId: i.itemId,
          credentialId: i.credentialId,
          targetId: i.targetId!,
          targetAccountId: i.targetAccountId!,
          expectedRevision: i.expectedRevision,
          status: 'pending_material',
          errorCode: null,
          errorMessage: null,
          resultRevision: null,
        })),
      }
      batches.set(result.batchId, result)
      return result
    })
    vi.mocked(api.submitCredentialBatchItem).mockImplementation(
      async (id, itemId) => {
        const batch = batches.get(id)!
        const next: CredentialBatch = {
          ...batch,
          items: batch.items.map((i) =>
            i.itemId === itemId
              ? { ...i, status: 'succeeded', resultRevision: 2 }
              : i
          ),
        }
        batches.set(id, next)
        return next
      }
    )
    const bytes = excelFile([
      ['系统代码', '账号', '新密码'],
      ...items.map((i) => [
        'CRM',
        i.safeIdentifier,
        ` test-secret-${i.safeIdentifier} `,
      ]),
    ])
    const view = await render(
      wrap(
        <BatchDialog open onOpenChange={vi.fn()} items={[]} source='excel' />
      )
    )
    await view
      .getByLabelText('上传 Excel')
      .upload(
        new File([new Uint8Array(bytes)], 'fixture.xlsx', {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        })
      )
    // 自备表不要求平台列名：用整表默认目标补足系统列。
    await view.getByPlaceholder('所有行属于同一系统时填写').fill('CRM')
    await view.getByRole('button', { name: '匹配账号并校验权限' }).click()
    await view.getByRole('button', { name: '预览 120 条更新' }).click()
    await view.getByRole('button', { name: '确认提交 120 条' }).click()
    await expect
      .element(view.getByText('成功 120', { exact: true }))
      .toBeInTheDocument()
    expect(api.createCredentialBatch).toHaveBeenCalledTimes(3)
    expect(
      vi
        .mocked(api.createCredentialBatch)
        .mock.calls.map((c) => c[0].items.length)
    ).toEqual([50, 50, 20])
    expect(api.submitCredentialBatchItem).toHaveBeenCalledTimes(120)
    expect(
      JSON.stringify(vi.mocked(api.resolveCredentialImport).mock.calls)
    ).not.toContain('test-secret')
    expect(JSON.stringify(sessionStorage)).not.toContain('test-secret')
  })
  it('单独调整期限无需密码，永久隐藏数量；失败保留输入', async () => {
    const item = credentialFixture()
    const close = vi.fn()
    vi.mocked(api.updateCredentialMetadata).mockRejectedValueOnce(
      new Error('保存失败')
    )
    const view = await render(
      wrap(<CredentialEditor item={item} action='validity' onClose={close} />)
    )
    await expect
      .element(view.getByLabelText('有效期数量'))
      .not.toBeInTheDocument()
    await view.getByRole('combobox', { name: '凭据有效期' }).click()
    await view.getByRole('option', { name: '按天' }).click()
    await view.getByLabelText('有效期数量').fill('60')
    await view.getByRole('button', { name: '保存', exact: true }).click()
    await expect.element(view.getByRole('alert')).toHaveTextContent('保存失败')
    await expect.element(view.getByLabelText('有效期数量')).toHaveValue('60')
    expect(api.replaceCredential).not.toHaveBeenCalled()
    expect(api.updateCredentialMetadata).toHaveBeenCalledWith(
      item.id,
      expect.objectContaining({
        expectedRevision: 1,
        validity: expect.objectContaining({ mode: 'days', amount: 60 }),
      })
    )
    expect(close).not.toHaveBeenCalled()
  })
  it('删除必须先说明保留账号与影响，服务端失败不关确认框', async () => {
    const item = credentialFixture()
    const close = vi.fn()
    vi.mocked(api.clearCredential).mockRejectedValue(new Error('账号正在使用'))
    const view = await render(
      wrap(<CredentialEditor item={item} action='delete' onClose={close} />)
    )
    expect(api.clearCredential).not.toHaveBeenCalled()
    await expect
      .element(
        view.getByText(
          '删除此账号的凭据登记并清除保存的密码，目标账号及历史记录仍会保留。'
        )
      )
      .toBeInTheDocument()
    await view
      .getByRole('button', { name: '删除凭据登记', exact: true })
      .click()
    await expect
      .element(view.getByRole('alert'))
      .toHaveTextContent('账号正在使用')
    expect(close).not.toHaveBeenCalled()
  })
  it('HTTP 200 中逐行失败不会冒充成功，成功密码清空且幂等 ID 不用账号 ID', async () => {
    const items = [credentialFixture(1), credentialFixture(2)]
    const close = vi.fn()
    let batch: CredentialBatch
    vi.mocked(api.fetchCredential).mockImplementation(async (id) => ({
      ...items.find((i) => i.id === id)!,
      notes: null,
      purpose: null,
      tags: [],
      expiryReminderLeadDays: 14,
      policyRevision: 1,
      currentVersion: null,
      domainHref: '/targets/t',
      sessionHref: null,
    }))
    vi.mocked(api.createCredentialBatch).mockImplementation(
      async (body: CredentialBatchCreateBody) =>
        (batch = {
          batchId: '44444444-4444-4444-8444-444444444444',
          kind: body.kind,
          createdAt: '2026-01-01T00:00:00.000Z',
          items: body.items.map((i) => ({
            itemId: i.itemId,
            credentialId: i.credentialId,
            targetId: i.targetId!,
            targetAccountId: i.targetAccountId!,
            expectedRevision: i.expectedRevision,
            status: 'pending_material',
            errorCode: null,
            errorMessage: null,
            resultRevision: null,
          })),
        })
    )
    vi.mocked(api.submitCredentialBatchItem).mockImplementation(
      async (_id, itemId) => {
        batch = {
          ...batch,
          items: batch.items.map((i, index) =>
            i.itemId === itemId
              ? {
                  ...i,
                  status: index === 0 ? 'succeeded' : 'conflict',
                  errorMessage: index === 0 ? null : '账号已被他人更新',
                  resultRevision: index === 0 ? 2 : null,
                }
              : i
          ),
        }
        return batch
      }
    )
    const view = await render(
      wrap(<BatchDialog open onOpenChange={close} items={items} />)
    )
    await view.getByLabelText('第1行新密码').fill('  fixture-only-1  ')
    await view.getByLabelText('第2行新密码').fill('fixture-only-2')
    await view.getByRole('button', { name: '预览 2 条更新' }).click()
    await view.getByRole('button', { name: '确认提交 2 条' }).click()
    await expect
      .element(view.getByText('保存成功', { exact: true }))
      .toBeInTheDocument()
    await expect
      .element(view.getByText('版本冲突', { exact: true }))
      .toBeInTheDocument()
    await expect.element(view.getByText('已保存并清空输入')).toBeInTheDocument()
    expect(close).not.toHaveBeenCalled()
    const body = vi.mocked(api.createCredentialBatch).mock.calls[0]![0]
    expect(body.items.every((i) => i.itemId !== i.credentialId)).toBe(true)
    expect(api.submitCredentialBatchItem).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      body.items[0]!.itemId,
      expect.objectContaining({
        password: '  fixture-only-1  ',
        idempotencyKey: body.items[0]!.itemId,
      })
    )
    expect(JSON.stringify(sessionStorage)).not.toContain('fixture-only')
  })
})
