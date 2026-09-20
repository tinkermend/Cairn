import { LOCAL_SECRET_PROVIDER } from '@cairn/shared'
import type { Db } from '../client.js'
import { schemaFor } from '../native.js'
import { eq } from 'drizzle-orm'

/** 登记一条不绑定 TargetAccount 的独立 Secret，供模型密钥等使用。 */
export async function registerStandaloneSecret(
  db: Db,
  input: { id: string; ciphertext: Buffer },
): Promise<{ id: string }> {
  const now = new Date()
  const { secrets: table } = schemaFor(db)
  await db.insert(table).values({
    id: input.id,
    provider: LOCAL_SECRET_PROVIDER,
    ciphertext: input.ciphertext,
    createdAt: now,
    updatedAt: now,
  })
  return { id: input.id }
}

/** 读取 secrets 密文（不解密）。 */
export async function loadSecretCiphertext(
  db: Db,
  secretId: string,
): Promise<{ id: string; provider: string; ciphertext: Buffer } | null> {
  const { secrets } = schemaFor(db)
  const [row] = await db.select().from(secrets).where(eq(secrets.id, secretId)).limit(1)
  if (!row) return null
  return { id: row.id, provider: row.provider, ciphertext: row.ciphertext }
}

/** 登记或覆盖独立 Secret。须在 OCC 成功之后、同一事务内调用。 */
export async function upsertStandaloneSecret(
  db: Db,
  input: { id: string; ciphertext: Buffer },
): Promise<{ id: string }> {
  const existing = await loadSecretCiphertext(db, input.id)
  if (!existing) return registerStandaloneSecret(db, input)
  const now = new Date()
  const { secrets: table } = schemaFor(db)
  await db.update(table).set({ ciphertext: input.ciphertext, updatedAt: now }).where(eq(table.id, input.id))
  return { id: input.id }
}
