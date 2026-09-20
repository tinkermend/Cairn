import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  hasPermission,
  type RoleDto,
  type RoleTargetScope,
} from '@cairn/shared'
import { fetchTargets } from '@/lib/targets-api'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

export function TargetScopeFields({
  roles,
  value,
  onChange,
  disabled = false,
}: {
  roles: RoleDto[]
  value: RoleTargetScope[]
  onChange: (scopes: RoleTargetScope[]) => void
  disabled?: boolean
}) {
  const [search, setSearch] = useState('')
  const [cursor, setCursor] = useState<string | undefined>()
  const targets = useQuery({
    queryKey: ['targets', 'authorization', search, cursor],
    queryFn: () => fetchTargets({ search, cursor, limit: 50 }),
    enabled: roles.some(
      (r) => value.find((v) => v.roleId === r.id)?.mode === 'selected'
    ),
  })
  const change = (next: RoleTargetScope) =>
    onChange([...value.filter((v) => v.roleId !== next.roleId), next])
  const scopeFor = (permission: string) => {
    const grants = roles
      .filter((role) => hasPermission(role.permissions, permission))
      .map(
        (role) =>
          value.find((scope) => scope.roleId === role.id) ?? {
            mode:
              role.kind === 'system' && role.key === 'admin' ? 'all' : 'none',
            targetIds: [],
          }
      )
    return {
      all: grants.some((g) => g.mode === 'all'),
      ids: new Set(
        grants.flatMap((g) => (g.mode === 'selected' ? g.targetIds : []))
      ),
    }
  }
  const read = scopeFor('target:read')
  const credentialRead = scopeFor('credential:read')
  const effective = (permission: string) => {
    const scopes = [read, credentialRead, scopeFor(permission)]
    if (permission === 'credential:import')
      scopes.push(scopeFor('credential:write'))
    const constrained = scopes.filter((scope) => !scope.all)
    if (!constrained.length) return '全部目标系统'
    const ids = [...constrained[0]!.ids].filter((id) =>
      constrained.every((scope) => scope.ids.has(id))
    )
    return ids.length ? `${ids.length} 个指定目标系统` : '无目标系统'
  }
  return (
    <section className='space-y-3 rounded-md border border-border-divider p-3'>
      <h3 className='text-title-sm'>目标系统授权范围</h3>
      <p className='text-label text-muted-foreground'>
        每个角色的能力仅在该角色指定的系统内生效。未配置范围的普通用户看不到目标系统与凭据。
      </p>
      {roles.map((role) => {
        const admin = role.kind === 'system' && role.key === 'admin'
        const scope = value.find((v) => v.roleId === role.id) ?? {
          roleId: role.id,
          mode: admin ? 'all' : 'none',
          targetIds: [],
        }
        return (
          <div
            key={role.id}
            className='space-y-2 border-t border-border-divider pt-3'
          >
            <label className='flex flex-wrap items-center justify-between gap-2'>
              <span className='text-label font-medium'>{role.name}</span>
              <Select
                value={scope.mode}
                disabled={admin || disabled}
                onValueChange={(mode) =>
                  change({
                    ...scope,
                    mode: mode as RoleTargetScope['mode'],
                    targetIds: mode === 'selected' ? scope.targetIds : [],
                  })
                }
              >
                <SelectTrigger
                  className='w-44'
                  aria-label={`${role.name}的目标范围`}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='none'>无目标系统</SelectItem>
                  <SelectItem value='selected'>指定目标系统</SelectItem>
                  <SelectItem value='all'>全部目标系统</SelectItem>
                </SelectContent>
              </Select>
            </label>
            {scope.mode === 'selected' && (
              <div className='space-y-2'>
                <Input
                  placeholder='搜索可授权的目标系统'
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value)
                    setCursor(undefined)
                  }}
                />
                <p className='text-label'>
                  已选 {scope.targetIds.length} 个系统
                </p>
                <div className='max-h-40 space-y-2 overflow-y-auto'>
                  {targets.data?.items.map((t) => (
                    <label
                      className='flex items-center gap-2 text-label'
                      key={t.id}
                    >
                      <Checkbox
                        disabled={disabled}
                        checked={scope.targetIds.includes(t.id)}
                        onCheckedChange={(v) =>
                          change({
                            ...scope,
                            targetIds:
                              v === true
                                ? [...scope.targetIds, t.id]
                                : scope.targetIds.filter((id) => id !== t.id),
                          })
                        }
                      />
                      {t.name} · {t.code}
                    </label>
                  ))}
                </div>
                {targets.isError && (
                  <p className='text-label text-destructive'>
                    系统列表加载失败
                  </p>
                )}
                <div className='flex gap-2'>
                  {cursor && (
                    <Button
                      type='button'
                      size='sm'
                      variant='ghost'
                      onClick={() => setCursor(undefined)}
                    >
                      返回首页
                    </Button>
                  )}
                  {targets.data?.nextCursor && (
                    <Button
                      type='button'
                      size='sm'
                      variant='ghost'
                      onClick={() => setCursor(targets.data!.nextCursor)}
                    >
                      下一页系统
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
        )
      })}
      <div
        className='space-y-1 border-t border-border-divider pt-3 text-label'
        aria-label='凭据授权生效预览'
      >
        <p className='font-medium'>保存后生效的凭据权限</p>
        <p>查看：{effective('credential:read')}</p>
        <p>维护：{effective('credential:write')}</p>
        <p>删除：{effective('credential:delete')}</p>
        <p>Excel 导入：{effective('credential:import')}</p>
      </div>
    </section>
  )
}
