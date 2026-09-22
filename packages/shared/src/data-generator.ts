import { z } from 'zod'
import type { JsonValue } from './wire.js'
import type { ScenarioInputDecl } from './step.js'

export const DATA_GENERATOR_KINDS = [
  'fixed',
  'random_number',
  'random_string',
  'mock_preset',
  'date_relative',
  'template',
  'enum_sample',
] as const
export type DataGeneratorKind = (typeof DATA_GENERATOR_KINDS)[number]

export const fixedGeneratorSchema = z.strictObject({
  kind: z.literal('fixed'),
  value: z.union([z.string(), z.number(), z.boolean()]),
})
export type FixedGenerator = z.infer<typeof fixedGeneratorSchema>

export const randomNumberGeneratorSchema = z.strictObject({
  kind: z.literal('random_number'),
  min: z.number(),
  max: z.number(),
  precision: z.number().int().min(0).max(6).default(0),
})
export type RandomNumberGenerator = z.infer<typeof randomNumberGeneratorSchema>

export const randomStringGeneratorSchema = z.strictObject({
  kind: z.literal('random_string'),
  prefix: z.string().max(32).default(''),
  suffix: z.string().max(32).default(''),
  length: z.number().int().min(1).max(64).default(8),
  charset: z.enum(['alphanumeric', 'alpha', 'numeric', 'hex']).default('alphanumeric'),
  unique: z.boolean().default(false),
})
export type RandomStringGenerator = z.infer<typeof randomStringGeneratorSchema>

export const MOCK_PRESETS = [
  'phone_cn',
  'email',
  'name_cn',
  'uuid_v4',
  'id_card_cn',
  'company_cn',
] as const
export type MockPreset = (typeof MOCK_PRESETS)[number]

export const mockPresetGeneratorSchema = z.strictObject({
  kind: z.literal('mock_preset'),
  preset: z.enum(MOCK_PRESETS),
  unique: z.boolean().default(false),
})
export type MockPresetGenerator = z.infer<typeof mockPresetGeneratorSchema>

export const dateRelativeGeneratorSchema = z.strictObject({
  kind: z.literal('date_relative'),
  offsetDaysMin: z.number().int().default(0),
  offsetDaysMax: z.number().int().default(0),
  format: z.string().default('YYYY-MM-DD HH:mm:ss'),
})
export type DateRelativeGenerator = z.infer<typeof dateRelativeGeneratorSchema>

export const templateGeneratorSchema = z.strictObject({
  kind: z.literal('template'),
  pattern: z.string().min(1).max(256),
  unique: z.boolean().default(false),
})
export type TemplateGenerator = z.infer<typeof templateGeneratorSchema>

export const enumSampleGeneratorSchema = z.strictObject({
  kind: z.literal('enum_sample'),
  options: z.array(z.string()).min(1).max(100),
})
export type EnumSampleGenerator = z.infer<typeof enumSampleGeneratorSchema>

export const dataGeneratorSpecSchema = z.discriminatedUnion('kind', [
  fixedGeneratorSchema,
  randomNumberGeneratorSchema,
  randomStringGeneratorSchema,
  mockPresetGeneratorSchema,
  dateRelativeGeneratorSchema,
  templateGeneratorSchema,
  enumSampleGeneratorSchema,
])
export type DataGeneratorSpec = z.infer<typeof dataGeneratorSpecSchema>

const CHARSETS = {
  numeric: '0123456789',
  alpha: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
  alphanumeric: '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
  hex: '0123456789abcdef',
}

const CHINESE_SURNAMES = [
  '赵', '钱', '孙', '李', '周', '吴', '郑', '王', '冯', '陈',
  '褚', '卫', '蒋', '沈', '韩', '杨', '朱', '秦', '尤', '许',
  '何', '吕', '施', '张', '孔', '曹', '严', '华', '金', '魏',
  '陶', '姜', '戚', '谢', '邹', '喻', '柏', '水', '窦', '章',
  '云', '苏', '潘', '葛', '奚', '范', '彭', '郎', '鲁', '韦',
  '昌', '马', '苗', '凤', '花', '方', '俞', '任', '袁', '柳',
  '鲍', '史', '唐', '费', '廉', '岑', '薛', '雷', '贺', '倪',
  '汤', '滕', '殷', '罗', '毕', '郝', '邬', '安', '常', '乐',
  '于', '时', '傅', '皮', '齐', '康', '伍', '余', '元', '卜',
  '顾', '孟', '平', '黄', '和', '穆', '萧', '尹', '姚', '邵',
]

