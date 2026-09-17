import { useState, useMemo } from 'react'
import {
  CAPABILITY_TREE_GROUPS,
  PERMISSION_LABELS,
  RESOURCE_LABELS,
  getPermissionDependencies,
  hasPermission,
  type PermissionCode,
} from '@cairn/shared'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Search, X } from 'lucide-react'

type PermissionMatrixProps = {
  value: PermissionCode[]
  onChange: (next: PermissionCode[]) => void
  disabled?: boolean
  /** 只能勾选主体已有的权限；未传则不限制（例如测试或查看系统角色）。 */
  grantable?: readonly string[]
  /** 是否开启依赖自动级联勾选，默认 true */
  autoCascade?: boolean
}

export function PermissionMatrix({
  value,
  onChange,
  disabled = false,
  grantable,
  autoCascade = true,
}: PermissionMatrixProps) {
  const [search, setSearch] = useState('')
  const selected = useMemo(() => new Set(value), [value])

  function toggle(code: PermissionCode, on: boolean) {
    const next = new Set(selected)
    if (on) {
      next.add(code)
      if (autoCascade) {
        const deps = getPermissionDependencies(code)
        for (const dep of deps) {
          if (grantable == null || hasPermission(grantable, dep)) {
            next.add(dep)
          }
        }
      }
    } else {
      next.delete(code)
    }
    onChange([...next])
  }

  function selectAllInModule(codes: readonly PermissionCode[]) {
    const next = new Set(selected)
    for (const code of codes) {
      if (grantable == null || hasPermission(grantable, code)) {
        next.add(code)
        if (autoCascade) {
          for (const dep of getPermissionDependencies(code)) {
            if (grantable == null || hasPermission(grantable, dep)) {
              next.add(dep)
            }
          }
        }
      }
    }
    onChange([...next])
  }

  function clearInModule(codes: readonly PermissionCode[]) {
    const next = new Set(selected)
    for (const code of codes) {
      next.delete(code)
    }
    onChange([...next])
  }

  const query = search.trim().toLowerCase()

  const filteredCategories = useMemo(() => {
    return CAPABILITY_TREE_GROUPS.map((category) => {
      const modules = category.modules
        .map((mod) => {
          const modName = (RESOURCE_LABELS[mod.key] ?? mod.label).toLowerCase()
          const items = mod.items.filter((item) => {
            if (!query) return true
            return (
              PERMISSION_LABELS[item.code].toLowerCase().includes(query) ||
              item.code.toLowerCase().includes(query) ||
              modName.includes(query)
            )
          })
          return { ...mod, items }
        })
        .filter((mod) => mod.items.length > 0)
      return { ...category, modules }
    }).filter((cat) => cat.modules.length > 0)
  }, [query])

  return (
    <div className='space-y-4' data-testid='permission-matrix'>
      <div className='relative'>
        <Search className='absolute left-2.5 top-2.5 size-4 text-muted-foreground' />
        <Input
          placeholder='搜索权限名称或编码（如：场景、运行、AI）...'
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className='ps-9 pe-9 text-body'
          disabled={disabled}
        />
        {search && (
          <Button
            type='button'
            variant='ghost'
            size='icon'
            className='absolute right-1 top-1 size-7'
            onClick={() => setSearch('')}
          >
            <X className='size-3.5' />
          </Button>
        )}
      </div>

      {filteredCategories.length === 0 ? (
        <div className='py-6 text-center text-label text-muted-foreground'>
          未找到匹配 “{search}” 的权限项
        </div>
      ) : (
        <div className='space-y-6'>
          {filteredCategories.map((category) => (
            <div key={category.key} className='space-y-4'>
              <div className='text-label font-semibold text-muted-foreground uppercase tracking-wider'>
                {category.label}
              </div>
              <div className='space-y-4'>
                {category.modules.map((mod) => {
                  const moduleTitle = RESOURCE_LABELS[mod.key] ?? mod.label
                  const moduleCodes = mod.items.map((i) => i.code)
                  const allChecked = moduleCodes.every((c) => selected.has(c))
                  const someChecked = moduleCodes.some((c) => selected.has(c))

                  return (
                    <fieldset
                      key={mod.key}
                      className='space-y-2 rounded-lg border border-border/60 bg-card p-3'
                    >
                      <div className='flex items-center justify-between pb-1'>
                        <legend className='text-body font-medium flex items-center gap-2'>
                          <span>{moduleTitle}</span>
                          {mod.description && (
                            <span className='text-label text-muted-foreground font-normal hidden sm:inline'>
                              · {mod.description}
                            </span>
                          )}
                        </legend>
                        {!disabled && (
                          <div className='flex items-center gap-1'>
                            <Button
                              type='button'
                              variant='ghost'
                              size='sm'
                              className='h-6 px-2 text-label'
                              disabled={allChecked}
                              onClick={() => selectAllInModule(moduleCodes)}
                            >
                              全选
                            </Button>
                            <Button
                              type='button'
                              variant='ghost'
                              size='sm'
                              className='h-6 px-2 text-label text-muted-foreground'
                              disabled={!someChecked}
                              onClick={() => clearInModule(moduleCodes)}
                            >
                              清空
                            </Button>
                          </div>
                        )}
                      </div>

                      <div className='grid gap-2 sm:grid-cols-2'>
                        {mod.items.map((item) => {
                          const isGrantable =
                            grantable == null || hasPermission(grantable, item.code)
                          const itemDisabled = disabled || !isGrantable

                          return (
                            <Label
                              key={item.code}
                              className='flex items-start gap-2 rounded-md p-1.5 transition-colors hover:bg-muted/40 font-normal cursor-pointer'
                            >
                              <Checkbox
                                checked={selected.has(item.code)}
                                disabled={itemDisabled}
                                onCheckedChange={(next) => toggle(item.code, next === true)}
                                aria-label={item.code}
                                className='mt-0.5'
                              />
                              <div className='flex-1 min-w-0'>
                                <div className='flex items-center gap-1.5'>
                                  <span className='text-body font-normal text-foreground'>
                                    {PERMISSION_LABELS[item.code]}
                                  </span>
                                  {item.isPageAccess && (
                                    <Badge
                                      variant='secondary'
                                      className='text-label px-1 py-0 h-4 font-normal text-muted-foreground'
                                    >
                                      页面
                                    </Badge>
                                  )}
                                </div>
                                <div className='flex items-center gap-2'>
                                  <span className='text-muted-foreground font-mono text-label'>
                                    {item.code}
                                  </span>
                                  {item.dependencies && item.dependencies.length > 0 && (
                                    <span className='text-label text-muted-foreground/80 hidden sm:inline'>
                                      (需 {item.dependencies.join(', ')})
                                    </span>
                                  )}
                                </div>
                              </div>
                            </Label>
                          )
                        })}
                      </div>
                    </fieldset>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

