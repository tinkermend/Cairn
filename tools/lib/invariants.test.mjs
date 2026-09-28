import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { INVARIANT_RULES } from '../check-invariants.mjs'
import { importSpecifiers, isTestFile } from './source-scan.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const rule = (id) => INVARIANT_RULES.find((r) => r.id.startsWith(id))
const check = (id, rel, content) => rule(id).check(resolve(root, rel), rel, content)

describe('规则表', () => {
  it('每条规则引用的宪法条款都是 CLAUDE.md 里现存的 ### 标题', () => {
    const headings = new Set(
      [...readFileSync(resolve(root, 'CLAUDE.md'), 'utf8').matchAll(/^###\s+(.+?)\s*$/gm)].map((m) => m[1]),
    )
    for (const r of INVARIANT_RULES) {
      for (const article of r.articles) assert.ok(headings.has(article), `${r.id} 引用了不存在的条款「${article}」`)
    }
  })

  it('规则 ID 不重复，已删除的编号不复用', () => {
    const prefixes = INVARIANT_RULES.map((r) => r.id.slice(0, 6))
    assert.equal(new Set(prefixes).size, prefixes.length)
    for (const retired of ['INV004', 'INV005', 'INV006']) assert.ok(!prefixes.includes(retired))
  })
})

describe('INV002 Worker 不持有控制面地址', () => {
  const rel = 'packages/worker/src/x.ts'
  it('读取 CAIRN_API_PORT / CAIRN_API_ORIGIN 即违规', () => {
    assert.equal(check('INV002', rel, 'const p = process.env.CAIRN_API_PORT').length, 1)
    assert.equal(check('INV002', rel, "env['CAIRN_API_ORIGIN']").length, 1)
  })
  it('目标系统的 /api/v1/ 地址与 HTTP 客户端不受限', () => {
    assert.deepEqual(check('INV002', rel, "import ky from 'ky'\nawait ky.get('https://erp.example.com/api/v1/orders')"), [])
  })
})

describe('INV003 快照冻结', () => {
  const rel = 'packages/db/src/runs/x.ts'
  it('drizzle update().set() 显式写冻结列即违规', () => {
    assert.equal(check('INV003', rel, 'await tx.update(runs).set({ snapshot: next }).where(w)').length, 1)
    assert.equal(check('INV003', rel, 'await db.update(scenarioVersions).set({ definition }).where(w)').length, 1)
  })
  it('适配层 updateRows / updateRowsCount 同样拦截', () => {
    assert.equal(check('INV003', rel, 'await updateRows(tx, runs, { status, snapshot }, w)').length, 1)
    assert.equal(check('INV003', rel, 'await native.updateRowsCount(tx, runs, { "snapshot": s }, w)').length, 1)
  })
  it('原生 SQL 改写也拦截', () => {
    assert.equal(check('INV003', rel, 'sql`UPDATE cairn.runs SET snapshot = ${s}`').length, 1)
  })
  it('更新其它列、其它表或展开补丁不拦', () => {
    const ok = [
      'await tx.update(runs).set({ status: "SUCCEEDED", eventSeq: 1 }).where(w)',
      'await tx.update(runs).set({ ...patch }).where(w)',
      'await tx.update(analysisRuns).set({ snapshot }).where(w)',
      'await updateRows(tx, scenarioVersions, { versionNo: 2 }, w)',
    ]
    for (const source of ok) assert.deepEqual(check('INV003', rel, source), [], source)
  })
})

describe('INV018 运行读取带 actorId', () => {
  const service = 'packages/api/src/browser-sessions/browser-sessions.service.ts'
  const owner = (arg) => `import { getRunSessionOwner } from '@cairn/db'
class S { private async resolveRunOwner(id: string) { return getRunSessionOwner(this.handle, ${arg}) } }`
  it('会话占用者解析的豁免不依赖实参写法', () => {
    assert.deepEqual(check('INV018', service, owner('ownerId')), [])
    assert.deepEqual(check('INV018', service, owner('id')), [])
  })
  it('豁免之外缺 actorId 仍拦截', () => {
    assert.equal(check('INV018', 'packages/api/src/runs/x.ts', "import { getRun } from '@cairn/db'\ngetRun(db, id)").length, 1)
    assert.equal(check('INV018', 'packages/api/src/runs/x.ts', owner('id')).length, 1)
  })
})

describe('source-scan 口径', () => {
  it('testing/ 与 __tests__/ 目录、spec/test 文件都算测试', () => {
    assert.ok(isTestFile(['', 'p', 'src', 'testing', 'fake.ts'].join(sep)))
    assert.ok(isTestFile(['', 'p', 'src', '__tests__', 'a.ts'].join(sep)))
    assert.ok(isTestFile('/p/src/a.spec.ts'))
    assert.ok(!isTestFile('/p/src/contest.ts'))
  })
  it('注释里的模块名不算 import，URL 不被当作注释', () => {
    const source = "// import 'midscene'\nimport a from './a.js'\nconst u = 'http://x/y'\nconst b = await import('b')"
    assert.deepEqual(importSpecifiers(source), ['./a.js', 'b'])
  })
})
