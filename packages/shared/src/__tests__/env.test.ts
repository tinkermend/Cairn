import { describe, expect, it } from 'vitest'
import {
  DEV_CREDENTIAL_KEY,
  DEV_INTERNAL_AUTH_SECRET,
  apiEnvSchema,
  dbEnvSchema,
  decodeCredentialKey,
  formatEnvIssues,
  objectStoreEnvSchema,
  parseDurationSeconds,
  workerEnvSchema,
} from '../env.js'

/**
 * 三把密钥必填、无默认值，所以每次 parse 都得带上。
 * 用固定夹具值而不是随机值：断言里要能对上。
 */
const API_SECRETS = {
  CAIRN_JWT_SECRET: 'test-only-jwt-secret-at-least-16',
  CAIRN_CREDENTIAL_KEY: DEV_CREDENTIAL_KEY,
  CAIRN_INTERNAL_AUTH_SECRET: DEV_INTERNAL_AUTH_SECRET,
}
const WORKER_SECRETS = {
  CAIRN_CREDENTIAL_KEY: DEV_CREDENTIAL_KEY,
  CAIRN_INTERNAL_AUTH_SECRET: DEV_INTERNAL_AUTH_SECRET,
}

const base = {
  CAIRN_DB_HOST: 'db.example',
  CAIRN_DB_NAME: 'cairn',
  CAIRN_DB_USER: 'cairn',
  CAIRN_DB_PASSWORD: 'secret',
}

describe('dbEnvSchema', () => {
  it('把字符串端口强制为数字', () => {
    expect(dbEnvSchema.parse({ ...base, CAIRN_DB_PORT: '5432' })).toMatchObject({ CAIRN_DB_PORT: 5432 })
  })

  it('端口与 schema 有默认值', () => {
    const env = dbEnvSchema.parse(base)
    if (env.CAIRN_DB_DRIVER !== 'postgres') throw new Error('Default driver must be postgres')
    expect(env.CAIRN_DB_PORT).toBe(5432)
    expect(env.CAIRN_DB_SCHEMA).toBe('cairn')
  })

  it('缺少必填项时抛错', () => {
    expect(() => dbEnvSchema.parse({ ...base, CAIRN_DB_PASSWORD: '' })).toThrow()
  })
})

