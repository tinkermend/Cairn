import { Inject, Injectable } from '@nestjs/common'
import {
  DomainError,
  getOrCreatePlatformConfig,
  getPlatformConfig,
  getPlatformConfigRevision,
  listPlatformConfigRevisions,
  loadSecretCiphertext,
  newId,
  registerPlatformAiSecret,
  registerStandaloneSecret,
  restorePlatformConfig,
  updatePlatformConfig,
  type AuditActor,
  type DbHandle,
} from '@cairn/db'
import {
  localSecretRef,
  platformConfigDocumentSchema,
  requiresAiSecretRebind,
  type PlatformConfigDocument,
  type PlatformConfigRestoreBody,
  type PlatformConfigSecretBody,
  type PlatformConfigTestConnectionBody,
  type PlatformConfigUpdateBody,
} from '@cairn/shared'
import { DB_HANDLE } from '../db/db.module'
import { rethrowDomain } from '../common/domain-error'
import { config } from '../config/env'
import { buildPlatformBootstrapDocument } from '../config/platform-bootstrap'
import { LocalSecretProvider } from '../secrets/local-secret-provider'

@Injectable()
export class PlatformConfigService {
  constructor(
    @Inject(DB_HANDLE) private readonly db: DbHandle,
    private readonly secrets: LocalSecretProvider,
  ) {}

  async ensure() {
    try {
      const existing = await getPlatformConfig(this.db)
      if (existing) return existing
      let secretId = config.CAIRN_BROWSER_AI_API_KEY_SECRET_ID
      if (!secretId && config.CAIRN_BROWSER_AI_API_KEY && config.CAIRN_ENV === 'development') {
        secretId = newId()
        await registerStandaloneSecret(this.db, {
          id: secretId,
          ciphertext: this.secrets.encrypt(secretId, config.CAIRN_BROWSER_AI_API_KEY),
        })
      }
      return await getOrCreatePlatformConfig(this.db, buildPlatformBootstrapDocument(config, secretId))
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async get() {
    return this.ensure()
  }

  validate(document: PlatformConfigDocument) {
    return { document: platformConfigDocumentSchema.parse(document) }
  }

  async update(body: PlatformConfigUpdateBody, actor: AuditActor) {
    const current = await this.ensure()
    try {
      await this.assertSecretBinding(body.document, current.document)
      return await updatePlatformConfig(this.db, {
        expectedRevision: body.expectedRevision,
        document: body.document,
        reason: body.reason,
        actor,
      })
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async restore(body: PlatformConfigRestoreBody, actor: AuditActor) {
    const current = await this.ensure()
    try {
      const document = await getPlatformConfigRevision(this.db, body.revision)
      await this.assertSecretBinding(document, current.document)
      return await restorePlatformConfig(this.db, {
        revision: body.revision,
        expectedRevision: body.expectedRevision,
        reason: body.reason,
        actor,
      })
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async revisions(query: { cursor?: string; limit?: number }) {
    await this.ensure()
    return listPlatformConfigRevisions(this.db, query).catch(rethrowDomain)
  }

  async registerSecret(body: PlatformConfigSecretBody, actor: AuditActor) {
    await this.ensure()
    try {
      const id = newId()
      await registerPlatformAiSecret(this.db, {
        id,
        ciphertext: this.secrets.encrypt(id, body.apiKey),
        actor,
      })
      return { secretRef: localSecretRef(id) }
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async testConnection(body: PlatformConfigTestConnectionBody) {
    let apiKey: string | undefined
    if (body.secretRef) {
      const row = await loadSecretCiphertext(this.db, body.secretRef.secretId)
      if (!row) {
        throw new DomainError('bad_request', 'AI_CONFIG_INVALID', '凭据引用不可用')
      }
      try {
        apiKey = this.secrets.decrypt(row.id, row.ciphertext)
      } catch {
        throw new DomainError('bad_request', 'AI_CONFIG_INVALID', '凭据引用不可用')
      }
    }
    const base = body.baseUrl.endsWith('/') ? body.baseUrl : `${body.baseUrl}/`
    const url = new URL('models', base)
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        signal: AbortSignal.timeout(8_000),
      })
      if (!response.ok) {
        return { ok: false, message: `模型服务返回 HTTP ${response.status}` }
      }
      return {
        ok: true,
        message: '已连通模型服务。这只证明当时可访问，不代表视觉或动作能力。',
      }
    } catch {
      return { ok: false, message: '无法访问模型服务' }
    }
  }

  private async assertSecretBinding(document: PlatformConfigDocument, previous?: PlatformConfigDocument) {
    if (!document.browserAi.enabled) return
    const secretId = document.browserAi.secretRef?.secretId
    if (!secretId) {
      throw new DomainError('bad_request', 'AI_CONFIG_INVALID', '启用浏览器仿真 AI 时必须配置 Secret 引用')
    }
    const row = await loadSecretCiphertext(this.db, secretId)
    if (!row) {
      throw new DomainError('bad_request', 'AI_CONFIG_INVALID', '凭据引用不可用')
    }
    if (requiresAiSecretRebind(previous?.browserAi, document.browserAi)) {
      throw new DomainError(
        'bad_request',
        'AI_CONFIG_INVALID',
        '变更模型服务地址后必须重新登记密钥，避免把原凭据发到新地址',
      )
    }
  }
}

