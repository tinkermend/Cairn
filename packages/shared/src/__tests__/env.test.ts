import { describe, expect, it } from 'vitest'
import {
  DEV_CREDENTIAL_KEY,
  DEV_JWT_SECRET,
  apiEnvSchema,
  dbEnvSchema,
  decodeCredentialKey,
  formatEnvIssues,
  parseDurationSeconds,
  workerEnvSchema,
} from '../env.js'

const base = {
  CAIRN_DB_HOST: 'db.example',
  CAIRN_DB_NAME: 'cairn',
  CAIRN_DB_USER: 'cairn',
  CAIRN_DB_PASSWORD: 'secret',
}

describe('dbEnvSchema', () => {
  it('把字符串端口强制为数字', () => {
    expect(dbEnvSchema.parse({ ...base, CAIRN_DB_PORT: '5432' }).CAIRN_DB_PORT).toBe(5432)
  })

  it('端口与 schema 有默认值', () => {
    const env = dbEnvSchema.parse(base)
    expect(env.CAIRN_DB_PORT).toBe(5432)
    expect(env.CAIRN_DB_SCHEMA).toBe('cairn')
  })

  it('缺少必填项时抛错', () => {
    expect(() => dbEnvSchema.parse({ ...base, CAIRN_DB_PASSWORD: '' })).toThrow()
  })
})

