import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import * as reporting from '@cairn/db'
import { setTimeout as delay } from 'node:timers/promises'
import type { Request, Response } from 'express'
import {
  createReport,
  createReportRevision,
  deleteReport,
  enqueueReportExport,
  getArtifactObject,
  getExportJob,
  getReport,
  listReports,
  loadReportRevisionDocument,
  previewReport,
  previewDeleteReport,
  type DbHandle,
} from '@cairn/db'
import type { ObjectStore } from '@cairn/storage'
import type {
  CreateReportBody,
  CreateReportRevisionBody,
  ExportReportBody,
  ReportListQuery,
} from '@cairn/shared'
import { REPORT_LIMITS, type SaveReportProfileBody, type CreateReportBundleBody, type DeriveMemberReportBody, type UploadReportAssetBody } from '@cairn/shared'
import { rethrowDomain } from '../common/domain-error.js'
import { abortWhenSseClientDrops } from '../common/sse-abort.js'
import type { RequestAccount } from '../common/request-account'
import { DB_HANDLE } from '../db/db.module'
import { OBJECT_STORE } from '../objects/object-store.token'

@Injectable()
export class ReportsService {
  constructor(
    @Inject(DB_HANDLE) private readonly database: DbHandle,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
  ) {}

  private actor(account: RequestAccount) {
    return { kind: 'console' as const, id: account.id }
  }

  list(query: ReportListQuery, actorId: string) {
    return listReports(this.database, query, actorId).catch(rethrowDomain)
  }

  get(reportId: string, actorId: string) {
    return getReport(this.database, reportId, actorId).catch(rethrowDomain)
  }

  preview(body: CreateReportBody, actorId: string) {
    return previewReport(this.database, body, actorId).catch(rethrowDomain)
  }

  create(body: CreateReportBody, account: RequestAccount) {
    return createReport(this.database, body, this.actor(account)).catch(rethrowDomain)
  }

  async revision(reportId: string, revisionId: string, actorId: string) {
    const report = await this.get(reportId, actorId)
    const loaded = await loadReportRevisionDocument(this.database, revisionId, actorId).catch(rethrowDomain)
    if (loaded.revision.reportId !== reportId) throw new NotFoundException({ code: 'REPORT_NOT_FOUND', message: '报告修订不存在' })
    return { report, revision: loaded.revision, document: loaded.revision.document }
  }

  addRevision(reportId: string, body: CreateReportRevisionBody, account: RequestAccount) {
    return createReportRevision(this.database, reportId, body, this.actor(account)).catch(rethrowDomain)
  }

  export(reportId: string, revisionId: string, body: ExportReportBody, account: RequestAccount) {
    return enqueueReportExport(this.database, reportId, revisionId, body.formats, this.actor(account), body.idempotencyKey).catch(
      rethrowDomain,
    )
  }

  job(jobId: string, actorId: string) {
    return getExportJob(this.database, jobId, actorId).catch(rethrowDomain)
  }

