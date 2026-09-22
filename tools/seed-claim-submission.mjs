import { randomUUID } from 'node:crypto'

const apiOrigin = process.env.CAIRN_API_ORIGIN ?? 'http://127.0.0.1:3030'
const labOrigin = process.env.CAIRN_LAB_ORIGIN ?? 'http://127.0.0.1:4178'
const webOrigin = process.env.CAIRN_WEB_ORIGIN ?? 'http://127.0.0.1:5173'

console.log('>>> 正在登录 Cairn 管理员账号...')
const loginRes = await fetch(`${apiOrigin}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    email: process.env.CAIRN_BOOTSTRAP_ADMIN_EMAIL ?? 'admin',
    password: process.env.CAIRN_BOOTSTRAP_ADMIN_PASSWORD ?? 'cairn-admin',
  }),
})

if (!loginRes.ok) {
  const errText = await loginRes.text()
  throw new Error(`登录 API 失败 (${loginRes.status}): ${errText}`)
}

const auth = await loginRes.json()
const token = auth.accessToken

async function apiRequest(path, method = 'GET', body = undefined) {
  const headers = { authorization: `Bearer ${token}` }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
  }
  const res = await fetch(`${apiOrigin}/api${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    data = text
  }
  if (!res.ok) {
    throw new Error(`API 请求失败 ${method} ${path} [${res.status}]: ${JSON.stringify(data)}`)
  }
  return data
}

console.log('>>> 1. 检查/创建目标系统 (Target)...')
const targetCode = 'claim-submission-target'
const existingTargets = await apiRequest(`/targets?search=${targetCode}&limit=10`)
let target = existingTargets.items?.find((item) => item.code === targetCode)

if (!target) {
  target = await apiRequest('/targets', 'POST', {
    code: targetCode,
    name: '企业费用报销与材料提报系统',
    entryUrl: `${labOrigin}/file-submission.html`,
    authMethod: 'password',
    captchaMode: 'none',
  })
  console.log(`✅ 目标系统已创建: ${target.id} (${target.name})`)
} else {
  console.log(`ℹ️ 目标系统已存在: ${target.id} (${target.name})`)
}

console.log('>>> 2. 检查/创建业务账号 (Target Account)...')
const accounts = await apiRequest(`/targets/${target.id}/accounts`)
let account = accounts.items?.[0]
if (!account) {
  account = await apiRequest(`/targets/${target.id}/accounts`, 'POST', {
    displayName: '报销业务测试员',
    username: 'claim-tester',
    password: 'Password123!',
    validity: { mode: 'permanent' },
  })
  console.log(`✅ 业务账号已创建: ${account.id} (${account.username})`)
} else {
  console.log(`ℹ️ 业务账号已存在: ${account.id} (${account.username})`)
}

console.log('>>> 3. 检查/创建报销全流程场景 (Scenario)...')
const existingScenarios = await apiRequest(`/scenarios?targetId=${target.id}&limit=10`)
let scenario = existingScenarios.items?.find((s) => s.name === '企业费用报销提报及附件上传全流程')

