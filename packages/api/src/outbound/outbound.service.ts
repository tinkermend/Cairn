import { BadRequestException, Inject, Injectable } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import type { Response } from 'express'
import {
  createOutboundTest,
  getOutboundChannels,
  getOutboundEvent,
  getOrCreatePlatformConfig,
  listOutboundEvents,
  loadSecretCiphertext,
  newId,
  operateOutboundDelivery,
  readOutboundPolicy,
  writeOutboundConfig,
  writeOutboundPolicy,
  type DbHandle,
} from '@cairn/db'
import {
  LOCAL_SECRET_PROVIDER,
  OUTBOUND_PROTOCOL,
  hasPermission,
  isBlockedAlertWebhookUrl,
  outboundChannelSecretSchema,
  alertWebhookSecretPayloadSchema,
  outboundSmtpSecretSchema,
  type OutboundChannelWrite,
  type OutboundSmtpWrite,
} from '@cairn/shared'
import { AuthService } from '../auth/auth.service'
import { rethrowDomain } from '../common/domain-error'
import { DB_HANDLE } from '../db/db.module'
import { LocalSecretProvider } from '../secrets/local-secret-provider'

@Injectable()
export class OutboundService {
  constructor(
    @Inject(DB_HANDLE) private readonly db: DbHandle,
    private readonly secrets: LocalSecretProvider,
    private readonly auth: AuthService,
    private readonly jwt: JwtService,
  ) {}

