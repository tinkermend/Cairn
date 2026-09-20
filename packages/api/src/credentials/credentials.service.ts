import { Inject, Injectable } from '@nestjs/common'
import {
  createCredentialBatch,
  getCredential,
  getCredentialBatch,
  listCredentialHistory,
  listCredentialUsages,
  listCredentials,
  newId,
  registerCredential,
  DomainError,
  clearCredential,
  resolveCredentialImport,
  credentialOwnerCandidates,
  replaceCredentialMaterial,
  revokeCredentialVersion,
  setCredentialEnabled,
  submitCredentialBatchItem,
  submitSealedBatchPassword,
  updateCredentialMetadata,
  type DbHandle,
} from '@cairn/db'
import {
  LOCAL_SECRET_PROVIDER,
  canonicalJson,
  hasPermission,
  type CredentialBatchCreateBody,
  type CredentialBatchItemSubmitBody,
  type CredentialHistoryQuery,
  type CredentialListQuery,
  type CredentialMetadataBody,
  type CredentialRegisterBody,
  type CredentialReplaceBody,
  type CredentialRevisionBody,
  type CredentialImportResolveBody,
} from '@cairn/shared'
import { rethrowDomain } from '../common/domain-error.js'
import type { RequestAccount } from '../common/request-account'
import { DB_HANDLE } from '../db/db.module'
import { LocalSecretProvider } from '../secrets/local-secret-provider'

@Injectable()
export class CredentialsService {
  constructor(
    @Inject(DB_HANDLE) private readonly database: DbHandle,
    private readonly secrets: LocalSecretProvider,
  ) {}

  private actor(account: RequestAccount) {
    return { id: account.id }
  }

  private options(account: RequestAccount) {
    return { canReadSession: hasPermission(account.permissions, 'session:read') }
  }

  private seal(value: string) {
    const id = newId()
    return { id, provider: LOCAL_SECRET_PROVIDER, ciphertext: this.secrets.encrypt(id, value) }
  }

  list(query: CredentialListQuery, account: RequestAccount) {
    return listCredentials(this.database, query, this.actor(account), this.options(account)).catch(rethrowDomain)
  }

  resolve(body: CredentialImportResolveBody, account: RequestAccount) {
    return resolveCredentialImport(this.database, body, this.actor(account)).catch(rethrowDomain)
  }

  owners(id: string, account: RequestAccount) {
    return credentialOwnerCandidates(this.database, id, this.actor(account)).catch(rethrowDomain)
  }

  get(credentialId: string, account: RequestAccount) {
    return getCredential(this.database, credentialId, this.actor(account), this.options(account)).catch(rethrowDomain)
  }

  usages(credentialId: string, account: RequestAccount) {
    return listCredentialUsages(this.database, credentialId, this.actor(account)).catch(rethrowDomain)
  }

  history(credentialId: string, query: CredentialHistoryQuery, account: RequestAccount) {
    return listCredentialHistory(this.database, credentialId, query, this.actor(account)).catch(rethrowDomain)
  }

  async register(body: CredentialRegisterBody, account: RequestAccount) {
    try {
      if (body.type !== 'target_password') throw new DomainError('bad_request', 'CREDENTIAL_TYPE_ACTION_UNSUPPORTED', '此处仅管理目标账号凭据')
      const material = body.password
      const sealed = material ? this.seal(material) : null
      return await registerCredential(this.database, body, this.actor(account), sealed)
    } catch (error) {
      rethrowDomain(error)
    }
  }

  metadata(credentialId: string, body: CredentialMetadataBody, account: RequestAccount) {
    return updateCredentialMetadata(this.database, credentialId, body, this.actor(account)).catch(rethrowDomain)
  }

  async replace(credentialId: string, body: CredentialReplaceBody, account: RequestAccount) {
    try {
      const material = body.password
      if (!material) {
        throw new DomainError('bad_request', 'CREDENTIAL_MATERIAL_UNAVAILABLE', '替换必须提供秘密材料')
      }
      const sealed = this.seal(material)
      return await replaceCredentialMaterial(this.database, credentialId, body, this.actor(account), sealed)
    } catch (error) {
      rethrowDomain(error)
    }
  }

  disable(credentialId: string, body: CredentialRevisionBody, account: RequestAccount) {
    return setCredentialEnabled(this.database, credentialId, body, false, this.actor(account)).catch(rethrowDomain)
  }

  clear(id: string, body: CredentialRevisionBody, account: RequestAccount, remove = false) {
    return clearCredential(this.database, id, body, this.actor(account), remove).catch(rethrowDomain)
  }

  enable(credentialId: string, body: CredentialRevisionBody, account: RequestAccount) {
    return setCredentialEnabled(this.database, credentialId, body, true, this.actor(account)).catch(rethrowDomain)
  }

  revoke(credentialId: string, versionId: string, body: CredentialRevisionBody, account: RequestAccount) {
    return revokeCredentialVersion(this.database, credentialId, versionId, body, this.actor(account)).catch(rethrowDomain)
  }

  createBatch(body: CredentialBatchCreateBody, account: RequestAccount) {
    return createCredentialBatch(this.database, body, this.actor(account)).catch(rethrowDomain)
  }

  getBatch(batchId: string, account: RequestAccount) {
    return getCredentialBatch(this.database, batchId, this.actor(account)).catch(rethrowDomain)
  }

  async submitBatchItem(
    batchId: string,
    itemId: string,
    body: CredentialBatchItemSubmitBody,
    account: RequestAccount,
  ) {
    try {
      if (body.password && body.validity) {
        const sealed = this.seal(body.password)
        return await submitSealedBatchPassword(this.database, {
          batchId,
          itemId,
          sealed,
          validity: body.validity,
          startedAt: body.startedAt,
          idempotencyKey: body.idempotencyKey,
          requestDigest: this.secrets.fingerprint(canonicalJson(body)),
          actor: this.actor(account),
        })
      }
      return await submitCredentialBatchItem(this.database, batchId, itemId, body, this.actor(account))
    } catch (error) {
      rethrowDomain(error)
    }
  }
}
