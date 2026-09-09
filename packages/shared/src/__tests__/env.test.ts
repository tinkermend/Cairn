import { describe, expect, it } from 'vitest'
import { dbEnvSchema } from '../env.js'

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
