import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from '../migrate.js'

function fixture(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'cairn-mig-'))
  for (const f of files) writeFileSync(join(dir, f), '-- noop\n')
  return dir
}

describe('loadMigrations', () => {
  it('按前缀顺序读取', () => {
    const dir = fixture(['0002_second.sql', '0001_first.sql'])
    expect(loadMigrations(dir).map((m) => m.prefix)).toEqual(['0001', '0002'])
  })

  it('拒绝重复前缀（前一代出现过两个 0005、两个 0018）', () => {
    const dir = fixture(['0001_a.sql', '0002_b.sql', '0002_c.sql'])
    expect(() => loadMigrations(dir)).toThrow(/前缀重复.*0002/)
  })

  it('拒绝缺号（前一代缺失 0016，历史不完整）', () => {
    const dir = fixture(['0001_a.sql', '0003_c.sql'])
    expect(() => loadMigrations(dir)).toThrow(/序号不连续.*0002/)
  })

  it('拒绝不合规范的文件名', () => {
    const dir = fixture(['init.sql'])
    expect(() => loadMigrations(dir)).toThrow(/文件名不合规范/)
  })

  it('真实迁移目录能通过全部校验', () => {
    const migrations = loadMigrations()
    expect(migrations.length).toBeGreaterThan(0)
    expect(migrations[0]?.prefix).toBe('0001')
    expect(migrations[0]?.sql).toContain('__SCHEMA__')
  })
})