describe('apiEnvSchema', () => {
  it('JWT 与 bootstrap 有本地默认值', () => {
    const env = apiEnvSchema.parse({})
    expect(env.CAIRN_BOOTSTRAP_ADMIN_EMAIL).toBe('admin')
    expect(env.CAIRN_BOOTSTRAP_ADMIN_PASSWORD).toBe('cairn-admin')
    expect(env.CAIRN_JWT_SECRET.length).toBeGreaterThanOrEqual(16)
  })

  it('端口、CORS、环境与日志级别有默认值', () => {
    const env = apiEnvSchema.parse({})
    expect(env.CAIRN_API_PORT).toBe(3030)
    expect(env.CAIRN_CORS_ORIGINS).toEqual(['http://localhost:5173'])
    expect(env.CAIRN_ENV).toBe('development')
    expect(env.CAIRN_LOG_LEVEL).toBe('info')
  })

  it('字符串端口被强制为数字', () => {
    expect(apiEnvSchema.parse({ CAIRN_API_PORT: '8080' }).CAIRN_API_PORT).toBe(8080)
  })

  it('非法端口被拒绝', () => {
    expect(() => apiEnvSchema.parse({ CAIRN_API_PORT: 'not-a-port' })).toThrow()
    expect(() => apiEnvSchema.parse({ CAIRN_API_PORT: '0' })).toThrow()
    expect(() => apiEnvSchema.parse({ CAIRN_API_PORT: '70000' })).toThrow()
  })

  it('空串按未设置处理，回落默认值', () => {
    // dotenv 无法表达「未设置」，占位写法就是 KEY=
    const env = apiEnvSchema.parse({ CAIRN_API_PORT: '', CAIRN_LOG_LEVEL: '', CAIRN_CORS_ORIGINS: '' })
    expect(env.CAIRN_API_PORT).toBe(3030)
    expect(env.CAIRN_LOG_LEVEL).toBe('info')
    expect(env.CAIRN_CORS_ORIGINS).toEqual(['http://localhost:5173'])
  })

  it('CORS 白名单在 schema 里就拆成数组，两端空白被吃掉', () => {
    const env = apiEnvSchema.parse({
      CAIRN_CORS_ORIGINS: 'http://localhost:5173, https://cairn.example.com:8443 ',
    })
    expect(env.CAIRN_CORS_ORIGINS).toEqual([
      'http://localhost:5173',
      'https://cairn.example.com:8443',
    ])
  })

  it('拆不出任何 origin 的取值被拒绝——启动成功却全站被拒是最难查的形态', () => {
    // 「非空字符串」能放过它，但拆出来是空白名单
    expect(() => apiEnvSchema.parse({ CAIRN_CORS_ORIGINS: ',' })).toThrow()
    expect(() => apiEnvSchema.parse({ CAIRN_CORS_ORIGINS: ' , , ' })).toThrow()
  })

  it('漏写 scheme 的 origin 被拒绝——浏览器发出的 Origin 永远带 scheme', () => {
    expect(() => apiEnvSchema.parse({ CAIRN_CORS_ORIGINS: 'localhost:5173' })).toThrow()
    expect(() =>
      apiEnvSchema.parse({ CAIRN_CORS_ORIGINS: 'http://localhost:5173,example.com' }),
    ).toThrow()
  })

  it('通配符仍可显式配置', () => {
    expect(apiEnvSchema.parse({ CAIRN_CORS_ORIGINS: '*' }).CAIRN_CORS_ORIGINS).toEqual(['*'])
  })

  it('非法日志级别与非法环境被拒绝', () => {
    expect(() => apiEnvSchema.parse({ CAIRN_LOG_LEVEL: 'verbose' })).toThrow()
    expect(() => apiEnvSchema.parse({ CAIRN_ENV: 'prod' })).toThrow()
  })

  it('development 允许沿用开发默认密钥', () => {
    expect(apiEnvSchema.parse({ CAIRN_ENV: 'development' }).CAIRN_JWT_SECRET).toBe(DEV_JWT_SECRET)
  })

  it('非 development 沿用默认 JWT 密钥时拒绝启动', () => {
    const result = apiEnvSchema.safeParse({
      CAIRN_ENV: 'production',
      CAIRN_BOOTSTRAP_ADMIN_PASSWORD: 'a-real-password',
    })
    expect(result.success).toBe(false)
    expect(result.error?.issues.map((i) => i.path.join('.'))).toContain('CAIRN_JWT_SECRET')
  })

  it('非 development 沿用默认管理员口令时拒绝启动', () => {
    const result = apiEnvSchema.safeParse({
      CAIRN_ENV: 'staging',
      CAIRN_JWT_SECRET: 'a-real-secret-value-over-16',
    })
    expect(result.success).toBe(false)
    expect(result.error?.issues.map((i) => i.path.join('.'))).toContain(
      'CAIRN_BOOTSTRAP_ADMIN_PASSWORD',
    )
  })

  it('凭据主密钥默认值解码为 32 字节', () => {
    const bytes = decodeCredentialKey(DEV_CREDENTIAL_KEY)
    expect(bytes?.byteLength).toBe(32)
    expect(apiEnvSchema.parse({}).CAIRN_CREDENTIAL_KEY).toBe(DEV_CREDENTIAL_KEY)
  })

  it('非法 base64 或非 32 字节的凭据主密钥被拒绝', () => {
    expect(() => apiEnvSchema.parse({ CAIRN_CREDENTIAL_KEY: 'not-base64!!!' })).toThrow()
    expect(() => apiEnvSchema.parse({ CAIRN_CREDENTIAL_KEY: 'dG9vLXNob3J0' })).toThrow()
  })

  it('非 development 覆盖三项后放行', () => {
    const env = apiEnvSchema.parse({
      CAIRN_ENV: 'production',
      CAIRN_JWT_SECRET: 'a-real-secret-value-over-16',
      CAIRN_BOOTSTRAP_ADMIN_PASSWORD: 'a-real-password',
      CAIRN_CREDENTIAL_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      CAIRN_OBJECT_STORE_DIR: '/var/cairn/objects',
    })
    expect(env.CAIRN_ENV).toBe('production')
    expect(env.CAIRN_OBJECT_STORE).toBe('local')
  })

  it('非 development 的本地对象目录必须是绝对路径', () => {
    const result = apiEnvSchema.safeParse({
      CAIRN_ENV: 'production',
      CAIRN_JWT_SECRET: 'a-real-secret-value-over-16',
      CAIRN_BOOTSTRAP_ADMIN_PASSWORD: 'a-real-password',
      CAIRN_CREDENTIAL_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      CAIRN_OBJECT_STORE: 'local',
      CAIRN_OBJECT_STORE_DIR: '.data/object-store',
    })
    expect(result.success).toBe(false)
    expect(result.error?.issues.map((i) => i.path.join('.'))).toContain('CAIRN_OBJECT_STORE_DIR')
  })

  it('非 development 沿用默认凭据主密钥时拒绝启动', () => {
    const result = apiEnvSchema.safeParse({
      CAIRN_ENV: 'production',
      CAIRN_JWT_SECRET: 'a-real-secret-value-over-16',
      CAIRN_BOOTSTRAP_ADMIN_PASSWORD: 'a-real-password',
    })
    expect(result.success).toBe(false)
    expect(result.error?.issues.map((i) => i.path.join('.'))).toContain('CAIRN_CREDENTIAL_KEY')
  })

  it('空着的 JWT 密钥在非 development 下同样被拒绝', () => {
    expect(() => apiEnvSchema.parse({ CAIRN_ENV: 'production', CAIRN_JWT_SECRET: '' })).toThrow()
  })
})

