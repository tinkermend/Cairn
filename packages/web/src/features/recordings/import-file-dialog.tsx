import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { parseDemonstrationFile } from '@cairn/authoring'
import {
  DEMONSTRATION_LIMITS,
  type DemonstrationProfile,
  type DemonstrationSource,
  type DemonstrationDetail,
} from '@cairn/shared'
import {
  createDemonstration,
  fetchDemonstration,
  newDemonstrationId,
  uploadDemonstrationImage,
} from '@/lib/demonstrations-api'
import { fetchTargets } from '@/lib/targets-api'
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
import {
  DemonstrationFacts,
  demonstrationProfileLabels,
} from './demonstration-facts'
import {
  DemonstrationImages,
  localSourceImages,
  type LocalSourceImage,
  type ReviewedImage,
} from './demonstration-images'

export function DemonstrationFileDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const targets = useQuery({
    queryKey: ['targets', 'demonstration-import'],
    queryFn: () => fetchTargets({ limit: 100, status: 'active' }),
    enabled: open,
  })
  const [profile, setProfile] = useState<DemonstrationProfile>(
    'midscene-recorder-json@1'
  )
  const [targetId, setTargetId] = useState('')
  const [name, setName] = useState('')
  const [source, setSource] = useState<DemonstrationSource>()
  const [images, setImages] = useState<ReviewedImage[]>([])
  const [embedded, setEmbedded] = useState<LocalSourceImage[]>([])
  const [ack, setAck] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [created, setCreated] = useState<DemonstrationDetail>()
  const key = useRef(newDemonstrationId())
  function resetSource() {
    setSource(undefined)
    setImages([])
    setEmbedded([])
    setCreated(undefined)
    setAck(false)
    setError('')
    key.current = newDemonstrationId()
  }
  async function parse(file?: File) {
    if (!file) return
    resetSource()
    if (file.size > DEMONSTRATION_LIMITS.fileBytes) {
      setError('文件超过 32 MiB')
      return
    }
    if (!targetId) {
      setError('请先选择目标系统')
      return
    }
    const captureId = key.current
    try {
      const text = await file.text()
      if (captureId !== key.current) return
      const next = parseDemonstrationFile({
        text,
        profile,
        targetId,
        captureId,
      })
      setSource(next)
      setEmbedded(localSourceImages(text, next))
      if (!name)
        setName(
          `${demonstrationProfileLabels[profile]} ${new Date().toLocaleDateString()}`
        )
    } catch (e) {
      setError(e instanceof Error ? e.message : '无法识别录制文件')
    }
  }
  async function save() {
    if (!source) return
    setBusy(true)
    setError('')
    try {
      const withImages: DemonstrationSource = {
        ...source,
        assetManifest: images.map((i) => i.manifest),
        facts: source.facts.map((fact) => {
          const next = structuredClone(fact)
          for (const item of images.filter((i) => i.factId === fact.id))
            next[item.phase] = {
              ...next[item.phase],
              screenshotAssetId: item.manifest.clientAssetId,
              reason: '用户附加并检查的来源截图；不据截图补造采集时点',
            }
          return next
        }),
      }
      const detail = created
        ? await fetchDemonstration(created.recordingDraftId)
        : await createDemonstration({
            idempotencyKey: key.current,
            name: name.trim(),
            source: withImages,
            acknowledgedOmittedConfig: ack,
          })
      setCreated(detail)
      for (const item of images) {
        const artifact = detail.artifacts.find(
          (a) => a.clientAssetId === item.manifest.clientAssetId
        )!
        if (artifact.status === 'available') continue
        await uploadDemonstrationImage(
          detail.recordingDraftId,
          artifact.id,
          newDemonstrationId(),
          item.blob
        )
      }
      await queryClient.invalidateQueries({ queryKey: ['recordings'] })
      onOpenChange(false)
      void navigate({
        to: '/recordings/$recordingId',
        params: { recordingId: detail.recordingDraftId },
      })
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : '上传失败。已上传的来源事实会保留，可重试附件。'
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next)
      }}
    >
      <DialogContent className='flex max-h-[90dvh] flex-col sm:max-w-4xl'>
        <DialogHeader>
          <DialogTitle>导入录制文件</DialogTitle>
          <DialogDescription>
            在本地检查并脱敏，将操作转换为可审查的草稿，再回填到场景。
          </DialogDescription>
        </DialogHeader>
        <div className='min-h-0 space-y-4 overflow-y-auto pr-1'>
          <div className='grid gap-4 sm:grid-cols-2'>
            <div className='space-y-2'>
              <Label>目标系统</Label>
              <Select
                value={targetId}
                disabled={busy || Boolean(created)}
                onValueChange={(id) => {
                  setTargetId(id)
                  resetSource()
                }}
              >
                <SelectTrigger className='w-full' aria-label='导入目标系统'>
                  <SelectValue placeholder='选择目标系统' />
                </SelectTrigger>
                <SelectContent>
                  {targets.data?.items.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {targets.isError && (
                <p role='alert' className='text-label text-destructive'>
                  无法加载目标系统{' '}
                  <button onClick={() => void targets.refetch()}>重试</button>
                </p>
              )}
            </div>
            <div className='space-y-2'>
              <Label>来源格式</Label>
              <Select
                value={profile}
                disabled={busy || Boolean(created)}
                onValueChange={(p) => {
                  setProfile(p as DemonstrationProfile)
                  resetSource()
                }}
              >
                <SelectTrigger className='w-full' aria-label='来源格式'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(demonstrationProfileLabels).map(
                    ([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    )
                  )}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className='space-y-2'>
            <Label htmlFor='demonstration-file'>
              录制文件（JSON、JSONL 或 YAML）
            </Label>
            <Input
              id='demonstration-file'
              type='file'
              accept='.json,.jsonl,.yaml,.yml'
              disabled={!targetId || busy || Boolean(created)}
              onChange={(e) => void parse(e.target.files?.[0])}
            />
            <p className='text-label text-muted-foreground'>
              最多 200 条操作、32 MiB。不支持 JS/TS
              代码、执行报告和缓存文件；内嵌截图默认不上传。
            </p>
          </div>
          <div className='space-y-2'>
            <Label htmlFor='demonstration-name'>草稿名称</Label>
            <Input
              id='demonstration-name'
              value={name}
              maxLength={128}
              disabled={busy || Boolean(created)}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          {source && (
            <>
              <DemonstrationFacts source={source} />
              {!created && (
                <fieldset disabled={busy}>
                  <DemonstrationImages
                    key={source.captureId}
                    source={source}
                    images={images}
                    onChange={setImages}
                    embedded={embedded}
                  />
                </fieldset>
              )}
              {source.omittedConfig.length > 0 && (
                <div className='rounded border border-border-divider p-3 text-label'>
                  <p>以下配置不会导入：{source.omittedConfig.join('、')}</p>
                  <label className='mt-2 flex gap-2'>
                    <input
                      type='checkbox'
                      checked={ack}
                      disabled={busy || Boolean(created)}
                      onChange={(e) => setAck(e.target.checked)}
                    />
                    我已了解，账号认证与运行策略将使用平台配置。
                  </label>
                </div>
              )}
            </>
          )}
          {error && (
            <p role='alert' className='text-body text-destructive'>
              {error}
            </p>
          )}
          {created && (
            <p className='text-label'>
              来源事实已保存。可重试截图上传，或先打开草稿处理步骤。
            </p>
          )}
        </div>
        <DialogFooter>
          <Button
            variant='outline'
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            关闭
          </Button>
          {created && (
            <Button
              variant='outline'
              disabled={busy}
              onClick={() => {
                onOpenChange(false)
                void navigate({
                  to: '/recordings/$recordingId',
                  params: { recordingId: created.recordingDraftId },
                })
              }}
            >
              打开已保存草稿
            </Button>
          )}
          <Button
            disabled={
              !source ||
              !name.trim() ||
              busy ||
              Boolean(source?.omittedConfig.length && !ack)
            }
            loading={busy}
            onClick={() => void save()}
          >
            {created ? '重试附件上传' : '保存录制草稿'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