  sourceOptions(subject: CreateReportBody['subject'], actorId: string) { return reporting.getReportSourceOptions(this.database, subject, actorId).catch(rethrowDomain) }
  revisions(id: string, actorId: string, cursor?: string) { return reporting.listReportRevisions(this.database, id, actorId, cursor).catch(rethrowDomain) }
  jobs(id: string, actorId: string, cursor?: string) { return reporting.listReportExportJobs(this.database, id, actorId, cursor).catch(rethrowDomain) }
  derive(id: string, body: DeriveMemberReportBody, account: RequestAccount) { return reporting.deriveMemberReport(this.database, id, body, this.actor(account)).catch(rethrowDomain) }
  bundle(body: CreateReportBundleBody, account: RequestAccount) { return reporting.createReportBundle(this.database, body, this.actor(account)).catch(rethrowDomain) }
  cancelJob(id: string, account: RequestAccount) { return reporting.cancelExportJob(this.database, id, this.actor(account)).catch(rethrowDomain) }
  retryJob(id: string, key: string, account: RequestAccount) { return reporting.retryExportJob(this.database, id, key, this.actor(account)).catch(rethrowDomain) }
  profiles(query: { targetId: string; limit?: number; cursor?: string }, actorId: string) { return reporting.listReportProfiles(this.database, query, actorId).catch(rethrowDomain) }
  profile(id: string, actorId: string) { return reporting.getReportProfile(this.database, id, actorId).catch(rethrowDomain) }
  profileVersions(id: string, cursor: string | undefined, actorId: string) { return reporting.listReportProfileVersions(this.database, id, { cursor }, actorId).catch(rethrowDomain) }
  saveProfile(id: string | null, body: SaveReportProfileBody, account: RequestAccount) { return reporting.saveReportProfile(this.database, id, body, this.actor(account)).catch(rethrowDomain) }
  defaults(id: string, actorId: string) { return reporting.getScenarioReportDefaults(this.database, id, actorId).catch(rethrowDomain) }
  saveDefaults(id: string, body: { profileId: string | null; expectedRevision: number }, account: RequestAccount) { return reporting.saveScenarioReportDefaults(this.database, id, body, this.actor(account)).catch(rethrowDomain) }
  async uploadLogo(body: UploadReportAssetBody, account: RequestAccount) {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body.base64)) throw new BadRequestException('图片编码无效')
    const bytes = Buffer.from(body.base64, 'base64')
    if (bytes.length > REPORT_LIMITS.logoBytes) throw new BadRequestException('Logo 最大 2 MiB')
    let normalized: Buffer
    try {
      const input = sharp(bytes, { limitInputPixels: REPORT_LIMITS.imagePixels, failOn: 'error' }), metadata = await input.metadata()
      if (!['png', 'jpeg'].includes(metadata.format ?? '') || (metadata.pages ?? 1) > 1) throw new Error('图片格式无效')
      normalized = await input.rotate().resize({ width: 1000, height: 1000, fit: 'inside', withoutEnlargement: true }).png().toBuffer()
      if (normalized.length > REPORT_LIMITS.logoBytes) throw new Error('归一化后图片过大')
    } catch { throw new BadRequestException('Logo 必须是 2 MiB 内、1600 万像素内的单帧 PNG / JPEG') }
    const reserved = await reporting.reserveReportLogo(this.database, body, this.actor(account)).catch(rethrowDomain)
    await this.store.put({ key: reserved.objectKey, body: normalized, contentType: 'image/png' })
    await reporting.attachArtifactBytes(this.database, { artifactId: reserved.id, byteSize: normalized.length, digest: `sha256:${createHash('sha256').update(normalized).digest('hex')}` }).catch(rethrowDomain)
    return { artifactId: reserved.id }
  }

  async artifactStream(artifactId: string, actorId: string) {
    const artifact = await reporting.getArtifact(this.database, artifactId, actorId, 'report:export').catch(rethrowDomain)
    const { object } = await getArtifactObject(this.database, artifactId).catch(rethrowDomain)
    await reporting.recordReportDownload(this.database, artifactId, { id: actorId }).catch(rethrowDomain)
    const database = this.database, store = this.store
    const chunks = async function* () {
      let offset = 0, size = object.byteSize ?? artifact.byteSize
      if (!size || size > REPORT_LIMITS.bundleBytes) throw new NotFoundException('产物大小无效')
      while (offset < size) {
        const current = await reporting.getArtifact(database, artifactId, actorId, 'report:export').catch(rethrowDomain)
        if (!current.available) throw new NotFoundException('产物已到期或被撤销')
        const got = await store.get(object.objectKey, { start: offset, end: Math.min(size - 1, offset + 1024 * 1024 - 1) })
        if (!got.body.length || got.range && got.range.start !== offset || !got.range && offset > 0) throw new Error('产物下载不完整')
        offset += got.body.length
        if (offset > size) throw new Error('产物大小不一致')
        yield Buffer.from(got.body)
      }
    }
    return { ...artifact, chunks: chunks() }
  }

  async streamJob(jobId: string, actorId: string, req: Request, res: Response) {
    let current = await this.job(jobId, actorId)
    const signal = abortWhenSseClientDrops(req, res)
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders?.()
    let previous = ''
    try {
      while (!signal.aborted) {
        const payload = JSON.stringify(current)
        if (payload !== previous) res.write(`event: observation\ndata: ${payload}\n\n`)
        else res.write(': heartbeat\n\n')
        previous = payload
        if (!['queued', 'running'].includes(current.status)) break
        await delay(1000, undefined, { signal })
        current = await this.job(jobId, actorId)
      }
    } catch {
      if (!signal.aborted) res.write('event: error\ndata: {"message":"导出进度不可访问，请刷新检查当前权限"}\n\n')
    } finally { if (!res.writableEnded) res.end() }
  }

  async deletePreview(reportId: string, actorId: string) {
    return previewDeleteReport(this.database, reportId, actorId).catch(rethrowDomain)
  }

  delete(reportId: string, account: RequestAccount) {
    return deleteReport(this.database, reportId, this.actor(account)).catch(rethrowDomain)
  }

  async artifactContent(artifactId: string, actorId: string) {
    const { getArtifact } = await import('@cairn/db')
    await getArtifact(this.database, artifactId, actorId, 'report:export').catch(rethrowDomain)
    const { artifact, object } = await getArtifactObject(this.database, artifactId).catch(rethrowDomain)
    try {
      const got = await this.store.get(object.objectKey)
      const metadata = await getArtifact(this.database, artifactId, actorId, 'report:export').catch(rethrowDomain)
      if (!metadata.available) throw new Error('产物已过期或不可用')
      return { body: got.body, contentType: artifact.contentType, fileName: artifact.fileName }
    } catch {
      throw new NotFoundException({ code: 'ARTIFACT_NOT_AVAILABLE', message: '产物不可用' })
    }
  }
}