describe('workerEnvSchema', () => {
  it('workerId、环境与日志级别有默认值', () => {
    const env = workerEnvSchema.parse({})
    expect(env.CAIRN_WORKER_ID).toBe('local-worker')
    expect(env.CAIRN_ENV).toBe('development')
    expect(env.CAIRN_LOG_LEVEL).toBe('info')
  })

  it('空 workerId 回落默认值而非启动失败', () => {
    expect(workerEnvSchema.parse({ CAIRN_WORKER_ID: '' }).CAIRN_WORKER_ID).toBe('local-worker')
  })

  it('显式 workerId 被采纳', () => {
    expect(workerEnvSchema.parse({ CAIRN_WORKER_ID: 'worker-3' }).CAIRN_WORKER_ID).toBe('worker-3')
  })

  it('非法日志级别被拒绝', () => {
    expect(() => workerEnvSchema.parse({ CAIRN_LOG_LEVEL: 'loud' })).toThrow()
  })

  it('对象存储默认走本地，并忽略未配的 S3 变量', () => {
    const env = workerEnvSchema.parse({
      CAIRN_S3_BUCKET: '',
      CAIRN_S3_ACCESS_KEY: '',
      CAIRN_S3_SECRET_KEY: '',
    })
    expect(env.CAIRN_OBJECT_STORE).toBe('local')
    expect(env.CAIRN_OBJECT_STORE_DIR).toBe('.data/object-store')
    expect(env.CAIRN_OBJECT_MAX_BYTES).toBe(33_554_432)
    expect(env.CAIRN_TRACE_MAX_BYTES).toBe(134_217_728)
    expect(env.CAIRN_EVIDENCE_UPLOAD_MAX_ATTEMPTS).toBe(3)
    expect(env.CAIRN_OBJECT_RETAIN_DAYS).toBe(30)
    expect(env.CAIRN_S3_FORCE_PATH_STYLE).toBe(false)
    expect(env.CAIRN_S3_BUCKET).toBeUndefined()
  })

  it('有 S3 endpoint 时默认走 path-style', () => {
    const env = workerEnvSchema.parse({ CAIRN_S3_ENDPOINT: 'http://127.0.0.1:9000' })
    expect(env.CAIRN_S3_FORCE_PATH_STYLE).toBe(true)
  })

  it('s3 驱动缺桶或密钥时拒绝启动', () => {
    const missingBucket = workerEnvSchema.safeParse({ CAIRN_OBJECT_STORE: 's3' })
    expect(missingBucket.success).toBe(false)
    expect(missingBucket.error?.issues.map((i) => i.path.join('.'))).toEqual(
      expect.arrayContaining(['CAIRN_S3_BUCKET', 'CAIRN_S3_ACCESS_KEY', 'CAIRN_S3_SECRET_KEY']),
    )

    const ok = workerEnvSchema.parse({
      CAIRN_OBJECT_STORE: 's3',
      CAIRN_S3_BUCKET: 'cairn-evidence',
      CAIRN_S3_ACCESS_KEY: 'key',
      CAIRN_S3_SECRET_KEY: 'secret',
    })
    expect(ok.CAIRN_S3_BUCKET).toBe('cairn-evidence')
  })

  it('非 development 的本地目录必须是绝对路径', () => {
    const relative = workerEnvSchema.safeParse({
      CAIRN_ENV: 'production',
      CAIRN_OBJECT_STORE: 'local',
      CAIRN_OBJECT_STORE_DIR: '.data/object-store',
    })
    expect(relative.success).toBe(false)
    expect(relative.error?.issues.map((i) => i.path.join('.'))).toContain('CAIRN_OBJECT_STORE_DIR')

    const absolute = workerEnvSchema.parse({
      CAIRN_ENV: 'production',
      CAIRN_OBJECT_STORE: 'local',
      CAIRN_OBJECT_STORE_DIR: '/var/cairn/objects',
      CAIRN_BROWSER_PROFILE_DIR: '/var/cairn/profiles',
      CAIRN_CREDENTIAL_KEY: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=',
    })
    expect(absolute.CAIRN_OBJECT_STORE_DIR).toBe('/var/cairn/objects')
  })

  it('s3 缺密钥时 formatEnvIssues 只含变量名', () => {
    const secret = 'should-not-appear-in-issues'
    const result = workerEnvSchema.safeParse({
      CAIRN_OBJECT_STORE: 's3',
      CAIRN_S3_ACCESS_KEY: secret,
    })
    expect(result.success).toBe(false)
    const lines = formatEnvIssues(result.error!)
    expect(lines.some((line) => line.includes('CAIRN_S3_BUCKET'))).toBe(true)
    expect(lines.some((line) => line.includes('CAIRN_S3_SECRET_KEY'))).toBe(true)
    for (const line of lines) expect(line).not.toContain(secret)
  })

  it('浏览器会话有默认值', () => {
    const env = workerEnvSchema.parse({})
    expect(env.CAIRN_BROWSER_HEADLESS).toBe(true)
    expect(env.CAIRN_BROWSER_PROFILE_DIR).toBe('.data/browser-profiles')
    expect(env.CAIRN_BROWSER_MAX_SESSIONS).toBe(2)
    expect(env.CAIRN_SESSION_IDLE_TTL_SECONDS).toBe(600)
    expect(env.CAIRN_SESSION_MAX_LIFETIME_SECONDS).toBe(14_400)
    expect(env.CAIRN_SESSION_LEASE_TTL_SECONDS).toBe(30)
    expect(env.CAIRN_SESSION_HEARTBEAT_MS).toBe(5_000)
    expect(env.CAIRN_SESSION_REAPER_INTERVAL_MS).toBe(15_000)
    expect(env.CAIRN_SESSION_AUTH_WAIT_SECONDS).toBe(300)
    expect(env.CAIRN_CREDENTIAL_KEY).toBe(DEV_CREDENTIAL_KEY)
  })

  it('非 development 不得沿用开发凭据密钥', () => {
    const result = workerEnvSchema.safeParse({
      CAIRN_ENV: 'production',
      CAIRN_OBJECT_STORE: 'local',
      CAIRN_OBJECT_STORE_DIR: '/var/cairn/objects',
      CAIRN_BROWSER_PROFILE_DIR: '/var/cairn/profiles',
    })
    expect(result.success).toBe(false)
    expect(result.error?.issues.map((i) => i.path.join('.'))).toContain('CAIRN_CREDENTIAL_KEY')
  })

  it('LEASE_TTL < 3×HEARTBEAT 时拒绝启动', () => {
    const result = workerEnvSchema.safeParse({
      CAIRN_SESSION_LEASE_TTL_SECONDS: '10',
      CAIRN_SESSION_HEARTBEAT_MS: '5000',
    })
    expect(result.success).toBe(false)
    expect(result.error?.issues.map((i) => i.path.join('.'))).toContain(
      'CAIRN_SESSION_LEASE_TTL_SECONDS',
    )
  })

  it('RunLease TTL < 3×Worker 心跳时拒绝启动', () => {
    const result = workerEnvSchema.safeParse({
      CAIRN_RUN_LEASE_TTL_SECONDS: '10',
      CAIRN_WORKER_HEARTBEAT_MS: '5000',
    })
    expect(result.success).toBe(false)
    expect(result.error?.issues.map((i) => i.path.join('.'))).toContain('CAIRN_RUN_LEASE_TTL_SECONDS')
  })

  it('WORKER_LOST_AFTER ≤ RunLease TTL 时拒绝启动', () => {
    const result = workerEnvSchema.safeParse({
      CAIRN_RUN_LEASE_TTL_SECONDS: '30',
      CAIRN_WORKER_LOST_AFTER_SECONDS: '30',
    })
    expect(result.success).toBe(false)
    expect(result.error?.issues.map((i) => i.path.join('.'))).toContain(
      'CAIRN_WORKER_LOST_AFTER_SECONDS',
    )
  })

  it('RunLease 相关默认值', () => {
    const env = workerEnvSchema.parse({})
    expect(env.CAIRN_WORKER_CAPACITY).toBe(1)
    expect(env.CAIRN_WORKER_HEARTBEAT_MS).toBe(5_000)
    expect(env.CAIRN_RUN_LEASE_TTL_SECONDS).toBe(30)
    expect(env.CAIRN_WORKER_LOST_AFTER_SECONDS).toBe(45)
    expect(env.CAIRN_RUN_MAX_RECOVERIES).toBe(3)
  })

  it('MAX_LIFETIME ≤ IDLE_TTL 时拒绝启动', () => {
    const result = workerEnvSchema.safeParse({
      CAIRN_SESSION_IDLE_TTL_SECONDS: '600',
      CAIRN_SESSION_MAX_LIFETIME_SECONDS: '600',
    })
    expect(result.success).toBe(false)
    expect(result.error?.issues.map((i) => i.path.join('.'))).toContain(
      'CAIRN_SESSION_MAX_LIFETIME_SECONDS',
    )
  })

  it('非 development 的 profile 目录必须是绝对路径', () => {
    const relative = workerEnvSchema.safeParse({
      CAIRN_ENV: 'production',
      CAIRN_OBJECT_STORE: 'local',
      CAIRN_OBJECT_STORE_DIR: '/var/cairn/objects',
      CAIRN_BROWSER_PROFILE_DIR: '.data/browser-profiles',
      CAIRN_CREDENTIAL_KEY: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=',
    })
    expect(relative.success).toBe(false)
    expect(relative.error?.issues.map((i) => i.path.join('.'))).toContain(
      'CAIRN_BROWSER_PROFILE_DIR',
    )

    const absolute = workerEnvSchema.parse({
      CAIRN_ENV: 'production',
      CAIRN_OBJECT_STORE: 'local',
      CAIRN_OBJECT_STORE_DIR: '/var/cairn/objects',
      CAIRN_BROWSER_PROFILE_DIR: '/var/cairn/profiles',
      CAIRN_CREDENTIAL_KEY: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=',
    })
    expect(absolute.CAIRN_BROWSER_PROFILE_DIR).toBe('/var/cairn/profiles')
  })
})

describe('formatEnvIssues', () => {
  it('逐行给出变量名与规则，不回显变量值', () => {
    const secret = 'super-secret-value-should-not-appear'
    const result = apiEnvSchema.safeParse({
      CAIRN_ENV: 'production',
      CAIRN_JWT_SECRET: DEV_JWT_SECRET,
      CAIRN_BOOTSTRAP_ADMIN_PASSWORD: secret,
    })
    expect(result.success).toBe(false)
    const lines = formatEnvIssues(result.error!)
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(line).toContain('CAIRN_')
      expect(line).not.toContain(secret)
    }
  })
})

describe('parseDurationSeconds', () => {
  it('解析 smhd', () => {
    expect(parseDurationSeconds('30s')).toBe(30)
    expect(parseDurationSeconds('12h')).toBe(12 * 3600)
    expect(parseDurationSeconds('7d')).toBe(7 * 86400)
  })
})
