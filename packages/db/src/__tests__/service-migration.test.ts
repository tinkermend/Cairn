import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { openIsolatedDb } from '../testing.js'
import { migrate } from '../migrate.js'
import { newId } from '../id.js'

it('service target FKs use the requested schema and repair applied 0019 without losing grants', async () => {
  const h = await openIsolatedDb(`service_fk_${Date.now()}`)
  const dir = mkdtempSync(join(tmpdir(), 'service-migration-'))
  const schema = 'service_upgrade'
  const source = resolve(import.meta.dirname, '../../migrations')
  const expectedApplied = readdirSync(source)
    .filter((file) => file.endsWith('.sql') && file >= '0020')
    .sort()
  try {
    for (const file of readdirSync(source).filter(f => f.endsWith('.sql') && f < '0020'))
      copyFileSync(join(source, file), join(dir, file))
    // Pool search_path remains cairn,public, deliberately different from the destination.
    await migrate(h.pool, schema, dir)
    const referencedSchema = async () => (await h.pool.query(
      `SELECT n.nspname FROM pg_constraint c
       JOIN pg_class t ON t.oid=c.confrelid JOIN pg_namespace n ON n.oid=t.relnamespace
       WHERE c.conrelid=$1::regclass AND c.conname='credential_target_grants_target_id_fkey'`,
      [`${schema}.credential_target_grants`],
    )).rows[0]!.nspname
    expect(await referencedSchema()).toBe(schema)
    const actorId = newId(), targetId = newId(), callerId = newId(), credentialId = newId()
    await h.pool.query(`INSERT INTO "${schema}".console_accounts(id,display_name) VALUES ($1,'迁移测试')`, [actorId])
    for (const ns of [schema, 'cairn'])
      await h.pool.query(`INSERT INTO "${ns}".targets(id,code,name,entry_url) VALUES ($1,'migration-target','迁移目标','https://example.com')`, [targetId])
    await h.pool.query(`INSERT INTO "${schema}".service_callers(id,name,owner) VALUES ($1,'应用','测试')`, [callerId])
    await h.pool.query(`INSERT INTO "${schema}".service_credentials
      (id,caller_id,name,secret_digest,scopes,expires_at,created_by_console_account_id)
      VALUES ($1,$2,'fixture',repeat('0',64),'["run:execute"]',now()+interval '1 day',$3)`,
      [credentialId, callerId, actorId])
    await h.pool.query(`INSERT INTO "${schema}".credential_target_grants(credential_id,target_id) VALUES ($1,$2)`, [credentialId, targetId])
    const oldConstraint = async () => h.pool.query(`ALTER TABLE "${schema}".credential_target_grants
      DROP CONSTRAINT credential_target_grants_target_id_fkey,
      ADD CONSTRAINT credential_target_grants_target_id_fkey FOREIGN KEY(target_id) REFERENCES cairn.targets(id) ON DELETE RESTRICT`)
    // Reproduce an already recorded 0019 whose unqualified FK resolved to cairn.targets.
    await oldConstraint()
    expect(await referencedSchema()).toBe('cairn')
    expect((await migrate(h.pool, schema)).applied).toEqual(expectedApplied)
    expect(await referencedSchema()).toBe(schema)
    expect((await h.pool.query(`SELECT credential_id,target_id FROM "${schema}".credential_target_grants`)).rows)
      .toEqual([{ credential_id: credentialId, target_id: targetId }])
    await expect(h.pool.query(`INSERT INTO "${schema}".credential_target_grants(credential_id,target_id) VALUES ($1,$2)`,
      [credentialId, newId()])).rejects.toMatchObject({ code: '23503' })
    expect((await migrate(h.pool, schema)).applied).toEqual([])

    // A wrong historical grant must block repair atomically, never be dropped or silently accepted.
    const foreignTarget = newId()
    await h.pool.query(`INSERT INTO cairn.targets(id,code,name,entry_url) VALUES ($1,'foreign-only','异库目标','https://example.com')`, [foreignTarget])
    await oldConstraint()
    await h.pool.query(`INSERT INTO "${schema}".credential_target_grants(credential_id,target_id) VALUES ($1,$2)`, [credentialId, foreignTarget])
    await h.pool.query(`DELETE FROM "${schema}"._migrations WHERE prefix='0020'`)
    await expect(migrate(h.pool, schema)).rejects.toThrow('0020_service_target_foreign_key.sql')
    expect(await referencedSchema()).toBe('cairn')
    expect((await h.pool.query(`SELECT * FROM "${schema}".credential_target_grants`)).rows).toHaveLength(2)
    expect((await h.pool.query(`SELECT * FROM "${schema}"._migrations WHERE prefix='0020'`)).rows).toHaveLength(0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    await h.close()
  }
})

it('repairs a historically recorded 0082 when its Webhook tables are absent', async () => {
  const h = await openIsolatedDb(`service_webhook_repair_${Date.now()}`)
  const dir = mkdtempSync(join(tmpdir(), 'service-webhook-repair-'))
  const schema = 'service_webhook_repair'
  const source = resolve(import.meta.dirname, '../../migrations')
  try {
    // Reproduce the faulty historical state without changing production
    // migration history: all predecessors are applied, 0082 is recorded, but
    // its tables do not exist. The repair must be the only remaining action.
    for (const file of readdirSync(source).filter((file) => file.endsWith('.sql') && file < '0082'))
      copyFileSync(join(source, file), join(dir, file))
    await migrate(h.pool, schema, dir)
    await h.pool.query(
      `INSERT INTO "${schema}"._migrations(prefix, filename) VALUES ('0082', '0082_service_webhooks.sql')`,
    )

    const result = await migrate(h.pool, schema)
    expect(result.applied).toEqual(['0083_service_webhooks_repair.sql'])
    expect(result.skipped).toContain('0082_service_webhooks.sql')

    const tables = await h.pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables
       WHERE schemaname = $1 AND tablename = ANY($2::text[])
       ORDER BY tablename`,
      [schema, ['service_webhook_deliveries', 'service_webhooks']],
    )
    expect(tables.rows.map((row) => row.tablename)).toEqual([
      'service_webhook_deliveries',
      'service_webhooks',
    ])
    const indexes = await h.pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = $1 AND tablename = 'service_webhook_deliveries'
       ORDER BY indexname`,
      [schema],
    )
    expect(indexes.rows.map((row) => row.indexname)).toEqual(
      expect.arrayContaining([
        'service_webhook_deliveries_due_idx',
        'service_webhook_deliveries_claim_idx',
        'service_webhook_deliveries_caller_created_idx',
      ]),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
    await h.close()
  }
})
