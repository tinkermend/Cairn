import { ChevronLeftIcon, ChevronRightIcon } from '@radix-ui/react-icons'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { CURSOR_PAGE_SIZES, type CursorPageSize } from '@/hooks/use-cursor-page'
import { cn } from '@/lib/utils'

type CursorPaginationProps = {
  pageIndex: number
  pageSize: CursorPageSize
  hasPreviousPage: boolean
  hasNextPage: boolean
  updating?: boolean
  onPageSizeChange: (size: CursorPageSize) => void
  onPreviousPage: () => void
  onNextPage: () => void
  className?: string
}

export function CursorPagination({
  pageIndex,
  pageSize,
  hasPreviousPage,
  hasNextPage,
  updating = false,
  onPageSizeChange,
  onPreviousPage,
  onNextPage,
  className,
}: CursorPaginationProps) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center justify-between gap-3',
        className,
      )}
    >
      <div className='flex items-center gap-2'>
        <Select
          value={`${pageSize}`}
          onValueChange={(value) => {
            onPageSizeChange(Number(value) as CursorPageSize)
          }}
        >
          <SelectTrigger className='h-8 w-17.5' aria-label='每页行数'>
            <SelectValue />
          </SelectTrigger>
          <SelectContent side='top'>
            {CURSOR_PAGE_SIZES.map((size) => (
              <SelectItem key={size} value={`${size}`}>
                {size}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className='text-[13px] leading-5 font-medium'>每页行数</p>
        {updating ? (
          <p className='text-label text-muted-foreground'>更新中…</p>
        ) : null}
      </div>
      <div className='flex items-center gap-2'>
        <p className='text-[13px] leading-5 font-medium'>第 {pageIndex + 1} 页</p>
        <Button
          type='button'
          variant='outline'
          className='size-8 p-0'
          onClick={onPreviousPage}
          disabled={!hasPreviousPage || updating}
        >
          <span className='sr-only'>上一页</span>
          <ChevronLeftIcon className='size-4' />
        </Button>
        <Button
          type='button'
          variant='outline'
          className='size-8 p-0'
          onClick={onNextPage}
          disabled={!hasNextPage || updating}
        >
          <span className='sr-only'>下一页</span>
          <ChevronRightIcon className='size-4' />
        </Button>
      </div>
    </div>
  )
}
