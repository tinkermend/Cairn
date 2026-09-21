import { describe, expect, it } from 'vitest'
import {
  EMPTY_TARGET_FORM_VALUES,
  accountFromForm,
  captchaFromForm,
  countConfiguredLocators,
  loginFieldsFromForm,
  selectorsFromForm,
  targetFormSchema,
  valuesFromTarget,
} from './target-form-schema'

describe('targetFormSchema', () => {
  it('验证空值必填项', () => {
    const res = targetFormSchema.safeParse({ ...EMPTY_TARGET_FORM_VALUES })
    expect(res.success).toBe(false)
    if (!res.success) {
      const fieldErrors = res.error.flatten().fieldErrors
      expect(fieldErrors.name).toBeDefined()
      expect(fieldErrors.entryUrl).toBeDefined()
    }
  })

  it('填写账号任意字段时，必须同时给出显示名与登录名', () => {
    const invalid = targetFormSchema.safeParse({
      ...EMPTY_TARGET_FORM_VALUES,
      name: '系统A',
      entryUrl: 'https://a.com',
      accountPassword: 'secret',
    })
    expect(invalid.success).toBe(false)
    if (!invalid.success) {
      const issues = invalid.error.issues
      expect(issues.some((i) => i.path.includes('accountDisplayName'))).toBe(true)
      expect(issues.some((i) => i.path.includes('accountUsername'))).toBe(true)
    }

    const valid = targetFormSchema.safeParse({
      ...EMPTY_TARGET_FORM_VALUES,
      name: '系统A',
      entryUrl: 'https://a.com',
      accountDisplayName: '演示号',
      accountUsername: 'demo',
      accountPassword: 'secret',
    })
    expect(valid.success).toBe(true)
  })

  it('loginFieldsFromForm 正确打包非空定位器', () => {
    const emptyFields = loginFieldsFromForm(EMPTY_TARGET_FORM_VALUES)
    expect(emptyFields).toBeNull()

    const withFields = loginFieldsFromForm({
      ...EMPTY_TARGET_FORM_VALUES,
      usernameBy: 'css',
      usernameValue: '#username',
      submitBy: 'id',
      submitValue: 'btn-login',
    })
    expect(withFields).toEqual({
      username: { by: 'css', value: '#username' },
      submit: { by: 'id', value: 'btn-login' },
    })
  })

  it('captchaFromForm 正确处理图形与滑块验证码', () => {
    expect(captchaFromForm(EMPTY_TARGET_FORM_VALUES)).toBeNull()

    const imageAuto = captchaFromForm({
      ...EMPTY_TARGET_FORM_VALUES,
      captchaMode: 'image',
    })
    expect(imageAuto).toEqual({ type: 'AUTO' })

    const imageExplicit = captchaFromForm({
      ...EMPTY_TARGET_FORM_VALUES,
      captchaMode: 'image',
      captchaImageBy: 'css',
      captchaImageValue: '.img',
      captchaInputBy: 'css',
      captchaInputValue: '.input',
    })
    expect(imageExplicit).toEqual({
      type: 'IMAGE',
      image: {
        imageLocator: { by: 'css', value: '.img' },
        inputLocator: { by: 'css', value: '.input' },
      },
    })
  })

  it('selectorsFromForm 正确过滤空行并限额 32 项', () => {
    const input = ' \n .sel-1 \n\n .sel-2 \n '
    expect(selectorsFromForm(input)).toEqual(['.sel-1', '.sel-2'])
  })

  it('accountFromForm 正确提取账号主体', () => {
    expect(accountFromForm(EMPTY_TARGET_FORM_VALUES)).toBeUndefined()
    const acc = accountFromForm({
      ...EMPTY_TARGET_FORM_VALUES,
      accountDisplayName: '管理员',
      accountUsername: 'root',
      accountPassword: 'pwd',
      validityMode: 'permanent',
    })
    expect(acc).toEqual({
      displayName: '管理员',
      username: 'root',
      status: 'active',
      usage: 'business',
      password: 'pwd',
      validity: {
        mode: 'permanent',
        startedAt: expect.any(String),
      },
    })
  })

  it('valuesFromTarget 正确映射 TargetDto 到表单值', () => {
    const targetDto = {
      id: 'tgt-1',
      code: 'tower-test',
      name: '铁塔视联',
      entryUrl: 'https://tower.com',
      loginUrl: null,
      authMethod: 'password' as const,
      captchaMode: 'none' as const,
      status: 'active' as const,
      loginFields: {
        username: { by: 'id' as const, value: 'u-input' },
      },
      captcha: null,
      sensitiveSelectors: ['#id-card'],
      accountCount: 0,
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
    }
    const formVals = valuesFromTarget(targetDto)
    expect(formVals.code).toBe('tower-test')
    expect(formVals.name).toBe('铁塔视联')
    expect(formVals.usernameValue).toBe('u-input')
    expect(formVals.sensitiveSelectors).toBe('#id-card')
  })

  it('countConfiguredLocators 正确统计配置数量', () => {
    expect(countConfiguredLocators(EMPTY_TARGET_FORM_VALUES)).toBe(0)
    expect(
      countConfiguredLocators({
        ...EMPTY_TARGET_FORM_VALUES,
        usernameValue: 'u',
        passwordValue: 'p',
        submitValue: 's',
      })
    ).toBe(3)
  })
})