const CHINESE_GIVEN_NAMES = [
  '伟', '芳', '娜', '秀英', '敏', '静', '丽', '强', '磊', '军',
  '洋', '勇', '艳', '杰', '娟', '涛', '明', '超', '秀兰', '霞',
  '平', '刚', '桂英', '文', '斌', '玉兰', '欣', '宇', '萍', '玲',
  '浩', '建华', '婷', '成', '海', '晨', '思源', '子轩', '梓涵', '浩宇',
  '诗涵', '俊杰', '雨桐', '志强', '建国', '文静', '佳怡', '皓轩', '一诺', '依诺',
]

const CHINESE_CITIES = ['北京', '上海', '广州', '深圳', '杭州', '南京', '武汉', '成都', '西安', '苏州']
const CHINESE_INDUSTRIES = ['智能科技', '信息技术', '网络科技', '商贸', '电子商务', '创新软件', '文化传媒', '供应链管理']
const CHINESE_SUFFIXES = ['有限公司', '股份有限公司', '科技有限公司', '商贸中心']

const PHONE_PREFIXES = ['133', '135', '136', '137', '138', '139', '150', '151', '152', '153', '158', '159', '177', '180', '186', '188', '189', '198', '199']

function sample<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!
}

function randomDigits(length: number): string {
  let res = ''
  for (let i = 0; i < length; i++) {
    res += Math.floor(Math.random() * 10).toString()
  }
  return res
}

function randomChars(length: number, charset: string): string {
  let res = ''
  for (let i = 0; i < length; i++) {
    res += charset[Math.floor(Math.random() * charset.length)]
  }
  return res
}

