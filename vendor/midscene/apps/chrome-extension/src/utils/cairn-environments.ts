export const CAIRN_ENVIRONMENTS = {
  development: { label: '开发环境', origin: 'http://localhost:5173' },
  testing: { label: '测试环境', origin: null },
  production: { label: '生产环境', origin: null },
} as const;

export type CairnEnvironment = keyof typeof CAIRN_ENVIRONMENTS;

export function isCairnEnvironment(value: string | null): value is CairnEnvironment {
  return value !== null && Object.prototype.hasOwnProperty.call(CAIRN_ENVIRONMENTS, value);
}

export function cairnEnvironmentOrigin(environment: CairnEnvironment): string | null {
  return CAIRN_ENVIRONMENTS[environment].origin;
}
