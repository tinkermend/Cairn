import { Inject, Injectable } from '@nestjs/common'
import { TargetsStore, type DbHandle } from '@cairn/db'
import { DB_HANDLE } from '../db/db.module'
import { rethrowDomain } from '../common/domain-error'
import { LocalSecretProvider } from '../secrets/local-secret-provider'

@Injectable()
export class TargetsService {
  private readonly store: TargetsStore
  constructor(@Inject(DB_HANDLE) database: DbHandle, secretProvider: LocalSecretProvider) {
    this.store = new TargetsStore(database, (id, password) => secretProvider.encrypt(id, password))
  }

  listTargets(...args: Parameters<TargetsStore['listTargets']>) {
    return this.store.listTargets(...args).catch(rethrowDomain)
  }

  getTarget(...args: Parameters<TargetsStore['getTarget']>) {
    return this.store.getTarget(...args).catch(rethrowDomain)
  }

  createTarget(...args: Parameters<TargetsStore['createTarget']>) {
    return this.store.createTarget(...args).catch(rethrowDomain)
  }

  updateTarget(...args: Parameters<TargetsStore['updateTarget']>) {
    return this.store.updateTarget(...args).catch(rethrowDomain)
  }

  deleteTarget(...args: Parameters<TargetsStore['deleteTarget']>) {
    return this.store.deleteTarget(...args).catch(rethrowDomain)
  }

  listAccounts(...args: Parameters<TargetsStore['listAccounts']>) {
    return this.store.listAccounts(...args).catch(rethrowDomain)
  }

  createAccount(...args: Parameters<TargetsStore['createAccount']>) {
    return this.store.createAccount(...args).catch(rethrowDomain)
  }

  updateAccount(...args: Parameters<TargetsStore['updateAccount']>) {
    return this.store.updateAccount(...args).catch(rethrowDomain)
  }

  deleteAccount(...args: Parameters<TargetsStore['deleteAccount']>) {
    return this.store.deleteAccount(...args).catch(rethrowDomain)
  }
}
