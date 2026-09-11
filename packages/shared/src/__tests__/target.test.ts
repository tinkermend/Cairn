import { describe, expect, it } from 'vitest'
import {
  LOGIN_FIELD_HEURISTICS,
  LOGIN_HEURISTIC_VERSION,
  createTargetAccountBodySchema,
  createTargetBodySchema,
  targetCodeSchema,
  targetListResponseSchema,
  targetSchema,
  updateTargetAccountBodySchema,
  updateTargetBodySchema,
} from '../target.js'

const now = '2026-09-10T00:00:00.000Z'

const target = {
  id: '00000000-0000-4000-8000-000000000001',
  code: 'tower-preprod',
  name: '铁塔视联',
  entryUrl: 'https://example.com/#/home',
  loginUrl: null,
  authMethod: 'password' as const,
  captchaMode: 'none' as const,
  status: 'active' as const,
  loginFields: null,
  accountCount: 0,
  createdAt: now,
  updatedAt: now,
}

describe('targetCodeSchema', () => {
  it('接受两位及以上 slug', () => {
    expect(targetCodeSchema.parse('ab')).toBe('ab')
    expect(targetCodeSchema.parse('tower-preprod')).toBe('tower-preprod')
  })

  it('拒绝单字符', () => {
    expect(() => targetCodeSchema.parse('a')).toThrow()
  })
})

describe('createTargetBodySchema', () => {
  it('接受合法创建体，默认认证与状态', () => {
    const parsed = createTargetBodySchema.parse({
      code: 'demo-sys',
      name: '演示',
      entryUrl: 'http://127.0.0.1:4177/login',
    })
    expect(parsed.authMethod).toBe('password')
    expect(parsed.captchaMode).toBe('none')
    expect(parsed.status).toBe('active')
    expect(parsed.loginUrl).toBeUndefined()
    expect(parsed.loginFields).toBeNull()
    expect(parsed.account).toBeUndefined()
  })

  it('空 loginFields 与空 locator value 归一为 null', () => {
    const empty = createTargetBodySchema.parse({
      code: 'empty-loc',
      name: 'x',
      entryUrl: 'https://example.com',
      loginFields: {},
    })
    expect(empty.loginFields).toBeNull()

    const blank = createTargetBodySchema.parse({
      code: 'blank-loc',
      name: 'x',
      entryUrl: 'https://example.com',
      loginFields: { username: { by: 'id', value: '  ' } },
    })
    expect(blank.loginFields).toBeNull()
  })

  it('接受手填定位与首个账号', () => {
    const parsed = createTargetBodySchema.parse({
      code: 'with-acc',
      name: '带账号',
      entryUrl: 'https://example.com',
      loginFields: { username: { by: 'id', value: 'username' } },
      account: { displayName: '演示', username: 'demo', password: 'secret' },
    })
    expect(parsed.loginFields).toEqual({ username: { by: 'id', value: 'username' } })
    expect(parsed.account).toMatchObject({ displayName: '演示', username: 'demo', password: 'secret' })
  })

  it('拒绝 heuristicVersion / 非法 by', () => {
    expect(() =>
      createTargetBodySchema.parse({
        code: 'bad-hv',
        name: 'x',
        entryUrl: 'https://example.com',
        loginFields: { heuristicVersion: 1 },
      }),
    ).toThrow()
    expect(() =>
      createTargetBodySchema.parse({
        code: 'bad-by',
        name: 'x',
        entryUrl: 'https://example.com',
        loginFields: { username: { by: 'xpath', value: '//input' } },
      }),
    ).toThrow()
  })

  it('保留 hash 入口', () => {
    const parsed = createTargetBodySchema.parse({
      code: 'hash-app',
      name: 'Hash',
      entryUrl: 'http://host.example/#/login',
    })
    expect(parsed.entryUrl).toBe('http://host.example/#/login')
  })

  it('拒绝无 scheme 与内嵌凭据', () => {
    expect(() =>
      createTargetBodySchema.parse({
        code: 'bad-url',
        name: 'x',
        entryUrl: 'example.com/login',
      }),
    ).toThrow()
    expect(() =>
      createTargetBodySchema.parse({
        code: 'bad-cred',
        name: 'x',
        entryUrl: 'https://u:p@example.com/login',
      }),
    ).toThrow()
  })

  it('空 loginUrl 归一为 null', () => {
    const parsed = createTargetBodySchema.parse({
      code: 'empty-login',
      name: 'x',
      entryUrl: 'https://example.com',
      loginUrl: '   ',
    })
    expect(parsed.loginUrl).toBeNull()
  })

  it('拒绝多写 code 以外的未知字段', () => {
    expect(() =>
      createTargetBodySchema.parse({
        code: 'extra-f',
        name: 'x',
        entryUrl: 'https://example.com',
        provider: 'local',
      }),
    ).toThrow()
  })
})

