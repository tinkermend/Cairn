import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  allocateMigration,
  assertTransferUsesDerivedVersion,
  inspectMigrations,
} from './migrations.mjs'

function tree() {
  const root = mkdtempSync(join(tmpdir(), 'cairn-mig-alloc-'))
  writeFileSync(join(root, '0001_baseline.sql'), '-- noop\n')
  // 冻结的历史链：不参与检查，也不再领号。
  mkdirSync(join(root, 'mysql'))
  writeFileSync(join(root, 'mysql', '0001_baseline.sql'), '-- noop\n')
  return root
}

describe('inspectMigrations', () => {
  it('拦住重复前缀和缺号', () => {
    const root = tree()
    writeFileSync(join(root, '0001_dup.sql'), '-- noop\n')
    writeFileSync(join(root, '0004_gap.sql'), '-- noop\n')
    const { errors } = inspectMigrations(root)
    assert.match(errors.join('\n'), /前缀重复：0001/)
    assert.match(errors.join('\n'), /序号不连续：期望 0003/)
  })

  it('不检查冻结的 mysql 历史链', () => {
    const root = tree()
    writeFileSync(join(root, 'mysql', '0003_gap.sql'), '-- noop\n')
    assert.deepEqual(inspectMigrations(root).errors, [])
  })
})

describe('allocateMigration', () => {
  it('锁内并发领取得到连续且不同的号', async () => {
    const root = tree()
    const lockPath = join(root, '.alloc.lock')
    const [first, second] = await Promise.all([
      allocateMigration({ name: 'alpha', migrationsRoot: root, lockPath }),
      allocateMigration({ name: 'beta', migrationsRoot: root, lockPath }),
    ])
    assert.deepEqual([first.logicalVersion, second.logicalVersion].sort(), ['0002', '0003'])
    const names = readdirSync(root).filter((f) => f.endsWith('.sql')).sort()
    assert.equal(names.length, 3)
    assert.ok(names.includes('0001_baseline.sql'))
    assert.deepEqual(first.files.length, 1)
    assert.deepEqual(readdirSync(join(root, 'mysql')), ['0001_baseline.sql'])
  })

  it('拒绝已占用的名字和非法名字', async () => {
    const root = tree()
    const lockPath = join(root, '.alloc.lock')
    await allocateMigration({ name: 'alpha', migrationsRoot: root, lockPath })
    await assert.rejects(
      () => allocateMigration({ name: 'alpha', migrationsRoot: root, lockPath }),
      /已被占用/,
    )
    await assert.rejects(
      () => allocateMigration({ name: 'Foo', migrationsRoot: root, lockPath }),
      /不合规范/,
    )
  })

  it('目录不连续时拒绝领取', async () => {
    const root = tree()
    writeFileSync(join(root, '0003_gap.sql'), '-- noop\n')
    await assert.rejects(
      () => allocateMigration({ name: 'next', migrationsRoot: root, lockPath: join(root, '.lock') }),
      /现有迁移不完整/,
    )
  })
})

describe('assertTransferUsesDerivedVersion', () => {
  it('要求跟目录派生，拒绝手写四位数', () => {
    assert.equal(assertTransferUsesDerivedVersion("const LOGICAL_VERSION = latestLogicalVersion()\n"), null)
    assert.match(
      assertTransferUsesDerivedVersion("const LOGICAL_VERSION = '0034'\n"),
      /latestLogicalVersion/,
    )
    assert.match(
      assertTransferUsesDerivedVersion("const LOGICAL_VERSION = latestLogicalVersion()\nconst x = z.literal('0034')\n"),
      /禁止手写/,
    )
  })
})
