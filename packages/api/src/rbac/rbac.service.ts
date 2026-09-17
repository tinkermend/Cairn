import { Inject, Injectable } from '@nestjs/common'
import { RbacStore, type DbHandle } from '@cairn/db'
import { DB_HANDLE } from '../db/db.module'
import { rethrowDomain } from '../common/domain-error'
import { hashSecret, verifySecret } from '../auth/password'

@Injectable()
export class RbacService {
  private readonly store: RbacStore
  constructor(@Inject(DB_HANDLE) database: DbHandle) {
    this.store = new RbacStore(database, { hash: hashSecret, verify: verifySecret })
  }

  listPermissions(...args: Parameters<RbacStore['listPermissions']>) {
    return this.store.listPermissions(...args)
  }

  reconcileSystemRolePermissions(...args: Parameters<RbacStore['reconcileSystemRolePermissions']>) {
    return this.store.reconcileSystemRolePermissions(...args).catch(rethrowDomain)
  }

  listRoles(...args: Parameters<RbacStore['listRoles']>) {
    return this.store.listRoles(...args).catch(rethrowDomain)
  }

  getRole(...args: Parameters<RbacStore['getRole']>) {
    return this.store.getRole(...args).catch(rethrowDomain)
  }

  createRole(...args: Parameters<RbacStore['createRole']>) {
    return this.store.createRole(...args).catch(rethrowDomain)
  }

  updateRole(...args: Parameters<RbacStore['updateRole']>) {
    return this.store.updateRole(...args).catch(rethrowDomain)
  }

  replaceRolePermissions(...args: Parameters<RbacStore['replaceRolePermissions']>) {
    return this.store.replaceRolePermissions(...args).catch(rethrowDomain)
  }

  deleteRole(...args: Parameters<RbacStore['deleteRole']>) {
    return this.store.deleteRole(...args).catch(rethrowDomain)
  }

  listRoleAccounts(...args: Parameters<RbacStore['listRoleAccounts']>) {
    return this.store.listRoleAccounts(...args).catch(rethrowDomain)
  }

  addRoleAccounts(...args: Parameters<RbacStore['addRoleAccounts']>) {
    return this.store.addRoleAccounts(...args).catch(rethrowDomain)
  }

  removeRoleAccounts(...args: Parameters<RbacStore['removeRoleAccounts']>) {
    return this.store.removeRoleAccounts(...args).catch(rethrowDomain)
  }

  listAccounts(...args: Parameters<RbacStore['listAccounts']>) {
    return this.store.listAccounts(...args).catch(rethrowDomain)
  }

  getAccount(...args: Parameters<RbacStore['getAccount']>) {
    return this.store.getAccount(...args).catch(rethrowDomain)
  }

  getMe(...args: Parameters<RbacStore['getMe']>) {
    return this.store.getMe(...args).catch(rethrowDomain)
  }

  updateMe(...args: Parameters<RbacStore['updateMe']>) {
    return this.store.updateMe(...args).catch(rethrowDomain)
  }

  createAccount(...args: Parameters<RbacStore['createAccount']>) {
    return this.store.createAccount(...args).catch(rethrowDomain)
  }

  updateAccount(...args: Parameters<RbacStore['updateAccount']>) {
    return this.store.updateAccount(...args).catch(rethrowDomain)
  }

  deleteAccount(...args: Parameters<RbacStore['deleteAccount']>) {
    return this.store.deleteAccount(...args).catch(rethrowDomain)
  }

  assignAccountRoles(...args: Parameters<RbacStore['assignAccountRoles']>) {
    return this.store.assignAccountRoles(...args).catch(rethrowDomain)
  }

  changePassword(...args: Parameters<RbacStore['changePassword']>) {
    return this.store.changePassword(...args).catch(rethrowDomain)
  }

  setPassword(...args: Parameters<RbacStore['setPassword']>) {
    return this.store.setPassword(...args).catch(rethrowDomain)
  }

  createLocalIdentity(...args: Parameters<RbacStore['createLocalIdentity']>) {
    return this.store.createLocalIdentity(...args).catch(rethrowDomain)
  }

  recordAudit(...args: Parameters<RbacStore['recordAudit']>) {
    return this.store.recordAudit(...args).catch(rethrowDomain)
  }

  listAuditEvents(...args: Parameters<RbacStore['listAuditEvents']>) {
    return this.store.listAuditEvents(...args).catch(rethrowDomain)
  }

  listLoginAuditEvents(...args: Parameters<RbacStore['listLoginAuditEvents']>) {
    return this.store.listLoginAuditEvents(...args).catch(rethrowDomain)
  }

  completeSuccessfulLogin(...args: Parameters<RbacStore['completeSuccessfulLogin']>) {
    return this.store.completeSuccessfulLogin(...args).catch(rethrowDomain)
  }

  recordLoginFailure(...args: Parameters<RbacStore['recordLoginFailure']>) {
    return this.store.recordLoginFailure(...args).catch(rethrowDomain)
  }
}
