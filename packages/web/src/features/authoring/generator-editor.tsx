import { useState, useMemo, useRef, useId, type KeyboardEvent } from 'react'
import {
  evaluateGenerator,
  type DataGeneratorSpec,
  type MockPreset,
  MOCK_PRESETS,
  GENERATOR_MACROS,
  generatorTemplateIssues,
} from '@cairn/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Sparkles, RefreshCw, X } from 'lucide-react'

const PRESET_LABELS: Record<MockPreset, string> = {
  phone_cn: '中国大陆手机号 (11位)',
  name_cn: '中文姓名 (百家姓)',
  email: '拟真电子邮箱',
  id_card_cn: '居民身份证号 (18位带校验码)',
  company_cn: '企业全称',
  uuid_v4: 'UUID v4 随机标示符',
}

function MacroInput({ value, disabled, onChange }: { value: string; disabled?: boolean; onChange: (value: string) => void }) {
  const input = useRef<HTMLInputElement>(null)
  const id = useId()
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [caret, setCaret] = useState(0)
  const [scroll, setScroll] = useState(0)
  const issues = generatorTemplateIssues(value)
  const before = value.slice(0, caret)
  const start = before.lastIndexOf('{{')
  const query = start >= 0 && !before.slice(start).includes('}}') ? before.slice(start + 2).toLowerCase() : ''
  const candidates = GENERATOR_MACROS.filter((item) => !query || item.token.toLowerCase().includes(query) || item.label.includes(query))
  const parts: Array<{ text: string; kind: 'text' | 'valid' | 'invalid' }> = []
  let cursor = 0
  for (const match of value.matchAll(/\{\{.*?(?:\}\}|$)/g)) {
    if (match.index > cursor) parts.push({ text: value.slice(cursor, match.index), kind: 'text' })
    parts.push({ text: match[0], kind: issues.some((issue) => issue.start === match.index) ? 'invalid' : 'valid' })
    cursor = match.index + match[0].length
  }
  if (cursor < value.length) parts.push({ text: value.slice(cursor), kind: 'text' })
  const insert = (token: string) => {
    const el = input.current
    const selectionStart = el?.selectionStart ?? value.length
    const selectionEnd = el?.selectionEnd ?? selectionStart
    const prefixStart = value.slice(0, selectionStart).lastIndexOf('{{')
    const begin = selectionStart === selectionEnd && prefixStart >= 0 ? prefixStart : selectionStart
    onChange(value.slice(0, begin) + token + value.slice(selectionEnd))
    setOpen(false)
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(begin + token.length, begin + token.length) })
  }
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || !open) return
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false) }
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive((index) => (index + 1) % Math.max(candidates.length, 1)) }
    if (event.key === 'ArrowUp') { event.preventDefault(); setActive((index) => (index - 1 + candidates.length) % Math.max(candidates.length, 1)) }
    if (event.key === 'Enter' && candidates[active]) { event.preventDefault(); insert(candidates[active].token) }
  }
  return <div className='relative'>
    <div aria-hidden='true' className='pointer-events-none absolute inset-x-3 top-1/2 -translate-y-1/2 overflow-hidden whitespace-nowrap font-mono text-label'>
      <span className='relative block w-max' style={{ transform: `translateX(-${scroll}px)` }}>{parts.map((part, index) => <span key={index} className={part.kind === 'valid' ? 'text-primary font-medium' : part.kind === 'invalid' ? 'text-destructive underline' : 'text-foreground'}>{part.text}</span>)}</span>
    </div>
    <Input ref={input} aria-label='生成器模板内容' role='combobox' aria-autocomplete='list' aria-expanded={open} aria-controls={`${id}-list`} aria-activedescendant={open && candidates[active] ? `${id}-${active}` : undefined}
      className='relative h-8 bg-transparent font-mono text-label text-transparent caret-foreground' placeholder='如 商品_{{rand:8}}' value={value} disabled={disabled}
      onScroll={(event) => setScroll(event.currentTarget.scrollLeft)} onChange={(event) => { onChange(event.target.value); const pos = event.target.selectionStart ?? event.target.value.length; setCaret(pos); setOpen(event.target.value.slice(0, pos).lastIndexOf('{{') > event.target.value.slice(0, pos).lastIndexOf('}}')); setActive(0) }} onClick={(event) => setCaret(event.currentTarget.selectionStart ?? value.length)} onKeyDown={keyDown} onBlur={() => setOpen(false)} />
    {open && !disabled ? <div id={`${id}-list`} role='listbox' aria-label='生成器宏' className='absolute z-50 max-h-52 w-full overflow-y-auto rounded-md border bg-popover p-1 shadow-lg'>
      {candidates.map((item, index) => <div id={`${id}-${index}`} key={item.token} role='option' aria-selected={index === active} className={`cursor-pointer rounded px-2 py-1 text-label ${index === active ? 'bg-primary/10' : ''}`} onMouseDown={(event) => event.preventDefault()} onClick={() => insert(item.token)}><code>{item.token}</code> · {item.label}<div className='text-muted-foreground'>{item.description}</div></div>)}
      {!candidates.length ? <p className='p-2 text-muted-foreground'>没有匹配的宏</p> : null}
    </div> : null}
    {issues.length ? <p role='alert' className='mt-1 text-label text-destructive'>{issues[0]!.message}</p> : null}
  </div>
}

