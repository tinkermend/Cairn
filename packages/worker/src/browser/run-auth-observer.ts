import type { Page, Response } from 'playwright'
import { matchHttpCondition, pageLooksLikeLogin, redactAuthUrl, resolveVerifyUrl, type AuthSignal, type TargetAuthProfileDefinition } from '@cairn/shared'

/** Only consumes the page's existing navigation/response/DOM; never requests a verify endpoint. */
export function observeRunAuthPage(input: {
  page: Page
  loginUrl?: string | null
  definition?: TargetAuthProfileDefinition
  onSignal: (signal: AuthSignal) => void
}) {
  let disposed = false
  const pending = new Set<Promise<void>>()
  const emit = (kind: AuthSignal['kind'], summary: string) => {
    if (!disposed) input.onSignal({ kind, at: new Date().toISOString(), summary: summary.slice(0, 512) })
  }
  const navigation = () => {
    if (pageLooksLikeLogin({ pageUrl: input.page.url(), loginUrl: input.loginUrl })) {
      emit('navigated_to_login', redactAuthUrl(input.page.url()) ?? '导航到登录页')
    }
  }
  const response = (response: Response) => {
    const definition = input.definition
    if (definition?.verify.mode !== 'http' || response.url() !== resolveVerifyUrl(definition)) return
    const condition = definition.verify.failure
    if ('locator' in condition || (condition.status !== undefined && condition.status !== response.status())) return
    const task = (async () => {
      const body = condition.jsonPath ? await response.json().catch(() => null) : null
      if (matchHttpCondition(response.status(), body, condition)) emit('auth_endpoint_expired', '认证端点响应命中冻结的失效条件')
    })()
    pending.add(task)
    void task.finally(() => pending.delete(task))
  }
  input.page.on('framenavigated', navigation)
  input.page.on('response', response)
  return {
    async inspect() {
      await Promise.all([...pending])
      navigation()
      const failure = input.definition?.verify.failure
      if (input.definition?.verify.mode === 'page' && failure && 'locator' in failure) {
        const locator = failure.locator
        const selector = locator.by === 'id' ? `[id=${JSON.stringify(locator.value)}]`
          : locator.by === 'name' ? `[name=${JSON.stringify(locator.value)}]` : locator.value
        if (await input.page.locator(selector).first().isVisible().catch(() => false)) {
          emit('login_form_visible', '当前页失效定位可见')
        }
      }
    },
    dispose() {
      disposed = true
      input.page.off('framenavigated', navigation)
      input.page.off('response', response)
    },
  }
}
