import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Page } from 'playwright'

export type FailureArtifactOptions = {
  testName: string
  page?: Page | null
  error?: Error | unknown
  context?: Record<string, unknown>
  outputDir?: string
}

export type FailureArtifactResult = {
  artifactDir: string
  domPath?: string
  screenshotPath?: string
  contextPath?: string
  errorPath?: string
}

/**
 * 递归脱敏凭据信息，防止密码、Token、密钥落盘明文泄漏（违反宪法第 15、18、19 条）
 */
export function sanitizeContext(data: unknown): unknown {
  if (data === null || data === undefined) return data
  if (typeof data === 'string') {
    // 粗粒度检测 token 或密码类字符串
    if (/password|secret|bearer|token/i.test(data) && data.length > 20) {
      return `${data.slice(0, 4)}***${data.slice(-4)}`
    }
    return data
  }
  if (Array.isArray(data)) {
    return data.map((item) => sanitizeContext(item))
  }
  if (typeof data === 'object') {
    const sanitized: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (/password|secret|token|credential|ciphertext|key/i.test(key)) {
        sanitized[key] = '***REDACTED***'
      } else {
        sanitized[key] = sanitizeContext(value)
      }
    }
    return sanitized
  }
  return data
}

/**
 * 测试失败时自动捕获现场信息：
 * 1. DOM HTML 快照；
 * 2. 页面全景截图（PNG）；
 * 3. 脱敏后的上下文（context.json）；
 * 4. 堆栈日志（error.log）；
 * 5. 输出绝对路径便于 AI/用户定位。
 */
export async function dumpTestFailureArtifacts(options: FailureArtifactOptions): Promise<FailureArtifactResult> {
  const safeName = options.testName.replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '_').slice(0, 60)
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dirName = `${safeName}-${timestamp}`
  const baseDir = options.outputDir ?? resolve(process.cwd(), '.artifacts/test-failures')
  const artifactDir = join(baseDir, dirName)

  await mkdir(artifactDir, { recursive: true })

  const result: FailureArtifactResult = { artifactDir }

  // 1. 抓取 DOM 与截图
  if (options.page && !options.page.isClosed()) {
    try {
      const html = await options.page.content()
      const domPath = join(artifactDir, 'dom-snapshot.html')
      await writeFile(domPath, html, 'utf8')
      result.domPath = domPath
    } catch {
      // 忽略因页面被销毁导致无法取 DOM
    }

    try {
      const screenshotPath = join(artifactDir, 'screenshot.png')
      await options.page.screenshot({ path: screenshotPath, fullPage: true })
      result.screenshotPath = screenshotPath
    } catch {
      // 忽略因页面上下文关闭等截图失败
    }
  }

  // 2. 写入脱敏后的执行上下文
  if (options.context) {
    try {
      const contextPath = join(artifactDir, 'context.json')
      const sanitized = sanitizeContext(options.context)
      await writeFile(contextPath, JSON.stringify(sanitized, null, 2), 'utf8')
      result.contextPath = contextPath
    } catch {
      // 忽略序列化失败
    }
  }

  // 3. 写入错误详情
  if (options.error) {
    try {
      const errorPath = join(artifactDir, 'error.log')
      const err = options.error as Error
      const errorContent = `Name: ${err.name ?? 'Error'}\nMessage: ${err.message ?? String(options.error)}\nStack:\n${err.stack ?? 'N/A'}\n`
      await writeFile(errorPath, errorContent, 'utf8')
      result.errorPath = errorPath
    } catch {
      // 忽略日志写入失败
    }
  }

  console.error(`\n[CAIRN-TEST-FAILURE] 现场快照工件已保存至: file://${artifactDir}\n`)
  return result
}
