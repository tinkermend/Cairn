import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  arrivalTargetForName,
  type MapJobKind,
  type MapSafeEntryDto,
  type MapSafetyBasisKind,
} from '@cairn/shared'
import { ChevronDown, ChevronRight, HelpCircle, Shield } from 'lucide-react'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import { createMapSafeEntry, updateMapSafeEntry } from '@/lib/map-api'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import {
  SelectField,
  SelectFieldOption,
} from '@/components/ui/select'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'

interface SafeEntryDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  targetId: string
  entry?: MapSafeEntryDto | null
}

const BASIS_KIND_OPTIONS: { value: MapSafetyBasisKind; label: string; desc: string }[] = [
  { value: 'confirmed_path', label: '已确认安全路径 (推荐)', desc: '经人工确认无破坏性操作的安全进入链接' },
  { value: 'target_readonly', label: '只读目标系统', desc: '系统本身为只读环境或账号仅具备只读权限' },
  { value: 'controlled_env', label: '受控测试环境', desc: '独立沙盒或专门的测绘测试环境' },
]

export function SafeEntryDialog({
  open,
  onOpenChange,
  targetId,
  entry,
}: SafeEntryDialogProps) {
  const queryClient = useQueryClient()
  const isEditing = Boolean(entry)

  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [enableProbeRefresh, setEnableProbeRefresh] = useState(true)
  const [enableExplore, setEnableExplore] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [arrivalName, setArrivalName] = useState('')
  const [safetyBasisKind, setSafetyBasisKind] = useState<MapSafetyBasisKind>('confirmed_path')
  const [summary, setSummary] = useState('')

  useEffect(() => {
    if (entry) {
      setName(entry.name)
      setUrl(entry.url)
      setEnableProbeRefresh(
        entry.jobKinds.includes('map_probe') || entry.jobKinds.includes('map_refresh'),
      )
      setEnableExplore(entry.jobKinds.includes('map_explore'))
      setArrivalName(entry.arrivalName === '页面就绪' ? '' : entry.arrivalName)
      setSafetyBasisKind(entry.safetyBasis?.kind ?? 'confirmed_path')
      setSummary(entry.safetyBasis?.summary ?? '')
      // Open advanced section if custom values were used
      if (
        (entry.arrivalName && entry.arrivalName !== '页面就绪') ||
        (entry.safetyBasis?.summary && entry.safetyBasis.summary !== '已核实进入路径') ||
        entry.safetyBasis?.kind !== 'confirmed_path'
      ) {
        setAdvancedOpen(true)
      } else {
        setAdvancedOpen(false)
      }
    } else {
      setName('')
      setUrl('')
      setEnableProbeRefresh(true)
      setEnableExplore(false)
      setArrivalName('')
      setSafetyBasisKind('confirmed_path')
      setSummary('')
      setAdvancedOpen(false)
    }
  }, [entry, open])

  const mutation = useMutation({
    mutationFn: async () => {
      const trimmedName = name.trim()
      const trimmedUrl = url.trim()
      if (!trimmedName) throw new Error('请输入路径名称')
      if (!trimmedUrl) throw new Error('请输入进入 URL')

      const jobKinds: MapJobKind[] = []
      if (enableProbeRefresh) {
        jobKinds.push('map_probe', 'map_refresh')
      }
      if (enableExplore) {
        jobKinds.push('map_explore')
      }
      if (jobKinds.length === 0) {
        throw new Error('请至少选择一种适用作业类型')
      }

      const trimmedArrival = arrivalName.trim()
      const finalArrivalName = trimmedArrival || '页面就绪'
      const finalArrivalTarget = trimmedArrival
        ? arrivalTargetForName(trimmedArrival)
        : { framePath: [], candidates: [{ by: 'css' as const, value: 'body' }] }

      const finalSummary = summary.trim() || '已核实进入路径'

      if (isEditing && entry) {
        return updateMapSafeEntry(targetId, entry.entryId, {
          expectedVersion: entry.version,
          name: trimmedName,
          url: trimmedUrl,
          arrivalName: finalArrivalName,
          arrivalTarget: finalArrivalTarget,
          safetyBasisKind,
          summary: finalSummary,
          jobKinds,
        })
      }

      return createMapSafeEntry(targetId, {
        idempotencyKey: `safe-entry:${Date.now()}`,
        name: trimmedName,
        url: trimmedUrl,
        arrivalName: finalArrivalName,
        arrivalTarget: finalArrivalTarget,
        safetyBasisKind,
        summary: finalSummary,
        jobKinds,
      })
    },
    onSuccess: () => {
      toast.success(isEditing ? '已更新安全进入路径' : '已新增安全进入路径')
      void queryClient.invalidateQueries({ queryKey: ['map', targetId, 'safe-entries'] })
      onOpenChange(false)
    },
    onError: (err) => {
      toast.error(err instanceof ApiRequestError || err instanceof Error ? err.message : '操作失败')
    },
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-lg'>
        <DialogHeader>
          <DialogTitle className='flex items-center gap-2'>
            <Shield className='size-5 text-link' />
            {isEditing ? '编辑安全进入路径' : '新增安全进入路径'}
          </DialogTitle>
          <DialogDescription>
            安全进入路径是执行地图测绘、定时复查与有界探索的受信入口。
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault()
            mutation.mutate()
          }}
          className='space-y-4 py-2'
        >
          {/* 路径名称 */}
          <div className='space-y-1.5'>
            <Label htmlFor='safe-entry-name'>
              路径名称 <span className='text-status-danger-foreground'>*</span>
            </Label>
            <Input
              id='safe-entry-name'
              placeholder='例如：用户控制台首页、商品列表管理'
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>

          {/* 进入 URL */}
          <div className='space-y-1.5'>
            <Label htmlFor='safe-entry-url'>
              进入页面网址 (URL) <span className='text-status-danger-foreground'>*</span>
            </Label>
            <Input
              id='safe-entry-url'
              type='url'
              placeholder='https://example.com/dashboard'
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
            />
          </div>

          {/* 适用作业类型 */}
          <div className='space-y-2 rounded-lg border border-border-card bg-surface-subtle p-3'>
            <Label className='text-body font-semibold text-text-primary'>适用作业类型</Label>
            <p className='text-caption text-text-muted'>
              指定哪些地图作业允许从该入口进入。
            </p>
            <div className='space-y-2 pt-1'>
              <label className='flex items-start gap-2.5 cursor-pointer text-body'>
                <Checkbox
                  checked={enableProbeRefresh}
                  onCheckedChange={(checked) => setEnableProbeRefresh(Boolean(checked))}
                  className='mt-0.5'
                />
                <div>
                  <span className='font-medium text-text-primary'>定时与手工复查</span>
                  <span className='block text-caption text-text-muted'>
                    适用于日常定时资产测绘（探查、全量刷新）
                  </span>
                </div>
              </label>

              <label className='flex items-start gap-2.5 cursor-pointer text-body'>
                <Checkbox
                  checked={enableExplore}
                  onCheckedChange={(checked) => setEnableExplore(Boolean(checked))}
                  className='mt-0.5'
                />
                <div>
                  <span className='font-medium text-text-primary'>网页受限探索</span>
                  <span className='block text-caption text-text-muted'>
                    允许 AI 探索作业从此入口出发发现新资产
                  </span>
                </div>
              </label>
            </div>
          </div>

          {/* 高级安全与就绪设置 (折叠面板) */}
          <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen} className='border-t border-border-card pt-2'>
            <CollapsibleTrigger asChild>
              <Button
                type='button'
                variant='ghost'
                size='sm'
                className='w-full justify-between px-1 text-caption text-text-muted hover:text-text-primary'
              >
                <span className='flex items-center gap-1.5 font-medium'>
                  <HelpCircle className='size-3.5' />
                  高级设置（页面就绪判定与安全依据）
                </span>
                {advancedOpen ? <ChevronDown className='size-4' /> : <ChevronRight className='size-4' />}
              </Button>
            </CollapsibleTrigger>

            <CollapsibleContent className='space-y-3.5 pt-3'>
              {/* 页面就绪特征文字 */}
              <div className='space-y-1'>
                <Label htmlFor='safe-entry-arrival' className='text-caption font-medium'>
                  页面就绪特征文字 (选填)
                </Label>
                <Input
                  id='safe-entry-arrival'
                  placeholder='页面包含的特征文字（如“设置”、“退出登录”），留空默认页面就绪'
                  value={arrivalName}
                  onChange={(e) => setArrivalName(e.target.value)}
                  className='text-caption'
                />
                <p className='text-[11px] text-text-muted'>
                  若网页加载时间较长或有单页异步渲染，可指定一个可见的文字元素作为到达判定。
                </p>
              </div>

              {/* 安全依据类型 */}
              <div className='space-y-1'>
                <Label htmlFor='safe-entry-basis-kind' className='text-caption font-medium'>
                  安全依据类型
                </Label>
                <SelectField
                  id='safe-entry-basis-kind'
                  value={safetyBasisKind}
                  onValueChange={(val) => setSafetyBasisKind(val as MapSafetyBasisKind)}
                  className='text-caption'
                >
                  {BASIS_KIND_OPTIONS.map((opt) => (
                    <SelectFieldOption key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectFieldOption>
                  ))}
                </SelectField>
              </div>

              {/* 安全依据说明 */}
              <div className='space-y-1'>
                <Label htmlFor='safe-entry-summary' className='text-caption font-medium'>
                  安全依据说明 (选填)
                </Label>
                <Input
                  id='safe-entry-summary'
                  placeholder='例如：只读仪表盘页面，无破坏性操作'
                  value={summary}
                  onChange={(e) => setSummary(e.target.value)}
                  className='text-caption'
                />
              </div>
            </CollapsibleContent>
          </Collapsible>

          <DialogFooter className='pt-2'>
            <Button
              type='button'
              variant='outline'
              onClick={() => onOpenChange(false)}
              disabled={mutation.isPending}
            >
              取消
            </Button>
            <Button
              type='submit'
              disabled={mutation.isPending || !name.trim() || !url.trim() || (!enableProbeRefresh && !enableExplore)}
            >
              {mutation.isPending ? '保存中…' : isEditing ? '保存修改' : '确认新增'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
