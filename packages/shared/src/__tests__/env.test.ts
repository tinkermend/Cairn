import { describe, expect, it } from 'vitest'
import { apiEnvSchema, dbEnvSchema, parseDurationSeconds } from '../env.js'

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
    expect(env.CAIRN_BOOTSTRAP_ADMIN_EMAIL).toBe('admin@cairn.dev')
    expect(env.CAIRN_BOOTSTRAP_ADMIN_PASSWORD).toBe('cairn-admin')
    expect(env.CAIRN_JWT_SECRET.length).toBeGreaterThanOrEqual(16)
  })
})

describe('parseDurationSeconds', () => {
  it('解析 smhd', () => {
    expect(parseDurationSeconds('30s')).toBe(30)
    expect(parseDurationSeconds('12h')).toBe(12 * 3600)
    expect(parseDurationSeconds('7d')).toBe(7 * 86400)
  })
})
