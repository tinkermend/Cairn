import type {
  PlatformConfigDocument,
  ScenarioAuthoringDocumentV2,
  TargetResolutionPolicy,
} from '@cairn/shared'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ScenarioLocatorSettings } from './scenario-locator-settings'
import { ScenarioReportSettings } from '@/features/reports/profiles'
import { FileText, Layers, Settings, Sliders } from 'lucide-react'

export interface ScenarioSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  scenarioId: string
  targetId: string
  document: ScenarioAuthoringDocumentV2
  platform?: PlatformConfigDocument
  target?: TargetResolutionPolicy | null
  disabled?: boolean
  onChange: (document: ScenarioAuthoringDocumentV2) => void
}

export function ScenarioSettingsDialog({
  open,
  onOpenChange,
  scenarioId,
  targetId,
  document,
  platform,
  target,
  disabled,
  onChange,
}: ScenarioSettingsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-2xl'>
        <DialogHeader>
          <div className='flex items-center gap-2'>
            <div className='flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary'>
              <Settings className='size-4' />
            </div>
            <div>
              <DialogTitle>场景配置</DialogTitle>
              <DialogDescription className='mt-0.5 text-label'>
                管理本场景全局运行策略、页面元素定位基线与运行报告配置。
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className='py-1'>
          <Tabs defaultValue='locator' className='w-full'>
            <TabsList className='w-full justify-start border-b mb-3'>
              <TabsTrigger value='locator' className='gap-1.5'>
                <Sliders className='size-3.5' />
                <span>定位策略</span>
              </TabsTrigger>
              <TabsTrigger value='report' className='gap-1.5'>
                <FileText className='size-3.5' />
                <span>报告配置</span>
              </TabsTrigger>
            </TabsList>

            <TabsContent value='locator' className='space-y-4 max-h-[60vh] overflow-y-auto pr-1'>
              <ScenarioLocatorSettings
                document={document}
                platform={platform}
                target={target}
                disabled={disabled}
                onChange={onChange}
              />

              <div className='rounded-lg bg-surface-subtle p-3 text-label text-muted-foreground border border-border-divider/60 space-y-1.5'>
                <div className='flex items-center gap-1.5 font-medium text-foreground'>
                  <Layers className='size-3.5 text-muted-foreground' />
                  <span>四级继承机制</span>
                </div>
                <p>
                  定位顺序生效优先级为：<span className='font-medium text-foreground'>步骤覆盖 &gt; 场景默认（本处） &gt; 目标系统 &gt; 平台</span>。
                </p>
                <p>
                  此处设置作为场景级缺省值，未显式定制定位顺序的普通步骤将继承此规则；步骤亦可在其高级属性中单独定制。
                </p>
              </div>
            </TabsContent>

            <TabsContent value='report' className='space-y-4 max-h-[60vh] overflow-y-auto pr-1'>
              <ScenarioReportSettings
                scenarioId={scenarioId}
                targetId={targetId}
              />
            </TabsContent>
          </Tabs>
        </div>

        <DialogFooter>
          <Button type='button' onClick={() => onOpenChange(false)}>
            完成
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