export function GeneratorConfigEditor({
  generator,
  disabled,
  onChange,
}: {
  generator?: DataGeneratorSpec
  disabled?: boolean
  onChange: (spec?: DataGeneratorSpec) => void
}) {
  const [rerollSeed, setRerollSeed] = useState(0)

  const samplePreview = useMemo(() => {
    if (!generator) return null
    try {
      return String(evaluateGenerator(generator))
    } catch {
      return '模板求值失败，请修正宏'
    }
  }, [generator, rerollSeed])

  if (!generator) {
    return (
      <Button
        type='button'
        variant='outline'
        size='sm'
        disabled={disabled}
        className='h-7 text-label gap-1.5 border-dashed'
        onClick={() =>
          onChange({
            kind: 'mock_preset',
            preset: 'phone_cn',
            unique: true,
          })
        }
      >
        <Sparkles className='h-3.5 w-3.5 text-primary' />
        配置动态生成规则
      </Button>
    )
  }

  return (
    <div className='p-3 rounded-lg border bg-muted space-y-2.5 text-label'>
      <div className='flex items-center justify-between'>
        <div className='flex items-center gap-1.5 font-medium text-foreground'>
          <Sparkles className='h-3.5 w-3.5 text-primary' />
          <span>智能动态生成器</span>
        </div>
        <Button
          type='button'
          variant='ghost'
          size='sm'
          disabled={disabled}
          className='h-6 w-6 p-0 text-muted-foreground hover:text-destructive'
          onClick={() => onChange(undefined)}
          title='移除生成器'
        >
          <X className='h-3.5 w-3.5' />
        </Button>
      </div>

      <div className='space-y-2.5'>
        <div className='space-y-1'>
          <Label className='text-caption text-muted-foreground'>生成规则类型</Label>
          <Select
            value={generator.kind}
            disabled={disabled}
            onValueChange={(val: string) => {
              if (val === 'mock_preset') {
                onChange({ kind: 'mock_preset', preset: 'phone_cn', unique: true })
              } else if (val === 'random_number') {
                onChange({ kind: 'random_number', min: 1, max: 100, precision: 0 })
              } else if (val === 'random_string') {
                onChange({ kind: 'random_string', length: 8, charset: 'alphanumeric', prefix: '', suffix: '', unique: true })
              } else if (val === 'date_relative') {
                onChange({ kind: 'date_relative', offsetDaysMin: 0, offsetDaysMax: 7, format: 'YYYY-MM-DD' })
              } else if (val === 'enum_sample') {
                onChange({ kind: 'enum_sample', options: ['选项A', '选项B', '选项C'] })
              } else if (val === 'template') {
                onChange({ kind: 'template', pattern: '用户_{{rand:8}}', unique: true })
              } else if (val === 'fixed') {
                onChange({ kind: 'fixed', value: '固定默认值' })
              }
            }}
          >
            <SelectTrigger className='w-full min-w-0 h-8 text-label'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='mock_preset'>真实预设字典 (姓名/手机/邮箱/企业)</SelectItem>
              <SelectItem value='random_number'>数值区间随机 (Min/Max/精度)</SelectItem>
              <SelectItem value='random_string'>字符随机生成 (字母/数字/前缀)</SelectItem>
              <SelectItem value='date_relative'>动态相对日期 (偏移量/格式)</SelectItem>
              <SelectItem value='enum_sample'>枚举候选抽样 (随机/顺序)</SelectItem>
              <SelectItem value='template'>复合模板渲染 (宏变量组合)</SelectItem>
              <SelectItem value='fixed'>静态固定值</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {generator.kind === 'mock_preset' && (
          <div className='space-y-1'>
            <Label className='text-caption text-muted-foreground'>字典预设项</Label>
            <Select
              value={generator.preset}
              disabled={disabled}
              onValueChange={(preset: MockPreset) => onChange({ ...generator, preset })}
            >
              <SelectTrigger className='w-full min-w-0 h-8 text-label'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MOCK_PRESETS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {PRESET_LABELS[p] ?? p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {generator.kind === 'random_number' && (
          <div className='grid grid-cols-3 gap-2'>
            <div>
              <Label className='text-caption text-muted-foreground'>最小值</Label>
              <Input
                type='number'
                className='h-8 text-label'
                value={generator.min}
                disabled={disabled}
                onChange={(e) => onChange({ ...generator, min: Number(e.target.value) })}
              />
            </div>
            <div>
              <Label className='text-caption text-muted-foreground'>最大值</Label>
              <Input
                type='number'
                className='h-8 text-label'
                value={generator.max}
                disabled={disabled}
                onChange={(e) => onChange({ ...generator, max: Number(e.target.value) })}
              />
            </div>
            <div>
              <Label className='text-caption text-muted-foreground'>小数位</Label>
              <Input
                type='number'
                min={0}
                max={6}
                className='h-8 text-label'
                value={generator.precision}
                disabled={disabled}
                onChange={(e) => onChange({ ...generator, precision: Number(e.target.value) })}
              />
            </div>
          </div>
        )}

        {generator.kind === 'random_string' && (
          <div className='grid grid-cols-3 gap-2'>
            <div>
              <Label className='text-caption text-muted-foreground'>长度</Label>
              <Input
                type='number'
                min={1}
                max={64}
                className='h-8 text-label'
                value={generator.length}
                disabled={disabled}
                onChange={(e) => onChange({ ...generator, length: Number(e.target.value) })}
              />
            </div>
            <div className='col-span-2'>
              <Label className='text-caption text-muted-foreground'>前缀</Label>
              <Input
                className='h-8 text-label'
                placeholder='例如 SKU-'
                value={generator.prefix ?? ''}
                disabled={disabled}
                onChange={(e) => onChange({ ...generator, prefix: e.target.value })}
              />
            </div>
          </div>
        )}

        {generator.kind === 'date_relative' && (
          <div className='grid grid-cols-3 gap-2'>
            <div>
              <Label className='text-caption text-muted-foreground'>最小天数</Label>
              <Input
                type='number'
                className='h-8 text-label'
                value={generator.offsetDaysMin}
                disabled={disabled}
                onChange={(e) => onChange({ ...generator, offsetDaysMin: Number(e.target.value) })}
              />
            </div>
            <div>
              <Label className='text-caption text-muted-foreground'>最大天数</Label>
              <Input
                type='number'
                className='h-8 text-label'
                value={generator.offsetDaysMax}
                disabled={disabled}
                onChange={(e) => onChange({ ...generator, offsetDaysMax: Number(e.target.value) })}
              />
            </div>
            <div>
              <Label className='text-caption text-muted-foreground'>格式</Label>
              <Input
                className='h-8 text-label font-mono'
                value={generator.format}
                disabled={disabled}
                onChange={(e) => onChange({ ...generator, format: e.target.value })}
              />
            </div>
          </div>
        )}

        {generator.kind === 'template' && (
          <div className='space-y-1'>
            <Label className='text-caption text-muted-foreground'>模板内容</Label>
            <MacroInput value={generator.pattern} disabled={disabled} onChange={(pattern) => onChange({ ...generator, pattern })} />
          </div>
        )}

        {generator.kind === 'fixed' && (
          <div className='space-y-1'>
            <Label className='text-caption text-muted-foreground'>固定默认值</Label>
            <Input
              className='h-8 text-label'
              value={String(generator.value)}
              disabled={disabled}
              onChange={(e) => onChange({ ...generator, value: e.target.value })}
            />
          </div>
        )}

        {generator.kind === 'enum_sample' && (
          <div className='space-y-1'>
            <Label className='text-caption text-muted-foreground'>候选列表 (逗号分隔)</Label>
            <Input
              className='h-8 text-label'
              value={generator.options.join(', ')}
              disabled={disabled}
              onChange={(e) =>
                onChange({
                  ...generator,
                  options: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                })
              }
            />
          </div>
        )}
      </div>

      {('unique' in generator) && (
        <div className='flex items-center space-x-2 pt-1'>
          <Checkbox
            id='unique-check'
            checked={Boolean(generator.unique)}
            disabled={disabled}
            onCheckedChange={(checked) => onChange({ ...generator, unique: Boolean(checked) })}
          />
          <Label htmlFor='unique-check' className='text-label font-normal text-muted-foreground cursor-pointer'>
            批次内全局唯一（开启后自动排重碰撞）
          </Label>
        </div>
      )}

      {/* 实时求值预览 */}
      <div className='flex items-center justify-between px-2.5 py-1.5 rounded bg-card border text-caption font-mono'>
        <div className='flex items-center gap-2 truncate'>
          <Badge variant='outline' className='text-caption px-1 py-0 h-4 font-normal'>
            求值预览
          </Badge>
          <span className='text-foreground font-semibold truncate'>{samplePreview}</span>
        </div>
        <Button
          type='button'
          variant='ghost'
          size='sm'
          disabled={disabled}
          className='h-5 w-5 p-0 text-muted-foreground hover:text-foreground'
          onClick={() => setRerollSeed((s) => s + 1)}
          title='重新摇号'
        >
          <RefreshCw className='h-3 w-3' />
        </Button>
      </div>
    </div>
  )
}
