import { z } from 'zod'

/**
 * TargetAccount 凭据引用。只指向 SecretProvider 里的一条记录，不带明文。
 *
 * `strictObject` 是这条契约的实际牙齿：多写 `password` / `value` / `secret`
 * 必须失败，而不是被静默丢掉后当成「已经引用化」。
 */

export const LOCAL_SECRET_PROVIDER = 'local'

export const secretRefSchema = z.strictObject({
  /** 不封闭枚举。本地实现用 `local`，Vault / KMS 到来时加新名字，不必改形状。 */
  provider: z.string().min(1).max(64),
  secretId: z.string().min(1).max(256),
})
export type SecretRef = z.infer<typeof secretRefSchema>
