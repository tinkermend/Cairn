import {
  PERMISSION_CATALOG,
  PERMISSION_LABELS,
  PERMISSION_RESOURCES,
  RESOURCE_LABELS,
  hasPermission,
  type PermissionCode,
} from '@cairn/shared'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'

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
              {RESOURCE_LABELS[resource]}
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
                      {PERMISSION_LABELS[item.code] ?? item.label}
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
