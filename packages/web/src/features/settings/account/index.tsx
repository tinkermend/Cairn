import { ContentSection } from '../components/content-section'
import { AccountForm } from './account-form'

export function SettingsAccount() {
  return (
    <ContentSection
      title='账号'
      desc='修改本地控制台身份的密码。'
    >
      <AccountForm />
    </ContentSection>
  )
}