  private async domain<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (error) {
      rethrowDomain(error)
    }
  }
  channels(actor: string, targetId?: string) {
    return this.domain(() => getOutboundChannels(this.db, actor, targetId))
  }
  list(actor: string, query: unknown) {
    return this.domain(() => listOutboundEvents(this.db, actor, query))
  }
  detail(actor: string, id: string) {
    return this.domain(() => getOutboundEvent(this.db, actor, id))
  }
  policy(actor: string, id: string) {
    return this.domain(() => readOutboundPolicy(this.db, id, actor))
  }
  savePolicy(actor: string, id: string, body: unknown) {
    return this.domain(() => writeOutboundPolicy(this.db, id, actor, body))
  }
  test(actor: string, id: string, body: unknown) {
    return this.domain(() => createOutboundTest(this.db, actor, id, body))
  }
  operate(actor: string, id: string, action: 'retry' | 'close', body: unknown) {
    return this.domain(() => operateOutboundDelivery(this.db, actor, id, action, body))
  }
  settings(
    actorId: string,
    body: { expectedRevision: number; reason: string; enabled: boolean; consoleBaseUrl: string },
  ) {
    return this.domain(async () => {
      await writeOutboundConfig(this.db, {
        actorId,
        ...body,
        settings: { enabled: body.enabled, consoleBaseUrl: body.consoleBaseUrl },
      })
      return this.channels(actorId)
    })
  }
  state(
    actorId: string,
    id: string,
    body: { expectedRevision: number; reason: string; enabled?: boolean; revokeVersion?: number },
  ) {
    return this.domain(async () => {
      await writeOutboundConfig(this.db, {
        actorId,
        ...body,
        state: { id, enabled: body.enabled, revokeVersion: body.revokeVersion },
      })
      return this.channels(actorId)
    })
  }
  smtpState(
    actorId: string,
    body: { expectedRevision: number; reason: string; enabled?: boolean; revokeVersion?: number },
  ) {
    return this.domain(async () => {
      await writeOutboundConfig(this.db, {
        actorId,
        ...body,
        smtpState: { enabled: body.enabled, revokeVersion: body.revokeVersion },
      })
      return this.channels(actorId)
    })
  }
  private async decrypt(ref: { provider: string; secretId: string } | undefined) {
    if (!ref) return undefined
    if (ref.provider !== LOCAL_SECRET_PROVIDER)
      throw new BadRequestException('无法复用此凭据，请重新填写')
    const row = await loadSecretCiphertext(this.db, ref.secretId)
    if (!row) throw new BadRequestException('原凭据不存在，请重新填写')
    return JSON.parse(this.secrets.decrypt(row.id, row.ciphertext)) as unknown
  }
  saveChannel(actorId: string, body: OutboundChannelWrite) {
    return this.domain(async () => {
      const current = await getOrCreatePlatformConfig(this.db)
      const old = current.document.outbound.channels.find((c) => c.id === body.id)
      const id = old?.id ?? body.id ?? newId(),
        secretId = newId()
      let secret: ReturnType<typeof outboundChannelSecretSchema.parse>
      let destinationUnchanged = false
      if (body.kind === 'webhook') {
        const raw = old?.kind === 'webhook' ? await this.decrypt(old.secretRef) : undefined
        const legacy =
          raw && typeof raw === 'object' && !('kind' in raw)
            ? alertWebhookSecretPayloadSchema.parse(raw)
            : undefined
        const previous = raw
          ? outboundChannelSecretSchema.parse(
              legacy ? { kind: 'webhook', url: legacy.url, token: legacy.token } : raw,
            )
          : undefined
        const p = previous?.kind === 'webhook' ? previous : undefined
        const url = body.url ?? p?.url
        destinationUnchanged = Boolean(p && url === p.url)
        if (
          !url ||
          new URL(url).protocol !== 'https:' ||
          new URL(url).username ||
          new URL(url).password ||
          new URL(url).hash ||
          isBlockedAlertWebhookUrl(url)
        )
          throw new BadRequestException('Webhook 须为不含内嵌凭据的公开 HTTPS 地址')
        secret = {
          kind: 'webhook',
          url,
          token: body.token === undefined ? p?.token : body.token || undefined,
          signingKey: body.signingKey === undefined ? p?.signingKey : body.signingKey || undefined,
        }
      } else {
        if (
          (body.format !== OUTBOUND_PROTOCOL && (body.format as string) !== 'cairn.notification@1') ||
          body.replay !== 'manual_on_unknown'
        )
          throw new BadRequestException('邮件使用标准推送格式，结果不明须人工处理')
        const oldSecret =
          old?.kind === 'email'
            ? outboundChannelSecretSchema.parse(await this.decrypt(old.secretRef))
            : undefined
        const previous = oldSecret?.kind === 'email' ? oldSecret.recipients : []
        const emails = body.emails ?? previous.map((r) => r.email)
        if (!emails.length || new Set(emails.map((e) => e.toLowerCase())).size !== emails.length)
          throw new BadRequestException('收件人不能为空或重复')
        secret = {
          kind: 'email',
          recipients: emails.map((email) => ({
            email,
            id: previous.find((r) => r.email === email)?.id ?? newId(),
          })),
        }
        destinationUnchanged = Boolean(
          oldSecret && JSON.stringify(emails) === JSON.stringify(previous.map((r) => r.email)),
        )
      }
      const parsed = outboundChannelSecretSchema.parse(secret)
      await writeOutboundConfig(this.db, {
        actorId,
        expectedRevision: body.expectedRevision,
        reason: body.reason,
        destinationUnchanged,
        channel: {
          id,
          name: body.name,
          enabled: body.enabled,
          allowAlerts: body.allowAlerts,
          targetIds: body.targetIds,
          kind: body.kind,
          version: (old?.version ?? 0) + 1,
          secretRef: { provider: LOCAL_SECRET_PROVIDER, secretId },
          host: parsed.kind === 'webhook' ? new URL(parsed.url).hostname : '',
          recipients:
            parsed.kind === 'email'
              ? parsed.recipients.map((r) => ({ id: r.id, masked: maskEmail(r.email) }))
              : [],
          format: body.format,
          replay: body.replay,
        },
        secrets: [
          { id: secretId, ciphertext: this.secrets.encrypt(secretId, JSON.stringify(parsed)) },
        ],
      })
      return this.channels(actorId)
    })
  }
  saveSmtp(actorId: string, body: OutboundSmtpWrite) {
    return this.domain(async () => {
      const current = await getOrCreatePlatformConfig(this.db),
        old = current.document.outbound.smtp
      const previous = old
        ? outboundSmtpSecretSchema.parse(await this.decrypt(old.secretRef))
        : undefined
      const { expectedRevision, reason, enabled, ...configuration } = body
      if (
        !body.password &&
        (!previous ||
          previous.host !== body.host ||
          previous.username !== body.username ||
          previous.port !== body.port)
      )
        throw new BadRequestException('更换 SMTP 身份时须填写密码')
      const secret = outboundSmtpSecretSchema.parse({
        ...configuration,
        password: body.password ?? previous?.password,
      })
      const secretId = newId()
      await writeOutboundConfig(this.db, {
        actorId,
        expectedRevision,
        reason,
        destinationUnchanged: Boolean(
          previous &&
          previous.host === secret.host &&
          previous.port === secret.port &&
          previous.username === secret.username &&
          previous.from === secret.from &&
          previous.tls === secret.tls,
        ),
        smtp: {
          enabled,
          version: (old?.version ?? 0) + 1,
          host: body.host,
          secretRef: { provider: LOCAL_SECRET_PROVIDER, secretId },
        },
        secrets: [
          { id: secretId, ciphertext: this.secrets.encrypt(secretId, JSON.stringify(secret)) },
        ],
      })
      return this.channels(actorId)
    })
  }
  async stream(input: {
    actorId: string
    query: unknown
    authorization?: string
    response: Response
    signal: AbortSignal
  }) {
    const res = input.response
    const token = input.authorization?.replace(/^Bearer /, '')
    const decoded = token ? (this.jwt.decode(token) as { exp?: number } | null) : null
    const expiresAt = decoded?.exp ? decoded.exp * 1000 : Date.now()
    // Validate access and filters before opening the stream. Every snapshot rechecks current DB scopes.
    await this.list(input.actorId, input.query)
    res
      .status(200)
      .set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      })
    res.flushHeaders()
    let timer: NodeJS.Timeout | undefined,
      closed = false,
      last = ''
    const close = () => {
      closed = true
      if (timer) clearTimeout(timer)
      if (!res.writableEnded) res.end()
      input.signal.removeEventListener('abort', close)
    }
    input.signal.addEventListener('abort', close, { once: true })
    res.once('close', close)
    const tick = async () => {
      if (closed) return
      try {
        const account = await this.auth.resolveAccount(input.actorId)
        if (
          expiresAt <= Date.now() ||
          account.status !== 'active' ||
          !hasPermission(account.permissions, 'outbound:read')
        ) {
          close()
          return
        }
        const snapshot = JSON.stringify(await this.list(input.actorId, input.query))
        if (!closed) {
          if (snapshot !== last) {
            res.write(`event: snapshot\ndata: ${snapshot}\n\n`)
            last = snapshot
          } else res.write(': keepalive\n\n')
        }
      } catch {
        close()
        return
      }
      if (!closed) {
        timer = setTimeout(() => void tick(), 5000)
        timer.unref()
      }
    }
    await tick()
  }
}
function maskEmail(email: string) {
  const [local, domain] = email.split('@')
  return `${local!.slice(0, 1)}***@${domain}`
}
