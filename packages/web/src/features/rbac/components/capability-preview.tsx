import { CAPABILITY_GROUP_LABELS, previewCapabilities } from '@cairn/shared'

type CapabilityPreviewProps = {
  permissions: readonly string[]
}

export function CapabilityPreview({ permissions }: CapabilityPreviewProps) {
  const preview = previewCapabilities(permissions)
  return (
    <section className='space-y-3 rounded-md border border-border bg-muted/40 p-3' data-testid='capability-preview'>
      <div>
        <h3 className='text-body font-medium text-muted-foreground'>能力预览</h3>
        <p className='text-label text-muted-foreground'>按当前勾选计算，保存后生效。</p>
      </div>
      <div className='space-y-2'>
        <p className='text-label font-medium text-muted-foreground'>将出现的菜单</p>
        {(Object.keys(CAPABILITY_GROUP_LABELS) as Array<keyof typeof CAPABILITY_GROUP_LABELS>).map(
          (group) => (
            <p key={group} className='text-body text-muted-foreground'>
              {CAPABILITY_GROUP_LABELS[group]}：
              {preview.menus[group].length > 0 ? preview.menus[group].join('、') : '无'}
            </p>
          ),
        )}
      </div>
      <div className='space-y-1'>
        <p className='text-label font-medium text-muted-foreground'>可执行的主操作</p>
        {preview.actions.length > 0 ? (
          <ul className='list-disc space-y-1 ps-5 text-body text-muted-foreground'>
            {preview.actions.map((action) => (
              <li key={action}>{action}</li>
            ))}
          </ul>
        ) : (
          <p className='text-body text-muted-foreground'>无</p>
        )}
      </div>
    </section>
  )
}
