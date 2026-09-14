export type ApiEnvironment = {
  id: string
  label: string
  origin: string
}

/** 登录页始终用下拉选 label；origin 只作次要说明。以后加环境只在这份名单加行。 */
export const CAIRN_API_ENVIRONMENTS = [
  {
    id: 'local',
    label: '本地开发环境',
    origin: 'http://localhost:3030',
  },
] as const satisfies readonly ApiEnvironment[]

export const DEFAULT_ENVIRONMENT_ID = CAIRN_API_ENVIRONMENTS[0].id

export function resolveApiEnvironment(
  id?: string | null,
  environments: readonly ApiEnvironment[] = CAIRN_API_ENVIRONMENTS,
): ApiEnvironment {
  return environments.find((item) => item.id === id) ?? environments[0] ?? CAIRN_API_ENVIRONMENTS[0]
}
