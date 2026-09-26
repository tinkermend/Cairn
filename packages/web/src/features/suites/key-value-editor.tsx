import { useEffect, useRef, useState } from 'react'
import type { JsonValue } from '@cairn/shared'
import { Plus, Trash2, Code2, List } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

type KeyValueRow = {
  id: string
  key: string
  value: string
}

function parseValue(val: string): JsonValue {
  const trimmed = val.trim()
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed === 'null') return null
  if (!Number.isNaN(Number(trimmed)) && trimmed !== '') return Number(trimmed)
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      return JSON.parse(trimmed) as JsonValue
    } catch {
      return val
    }
  }
  return val
}

function serializeValue(val: JsonValue): string {
  if (typeof val === 'string') return val
  return JSON.stringify(val)
}

function objectToRows(obj: Record<string, JsonValue>): KeyValueRow[] {
  return Object.entries(obj).map(([k, v], idx) => ({
    id: `${idx}-${k}`,
    key: k,
    value: serializeValue(v),
  }))
}

function rowsToObject(rows: KeyValueRow[]): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {}
  for (const row of rows) {
    const k = row.key.trim()
    if (k) {
      result[k] = parseValue(row.value)
    }
  }
  return result
}

export function KeyValueEditor({
  value,
  onChange,
  disabled = false,
  placeholderKey = '参数名 (Key)',
  placeholderValue = '参数值 (Value)',
  referenceOptions = [],
}: {
  value: Record<string, JsonValue>
  onChange: (next: Record<string, JsonValue>) => void
  disabled?: boolean
  placeholderKey?: string
  placeholderValue?: string
  referenceOptions?: Array<{ value: string; label: string; description: string }>
}) {
  const [mode, setMode] = useState<'grid' | 'json'>('grid')
  const [rows, setRows] = useState<KeyValueRow[]>(() => objectToRows(value))
  const [jsonText, setJsonText] = useState<string>(() => JSON.stringify(value, null, 2))
  const [jsonError, setJsonError] = useState<string | null>(null)
  const [referenceRow, setReferenceRow] = useState<number | null>(null)
  const [referenceIndex, setReferenceIndex] = useState(0)
  const valueInputs = useRef<Record<number, HTMLInputElement | null>>({})

  function insertReference(index: number, reference: string) {
    const row = rows[index]
    if (!row) return
    const input = valueInputs.current[index]
    const start = input?.selectionStart ?? row.value.length
    const end = input?.selectionEnd ?? start
    const trigger = row.value.slice(0, start).lastIndexOf('${')
    const begin = start === end && trigger >= 0 ? trigger : start
    handleRowValueChange(index, row.value.slice(0, begin) + reference + row.value.slice(end))
    setReferenceRow(null)
    requestAnimationFrame(() => { input?.focus(); input?.setSelectionRange(begin + reference.length, begin + reference.length) })
  }

  useEffect(() => {
    setRows(objectToRows(value))
    setJsonText(JSON.stringify(value, null, 2))
    setJsonError(null)
  }, [value])

  function handleRowKeyChange(index: number, newKey: string) {
    const updated = [...rows]
    updated[index] = { ...updated[index]!, key: newKey }
    setRows(updated)
    onChange(rowsToObject(updated))
  }

  function handleRowValueChange(index: number, newValue: string) {
    const updated = [...rows]
    updated[index] = { ...updated[index]!, value: newValue }
    setRows(updated)
    onChange(rowsToObject(updated))
  }

  function addRow() {
    const updated = [...rows, { id: `row-${Date.now()}-${rows.length}`, key: '', value: '' }]
    setRows(updated)
  }

  function removeRow(index: number) {
    const updated = rows.filter((_, i) => i !== index)
    setRows(updated)
    onChange(rowsToObject(updated))
  }

  function handleJsonChange(text: string) {
    setJsonText(text)
    try {
      const parsed = JSON.parse(text)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        setJsonError(null)
        onChange(parsed as Record<string, JsonValue>)
      } else {
        setJsonError('JSON 根节点必须为对象 (Object)')
      }
    } catch (e) {
      setJsonError((e as Error).message)
    }
  }

  return (
    <div className='space-y-3'>
      <div className='flex items-center justify-between gap-2'>
        <span className='text-label text-muted-foreground'>
          {mode === 'grid'
            ? `共 ${rows.length} 个参数项`
            : '原始 JSON 格式编辑'}
        </span>
        <Button
          variant='ghost'
          size='sm'
          className='h-7 text-label'
          onClick={() => {
            if (mode === 'grid') {
              setJsonText(JSON.stringify(rowsToObject(rows), null, 2))
              setMode('json')
            } else {
              setMode('grid')
            }
          }}
        >
          {mode === 'grid' ? (
            <>
              <Code2 className='mr-1 size-3.5' />
              转为 JSON
            </>
          ) : (
            <>
              <List className='mr-1 size-3.5' />
              转为表格
            </>
          )}
        </Button>
      </div>

      {mode === 'grid' ? (
        <div className='space-y-2'>
          {rows.length === 0 ? (
            <div className='rounded-md border border-dashed border-border-divider p-4 text-center text-label text-muted-foreground'>
              暂无参数，点击下方按钮添加。
            </div>
          ) : (
            rows.map((row, index) => (
              <div key={row.id} className='flex items-center gap-2'>
                <Input
                  value={row.key}
                  disabled={disabled}
                  placeholder={placeholderKey}
                  aria-label={`参数名 ${index + 1}`}
                  className='w-1/3 min-w-[120px] font-mono text-small bg-card'
                  onChange={(e) => handleRowKeyChange(index, e.target.value)}
                />
                <div className='relative min-w-0 flex-1'>
                <Input
                  ref={(element) => { valueInputs.current[index] = element }}
                  value={row.value}
                  disabled={disabled}
                  placeholder={placeholderValue}
                  aria-label={`参数值 ${index + 1}`}
                  className='w-full min-w-0 font-mono text-small bg-card'
                  onChange={(e) => {
                    handleRowValueChange(index, e.target.value)
                    const before = e.target.value.slice(0, e.target.selectionStart ?? e.target.value.length)
                    setReferenceRow(referenceOptions.length && before.lastIndexOf('${') > before.lastIndexOf('}') ? index : null)
                    setReferenceIndex(0)
                  }}
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing || referenceRow !== index) return
                    if (event.key === 'Escape') { event.preventDefault(); setReferenceRow(null) }
                    if (event.key === 'ArrowDown') { event.preventDefault(); setReferenceIndex((current) => (current + 1) % referenceOptions.length) }
                    if (event.key === 'ArrowUp') { event.preventDefault(); setReferenceIndex((current) => (current - 1 + referenceOptions.length) % referenceOptions.length) }
                    if (event.key === 'Enter' && referenceOptions[referenceIndex]) { event.preventDefault(); insertReference(index, referenceOptions[referenceIndex].value) }
                  }}
                />
                {referenceRow === index && referenceOptions.length ? <div role='listbox' aria-label='前序阶段输出' className='absolute z-50 max-h-48 w-full overflow-y-auto rounded-md border bg-popover p-1 shadow-lg'>
                  {referenceOptions.map((option, optionIndex) => <div key={option.value} role='option' aria-selected={optionIndex === referenceIndex} className={`cursor-pointer rounded px-2 py-1 text-label ${optionIndex === referenceIndex ? 'bg-primary/10' : ''}`} onMouseDown={(event) => event.preventDefault()} onClick={() => insertReference(index, option.value)}>{option.label}<div className='font-mono text-muted-foreground'>{option.value}</div><div className='text-muted-foreground'>{option.description}</div></div>)}
                </div> : null}
                </div>
                {referenceOptions.length && (typeof value[row.key] === 'string' || value[row.key] === undefined) ? <Button type='button' variant='ghost' size='sm' className='shrink-0 text-label' onClick={() => setReferenceRow(referenceRow === index ? null : index)}>插入输出</Button> : null}
                {!disabled && (
                  <Button
                    variant='ghost'
                    size='icon'
                    aria-label={`删除参数 ${index + 1}`}
                    className='size-7 shrink-0 text-muted-foreground hover:text-destructive'
                    onClick={() => removeRow(index)}
                  >
                    <Trash2 className='size-3.5' />
                  </Button>
                )}
              </div>
            ))
          )}
          {!disabled && (
            <Button
              variant='outline'
              size='sm'
              className='mt-1 text-label'
              onClick={addRow}
            >
              <Plus className='mr-1 size-3.5' />
              添加参数
            </Button>
          )}
        </div>
      ) : (
        <div className='space-y-1.5'>
          <Textarea
            value={jsonText}
            disabled={disabled}
            rows={6}
            className='font-mono text-small w-full resize-y min-h-[140px]'
            onChange={(e) => handleJsonChange(e.target.value)}
          />
          {jsonError && (
            <p className='text-label text-destructive'>JSON 语法错误: {jsonError}</p>
          )}
        </div>
      )}
    </div>
  )
}
