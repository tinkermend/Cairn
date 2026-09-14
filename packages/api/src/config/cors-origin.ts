/**
 * 控制台 origin 来自 CAIRN_CORS_ORIGINS。
 * 识途录制器 Side Panel 的 Origin 是 chrome-extension://<id>，不能写进环境变量白名单
 * （扩展 ID 随未打包加载变化）。这里单独放行，预检才能带回 Access-Control-Allow-Origin。
 */
export function isAllowedCorsOrigin(
  origin: string | undefined,
  allowed: readonly string[],
): boolean {
  if (!origin) return true
  if (allowed.includes('*') || allowed.includes(origin)) return true
  return origin.startsWith('chrome-extension://')
}
