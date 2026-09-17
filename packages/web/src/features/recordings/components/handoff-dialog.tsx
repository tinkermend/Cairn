import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import { createScenario, fetchScenarios } from '@/lib/scenarios-api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { createBlankStep } from '@/features/authoring'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  recordingId: string
  recordingName: string
  targetId: string
  targetName: string
}

export function RecordingHandoffDialog({
  open,
  onOpenChange,
  recordingId,
  recordingName,
  targetId,
  targetName,
}: Props) {
  const navigate = useNavigate()
  const [activeTab, setActiveTab] = useState<'existing' | 'new'>('existing')
  const [selectedScenarioId, setSelectedScenarioId] = useState<string>('')
  const [newScenarioName, setNewScenarioName] = useState(recordingName)
  const [creating, setCreating] = useState(false)

  // 获取同目标系统下的已有场景
  const scenariosQuery = useQuery({
    queryKey: ['scenarios', { targetId, limit: 100 }],
    queryFn: () => fetchScenarios({ targetId, limit: 100 }),
    enabled: open,
  })

  const scenarios = useMemo(
    () => scenariosQuery.data?.items ?? [],
    [scenariosQuery.data?.items]
  )

  // 默认选中第一个已有场景
  const effectiveScenarioId =
    selectedScenarioId || (scenarios.length > 0 ? scenarios[0].id : '')

  const handleGoExisting = () => {
    if (!effectiveScenarioId) {
      toast.error('请选择一个目标场景')
      return
    }
    onOpenChange(false)
    void navigate({
      to: '/scenarios/$scenarioId',
      params: { scenarioId: effectiveScenarioId },
      search: { import: recordingId },
    })
  }

  const handleCreateAndHandoff = async () => {
    if (!newScenarioName.trim()) {
      toast.error('请输入新场景名称')
      return
    }
    setCreating(true)
    try {
      const created = await createScenario({
        targetId,
        name: newScenarioName.trim(),
        steps: [createBlankStep('navigate')],
      })
      toast.success(`新场景「${created.name}」已创建`)
      onOpenChange(false)
      void navigate({
        to: '/scenarios/$scenarioId',
        params: { scenarioId: created.id },
        search: { import: recordingId },
      })
    } catch (error) {
      toast.error(
        error instanceof ApiRequestError ? error.message : '创建场景失败'
      )
    } finally {
      setCreating(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-md'>
        <DialogHeader>
          <DialogTitle>回填录制草稿到场景</DialogTitle>
          <DialogDescription>
            将操作序列导入至目标系统「{targetName}
            」下的自动化场景，进行结构化编排与调试。
          </DialogDescription>
        </DialogHeader>

        <Tabs
          value={activeTab}
          onValueChange={(val) => setActiveTab(val as 'existing' | 'new')}
          className='w-full'
        >
          <TabsList className='grid w-full grid-cols-2'>
            <TabsTrigger
              value='existing'
              disabled={scenarios.length === 0 && !scenariosQuery.isLoading}
            >
              回填到已有场景{' '}
              {scenarios.length > 0 ? `(${scenarios.length})` : ''}
            </TabsTrigger>
            <TabsTrigger value='new'>以草稿新建场景</TabsTrigger>
          </TabsList>

          {/* Tab 1: 回填到已有场景 */}
          <TabsContent value='existing' className='mt-4 space-y-4'>
            {scenariosQuery.isLoading ? (
              <p className='py-4 text-center text-label text-muted-foreground'>
                正在加载场景列表…
              </p>
            ) : scenarios.length === 0 ? (
              <div className='rounded-md border border-dashed border-border-card p-4 text-center text-label text-muted-foreground'>
                当前目标系统下尚无可用场景，请切换到「以草稿新建场景」创建首个场景。
              </div>
            ) : (
              <div className='space-y-2'>
                <Label htmlFor='scenario-select' className='text-label'>
                  选择目标场景
                </Label>
                <Select
                  value={effectiveScenarioId}
                  onValueChange={setSelectedScenarioId}
                >
                  <SelectTrigger id='scenario-select' className='w-full'>
                    <SelectValue placeholder='请选择场景' />
                  </SelectTrigger>
                  <SelectContent>
                    {scenarios.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name} ({s.stepCount} 步)
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className='text-label text-muted-foreground'>
                  进入场景 Studio
                  后将自动弹出回填向导，您可以逐项确认步骤或替换参数。
                </p>
              </div>
            )}
            <DialogFooter>
              <Button variant='outline' onClick={() => onOpenChange(false)}>
                取消
              </Button>
              <Button
                disabled={!effectiveScenarioId || scenariosQuery.isLoading}
                onClick={handleGoExisting}
              >
                前往回填向导
              </Button>
            </DialogFooter>
          </TabsContent>

          {/* Tab 2: 以草稿新建场景 */}
          <TabsContent value='new' className='mt-4 space-y-4'>
            <div className='space-y-2'>
              <Label htmlFor='new-scenario-name' className='text-label'>
                新场景名称
              </Label>
              <Input
                id='new-scenario-name'
                value={newScenarioName}
                onChange={(e) => setNewScenarioName(e.target.value)}
                placeholder='输入新场景名称'
              />
              <p className='text-label text-muted-foreground'>
                将基于目标系统「{targetName}
                」创建新场景，并在创建后自动打开录制导入面板。
              </p>
            </div>
            <DialogFooter>
              <Button variant='outline' onClick={() => onOpenChange(false)}>
                取消
              </Button>
              <Button
                disabled={!newScenarioName.trim() || creating}
                loading={creating}
                onClick={() => void handleCreateAndHandoff()}
              >
                创建并导入
              </Button>
            </DialogFooter>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
