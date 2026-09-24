import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { checkMigrationSql, compareWithBaseline, countCodeHits } from './portability.mjs'

const rules = (sql) => checkMigrationSql('0200_x.sql', sql).map((i) => i.rule)

describe('checkMigrationSql', () => {
  it('放过各库都有对应物的通用 DDL', () => {
    const sql = `CREATE TABLE t (
  id UUID PRIMARY KEY,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('A', 'B'))
);
CREATE UNIQUE INDEX t_status ON t (status, at);
ALTER TABLE t ADD COLUMN note VARCHAR(64) NULL;
INSERT INTO t (id, status) SELECT 'x', 'A' WHERE NOT EXISTS (SELECT 1 FROM t WHERE id = 'x');`
    assert.deepEqual(rules(sql), [])
  })

  it('拦住触发器、DO 块、条件索引、upsert、数组与数据库生成 ID', () => {
    assert.deepEqual(rules('CREATE OR REPLACE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN END $$;'), ['function'])
    assert.deepEqual(rules('CREATE TRIGGER tr BEFORE UPDATE ON t FOR EACH ROW EXECUTE FUNCTION f();'), ['trigger'])
    assert.deepEqual(rules("DO $$ BEGIN UPDATE t SET a = 1; END $$;"), ['do-block'])
    assert.deepEqual(rules("CREATE UNIQUE INDEX u ON t (k) WHERE state = 'ACTIVE';"), ['partial-index'])
    assert.deepEqual(rules('INSERT INTO t (id) VALUES (1) ON CONFLICT DO NOTHING;'), ['upsert'])
    assert.deepEqual(rules('ALTER TABLE t ADD COLUMN tags TEXT[] NOT NULL;'), ['array-type'])
    assert.deepEqual(rules('INSERT INTO t (id) VALUES (gen_random_uuid());'), ['db-uuid'])
  })

  it('字符串字面量里的关键字不误报', () => {
    assert.deepEqual(rules("UPDATE t SET note = 'ON CONFLICT DO trigger ->>';"), [])
  })

  it('单条语句可带原因豁免，没有原因不算', () => {
    assert.deepEqual(rules("-- portability-exception: 一次性历史修复\nCREATE UNIQUE INDEX u ON t (k) WHERE a;"), [])
    assert.deepEqual(rules('-- portability-exception:\nCREATE UNIQUE INDEX u ON t (k) WHERE a;'), ['partial-index'])
  })
})

describe('countCodeHits / compareWithBaseline', () => {
  it('统计方言写法并忽略注释', () => {
    const src = "// data->>'a' 旧写法\nconst q = sql`${c}->>'a'`\nawait db.insert(t).values(v).returning()\n"
    assert.deepEqual(countCodeHits(src), { 'json-operator': 1, returning: 1 })
  })

  it('新增命中失败，减少命中提示收紧', () => {
    const baseline = { 'a.ts': { returning: 2 } }
    assert.equal(compareWithBaseline({ 'a.ts': { returning: 2 } }, baseline).errors.length, 0)
    assert.equal(compareWithBaseline({ 'a.ts': { returning: 3 } }, baseline).errors.length, 1)
    assert.equal(compareWithBaseline({ 'b.ts': { ilike: 1 } }, baseline).errors.length, 1)
    assert.deepEqual(compareWithBaseline({}, baseline).shrunk, ['a.ts：returning 2 → 0'])
  })
})
