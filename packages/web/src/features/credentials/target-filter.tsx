import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchTargets } from '@/lib/targets-api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'

export function CredentialTargetFilter({
  onChange,
}: {
  onChange: (id?: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [cursor, setCursor] = useState<string | undefined>()
  const [label, setLabel] = useState('全部目标系统')
  const query = useQuery({
    queryKey: ['targets', 'credential-filter', search, cursor],
    queryFn: () =>
      fetchTargets({ search, cursor, limit: 50, credentialAction: 'read' }),
    enabled: open,
  })
  const select = (id?: string, name = '全部目标系统') => {
    setLabel(name)
    onChange(id)
    setOpen(false)
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant='outline' aria-label='筛选所属目标系统'>
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-80 space-y-2'>
        <Input
          aria-label='搜索筛选目标系统'
          placeholder='搜索目标名称或编码'
          value={search}
          onChange={(e) => {
            setSearch(e.target.value)
            setCursor(undefined)
          }}
        />
        <div className='max-h-64 overflow-y-auto'>
          <Button
            variant='ghost'
            className='w-full justify-start'
            onClick={() => select()}
          >
            全部目标系统
          </Button>
          {query.data?.items.map((t) => (
            <Button
              key={t.id}
              variant='ghost'
              className='h-auto w-full justify-start text-left whitespace-normal'
              onClick={() => select(t.id, t.name)}
            >
              {t.name} · {t.code}
            </Button>
          ))}
        </div>
        {query.isError && (
          <p role='alert' className='text-label text-destructive'>
            目标系统加载失败
          </p>
        )}
        <div className='flex justify-between'>
          <Button
            size='sm'
            variant='ghost'
            disabled={!cursor}
            onClick={() => setCursor(undefined)}
          >
            首页
          </Button>
          <Button
            size='sm'
            variant='ghost'
            disabled={!query.data?.nextCursor}
            onClick={() => setCursor(query.data?.nextCursor)}
          >
            下一页
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
