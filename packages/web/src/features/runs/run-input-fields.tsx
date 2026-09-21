import type { ScenarioInputDecl } from '@cairn/shared'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/**
 * 正式运行与定时计划共用的输入填写区。字段来自已发布定义的必需键（见 shared 的
 * requiredRunInputKeys），不是草稿声明；这里只负责渲染与取值，不做表单框架。
 */
export function RunInputFields({
  idPrefix,
  decls,
  values,
  onChange,
  disabled = false,
}: {
  idPrefix: string
  decls: readonly ScenarioInputDecl[]
  values: Record<string, string>
  onChange: (key: string, value: string) => void
  disabled?: boolean
}) {
  if (decls.length === 0) return null
  return (
    <div className='space-y-3'>
      {decls.map((decl) => (
        <div key={decl.key} className='space-y-2'>
          <Label htmlFor={`${idPrefix}-${decl.key}`}>{decl.label}</Label>
          <Input
            id={`${idPrefix}-${decl.key}`}
            value={values[decl.key] ?? ''}
            disabled={disabled}
            onChange={(event) => onChange(decl.key, event.target.value)}
          />
        </div>
      ))}
    </div>
  )
}

/** 第一个留空的必需键。留空的键根本不会进 input，跑到该步才失败，所以提交前就要挡住。 */
export function missingRunInput(
  decls: readonly ScenarioInputDecl[],
  values: Record<string, string>,
): ScenarioInputDecl | undefined {
  return decls.find((decl) => (values[decl.key] ?? '').trim() === '')
}

export function runInputValues(
  decls: readonly ScenarioInputDecl[],
  values: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(decls.map((decl) => [decl.key, values[decl.key] ?? '']))
}
