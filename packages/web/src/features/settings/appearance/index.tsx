import { ContentSection } from '../components/content-section'

export function SettingsAppearance() {
  return (
    <ContentSection title='外观' desc='控制台固定为已设计的浅色主题。'>
      <p className='text-body leading-6 text-muted-foreground'>
        使用系统字体栈。Inter 与 Manrope 仅作本地回退，不会从 CDN 加载。
      </p>
    </ContentSection>
  )
}
