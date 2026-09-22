import { useState, useMemo } from 'react'
import {
  evaluateGenerator,
  type DataGeneratorSpec,
  type MockPreset,
  MOCK_PRESETS,
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
      return '求值失败'
    }
  }, [generator, rerollSeed])

  if (!generator) {
    return (
      <Button
        type='button'
        variant='outline'
        size='sm'
        disabled={disabled}
        className='h-7 text-xs gap-1.5 border-dashed'
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
    <div className='p-3 rounded-lg border bg-muted/20 space-y-2.5 text-xs'>
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

      <div className='grid grid-cols-2 gap-2'>
        <div>
          <Label className='text-[11px] text-muted-foreground'>生成规则类型</Label>
          <Select
            value={generator.kind}
            disabled={disabled}
            onValueChange={(val: any) => {
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
                onChange({ kind: 'template', pattern: '用户_{{random_string}}', unique: true })
              } else if (val === 'fixed') {
                onChange({ kind: 'fixed', value: '固定默认值' })
              }
            }}
          >
            <SelectTrigger className='h-8 text-xs'>
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
          <div>
            <Label className='text-[11px] text-muted-foreground'>字典预设项</Label>
            <Select
              value={generator.preset}
              disabled={disabled}
              onValueChange={(preset: MockPreset) => onChange({ ...generator, preset })}
            >
              <SelectTrigger className='h-8 text-xs'>
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
          <div className='flex gap-1.5'>
            <div className='flex-1'>
              <Label className='text-[11px] text-muted-foreground'>最小值</Label>
              <Input
                type='number'
                className='h-8 text-xs'
                value={generator.min}
                disabled={disabled}
                onChange={(e) => onChange({ ...generator, min: Number(e.target.value) })}
              />
            </div>
            <div className='flex-1'>
              <Label className='text-[11px] text-muted-foreground'>最大值</Label>
              <Input
                type='number'
                className='h-8 text-xs'
                value={generator.max}
                disabled={disabled}
                onChange={(e) => onChange({ ...generator, max: Number(e.target.value) })}
              />
            </div>
            <div className='w-16'>
              <Label className='text-[11px] text-muted-foreground'>小数位</Label>
              <Input
                type='number'
                min={0}
                max={6}
                className='h-8 text-xs'
                value={generator.precision}
                disabled={disabled}
                onChange={(e) => onChange({ ...generator, precision: Number(e.target.value) })}
              />
            </div>
          </div>
        )}

        {generator.kind === 'random_string' && (
          <div className='flex gap-1.5'>
            <div className='w-20'>
              <Label className='text-[11px] text-muted-foreground'>长度</Label>
              <Input
                type='number'
                min={1}
                max={64}
                className='h-8 text-xs'
                value={generator.length}
                disabled={disabled}
                onChange={(e) => onChange({ ...generator, length: Number(e.target.value) })}
              />
            </div>
            <div className='flex-1'>
              <Label className='text-[11px] text-muted-foreground'>前缀</Label>
              <Input
                className='h-8 text-xs'
                placeholder='例如 SKU-'
                value={generator.prefix ?? ''}
                disabled={disabled}
                onChange={(e) => onChange({ ...generator, prefix: e.target.value })}
              />
            </div>
          </div>
        )}

        {generator.kind === 'template' && (
          <div>
            <Label className='text-[11px] text-muted-foreground'>模板内容</Label>
            <Input
              className='h-8 text-xs'
              placeholder='如 商品_{{random_string}}'
              value={generator.pattern}
              disabled={disabled}
              onChange={(e) => onChange({ ...generator, pattern: e.target.value })}
            />
          </div>
        )}

        {generator.kind === 'fixed' && (
          <div>
            <Label className='text-[11px] text-muted-foreground'>固定默认值</Label>
            <Input
              className='h-8 text-xs'
              value={String(generator.value)}
              disabled={disabled}
              onChange={(e) => onChange({ ...generator, value: e.target.value })}
            />
          </div>
        )}

        {generator.kind === 'enum_sample' && (
          <div>
            <Label className='text-[11px] text-muted-foreground'>候选列表 (逗号分隔)</Label>
            <Input
              className='h-8 text-xs'
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
          <Label htmlFor='unique-check' className='text-xs font-normal text-muted-foreground cursor-pointer'>
            批次内全局唯一（开启后自动排重碰撞）
          </Label>
        </div>
      )}

      {/* 实时求值预览 */}
      <div className='flex items-center justify-between px-2.5 py-1.5 rounded bg-background/80 border text-[11px] font-mono'>
        <div className='flex items-center gap-2 truncate'>
          <Badge variant='outline' className='text-[10px] px-1 py-0 h-4 font-normal'>
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