function generateUuidV4(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function generateChineseIdCard(): string {
  const areaCode = sample(['110101', '310101', '440106', '330106', '320102', '510104'])
  const year = 1970 + Math.floor(Math.random() * 35)
  const month = String(1 + Math.floor(Math.random() * 12)).padStart(2, '0')
  const day = String(1 + Math.floor(Math.random() * 28)).padStart(2, '0')
  const seq = randomDigits(3)
  const prefix17 = `${areaCode}${year}${month}${day}${seq}`
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
  const checksumMap = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2']
  let sum = 0
  for (let i = 0; i < 17; i++) {
    sum += Number(prefix17[i]) * weights[i]!
  }
  const checksum = checksumMap[sum % 11]!
  return `${prefix17}${checksum}`
}

export function formatDate(date: Date, format: string): string {
  const YYYY = String(date.getFullYear())
  const MM = String(date.getMonth() + 1).padStart(2, '0')
  const DD = String(date.getDate()).padStart(2, '0')
  const HH = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  const ss = String(date.getSeconds()).padStart(2, '0')

  return format
    .replace(/YYYY/g, YYYY)
    .replace(/MM/g, MM)
    .replace(/DD/g, DD)
    .replace(/HH/g, HH)
    .replace(/mm/g, mm)
    .replace(/ss/g, ss)
}

export function evaluateGenerator(spec: DataGeneratorSpec): JsonValue {
  switch (spec.kind) {
    case 'fixed':
      return spec.value

    case 'random_number': {
      const min = Math.min(spec.min, spec.max)
      const max = Math.max(spec.min, spec.max)
      const precision = spec.precision ?? 0
      if (precision === 0) {
        return Math.floor(min + Math.random() * (max - min + 1))
      }
      const factor = 10 ** precision
      const raw = min + Math.random() * (max - min)
      return Math.round(raw * factor) / factor
    }

    case 'random_string': {
      const charset = CHARSETS[spec.charset ?? 'alphanumeric']
      const len = spec.length ?? 8
      const body = randomChars(len, charset)
      return `${spec.prefix ?? ''}${body}${spec.suffix ?? ''}`
    }

    case 'mock_preset': {
      switch (spec.preset) {
        case 'phone_cn':
          return `${sample(PHONE_PREFIXES)}${randomDigits(8)}`
        case 'email':
          return `user_${randomChars(6, CHARSETS.hex)}@test.com`
        case 'name_cn':
          return `${sample(CHINESE_SURNAMES)}${sample(CHINESE_GIVEN_NAMES)}`
        case 'uuid_v4':
          return generateUuidV4()
        case 'id_card_cn':
          return generateChineseIdCard()
        case 'company_cn':
          return `${sample(CHINESE_CITIES)}${sample(CHINESE_SURNAMES)}${sample(CHINESE_INDUSTRIES)}${sample(CHINESE_SUFFIXES)}`
      }
      break
    }

    case 'date_relative': {
      const minDays = Math.min(spec.offsetDaysMin ?? 0, spec.offsetDaysMax ?? 0)
      const maxDays = Math.max(spec.offsetDaysMin ?? 0, spec.offsetDaysMax ?? 0)
      const offsetDays = Math.floor(minDays + Math.random() * (maxDays - minDays + 1))
      const d = new Date()
      d.setDate(d.getDate() + offsetDays)
      return formatDate(d, spec.format || 'YYYY-MM-DD HH:mm:ss')
    }

    case 'template': {
      let result = spec.pattern
      result = result.replace(/\{\{date[.:]([A-Za-z0-9_\-:\s]+)\}\}/g, (_m, fmt) => formatDate(new Date(), fmt))
      result = result.replace(/\{\{(?:rand|alphanumeric)[.:](\d+)\}\}/g, (_m, lenStr) => randomChars(Number(lenStr), CHARSETS.alphanumeric))
      result = result.replace(/\{\{number[.:](\d+)\}\}/g, (_m, lenStr) => randomChars(Number(lenStr), CHARSETS.numeric))
      result = result.replace(/\{\{alpha[.:](\d+)\}\}/g, (_m, lenStr) => randomChars(Number(lenStr), CHARSETS.alpha))
      result = result.replace(/\{\{uuid\}\}/g, () => generateUuidV4())
      return result
    }

    case 'enum_sample': {
      if (!spec.options.length) return ''
      return sample(spec.options)
    }
  }
}

export function evaluateGeneratorWithUniqueness(
  spec: DataGeneratorSpec,
  key: string,
  usedSets: Map<string, Set<string | number>>,
): JsonValue {
  const isUnique = 'unique' in spec && Boolean(spec.unique)
  if (!isUnique) return evaluateGenerator(spec)

  let set = usedSets.get(key)
  if (!set) {
    set = new Set()
    usedSets.set(key, set)
  }

  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate = evaluateGenerator(spec)
    if (typeof candidate === 'string' || typeof candidate === 'number') {
      if (!set.has(candidate)) {
        set.add(candidate)
        return candidate
      }
    } else {
      return candidate
    }
  }
  throw new Error(`生成唯一键失败：在字段 ${key} 发生 100 次碰撞`)
}

export function materializeBatchInputs(
  schemaInputs: readonly ScenarioInputDecl[],
  rawRowInputs: Record<string, unknown>[],
  generatorSpecs?: Record<string, DataGeneratorSpec>,
): Record<string, JsonValue>[] {
  const usedUniqueValues = new Map<string, Set<string | number>>()

  return rawRowInputs.map((rawInputs) => {
    const result: Record<string, JsonValue> = { ...(rawInputs as Record<string, JsonValue>) }

    for (const inputDecl of schemaInputs) {
      if (result[inputDecl.key] !== undefined && result[inputDecl.key] !== null && result[inputDecl.key] !== '') {
        continue
      }

      const spec = generatorSpecs?.[inputDecl.key] ?? inputDecl.defaultGenerator
      if (spec) {
        result[inputDecl.key] = evaluateGeneratorWithUniqueness(spec, inputDecl.key, usedUniqueValues)
      }
    }
    return result
  })
}
