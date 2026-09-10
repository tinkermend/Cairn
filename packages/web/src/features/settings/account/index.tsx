import { ContentSection } from '../components/content-section'
import { AccountForm } from './account-form'

export function SettingsAccount() {
  return (
    <ContentSection
      title='Account'
      desc='Change the password for your local console identity.'
    >
      <AccountForm />
    </ContentSection>
  )
}
