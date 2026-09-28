import { useCallback, useState, useRef, useMemo, type KeyboardEvent } from 'react'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Popover, PopoverContent, PopoverAnchor } from '@/components/ui/popover'
import type { BindingOption } from '@/features/authoring/document'
import { Braces, Variable, Database, Box } from 'lucide-react'

import { useResetOnChange } from '@/hooks/use-reset-on-change'
export interface ContextMentionInputProps {
  id?: string
  value: string
  placeholder?: string
  disabled?: boolean
  multiline?: boolean
  className?: string
  'aria-label'?: string
  bindings: BindingOption[]
  mode?: 'template' | 'binding_picker'
  onChange: (value: string) => void
  onSelectBinding?: (binding: BindingOption) => void
}

export function ContextMentionInput({
  id,
  value,
  placeholder,
  disabled,
  multiline = false,
  className,
  'aria-label': ariaLabel,
  bindings,
  mode = 'template',
  onChange,
  onSelectBinding,
}: ContextMentionInputProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  // Input / Textarea 二选一渲染：回调 ref 同时满足两者的 ref 类型。
  const setInputRef = useCallback((el: HTMLInputElement | HTMLTextAreaElement | null) => {
    inputRef.current = el
  }, [])

  // 区分变量类别
  const categorizedBindings = useMemo(() => {
    const q = query.toLowerCase().trim()
    const filtered = bindings.filter(
      (b) =>
        b.key.toLowerCase().includes(q) ||
        b.label.toLowerCase().includes(q) ||
        b.description?.toLowerCase().includes(q) ||
        b.typeLabel?.toLowerCase().includes(q),
    )

    return filtered.map((b) => {
      let category = 'step'
      let icon = Variable
      if (b.label.startsWith('输入') || b.key.startsWith('input.')) {
        category = 'input'
        icon = Database
      } else if (b.label.startsWith('模块') || b.key.startsWith('module.')) {
        category = 'module'
        icon = Box
      }
      return { ...b, category, Icon: icon }
    })
  }, [bindings, query])

  // 候选列表或查询变化时高亮回到第一项
  useResetOnChange(`${categorizedBindings.length}:${query}`, () => setSelectedIndex(0))

  function handleSelect(item: BindingOption) {
    if (item.stale) return
    const rawBinding: BindingOption = {
      key: item.key,
      label: item.label,
      ...(item.stale ? { stale: item.stale } : {}),
      ...(item.typeLabel ? { typeLabel: item.typeLabel } : {}),
      ...(item.description ? { description: item.description } : {}),
    }
    if (mode === 'binding_picker') {
      onSelectBinding?.(rawBinding)
      setIsOpen(false)
      return
    }

    // template mode: insert at cursor
    const el = inputRef.current
    if (!el) {
      onChange(`${value}{{${rawBinding.key}}}`)
      setIsOpen(false)
      return
    }

    const start = el.selectionStart ?? value.length
    const end = el.selectionEnd ?? value.length
    const textBefore = value.slice(0, start)
    const textAfter = value.slice(end)

    // 如果光标前刚好有 {{ 或 @，替换掉触发符
    let prefix = textBefore
    if (prefix.endsWith('{{')) {
      prefix = prefix.slice(0, -2)
    } else if (prefix.endsWith('@')) {
      prefix = prefix.slice(0, -1)
    }

    const inserted = `{{${rawBinding.key}}}`
    const nextVal = `${prefix}${inserted}${textAfter}`
    onChange(nextVal)
    setIsOpen(false)

    // 重新聚焦并将光标移到插入标记之后
    setTimeout(() => {
      el.focus()
      const newPos = prefix.length + inserted.length
      el.setSelectionRange(newPos, newPos)
    }, 0)
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
    if (!isOpen) {
      // 触发检测
      if (e.key === '@' || (e.key === '{' && value.endsWith('{'))) {
        setQuery('')
        setIsOpen(true)
      }
      return
    }

    // 浮层展开状态下的键盘事件拦截与无障碍处理
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      e.stopPropagation()
      setSelectedIndex((prev) =>
        prev + 1 >= categorizedBindings.length ? 0 : prev + 1,
      )
      return
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault()
      e.stopPropagation()
      setSelectedIndex((prev) =>
        prev - 1 < 0 ? Math.max(0, categorizedBindings.length - 1) : prev - 1,
      )
      return
    }

    if (e.key === 'Enter') {
      if (categorizedBindings.length > 0 && selectedIndex < categorizedBindings.length) {
        e.preventDefault()
        e.stopPropagation()
        handleSelect(categorizedBindings[selectedIndex]!)
      } else {
        setIsOpen(false)
      }
      return
    }

    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setIsOpen(false)
      return
    }
  }

  function handleChange(nextText: string) {
    onChange(nextText)
    // 监听输入
    if (nextText.endsWith('{{') || nextText.endsWith('@')) {
      setQuery('')
      setIsOpen(true)
    } else if (isOpen) {
      // 提取触发符后的查询字串
      const lastAt = nextText.lastIndexOf('@')
      const lastBrace = nextText.lastIndexOf('{{')
      const lastTrigger = Math.max(lastAt, lastBrace)
      if (lastTrigger !== -1) {
        const afterTrigger = nextText.slice(lastTrigger + (lastTrigger === lastBrace ? 2 : 1))
        if (!afterTrigger.includes(' ') && !afterTrigger.includes('}')) {
          setQuery(afterTrigger)
        } else {
          setIsOpen(false)
        }
      } else {
        setIsOpen(false)
      }
    }
  }

  const InputComp = multiline ? Textarea : Input

  return (
    <div className='relative w-full' data-testid='context-mention-input-wrapper'>
      <Popover open={isOpen} onOpenChange={setIsOpen}>
        <PopoverAnchor asChild>
          <div className='relative flex items-center w-full'>
            <InputComp
              id={id}
              ref={setInputRef}
              value={value}
              disabled={disabled}
              placeholder={placeholder}
              aria-label={ariaLabel}
              className={className}
              onChange={(e) => handleChange(e.target.value)}
              onKeyDown={handleKeyDown}
            />
            {bindings.length > 0 && !disabled ? (
              <button
                type='button'
                tabIndex={-1}
                aria-label='插入变量引用'
                title='可用上下文变量'
                className='absolute right-2 text-muted-foreground/60 hover:text-primary transition-colors p-0.5 rounded'
                onClick={() => {
                  setQuery('')
                  setIsOpen((prev) => !prev)
                }}
              >
                <Braces className='size-3.5' />
              </button>
            ) : null}
          </div>
        </PopoverAnchor>

        <PopoverContent
          align='start'
          sideOffset={4}
          onOpenAutoFocus={(e) => e.preventDefault()}
          className='w-72 p-1 max-h-60 overflow-y-auto z-50 shadow-elevation-md bg-popover text-popover-foreground border-border rounded-panel'
        >
          <div className='px-2 py-1 text-label text-muted-foreground font-medium border-b border-border/50 flex items-center justify-between'>
            <span>可用上下文变量 ({categorizedBindings.length})</span>
            <span className='text-3xs text-muted-foreground/70'>↑↓ 导航 · ↵ 选中</span>
          </div>

          {categorizedBindings.length === 0 ? (
            <div className='p-3 text-center text-small text-muted-foreground'>
              暂无匹配变量
            </div>
          ) : (
            <div className='py-1 space-y-0.5' role='listbox'>
              {categorizedBindings.map((item, idx) => {
                const isSelected = idx === selectedIndex
                const ItemIcon = item.Icon
                return (
                  <button
                    key={item.key}
                    type='button'
                    role='option'
                    aria-selected={isSelected}
                    aria-disabled={item.stale || undefined}
                    disabled={item.stale}
                    className={`w-full text-left px-2 py-1.5 rounded flex items-center gap-2 text-small transition-colors ${
                      isSelected
                        ? 'bg-primary/10 text-primary font-medium'
                        : item.stale ? 'text-muted-foreground opacity-60' : 'text-foreground hover:bg-muted/50'
                    }`}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      handleSelect(item)
                    }}
                  >
                    <ItemIcon className='size-3.5 shrink-0 opacity-70' />
                    <div className='flex flex-col min-w-0 flex-1 leading-tight'>
                      <span className='truncate font-mono text-label'>{item.key}</span>
                      <span className='truncate text-2xs text-muted-foreground'>
                        {item.label}{item.typeLabel ? ` · ${item.typeLabel}` : ''}{item.stale ? ' · 不可用' : ''}
                      </span>
                      {item.description ? <span className='truncate text-2xs text-muted-foreground' title={item.description}>{item.description}</span> : null}
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </PopoverContent>
      </Popover>
    </div>
  )
}
