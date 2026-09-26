import type { Step } from '@cairn/shared'
import { uniqueOutputKey as sharedUniqueOutputKey } from '@/features/authoring/document'

export interface StepSnippetTemplate {
  id: string
  name: string
  description: string
  category: 'auth' | 'form' | 'table' | 'dialog'
  createSteps: (ctx: {
    generateId: () => string
    allocateOutputKey: (base: string) => string
  }) => Step[]
}

export const STEP_SNIPPET_TEMPLATES: readonly StepSnippetTemplate[] = [
  {
    id: 'snippet-form-login',
    name: '标准表单登录模版',
    description: '导航至登录页、填写账号密码、点击提交并校验登录态',
    category: 'auth',
    createSteps: ({ generateId }) => [
      {
        id: generateId(),
        name: '导航至登录页',
        type: 'navigate',
        effectType: 'READ_ONLY',
        input: { url: 'https://example.com/login' },
      },
      {
        id: generateId(),
        name: '填写登录账号',
        type: 'fill',
        effectType: 'SIDE_EFFECT',
        input: {
          target: { framePath: [], candidates: [{ by: 'css', value: 'input[name="username"]' }] },
          value: 'admin',
        },
      },
      {
        id: generateId(),
        name: '填写登录密码',
        type: 'fill',
        effectType: 'SIDE_EFFECT',
        input: {
          target: { framePath: [], candidates: [{ by: 'css', value: 'input[name="password"]' }] },
          value: '••••••••',
          sensitive: true,
        },
      },
      {
        id: generateId(),
        name: '点击登录按钮',
        type: 'click',
        effectType: 'SIDE_EFFECT',
        input: {
          target: { framePath: [], candidates: [{ by: 'css', value: 'button[type="submit"]' }] },
        },
      },
      {
        id: generateId(),
        name: '断言登录成功',
        type: 'assert',
        effectType: 'READ_ONLY',
        input: {
          target: { framePath: [], candidates: [{ by: 'css', value: '.user-profile, .dashboard' }] },
          expect: { kind: 'exists' },
        },
      },
    ],
  },
  {
    id: 'snippet-table-first-row',
    name: '表格首行提取与操作模版',
    description: '等待表格加载、提取首行数据凭证并触发操作',
    category: 'table',
    createSteps: ({ generateId, allocateOutputKey }) => {
      const rowIdKey = allocateOutputKey('extracted_row_id')
      return [
        {
          id: generateId(),
          name: '等待表格数据加载',
          type: 'wait',
          effectType: 'READ_ONLY',
          input: {
            kind: 'visible',
            target: { framePath: [], candidates: [{ by: 'css', value: 'table tbody tr' }] },
          },
        },
        {
          id: generateId(),
          name: '提取首行记录编号',
          type: 'extract',
          effectType: 'READ_ONLY',
          outputKey: rowIdKey,
          input: {
            target: { framePath: [], candidates: [{ by: 'css', value: 'table tbody tr:first-child td:first-child' }] },
            as: 'text',
          },
        },
        {
          id: generateId(),
          name: '点击首行操作按钮',
          type: 'click',
          effectType: 'SIDE_EFFECT',
          input: {
            target: { framePath: [], candidates: [{ by: 'css', value: 'table tbody tr:first-child button.action-btn' }] },
          },
        },
      ]
    },
  },
  {
    id: 'snippet-confirm-dialog',
    name: '二次确认弹窗模版',
    description: '触发动作、等待确认弹窗、点击确定并断言操作结果',
    category: 'dialog',
    createSteps: ({ generateId }) => [
      {
        id: generateId(),
        name: '点击打开确认弹窗',
        type: 'click',
        effectType: 'SIDE_EFFECT',
        input: {
          target: { framePath: [], candidates: [{ by: 'css', value: 'button.open-confirm' }] },
        },
      },
      {
        id: generateId(),
        name: '等待确认弹窗显示',
        type: 'wait',
        effectType: 'READ_ONLY',
        input: {
          kind: 'visible',
          target: { framePath: [], candidates: [{ by: 'css', value: '[role="dialog"]' }] },
        },
      },
      {
        id: generateId(),
        name: '点击弹窗确定按钮',
        type: 'click',
        effectType: 'SIDE_EFFECT',
        input: {
          target: { framePath: [], candidates: [{ by: 'css', value: '[role="dialog"] button.confirm-btn' }] },
        },
      },
      {
        id: generateId(),
        name: '断言操作成功反馈',
        type: 'assert',
        effectType: 'READ_ONLY',
        input: {
          target: { framePath: [], candidates: [{ by: 'css', value: '.toast-success' }] },
          expect: { kind: 'exists' },
        },
      },
    ],
  },
]

export function instantiateSnippet(
  template: StepSnippetTemplate,
  usedContextKeys: Set<string>,
): Step[] {
  const currentUsed = new Set(usedContextKeys)

  return template.createSteps({
    generateId: () => crypto.randomUUID(),
    allocateOutputKey: (base: string) => {
      const allocated = sharedUniqueOutputKey(base, currentUsed)
      currentUsed.add(allocated)
      return allocated
    },
  })
}
