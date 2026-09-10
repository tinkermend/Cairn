import { ContentSection } from '../components/content-section'
import { ProfileForm } from './profile-form'

export function SettingsProfile() {
  return (
    <ContentSection
      title='个人资料'
      desc='其他控制台用户看到的显示名称。'
    >
      <ProfileForm />
    </ContentSection>
  )
}
