import { useState } from 'react'
import type { JsonValue } from '@cairn/shared'
import { Button } from '@/components/ui/button'

const PREVIEW_ROWS = 20

function cellText(value: JsonValue | undefined): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

function ListTable({ name, rows }: { name: string; rows: JsonValue[] }) {
  const [expanded, setExpanded] = useState(false)
  const visible = expanded ? rows : rows.slice(0, PREVIEW_ROWS)
  const objectRows = rows.filter((row): row is Record<string, JsonValue> => Boolean(row) && typeof row === 'object' && !Array.isArray(row))
  const columns = objectRows.length > 0
    ? [...new Set(objectRows.flatMap((row) => Object.keys(row)))]
    : ['value']

  return (
    <div className='space-y-2'>
      <p className='text-label text-muted-foreground'>
        → {name}（列表，{rows.length} 项）
      </p>
      <div className='overflow-x-auto rounded-md border border-border-card'>
        <table className='w-full text-label'>
          <thead className='bg-muted/40'>
            <tr>
              {columns.map((column) => (
                <th key={column} className='px-2 py-1 text-left font-medium'>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((row, index) => (
              <tr key={index} className='border-t border-border-card/60'>
                {columns.map((column) => (
                  <td key={column} className='px-2 py-1 font-mono'>
                    {cellText(
                      row && typeof row === 'object' && !Array.isArray(row)
                        ? row[column]
                        : column === 'value'
                          ? row
                          : undefined,
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > PREVIEW_ROWS ? (
        <Button type='button' variant='ghost' size='sm' className='h-7 px-2 text-label' onClick={() => setExpanded((value) => !value)}>
          {expanded ? '收起' : `展开其余 ${rows.length - PREVIEW_ROWS} 行`}
        </Button>
      ) : null}
    </div>
  )
}

export function ContextLists({ context }: { context: Record<string, JsonValue> }) {
  const lists = Object.entries(context).filter((entry): entry is [string, JsonValue[]] => Array.isArray(entry[1]))
  if (lists.length === 0) return null
  return (
    <div className='mb-3 space-y-3'>
      {lists.map(([name, rows]) => (
        <ListTable key={name} name={name} rows={rows} />
      ))}
    </div>
  )
}