describe('apiEnvSchema', () => {
  it('变化提示默认 auto，显式 redis 必须有 URL', () => {
    const env = apiEnvSchema.parse({ ...API_SECRETS })
    expect(env.CAIRN_CHANGE_HINT).toBe('auto')
    expect(env.CAIRN_RUN_EVENT_RETAIN_DAYS).toBe(7)
    expect(env.CAIRN_MONITOR_SSE_INTERVAL_MS).toBe(5_000)
    expect(env.CAIRN_MONITOR_SSE_MIN_INTERVAL_MS).toBe(5_000)
    expect(env.CAIRN_API_HEARTBEAT_MS).toBe(5_000)
    expect(env.CAIRN_API_LOST_AFTER_SECONDS).toBe(45)
    expect(env.CAIRN_MONITOR_SAMPLE_INTERVAL_MS).toBe(60_000)
    expect(env.CAIRN_BUILD_VERSION).toBeUndefined()
    expect(() => apiEnvSchema.parse({ ...API_SECRETS,  CAIRN_CHANGE_HINT: 'redis' })).toThrow()
    expect(apiEnvSchema.parse({ ...API_SECRETS,  CAIRN_CHANGE_HINT: 'redis', CAIRN_REDIS_URL: 'redis://127.0.0.1:6379' }).CAIRN_REDIS_URL).toBe(
      'redis://127.0.0.1:6379',
    )
    expect(() =>
      apiEnvSchema.parse({ ...API_SECRETS,  CAIRN_MONITOR_SSE_INTERVAL_MS: '2000', CAIRN_MONITOR_SSE_MIN_INTERVAL_MS: '5000' }),
    ).toThrow()
    expect(
      apiEnvSchema.parse({ ...API_SECRETS,  CAIRN_MONITOR_SSE_MIN_INTERVAL_MS: '2000', CAIRN_MONITOR_OVERVIEW_CACHE_MS: '2000' })
        .CAIRN_MONITOR_SSE_MIN_INTERVAL_MS,
    ).toBe(2_000)
    expect(env.CAIRN_MONITOR_OVERVIEW_CACHE_MS).toBe(3_000)
    expect(() =>
      apiEnvSchema.parse({ ...API_SECRETS,  CAIRN_MONITOR_OVERVIEW_CACHE_MS: '6000', CAIRN_MONITOR_SSE_MIN_INTERVAL_MS: '5000' }),
    ).toThrow()
  })

  it('JWT 密钥必填、无默认值，漏配即拒绝启动', () => {
    const env = apiEnvSchema.parse({ ...API_SECRETS })
    expect(env.CAIRN_JWT_SECRET.length).toBeGreaterThanOrEqual(16)
    const { CAIRN_JWT_SECRET: _omitted, ...withoutJwt } = API_SECRETS
    const result = apiEnvSchema.safeParse(withoutJwt)
    expect(result.success).toBe(false)
    expect(result.error?.issues.map((i) => i.path.join('.'))).toContain('CAIRN_JWT_SECRET')
  })

  it('支持人类可读字节大小格式（如 128MB, 32M, 1GB）与纯数字字节', () => {
    expect(apiEnvSchema.parse({ ...API_SECRETS,  CAIRN_OBJECT_MAX_BYTES: '32MB' }).CAIRN_OBJECT_MAX_BYTES).toBe(33_554_432)
    expect(apiEnvSchema.parse({ ...API_SECRETS,  CAIRN_VIDEO_MAX_BYTES: '128M' }).CAIRN_VIDEO_MAX_BYTES).toBe(134_217_728)
    expect(workerEnvSchema.parse({ ...WORKER_SECRETS,  CAIRN_TRACE_MAX_BYTES: '1GB' }).CAIRN_TRACE_MAX_BYTES).toBe(1_073_741_824)
    expect(apiEnvSchema.parse({ ...API_SECRETS,  CAIRN_OBJECT_MAX_BYTES: 1024 }).CAIRN_OBJECT_MAX_BYTES).toBe(1024)
    expect(() => apiEnvSchema.parse({ ...API_SECRETS,  CAIRN_OBJECT_MAX_BYTES: 'invalid' })).toThrow(/字节大小/)
  })

  it('端口、CORS、环境与日志级别有默认值', () => {
    const env = apiEnvSchema.parse({ ...API_SECRETS })
    expect(env.CAIRN_API_PORT).toBe(3030)
    expect(env.CAIRN_VIDEO_MAX_BYTES).toBe(134_217_728)
    expect(env.CAIRN_CORS_ORIGINS).toEqual(['http://localhost:5173'])
    expect(env.CAIRN_TRUST_PROXY_HOPS).toBe(0)
    expect(env.CAIRN_LOG_LEVEL).toBe('info')
    // 没有环境档位这个概念了：配了也只是个无人读取的多余变量。
    expect(env).not.toHaveProperty('CAIRN_ENV')
  })

  it('反代跳数为非负整数，非法值拒绝', () => {
    expect(apiEnvSchema.parse({ ...API_SECRETS,  CAIRN_TRUST_PROXY_HOPS: '2' }).CAIRN_TRUST_PROXY_HOPS).toBe(2)
    expect(() => apiEnvSchema.parse({ ...API_SECRETS,  CAIRN_TRUST_PROXY_HOPS: '-1' })).toThrow()
  })

  it('字符串端口被强制为数字', () => {
    expect(apiEnvSchema.parse({ ...API_SECRETS,  CAIRN_API_PORT: '8080' }).CAIRN_API_PORT).toBe(8080)
  })

  it('非法端口被拒绝', () => {
    expect(() => apiEnvSchema.parse({ ...API_SECRETS,  CAIRN_API_PORT: 'not-a-port' })).toThrow()
    expect(() => apiEnvSchema.parse({ ...API_SECRETS,  CAIRN_API_PORT: '0' })).toThrow()
    expect(() => apiEnvSchema.parse({ ...API_SECRETS,  CAIRN_API_PORT: '70000' })).toThrow()
  })

  it('空串按未设置处理，回落默认值', () => {
    // dotenv 无法表达「未设置」，占位写法就是 KEY=
    const env = apiEnvSchema.parse({ ...API_SECRETS,  CAIRN_API_PORT: '', CAIRN_LOG_LEVEL: '', CAIRN_CORS_ORIGINS: '' })
    expect(env.CAIRN_API_PORT).toBe(3030)
    expect(env.CAIRN_LOG_LEVEL).toBe('info')
    expect(env.CAIRN_CORS_ORIGINS).toEqual(['http://localhost:5173'])
  })

  it('CORS 白名单在 schema 里就拆成数组，两端空白被吃掉', () => {
    const env = apiEnvSchema.parse({ ...API_SECRETS, 
      CAIRN_CORS_ORIGINS: 'http://localhost:5173, https://cairn.example.com:8443 ',
    })
    expect(env.CAIRN_CORS_ORIGINS).toEqual([
      'http://localhost:5173',
      'https://cairn.example.com:8443',
    ])
  })

  it('拆不出任何 origin 的取值被拒绝——启动成功却全站被拒是最难查的形态', () => {
    // 「非空字符串」能放过它，但拆出来是空白名单
    expect(() => apiEnvSchema.parse({ ...API_SECRETS,  CAIRN_CORS_ORIGINS: ',' })).toThrow()
    expect(() => apiEnvSchema.parse({ ...API_SECRETS,  CAIRN_CORS_ORIGINS: ' , , ' })).toThrow()
  })

  it('漏写 scheme 的 origin 被拒绝——浏览器发出的 Origin 永远带 scheme', () => {
    expect(() => apiEnvSchema.parse({ ...API_SECRETS,  CAIRN_CORS_ORIGINS: 'localhost:5173' })).toThrow()
    expect(() =>
      apiEnvSchema.parse({ ...API_SECRETS,  CAIRN_CORS_ORIGINS: 'http://localhost:5173,example.com' }),
    ).toThrow()
  })

  it('通配符仍可显式配置', () => {
    expect(apiEnvSchema.parse({ ...API_SECRETS,  CAIRN_CORS_ORIGINS: '*' }).CAIRN_CORS_ORIGINS).toEqual(['*'])
  })

  it('非法日志级别被拒绝', () => {
    expect(() => apiEnvSchema.parse({ ...API_SECRETS,  CAIRN_LOG_LEVEL: 'verbose' })).toThrow()
  })

  it('凭据主密钥必填，且必须解码为 32 字节', () => {
    expect(decodeCredentialKey(DEV_CREDENTIAL_KEY)?.byteLength).toBe(32)
    const { CAIRN_CREDENTIAL_KEY: _omitted, ...withoutKey } = API_SECRETS
    const result = apiEnvSchema.safeParse(withoutKey)
    expect(result.success).toBe(false)
    expect(result.error?.issues.map((i) => i.path.join('.'))).toContain('CAIRN_CREDENTIAL_KEY')
  })

  it('非法 base64 或非 32 字节的凭据主密钥被拒绝', () => {
    expect(() => apiEnvSchema.parse({ ...API_SECRETS,  CAIRN_CREDENTIAL_KEY: 'not-base64!!!' })).toThrow()
    expect(() => apiEnvSchema.parse({ ...API_SECRETS,  CAIRN_CREDENTIAL_KEY: 'dG9vLXNob3J0' })).toThrow()
  })

  it('本地对象目录相对与绝对路径都接受', () => {
    const relative = apiEnvSchema.parse({ ...API_SECRETS,
      CAIRN_OBJECT_STORE: 'local',
      CAIRN_OBJECT_STORE_DIR: '.data/object-store',
    })
    expect(relative.CAIRN_OBJECT_STORE_DIR).toBe('.data/object-store')
    const absolute = apiEnvSchema.parse({ ...API_SECRETS,
      CAIRN_OBJECT_STORE: 'local',
      CAIRN_OBJECT_STORE_DIR: '/var/cairn/objects',
    })
    expect(absolute.CAIRN_OBJECT_STORE_DIR).toBe('/var/cairn/objects')
  })

})