const steps = [
  {
    id: randomUUID(),
    name: '打开费用报销申报系统',
    type: 'navigate',
    effectType: 'SIDE_EFFECT',
    input: {
      url: `${labOrigin}/file-submission.html`,
    },
  },
  {
    id: randomUUID(),
    name: '下载费用报销标准模板',
    type: 'download',
    effectType: 'SIDE_EFFECT',
    outputKey: 'templateCsv',
    input: {
      target: {
        framePath: [],
        candidates: [{ by: 'css', value: '#download-template-btn' }],
      },
      waitMs: 30000,
    },
  },
  {
    id: randomUUID(),
    name: '填写申请人姓名(必填)',
    type: 'fill',
    effectType: 'SIDE_EFFECT',
    input: {
      target: {
        framePath: [],
        candidates: [{ by: 'css', value: '#applicant-name' }],
      },
      value: '张三 (EMP-1002)',
    },
  },
  {
    id: randomUUID(),
    name: '选择业务类别(必填)',
    type: 'select',
    effectType: 'SIDE_EFFECT',
    input: {
      target: {
        framePath: [],
        candidates: [{ by: 'css', value: '#category-select' }],
      },
      by: 'value',
      value: 'INVOICE',
    },
  },
  {
    id: randomUUID(),
    name: '填写紧急联系电话(选填)',
    type: 'fill',
    effectType: 'SIDE_EFFECT',
    input: {
      target: {
        framePath: [],
        candidates: [{ by: 'css', value: '#emergency-phone' }],
      },
      value: '13800138000',
    },
  },
  {
    id: randomUUID(),
    name: '填写补充业务说明(选填)',
    type: 'fill',
    effectType: 'SIDE_EFFECT',
    input: {
      target: {
        framePath: [],
        candidates: [{ by: 'css', value: '#remarks' }],
      },
      value: '2026年Q3机房维护及采购发票提报申请',
    },
  },
  {
    id: randomUUID(),
    name: '勾选加急审批复选框(选填)',
    type: 'click',
    effectType: 'SIDE_EFFECT',
    input: {
      target: {
        framePath: [],
        candidates: [{ by: 'css', value: '#urgent-check' }],
      },
    },
  },
  {
    id: randomUUID(),
    name: '上传核心发票凭证(文件上传)',
    type: 'upload',
    effectType: 'SIDE_EFFECT',
    input: {
      target: {
        framePath: [],
        candidates: [{ by: 'css', value: '#invoice-file' }],
      },
      files: [
        {
          source: 'context',
          from: 'templateCsv',
        },
      ],
    },
  },
  {
    id: randomUUID(),
    name: '确认提交提报申请',
    type: 'click',
    effectType: 'SIDE_EFFECT',
    input: {
      target: {
        framePath: [],
        candidates: [{ by: 'css', value: '#submit-btn' }],
      },
    },
  },
  {
    id: randomUUID(),
    name: '等待结果反馈卡片可见',
    type: 'wait',
    effectType: 'READ_ONLY',
    input: {
      kind: 'visible',
      target: {
        framePath: [],
        candidates: [{ by: 'css', value: '#result-box' }],
      },
    },
  },
  {
    id: randomUUID(),
    name: '断言提报申请单号已生成',
    type: 'assert',
    effectType: 'READ_ONLY',
    input: {
      target: {
        framePath: [],
        candidates: [{ by: 'css', value: '#ticket-id' }],
      },
      expect: {
        kind: 'text_contains',
        value: 'CLAIM-',
      },
    },
  },
]

if (!scenario) {
  scenario = await apiRequest('/scenarios', 'POST', {
    targetId: target.id,
    name: '企业费用报销提报及附件上传全流程',
    steps,
  })
} else {
  console.log(`ℹ️ 场景已存在: ${scenario.id}`)
}
console.log('>>> 5. 在平台真实调度发起一次 Run (执行)...')
const run = await apiRequest('/runs', 'POST', {
  scenarioId: scenario.id,
})
console.log(`🚀 Run 已在平台成功排队入库: ID = ${run.id}`)

console.log('>>> 6. 等待后台 Worker 领取并完成执行...')
let finalRun = null
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 2000))
  finalRun = await apiRequest(`/runs/${run.id}`)
  process.stdout.write(`  [${i * 2}s] 状态: ${finalRun.status} (已执行步骤: ${finalRun.progress?.completedSteps ?? 0}/${finalRun.progress?.totalSteps ?? steps.length})\r`)
  if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(finalRun.status)) {
    console.log('')
    break
  }
}

console.log(`\n>>> 执行结果: ${finalRun.status}`)
if (finalRun.status !== 'SUCCEEDED') {
  console.error('❌ 执行未成功，错误详情:', JSON.stringify(finalRun.error, null, 2))
} else {
  console.log('🎉 恭喜！平台后台真实 Worker 已成功执行该场景全流程！')
}

console.log('\n=============================================')
console.log('📌 请前往平台 Web 控制台进行可视化手动验证：')
console.log(`1. 目标系统详情: ${webOrigin}/targets/${target.id}`)
console.log(`2. 场景编排工作台: ${webOrigin}/scenarios/${scenario.id}`)
console.log(`3. 运行记录与执行事实: ${webOrigin}/runs/${run.id}`)
console.log(`4. 证据中心(包含下载的模板文件证据): ${webOrigin}/evidence`)
console.log('=============================================\n')
