import type { AccountDto } from '@cairn/shared'
export type PersistenceActor = Pick<
  AccountDto,
  'id' | 'displayName' | 'email' | 'status' | 'roles' | 'permissions'
>
