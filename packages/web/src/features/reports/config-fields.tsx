import { useId, useState } from 'react'
import { type ReportConfig } from '@cairn/shared'
import { toast } from 'sonner'
import { uploadReportLogo } from '@/lib/reports-api'
import { useCan } from '@/hooks/use-permissions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

export function ReportConfigFields({
  config,
  onChange,
  targetId,
  editScope,
  screenshots,
  profile = false,
}: {
  config: ReportConfig
  onChange: (value: ReportConfig) => void
  targetId: string
  editScope: 'scenario' | 'suite'
  screenshots?: Array<{ evidenceId: string; caption: string; status: string }>
  profile?: boolean
}) {
  const id = useId(),
    canUpload = useCan(editScope === 'suite' ? 'suite:write' : 'workflow:write')
  const [uploading, setUploading] = useState(false),
    [page, setPage] = useState(0)
  const patch = (value: Partial<ReportConfig>) =>
    onChange({ ...config, ...value })
  return (
    <div className='grid min-w-0 gap-4'>
      <div className='grid gap-3 sm:grid-cols-2'>
        {(
          ['subtitle', 'organization', 'authorDisplayName', 'timeZone'] as const
        ).map((field) => (
          <div key={field} className='grid gap-2'>
            <Label htmlFor={`${id}-${field}`}>
              {
                {
                  subtitle: '副标题',
                  organization: '组织',
                  authorDisplayName: '作者',
                  timeZone: '时区',
                }[field]
              }
            </Label>
            <Input
              id={`${id}-${field}`}
              maxLength={
                field === 'subtitle' ? 200 : field === 'organization' ? 128 : 64
              }
              value={config[field] ?? ''}
              onChange={(event) => patch({ [field]: event.target.value })}
            />
          </div>
        ))}
        <div className='grid gap-2'>
          <Label>报告详略</Label>
          <Select
            value={config.detailLevel}
            onValueChange={(value) =>
              patch({ detailLevel: value as ReportConfig['detailLevel'] })
            }
          >
            <SelectTrigger aria-label='报告详略'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='detailed'>详细结果</SelectItem>
              <SelectItem value='summary'>摘要与成员结论</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className='grid gap-2'>
          <Label>截图范围</Label>
          <Select
            value={config.screenshotScope}
            onValueChange={(value) =>
              patch({
                screenshotScope: value as ReportConfig['screenshotScope'],
              })
            }
          >
            <SelectTrigger aria-label='截图范围'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='anomalies'>异常步骤截图</SelectItem>
              <SelectItem value='none'>不嵌入截图</SelectItem>
              {!profile && (
                <SelectItem value='selected'>手动选择截图</SelectItem>
              )}
            </SelectContent>
          </Select>
        </div>
      </div>
      <label className='flex items-center gap-2 text-body'>
        <input
          type='checkbox'
          checked={config.includeSuccessDetails}
          onChange={(event) =>
            patch({ includeSuccessDetails: event.target.checked })
          }
        />
        展示成功步骤详情
      </label>
      <fieldset className='grid gap-2 rounded-md border p-3'>
        <legend className='px-1 text-label'>可选章节</legend>
        {([
          ['includeEvidenceIndex', '完整证据索引'],
          ['includeAttemptHistory', '成功步骤的尝试历史'],
        ] as const).map(([field, label]) => (
          <label key={field} className='flex items-center gap-2 text-body'>
            <input
              type='checkbox'
              checked={config[field] !== false}
              onChange={(event) => patch({ [field]: event.target.checked })}
            />
            {label}
          </label>
        ))}
        <p className='text-label text-muted-foreground'>
          执行范围、异常结果、失败尝试和缺项说明始终保留。
        </p>
      </fieldset>
      <div className='grid gap-2'>
        <Label htmlFor={`${id}-logo`}>报告 Logo</Label>
        {canUpload && (
          <Input
            id={`${id}-logo`}
            type='file'
            accept='image/png,image/jpeg'
            disabled={uploading}
            onChange={async (event) => {
              const file = event.target.files?.[0]
              if (!file) return
              if (
                file.size > 2 * 1024 * 1024 ||
                !['image/png', 'image/jpeg'].includes(file.type)
              ) {
                toast.error('请选择 2 MiB 内的 PNG 或 JPEG')
                return
              }
              setUploading(true)
              try {
                const base64 = await new Promise<string>((resolve, reject) => {
                  const reader = new FileReader()
                  reader.onload = () =>
                    resolve(String(reader.result).split(',')[1]!)
                  reader.onerror = reject
                  reader.readAsDataURL(file)
                })
                const uploaded = await uploadReportLogo({
                  targetId,
                  editScope,
                  fileName: file.name,
                  contentType: file.type as 'image/png' | 'image/jpeg',
                  base64,
                })
                patch({ logoArtifactId: uploaded.artifactId })
                toast.success('Logo 已上传')
              } catch (error) {
                toast.error(error instanceof Error ? error.message : '上传失败')
              } finally {
                setUploading(false)
              }
            }}
          />
        )}
        <p className='text-label text-muted-foreground'>
          {uploading
            ? '正在上传…'
            : config.logoArtifactId
              ? '已选择 Logo，将随报告封存。'
              : '未选择 Logo。'}{' '}
          {!canUpload
            ? '可使用默认配置中的 Logo。'
            : 'PNG / JPEG，最大 2 MiB。'}
        </p>
        {config.logoArtifactId && (
          <Button
            className='justify-self-start'
            variant='ghost'
            size='sm'
            onClick={() => patch({ logoArtifactId: null })}
          >
            移除 Logo
          </Button>
        )}
      </div>
      {config.screenshotScope === 'selected' && !profile && (
        <fieldset className='grid gap-2 rounded-md border p-3'>
          <legend className='px-1 text-label'>
            已选 {config.selectedEvidenceIds?.length ?? 0} / 200 张
          </legend>
          {(screenshots ?? []).slice(page * 20, page * 20 + 20).map((image) => (
            <label
              key={image.evidenceId}
              className='flex min-w-0 items-start gap-2 text-label'
            >
              <input
                type='checkbox'
                checked={
                  config.selectedEvidenceIds?.includes(image.evidenceId) ??
                  false
                }
                onChange={(event) => {
                  const ids = config.selectedEvidenceIds ?? []
                  if (event.target.checked && ids.length >= 200) {
                    toast.error('最多选择 200 张截图')
                    return
                  }
                  patch({
                    selectedEvidenceIds: event.target.checked
                      ? [...ids, image.evidenceId]
                      : ids.filter((item) => item !== image.evidenceId),
                  })
                }}
              />
              <span className='break-words'>
                {image.caption} ·{' '}
                {image.status === 'available' ? '可用' : '不可用，将列为缺项'}
                <span className='block text-small text-muted-foreground'>
                  {image.evidenceId}
                </span>
              </span>
            </label>
          ))}
          {!screenshots?.length && (
            <p className='text-label text-muted-foreground'>
              当前来源没有截图。
            </p>
          )}
          {(screenshots?.length ?? 0) > 20 && (
            <div className='flex gap-2'>
              <Button
                variant='outline'
                size='sm'
                disabled={!page}
                onClick={() => setPage(page - 1)}
              >
                上一页截图
              </Button>
              <Button
                variant='outline'
                size='sm'
                disabled={(page + 1) * 20 >= screenshots!.length}
                onClick={() => setPage(page + 1)}
              >
                下一页截图
              </Button>
            </div>
          )}
        </fieldset>
      )}
    </div>
  )
}