describe('updateTargetBodySchema', () => {
  it('拒绝携带 code', () => {
    expect(() => updateTargetBodySchema.parse({ code: 'new-code', name: 'n' })).toThrow()
  })

  it('空对象非法', () => {
    expect(() => updateTargetBodySchema.parse({})).toThrow()
  })

  it('拒绝夹带 account', () => {
    expect(() =>
      updateTargetBodySchema.parse({
        name: 'n',
        account: { displayName: '甲', username: 'a' },
      }),
    ).toThrow()
  })

  it('只改 loginFields 合法，空对象归一为 null', () => {
    expect(updateTargetBodySchema.parse({ loginFields: {} }).loginFields).toBeNull()
    expect(
      updateTargetBodySchema.parse({
        loginFields: { password: { by: 'name', value: 'password' } },
      }).loginFields,
    ).toEqual({ password: { by: 'name', value: 'password' } })
  })
})

describe('updateTargetAccountBodySchema', () => {
  it('password 与 clearPassword 互斥', () => {
    expect(() =>
      updateTargetAccountBodySchema.parse({ password: 'secret', clearPassword: true }),
    ).toThrow()
  })

  it('拒绝 provider / secretId', () => {
    expect(() =>
      updateTargetAccountBodySchema.parse({ provider: 'local', displayName: '甲' }),
    ).toThrow()
    expect(() =>
      updateTargetAccountBodySchema.parse({ secretId: 'x', displayName: '甲' }),
    ).toThrow()
  })

  it('空 password 非法', () => {
    expect(() => updateTargetAccountBodySchema.parse({ password: '' })).toThrow()
  })
})

describe('createTargetAccountBodySchema', () => {
  it('密码可选', () => {
    expect(
      createTargetAccountBodySchema.parse({ displayName: '运维', username: 'ops' }).password,
    ).toBeUndefined()
  })
})

describe('LOGIN_FIELD_HEURISTICS', () => {
  it('版本为 1，顺序与条数钉死', () => {
    expect(LOGIN_HEURISTIC_VERSION).toBe(1)
    expect(LOGIN_FIELD_HEURISTICS.username).toEqual([
      { by: 'id', value: 'username' },
      { by: 'id', value: 'user' },
      { by: 'id', value: 'account' },
      { by: 'id', value: 'loginName' },
      { by: 'id', value: 'login-name' },
      { by: 'name', value: 'username' },
      { by: 'name', value: 'user' },
      { by: 'name', value: 'account' },
      { by: 'css', value: 'input[autocomplete="username"]' },
      { by: 'css', value: 'input[type="email"]' },
    ])
    expect(LOGIN_FIELD_HEURISTICS.password).toEqual([
      { by: 'id', value: 'password' },
      { by: 'id', value: 'passwd' },
      { by: 'id', value: 'pwd' },
      { by: 'name', value: 'password' },
      { by: 'css', value: 'input[autocomplete="current-password"]' },
      { by: 'css', value: 'input[type="password"]' },
    ])
    expect(LOGIN_FIELD_HEURISTICS.submit).toEqual([
      { by: 'css', value: 'button[type="submit"]' },
      { by: 'css', value: 'input[type="submit"]' },
      { by: 'id', value: 'login' },
      { by: 'id', value: 'submit' },
      { by: 'name', value: 'login' },
    ])
  })
})

describe('targetSchema / list', () => {
  it('列表信封带可选 nextCursor', () => {
    expect(() => targetSchema.parse(target)).not.toThrow()
    expect(targetListResponseSchema.parse({ items: [target] }).nextCursor).toBeUndefined()
    expect(
      targetListResponseSchema.parse({ items: [target], nextCursor: 'abc' }).nextCursor,
    ).toBe('abc')
  })

  it('出站接受已落库的非 slug 编码；创建仍拒绝', () => {
    expect(() => targetSchema.parse({ ...target, code: 'exec-y_exec' })).not.toThrow()
    expect(
      targetListResponseSchema.parse({ items: [{ ...target, code: 'exec-y_exec' }] }).items[0]
        ?.code,
    ).toBe('exec-y_exec')
    expect(() =>
      createTargetBodySchema.parse({
        code: 'exec-y_exec',
        name: 'x',
        entryUrl: 'https://example.com',
      }),
    ).toThrow()
  })
})