describe('workerEnvSchema', () => {
  it('workerId 与日志级别有默认值', () => {
    const env = workerEnvSchema.parse({ ...WORKER_SECRETS })
    expect(env.CAIRN_WORKER_ID).toBe('local-worker')
    expect(env.CAIRN_LOG_LEVEL).toBe('info')
    expect(env).not.toHaveProperty('CAIRN_ENV')
    expect(env.CAIRN_MONITOR_SAMPLE_INTERVAL_MS).toBe(60_000)
    expect(env.CAIRN_MONITOR_OBJECT_STORE_PROBE_MS).toBe(60_000)
    expect(() => workerEnvSchema.parse({ ...WORKER_SECRETS,  CAIRN_MONITOR_SAMPLE_INTERVAL_MS: '10000' })).toThrow()
  })

  it('空 workerId 回落默认值而非启动失败', () => {
    expect(workerEnvSchema.parse({ ...WORKER_SECRETS,  CAIRN_WORKER_ID: '' }).CAIRN_WORKER_ID).toBe('local-worker')
  })

  it('显式 workerId 被采纳', () => {
    expect(workerEnvSchema.parse({ ...WORKER_SECRETS,  CAIRN_WORKER_ID: 'worker-3' }).CAIRN_WORKER_ID).toBe('worker-3')
  })

  it('非法日志级别被拒绝', () => {
    expect(() => workerEnvSchema.parse({ ...WORKER_SECRETS,  CAIRN_LOG_LEVEL: 'loud' })).toThrow()
  })

  it('对象存储默认走本地，并忽略未配的 S3 变量', () => {
    const env = workerEnvSchema.parse({ ...WORKER_SECRETS, 
      CAIRN_S3_BUCKET: '',
      CAIRN_S3_ACCESS_KEY: '',
      CAIRN_S3_SECRET_KEY: '',
    })
    expect(env.CAIRN_OBJECT_STORE).toBe('local')
    expect(env.CAIRN_OBJECT_STORE_DIR).toBe('.data/object-store')
    expect(env.CAIRN_OBJECT_MAX_BYTES).toBe(33_554_432)
    expect(env.CAIRN_TRACE_MAX_BYTES).toBe(134_217_728)
    expect(env.CAIRN_VIDEO_MAX_BYTES).toBe(134_217_728)
    expect(env.CAIRN_EVIDENCE_UPLOAD_MAX_ATTEMPTS).toBe(3)
    expect(env.CAIRN_OBJECT_RETAIN_DAYS).toBe(30)
    expect(env.CAIRN_S3_FORCE_PATH_STYLE).toBe(false)
    expect(env.CAIRN_S3_BUCKET).toBeUndefined()
  })

  it('有 S3 endpoint 时默认走 path-style', () => {
    const env = workerEnvSchema.parse({ ...WORKER_SECRETS,  CAIRN_S3_ENDPOINT: 'http://127.0.0.1:9000' })
    expect(env.CAIRN_S3_FORCE_PATH_STYLE).toBe(true)
  })

  it('s3 驱动缺桶或密钥时拒绝启动', () => {
    const missingBucket = workerEnvSchema.safeParse({ ...WORKER_SECRETS,  CAIRN_OBJECT_STORE: 's3' })
    expect(missingBucket.success).toBe(false)
    expect(missingBucket.error?.issues.map((i) => i.path.join('.'))).toEqual(
      expect.arrayContaining(['CAIRN_S3_BUCKET', 'CAIRN_S3_ACCESS_KEY', 'CAIRN_S3_SECRET_KEY']),
    )

    const ok = workerEnvSchema.parse({ ...WORKER_SECRETS, 
      CAIRN_OBJECT_STORE: 's3',
      CAIRN_S3_BUCKET: 'cairn-evidence',
      CAIRN_S3_ACCESS_KEY: 'key',
      CAIRN_S3_SECRET_KEY: 'secret',
    })
    expect(ok.CAIRN_S3_BUCKET).toBe('cairn-evidence')
  })

  it('本地对象目录相对与绝对路径都接受', () => {
    const relative = workerEnvSchema.parse({ ...WORKER_SECRETS,
      CAIRN_OBJECT_STORE: 'local',
      CAIRN_OBJECT_STORE_DIR: '.data/object-store',
    })
    expect(relative.CAIRN_OBJECT_STORE_DIR).toBe('.data/object-store')
    const absolute = workerEnvSchema.parse({ ...WORKER_SECRETS,
      CAIRN_OBJECT_STORE: 'local',
      CAIRN_OBJECT_STORE_DIR: '/var/cairn/objects',
    })
    expect(absolute.CAIRN_OBJECT_STORE_DIR).toBe('/var/cairn/objects')
  })

  it('s3 缺密钥时 formatEnvIssues 只含变量名', () => {
    const secret = 'should-not-appear-in-issues'
    const result = workerEnvSchema.safeParse({ ...WORKER_SECRETS, 
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
    const env = workerEnvSchema.parse({ ...WORKER_SECRETS })
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
    expect(env.CAIRN_PERIODIC_SLOT_LEASE_TTL_MS).toBe(60_000)
    expect(env.CAIRN_PERIODIC_SLOT_FAILURE_RETRY_MS).toBe(5_000)
    expect(env.CAIRN_REAPER_DRAIN_BUDGET_MS).toBe(5_000)
    expect(env.CAIRN_MONITOR_PURGE_INTERVAL_MS).toBe(600_000)
    expect(env.CAIRN_CREDENTIAL_REMINDER_SCAN_INTERVAL_MS).toBe(60_000)
  })

  it('排空预算必须小于 reaper 周期', () => {
    expect(() =>
      workerEnvSchema.parse({ ...WORKER_SECRETS, 
        CAIRN_REAPER_DRAIN_BUDGET_MS: '15000',
        CAIRN_SESSION_REAPER_INTERVAL_MS: '15000',
      }),
    ).toThrow()
  })

  it('LEASE_TTL < 3×HEARTBEAT 时拒绝启动', () => {
    const result = workerEnvSchema.safeParse({ ...WORKER_SECRETS, 
      CAIRN_SESSION_LEASE_TTL_SECONDS: '10',
      CAIRN_SESSION_HEARTBEAT_MS: '5000',
    })
    expect(result.success).toBe(false)
    expect(result.error?.issues.map((i) => i.path.join('.'))).toContain(
      'CAIRN_SESSION_LEASE_TTL_SECONDS',
    )
  })

  it('RunLease TTL < 3×Worker 心跳时拒绝启动', () => {
    const result = workerEnvSchema.safeParse({ ...WORKER_SECRETS, 
      CAIRN_RUN_LEASE_TTL_SECONDS: '10',
      CAIRN_WORKER_HEARTBEAT_MS: '5000',
    })
    expect(result.success).toBe(false)
    expect(result.error?.issues.map((i) => i.path.join('.'))).toContain('CAIRN_RUN_LEASE_TTL_SECONDS')
  })

  it('WORKER_LOST_AFTER ≤ RunLease TTL 时拒绝启动', () => {
    const result = workerEnvSchema.safeParse({ ...WORKER_SECRETS, 
      CAIRN_RUN_LEASE_TTL_SECONDS: '30',
      CAIRN_WORKER_LOST_AFTER_SECONDS: '30',
    })
    expect(result.success).toBe(false)
    expect(result.error?.issues.map((i) => i.path.join('.'))).toContain(
      'CAIRN_WORKER_LOST_AFTER_SECONDS',
    )
  })

  it('浏览器 AI 默认关闭，其余项不必填', () => {
    const env = workerEnvSchema.parse({ ...WORKER_SECRETS })
    expect(env.CAIRN_BROWSER_AI_ENABLED).toBe(false)
    expect(env.CAIRN_BROWSER_AI_REQUEST_TIMEOUT_MS).toBe(15_000)
    expect(env.CAIRN_BROWSER_AI_HANG_WAIT_MS).toBe(5_000)
  })

  it('启用浏览器 AI 但缺模型配置时仍可启动', () => {
    const result = workerEnvSchema.safeParse({ ...WORKER_SECRETS,  CAIRN_BROWSER_AI_ENABLED: 'true' })
    expect(result.success).toBe(true)
    expect(result.data?.CAIRN_BROWSER_AI_ENABLED).toBe(true)
  })

  it('启用浏览器 AI 时可直填密钥（注册成 Secret 前的过渡路径）', () => {
    const env = workerEnvSchema.parse({ ...WORKER_SECRETS, 
      CAIRN_BROWSER_AI_ENABLED: 'true',
      CAIRN_BROWSER_AI_BASE_URL: 'https://ark.example/api/v3',
      CAIRN_BROWSER_AI_MODEL: 'demo-model',
      CAIRN_BROWSER_AI_MODEL_FAMILY: 'doubao-seed',
      CAIRN_BROWSER_AI_API_KEY: 'sk-dev',
    })
    expect(env.CAIRN_BROWSER_AI_ENABLED).toBe(true)
    expect(env.CAIRN_BROWSER_AI_MODEL).toBe('demo-model')
  })

  it('RunLease 相关默认值', () => {
    const env = workerEnvSchema.parse({ ...WORKER_SECRETS })
    expect(env.CAIRN_WORKER_CAPACITY).toBe(1)
    expect(env.CAIRN_WORKER_ROLES).toBe('all')
    expect(() => workerEnvSchema.parse({ ...WORKER_SECRETS,  CAIRN_WORKER_ROLES: 'all,executor' })).toThrow()
    expect(env.CAIRN_WORKER_HEARTBEAT_MS).toBe(5_000)
    expect(env.CAIRN_RUN_LEASE_TTL_SECONDS).toBe(30)
    expect(env.CAIRN_WORKER_LOST_AFTER_SECONDS).toBe(45)
    expect(env.CAIRN_RUN_MAX_RECOVERIES).toBe(3)
  })

  it('MAX_LIFETIME ≤ IDLE_TTL 时拒绝启动', () => {
    const result = workerEnvSchema.safeParse({ ...WORKER_SECRETS, 
      CAIRN_SESSION_IDLE_TTL_SECONDS: '600',
      CAIRN_SESSION_MAX_LIFETIME_SECONDS: '600',
    })
    expect(result.success).toBe(false)
    expect(result.error?.issues.map((i) => i.path.join('.'))).toContain(
      'CAIRN_SESSION_MAX_LIFETIME_SECONDS',
    )
  })

  it('浏览器 profile 目录相对与绝对路径都接受', () => {
    const relative = workerEnvSchema.parse({ ...WORKER_SECRETS,
      CAIRN_BROWSER_PROFILE_DIR: '.data/browser-profiles',
    })
    expect(relative.CAIRN_BROWSER_PROFILE_DIR).toBe('.data/browser-profiles')
    const absolute = workerEnvSchema.parse({ ...WORKER_SECRETS,
      CAIRN_BROWSER_PROFILE_DIR: '/var/cairn/profiles',
    })
    expect(absolute.CAIRN_BROWSER_PROFILE_DIR).toBe('/var/cairn/profiles')
  })
})

describe('formatEnvIssues', () => {
  it('逐行给出变量名与规则，不回显变量值', () => {
    const secret = 'super-secret-value-should-not-appear'
    const result = apiEnvSchema.safeParse({ ...API_SECRETS,
      CAIRN_CREDENTIAL_KEY: secret,
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

describe('Worker 广告入口与终结点解析', () => {
  it('默认不注入广告 URL，API 自动兜底 local-worker', () => {
    const worker = workerEnvSchema.parse({ ...WORKER_SECRETS })
    expect(worker.CAIRN_WORKER_ADVERTISE_URL).toBeUndefined()
    expect(apiEnvSchema.parse({ ...API_SECRETS }).CAIRN_WORKER_ENDPOINTS).toBe('local-worker=http://127.0.0.1:8091')
  })

  it('广告 URL 支持合法的 HTTP/HTTPS origin', () => {
    expect(
      workerEnvSchema.parse({ ...WORKER_SECRETS, 
        CAIRN_WORKER_ADVERTISE_URL: 'http://127.0.0.1:8443',
      }).CAIRN_WORKER_ADVERTISE_URL,
    ).toBe('http://127.0.0.1:8443')
    expect(
      workerEnvSchema.parse({ ...WORKER_SECRETS, 
        CAIRN_WORKER_ADVERTISE_URL: 'https://127.0.0.1:8443',
      }).CAIRN_WORKER_ADVERTISE_URL,
    ).toBe('https://127.0.0.1:8443')
    expect(
      workerEnvSchema.parse({ ...WORKER_SECRETS, 
        CAIRN_WORKER_ADVERTISE_URL: 'http://worker-a.internal:8443',
      }).CAIRN_WORKER_ADVERTISE_URL,
    ).toBe('http://worker-a.internal:8443')
    expect(
      workerEnvSchema.parse({ ...WORKER_SECRETS, 
        CAIRN_WORKER_ADVERTISE_URL: 'https://worker-a.internal:8443',
      }).CAIRN_WORKER_ADVERTISE_URL,
    ).toBe('https://worker-a.internal:8443')
  })

  it('通配监听与 port=0 配广告 URL 拒启', () => {
    expect(workerEnvSchema.safeParse({ ...WORKER_SECRETS,  CAIRN_WORKER_INTERNAL_HOST: '0.0.0.0' }).success).toBe(false)
    expect(workerEnvSchema.safeParse({ ...WORKER_SECRETS,  CAIRN_WORKER_INTERNAL_HOST: '::' }).success).toBe(false)
    expect(
      workerEnvSchema.safeParse({ ...WORKER_SECRETS, 
        CAIRN_WORKER_INTERNAL_PORT: '0',
        CAIRN_WORKER_ADVERTISE_URL: 'http://127.0.0.1:8091',
      }).success,
    ).toBe(false)
    expect(workerEnvSchema.parse({ ...WORKER_SECRETS,  CAIRN_WORKER_INTERNAL_PORT: '0' }).CAIRN_WORKER_INTERNAL_PORT).toBe(0)
  })
})

/**
 * 对象存储的独立入口：库迁移这类不启动 API / Worker 的运维工具用它。
 * 迁移窗口里通常只带库与存储连接信息，不该被 JWT / 凭据主密钥 / 内部 HMAC 挡住。
 */
describe('objectStoreEnvSchema', () => {
  it('只带对象存储变量就能解析，不要求三把密钥', () => {
    const env = objectStoreEnvSchema.parse({
      CAIRN_OBJECT_STORE: 's3',
      CAIRN_S3_ENDPOINT: 'http://127.0.0.1:9021',
      CAIRN_S3_BUCKET: 'cairn-evidence',
      CAIRN_S3_ACCESS_KEY: 'key',
      CAIRN_S3_SECRET_KEY: 'secret',
    })
    expect(env.CAIRN_OBJECT_STORE).toBe('s3')
    // 与 api / worker 一致：有 endpoint 时默认 path-style。
    expect(env.CAIRN_S3_FORCE_PATH_STYLE).toBe(true)
  })

  it('把整份进程环境（含无关变量）喂进来也只取自己的字段', () => {
    const env = objectStoreEnvSchema.parse({
      CAIRN_OBJECT_STORE: 'local',
      CAIRN_DB_PASSWORD: 'unrelated',
      PATH: '/usr/bin',
    })
    expect(env).not.toHaveProperty('CAIRN_DB_PASSWORD')
    expect(env).not.toHaveProperty('PATH')
    expect(env.CAIRN_S3_FORCE_PATH_STYLE).toBe(false)
  })

  it('s3 缺桶或密钥时照样拒绝，规则与 api / worker 同一份', () => {
    const result = objectStoreEnvSchema.safeParse({ CAIRN_OBJECT_STORE: 's3' })
    expect(result.success).toBe(false)
    expect(result.error?.issues.map((i) => i.path.join('.'))).toEqual(
      expect.arrayContaining(['CAIRN_S3_BUCKET', 'CAIRN_S3_ACCESS_KEY', 'CAIRN_S3_SECRET_KEY']),
    )
  })
})
