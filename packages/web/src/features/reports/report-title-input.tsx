import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { REPORT_TITLE_CATALOG, parseReportTitle, reportTitleSources, type ReportTitleSource } from '@cairn/shared'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'

export function ReportTitleInput({ id, value, onChange, source, optional = false, label = '报告标题', placeholder }: {
  id?: string
  value: string
  onChange: (value: string) => void
  source?: ReportTitleSource
  optional?: boolean
  label?: string
  placeholder?: string
}) {
  const generatedId = useId()
  const fieldId = id ?? generatedId
  const listId = `${fieldId}-options`
  const helpId = `${fieldId}-help`
  const errorId = `${fieldId}-error`
  const input = useRef<HTMLInputElement>(null)
  const anchor = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [range, setRange] = useState<[number, number]>([0, 0])
  const [scroll, setScroll] = useState(0)
  const [touched, setTouched] = useState(false)
  const [composing, setComposing] = useState(false)
  const segments = useMemo(() => parseReportTitle(value, source), [value, source])
  const error = (!optional && !value.trim() ? '请输入报告标题' : segments.find((part) => part.message)?.message ?? (value && !source && !reportTitleSources(value).length ? '标题同时使用了单次运行与场景集专用变量' : undefined))
  const query = value.slice(range[0] + 1, range[1]).toLowerCase()
  const options = REPORT_TITLE_CATALOG.filter((item) => !query || item.key.toLowerCase().includes(query) || item.label.includes(query))

  const locate = (text: string, caret: number) => {
    let start = caret - 1
    while (start >= 0 && text[start] !== '{' && text[start] !== '}') start--
    if (start >= 0 && text[start] === '{' && text[start - 1] !== '\\') return [start, caret] as [number, number]
    return [caret, caret] as [number, number]
  }
  const updateRange = (text: string, caret: number) => {
    const next = locate(text, caret)
    setRange(next)
    if (next[0] !== next[1]) { setOpen(true); setActive(0) }
    else setOpen(false)
  }
  const insert = (item: (typeof REPORT_TITLE_CATALOG)[number]) => {
    if (source && !(item.sources as readonly string[]).includes(source)) return
    const el = input.current
    const selectionStart = el?.selectionStart ?? value.length
    const selectionEnd = el?.selectionEnd ?? selectionStart
    const start = selectionStart === selectionEnd && range[0] !== range[1] ? range[0] : selectionStart
    const end = selectionStart === selectionEnd && range[0] !== range[1] ? range[1] : selectionEnd
    const insertion = `{${item.key}}`
    onChange(value.slice(0, start) + insertion + value.slice(end))
    setOpen(false)
    requestAnimationFrame(() => {
      if (!el) return
      el.focus()
      const caret = start + insertion.length
      el.setSelectionRange(caret, caret)
      const context = document.createElement('canvas').getContext('2d')
      if (!context) return
      context.font = getComputedStyle(el).font
      const x = context.measureText(value.slice(0, start) + insertion).width
      const viewport = el.clientWidth - 24
      const nextScroll = x - el.scrollLeft > viewport ? Math.max(0, x - viewport + 8) : x - el.scrollLeft < 0 ? Math.max(0, x - 8) : el.scrollLeft
      el.scrollLeft = nextScroll
      setScroll(el.scrollLeft)
    })
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (composing || event.nativeEvent.isComposing || event.keyCode === 229 || !open) return
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false) }
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive((current) => (current + 1) % Math.max(options.length, 1)) }
    if (event.key === 'ArrowUp') { event.preventDefault(); setActive((current) => (current - 1 + options.length) % Math.max(options.length, 1)) }
    if (event.key === 'Enter' && options[active]) { event.preventDefault(); insert(options[active]) }
  }
  return <Popover open={open} onOpenChange={setOpen}><div className='relative min-w-0 space-y-1.5'>
    <PopoverAnchor asChild><div ref={anchor} className='flex flex-col gap-2 sm:flex-row'>
      <div className='relative min-w-0 flex-1'>
        <div aria-hidden='true' className='pointer-events-none absolute inset-x-3 top-1/2 -translate-y-1/2 overflow-hidden whitespace-nowrap text-body md:text-label'>
          <span className='relative block w-max' style={{ transform: `translateX(-${scroll}px)` }}>
            {segments.map((part) => <span key={`${part.start}-${part.end}`} className={part.kind === 'variable' ? 'text-primary font-medium' : ['unknown', 'unavailable', 'invalid'].includes(part.kind) ? 'text-destructive underline decoration-wavy' : 'text-foreground'} title={part.kind === 'variable' ? REPORT_TITLE_CATALOG.find((item) => item.key === part.key)?.description : part.message}>{part.raw}</span>)}
          </span>
        </div>
        <Input id={fieldId} ref={input} value={value} maxLength={200} placeholder={placeholder} aria-label={label}
          role='combobox' aria-autocomplete='list' aria-expanded={open} aria-controls={listId}
          aria-activedescendant={open && options[active] ? `${listId}-${active}` : undefined}
          aria-describedby={`${helpId}${touched && error ? ` ${errorId}` : ''}`} aria-invalid={touched && Boolean(error)}
          className='relative bg-transparent text-body md:text-label text-transparent caret-foreground placeholder:text-muted-foreground'
          onScroll={(event) => setScroll(event.currentTarget.scrollLeft)}
          onChange={(event) => { onChange(event.target.value); if (!composing) updateRange(event.target.value, event.target.selectionStart ?? event.target.value.length) }}
          onClick={(event) => updateRange(value, event.currentTarget.selectionStart ?? value.length)}
          onKeyDown={onKeyDown} onCompositionStart={() => setComposing(true)}
          onCompositionEnd={(event) => { setComposing(false); updateRange(event.currentTarget.value, event.currentTarget.selectionStart ?? event.currentTarget.value.length) }}
          onBlur={() => { setTouched(true); setOpen(false) }} />
      </div>
      <Button type='button' variant='outline' className='self-start sm:self-auto' aria-haspopup='listbox' aria-expanded={open} aria-controls={listId}
        onMouseDown={(event) => event.preventDefault()} onClick={() => {
        const el = input.current
        setRange([el?.selectionStart ?? value.length, el?.selectionEnd ?? value.length])
        setActive(0)
        setOpen(true)
        el?.focus()
      }}>插入变量</Button>
    </div></PopoverAnchor>
    <p id={helpId} className='text-label text-muted-foreground'>输入 {'{'} 查看变量；蓝色表示当前来源可用。字面大括号使用 {'\\{'} 和 {'\\}'}。</p>
    {touched && error ? <p id={errorId} role='alert' className='text-label text-destructive'>{error}</p> : null}
    <PopoverContent align='start' sideOffset={4} collisionPadding={12}
      onOpenAutoFocus={(event) => event.preventDefault()}
      onInteractOutside={(event) => { if (anchor.current?.contains(event.target as Node)) event.preventDefault() }}
      className='max-h-64 w-[min(34rem,calc(100vw-2rem))] overflow-y-auto p-1'>
      <div id={listId} role='listbox' aria-label='标题变量'>
      {options.length ? options.map((item, index) => {
        const available = !source || (item.sources as readonly string[]).includes(source)
        return <div key={item.key} id={`${listId}-${index}`} role='option' aria-selected={index === active} aria-disabled={!available}
          className={`rounded px-3 py-2 text-left text-label ${index === active ? 'bg-primary/10' : ''} ${available ? 'cursor-pointer' : 'opacity-50'}`}
          onMouseDown={(event) => event.preventDefault()} onClick={() => insert(item)}>
          <div className='font-medium'>{item.label} <code>{`{${item.key}}`}</code> <span className='text-muted-foreground'>· {item.sources.length === 2 ? '通用' : item.sources[0] === 'RUN' ? '单次运行' : '场景集'}</span></div>
          <div className='text-muted-foreground'>{item.description}；格式：{item.valueType}；来源：{item.exampleSource}；示例：{item.example}{!available ? '（当前来源不可用）' : ''}</div>
        </div>
      }) : <p className='p-3 text-label text-muted-foreground'>没有匹配变量，请检查拼写。</p>}
      </div>
    </PopoverContent>
    <span role='status' className='sr-only'>{open ? `${options.length} 个标题变量候选` : ''}</span>
  </div></Popover>
}
