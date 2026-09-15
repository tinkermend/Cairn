import { mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { compileScenarioDocument, createScenarioBodySchema } from '../../packages/shared/dist/index.js'

const api = process.env.CAIRN_API_ORIGIN ?? 'http://127.0.0.1:3030'
const lab = process.env.FLOWGRAM_LAB_ORIGIN ?? 'http://127.0.0.1:4186'
const web = process.env.FLOWGRAM_WEB_ORIGIN ?? 'http://127.0.0.1:5186'
const login = await fetch(`${api}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: process.env.CAIRN_BOOTSTRAP_ADMIN_EMAIL ?? 'admin', password: process.env.CAIRN_BOOTSTRAP_ADMIN_PASSWORD ?? 'cairn-admin' }) })
if (!login.ok) throw new Error(`登录失败 ${login.status}`)
const auth = await login.json()
async function request(path, body) {
  const response = await fetch(`${api}/api${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${auth.accessToken}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
  const result = await response.json()
  if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(result)}`)
  return result
}
const code = 'flowgram-sequence-spike'
const targets = await request(`/targets?search=${code}&limit=100`)
const target = targets.items.find((item) => item.code === code) ?? await request('/targets', { code, name: 'FlowGram 接入验证 · 采购核对靶场', entryUrl: `${lab}/flowgram-orders.html`, loginUrl: `${lab}/flowgram-login.html`, authMethod: 'password', captchaMode: 'none', loginFields: { username: { by: 'id', value: 'username' }, password: { by: 'id', value: 'password' }, submit: { by: 'id', value: 'login-submit' } } })
const accounts = await request(`/targets/${target.id}/accounts`)
const account = accounts.items[0] ?? await request(`/targets/${target.id}/accounts`, { displayName: '采购核对测试账号', username: 'flowgram-lab', password: randomUUID() })
const locator = (value) => ({ framePath: [], candidates: [{ by: 'css', value }] })
const step = (type, name, input, extra = {}) => ({ id: randomUUID(), type, name, effectType: ['navigate', 'fill', 'ai_action'].includes(type) ? 'SIDE_EFFECT' : 'READ_ONLY', input, ...extra })
const steps = [
  step('navigate', '打开采购核对工作台', { url: `${lab}/flowgram-orders.html` }),
  step('fill', '输入采购客户名称', { target: locator('#customer'), value: '华东设备有限公司' }),
  step('ai_action', 'AI 查询该客户的订单', { instruction: '点击“查询订单”按钮，完成当前已填写客户的订单查询。不要修改客户名称，不要操作核对登记区域。' }, { policy: { timeoutMs: 90000, retryLimit: 0 } }),
  step('assert', '核对查询结果中的订单号', { target: locator('#order-number'), expect: { kind: 'text_equals', value: 'FG-2026-0108' } }),
  step('ai_extract', 'AI 提取订单号与应付金额', { instruction: '读取查询结果表格中唯一一行订单。orderNo 是订单号原文；amount 是应付金额，返回不含货币符号的两位小数字符串。只读取表格，不操作页面。', outputSchema: { kind: 'object', fields: [{ name: 'orderNo', type: 'string', required: true }, { name: 'amount', type: 'string', required: true }] } }, { outputKey: 'purchaseOrder', policy: { timeoutMs: 90000 } }),
  step('fill', '将 AI 提取的订单号填入核对表', { target: locator('#reconcile-order'), from: 'purchaseOrder', fromField: 'orderNo' }),
  step('fill', '将 AI 提取的金额填入核对表', { target: locator('#reconcile-amount'), from: 'purchaseOrder', fromField: 'amount' }),
  step('ai_action', 'AI 核对并登记采购订单', { instruction: '订单号和金额已填写。点击一次“核对并登记”按钮。不要修改字段，不要重复提交。' }, { policy: { timeoutMs: 90000, retryLimit: 0 } }),
  step('assert', '核对登记回执的订单与金额', { target: locator('#reconcile-result'), expect: { kind: 'text_equals', value: '已核对 · FG-2026-0108 · 1280.00' } }),
  step('ai_assert', 'AI 确认订单已完成且仅登记一次', { instruction: '判断页面是否同时满足：采购客户为华东设备有限公司；订单 FG-2026-0108、金额 1280.00 已核对；本页成功登记次数为 1。只读取页面，不执行操作。' }, { outputKey: 'businessCheck', policy: { timeoutMs: 90000 } }),
]
const body = createScenarioBodySchema.parse({ targetId: target.id, name: 'FlowGram · 采购订单核对（10 步混编）', steps })
const scenario = await request('/scenarios', body)
const compiled = compileScenarioDocument(scenario.draft.document, { mode: 'release', target: { exists: true, status: 'active' } })
if (!compiled.ok) throw new Error(JSON.stringify(compiled))
const result = { scenarioId: scenario.id, targetId: target.id, targetAccountId: account.id, revision: scenario.draft.revision, url: `${web}/scenarios/${scenario.id}?editor=flowgram`, steps: steps.map(({ id, name, type }) => ({ id, name, type })) }
const out = fileURLToPath(new URL('../../.artifacts/flowgram-spike/', import.meta.url))
await mkdir(out, { recursive: true })
await writeFile(`${out}/sample.json`, JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
