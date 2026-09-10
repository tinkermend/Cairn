import {
  PERMISSION_CATALOG,
  PERMISSION_RESOURCES,
  hasPermission,
  type PermissionCode,
  type PermissionResource,
} from '@cairn/shared'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'

const RESOURCE_LABELS_ZH: Record<PermissionResource, string> = {
  account: '账号',
  role: '角色',
  workflow: '工作流',
  run: 'Run',
  target: '目标系统',
  settings: '设置',
  audit: '审计',
}

const PERMISSION_LABELS_ZH: Record<PermissionCode, string> = {
  'account:read': '查看账号',
  'account:write': '创建和更新账号',
  'account:delete': '删除账号',
  'role:read': '查看角色',
  'role:write': '创建和更新角色',
  'role:delete': '删除自定义角色',
  'workflow:read': '查看工作流',
  'workflow:write': '创建和更新工作流',
  'workflow:delete': '删除工作流',
  'run:read': '查看 Run',
  'run:execute': '启动 Run',
  'run:cancel': '取消 Run',
  'target:read': '查看目标系统',
  'target:write': '创建和更新目标系统',
  'target:delete': '删除目标系统',
  'settings:read': '查看设置',
  'settings:write': '更新设置',
  'audit:read': '查看审计',
}

type PermissionMatrixProps = {
  value: PermissionCode[]
  onChange: (next: PermissionCode[]) => void
  disabled?: boolean
  /** 只能勾选主体已有的权限；未传则不限制（例如测试或查看系统角色）。 */
  grantable?: readonly string[]
}

export function PermissionMatrix({
  value,
  onChange,
  disabled = false,
  grantable,
}: PermissionMatrixProps) {
  const selected = new Set(value)

  function toggle(code: PermissionCode, on: boolean) {
    const next = new Set(selected)
    if (on) next.add(code)
    else next.delete(code)
    onChange([...next])
  }

  return (
    <div className='space-y-4' data-testid='permission-matrix'>
      {PERMISSION_RESOURCES.map((resource) => {
        const items = PERMISSION_CATALOG.filter((p) => p.resource === resource)
        if (items.length === 0) return null
        return (
          <fieldset key={resource} className='space-y-2'>
            <legend className='text-body font-medium'>
              {RESOURCE_LABELS_ZH[resource]}
            </legend>
            <div className='grid gap-2 sm:grid-cols-2'>
              {items.map((item) => (
                <Label
                  key={item.code}
                  className='flex items-center gap-2 font-normal'
                >
                  <Checkbox
                    checked={selected.has(item.code)}
                    disabled={disabled || (grantable != null && !hasPermission(grantable, item.code))}
                    onCheckedChange={(next) => toggle(item.code, next === true)}
                    aria-label={item.code}
                  />
                  <span>
                    <span className='block'>
                      {PERMISSION_LABELS_ZH[item.code] ?? item.label}
                    </span>
                    <span className='text-muted-foreground font-mono text-label'>
                      {item.code}
                    </span>
                  </span>
                </Label>
              ))}
            </div>
          </fieldset>
        )
      })}
    </div>
  )
}
