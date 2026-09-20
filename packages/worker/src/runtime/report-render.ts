import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, open, opendir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Worker } from 'node:worker_threads'
import sharp from 'sharp'
import { attachArtifactBytes, claimExportJobs, commitReportMaterial, completeExportJob, finishReportMaterials, getCachedReportArtifacts, getExportMaterials, getReportBundleFiles, loadReportRevisionDocument, renewExportJob, reserveExportArtifact, updateExportProgress, type DbHandle } from '@cairn/db'
import { REPORT_LIMITS, REPORT_RENDER_VERSION, sanitizeReportFileName, type ReportDocument } from '@cairn/shared'
import type { ObjectStore } from '@cairn/storage'
import { crc32, zipEnd, zipHeaders } from './report-layout'
export { renderReportDocx, renderReportPdf } from './report-layout'

type Grant = { jobId: string; workerId: string; instanceId: string; claimEpoch: number }
type ImageInput = { id: string; path: string; width: number; height: number; kind: 'logo' | 'screenshot'; caption: string }

/** Unknown sizes are measured with bounded range reads, never treated as zero. */
export async function copyBoundedObject(store: ObjectStore, key: string, path: string, maxBytes: number, signal: AbortSignal, expectedDigest?: string | null) {
  const file = await open(path, 'wx'), hash = createHash('sha256')
  let offset = 0, size = Infinity
  try {
    while (offset < size) {
      signal.throwIfAborted()
      const got = await store.get(key, { start: offset, end: Math.min(offset + 1024 * 1024 - 1, maxBytes) })
      size = got.range?.size ?? got.head.byteSize
      if (!Number.isSafeInteger(size) || size <= 0 || size > maxBytes || offset + got.body.length > maxBytes || !got.body.length) throw new Error('对象实际大小超过上限或无法确定，请调整报告范围')
      if (got.range && got.range.start !== offset || !got.range && offset > 0) throw new Error('对象存储未返回请求的字节范围')
      hash.update(got.body); await file.write(got.body); offset += got.body.length
    }
    if (offset !== size) throw new Error('对象下载不完整')
    const actual = `sha256:${hash.digest('hex')}`
    if (expectedDigest && actual !== expectedDigest) throw new Error('材料摘要不一致')
    return { byteSize: offset, digest: actual }
  } finally { await file.close() }
}

export async function renderReportInThread(document: ReportDocument, images: ImageInput[], format: 'docx' | 'pdf', path: string, signal: AbortSignal) {
  signal.throwIfAborted()
  return new Promise<void>((resolve, reject) => {
    const thread = new Worker(join(__dirname, 'report-render-thread.js'), { workerData: { document, images, format, path }, resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64 } })
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true; signal.removeEventListener('abort', abort); void thread.terminate()
      if (error) reject(error); else resolve()
    }
    const abort = () => finish(new Error('导出已取消、超时或执行权失效'))
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
    thread.once('message', (result) => finish(result.ok ? undefined : new Error(result.error)))
    thread.once('error', finish)
    thread.once('exit', (code) => { if (!settled) finish(new Error(`渲染进程异常结束（${code}），可重试文件任务`)) })
  })
}

async function uploadFile(handle: DbHandle, store: ObjectStore, grant: Grant, path: string, input: { kind: 'report_material' | 'report_docx' | 'report_pdf' | 'report_bundle'; fileName: string; contentType: string }, signal: AbortSignal) {
  const maxBytes = input.kind === 'report_bundle' ? REPORT_LIMITS.bundleBytes : input.kind === 'report_material' ? REPORT_LIMITS.imageBytes : REPORT_LIMITS.fileBytes
  const reserved = await reserveExportArtifact(handle, grant, input)
  signal.throwIfAborted()
  const head = store.putFile ? await store.putFile({ key: reserved.objectKey, path, contentType: input.contentType, maxBytes, signal }) : await (async () => {
    if ((await stat(path)).size > Math.min(maxBytes, 32 * 1024 * 1024)) throw new Error('当前对象适配器不支持有界大文件上传')
    return store.put({ key: reserved.objectKey, body: await readFile(path), contentType: input.contentType })
  })()
  signal.throwIfAborted()
  if (!await renewExportJob(handle, grant)) throw new Error('导出执行权失效')
  await attachArtifactBytes(handle, { artifactId: reserved.id, byteSize: head.byteSize, digest: head.digest })
  return { id: reserved.id, ...head }
}

async function materialize(handle: DbHandle, store: ObjectStore, grant: Grant, directory: string, signal: AbortSignal) {
  const rows = await getExportMaterials(handle, grant)
  for (const [index, row] of rows.entries()) {
    signal.throwIfAborted()
    if (row.status !== 'pending') continue
    await updateExportProgress(handle, grant, `准备材料 ${index + 1} / ${rows.length}`)
    if (!row.sourceAvailable || !row.objectKey) { await commitReportMaterial(handle, grant, { materialId: row.id, missingReason: '原图在取材前已过期或被清理' }); continue }
    let normalized: { data: Buffer; info: sharp.OutputInfo } | undefined
    try {
      const sourcePath = join(directory, `${row.id}.source`)
      await copyBoundedObject(store, row.objectKey, sourcePath, row.kind === 'logo' ? REPORT_LIMITS.logoBytes : REPORT_LIMITS.imageBytes, signal, row.sourceDigest)
      const image = sharp(sourcePath, { limitInputPixels: REPORT_LIMITS.imagePixels, failOn: 'error' }), meta = await image.metadata()
      if (!['jpeg', 'png'].includes(meta.format ?? '') || (meta.pages ?? 1) > 1) throw new Error('材料必须是单帧 PNG 或 JPEG')
      normalized = await image.rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 85 }).toBuffer({ resolveWithObject: true })
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof Error && /上限|pixel limit/i.test(error.message)) throw error
      await commitReportMaterial(handle, grant, { materialId: row.id, missingReason: '原图在取材时不可用、格式不支持或校验失败' })
    }
    if (normalized) {
      const path = join(directory, `${row.id}.jpg`)
      await writeFile(path, normalized.data)
      const artifact = await uploadFile(handle, store, grant, path, { kind: 'report_material', fileName: `${row.id}.jpg`, contentType: 'image/jpeg' }, signal)
      await commitReportMaterial(handle, grant, { materialId: row.id, artifactId: artifact.id, digest: artifact.digest, byteSize: artifact.byteSize, width: normalized.info.width, height: normalized.info.height })
    }
  }
  await finishReportMaterials(handle, grant)
}

export async function writeReportZip(path: string, files: Array<{ name: string; path: string }>, signal: AbortSignal) {
  const file = await open(path, 'wx'), central: Buffer[] = []
  let offset = 0
  try {
    for (const input of files) {
      signal.throwIfAborted()
      let size = 0, crc = 0
      for await (const chunk of createReadStream(input.path, { signal })) { const bytes = chunk as Buffer; size += bytes.length; crc = crc32(bytes, crc); if (offset + size > REPORT_LIMITS.bundleBytes) throw new Error('报告包超过 1 GiB 上限，请减少导出范围') }
      const headers = zipHeaders(input.name, size, crc, offset)
      await file.write(headers.local)
      for await (const chunk of createReadStream(input.path, { signal })) await file.write(chunk as Buffer)
      offset += headers.local.length + size; central.push(headers.central)
    }
    const bytes = Buffer.concat(central), end = zipEnd(files.length, bytes.length, offset)
    if (offset + bytes.length + end.length > REPORT_LIMITS.bundleBytes) throw new Error('报告包超过 1 GiB 上限')
    await file.write(bytes); await file.write(end)
  } finally { await file.close() }
}

async function bundle(handle: DbHandle, store: ObjectStore, grant: Grant, directory: string, signal: AbortSignal) {
  const data = await getReportBundleFiles(handle, grant)
  const files: Array<{ name: string; path: string }> = [], manifest: Array<Record<string, unknown>> = []
  let total = 0
  for (const entry of data.entries) for (const format of data.manifest.formats as string[]) {
    await updateExportProgress(handle, grant, `打包 ${entry.name} · ${format.toUpperCase()}`)
    const cached = entry.files.find((item) => item.format === format), name = `${sanitizeReportFileName(entry.name)}/${entry.revisionId}.${format}`
    const identity = { reportId: entry.reportId, revisionId: entry.revisionId, source: entry.source ?? null, format }
    if (!cached) { manifest.push({ ...identity, status: 'missing', reason: entry.error ?? '文件不可用或已到期' }); continue }
    const path = join(directory, `${cached.artifact.id}.${format}`)
    try {
      const copied = await copyBoundedObject(store, cached.object.objectKey, path, REPORT_LIMITS.fileBytes, signal, cached.artifact.digest)
      total += copied.byteSize
      if (total > REPORT_LIMITS.bundleBytes) throw new Error('报告包超过 1 GiB 上限')
      files.push({ name, path }); manifest.push({ ...identity, file: name, status: 'complete', ...copied })
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof Error && /上限/.test(error.message)) throw error
      manifest.push({ ...identity, status: 'missing', reason: '文件在打包时不可用或摘要校验失败' })
    }
  }
  if (!files.length) throw new Error('没有可交付文件；请重试失败的格式任务后重新打包')
  const partial = manifest.some((item) => item.status === 'missing'), manifestPath = join(directory, 'manifest.json')
  await writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, asOf: data.manifest.asOf, generatedAt: new Date().toISOString(), title: data.manifest.title, status: partial ? 'partial' : 'complete', entries: manifest }, null, 2))
  files.push({ name: 'manifest.json', path: manifestPath })
  const path = join(directory, 'reports.zip')
  await writeReportZip(path, files, signal)
  const artifact = await uploadFile(handle, store, grant, path, { kind: 'report_bundle', fileName: `${sanitizeReportFileName(String(data.manifest.title))}.zip`, contentType: 'application/zip' }, signal)
  await completeExportJob(handle, { ...grant, artifactIds: [artifact.id], status: partial ? 'partial' : 'complete', ...(partial ? { error: '部分文件缺失，详见包内 manifest.json' } : {}) })
}

/** A crashed process cannot run finally; stale private workspaces have no live ten-minute job. */
export async function cleanupReportWorkspaces(root = tmpdir(), now = Date.now()) {
  const directory = await opendir(root)
  let inspected = 0, removed = 0
  for await (const entry of directory) {
    if (++inspected > 1000) break
    if (!entry.isDirectory() || !/^cairn-report-[a-zA-Z0-9]{6}$/.test(entry.name)) continue
    const path = join(root, entry.name)
    try {
      if (now - (await stat(path)).mtimeMs > REPORT_LIMITS.taskMs * 2) {
        await rm(path, { recursive: true, force: true }); removed++
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  return removed
}

export async function dispatchExportJobs(handle: DbHandle, store: ObjectStore, input: { workerId: string; instanceId: string; signal?: AbortSignal }, watchHeartbeat: (renew: () => Promise<void>) => () => void = () => () => undefined): Promise<number> {
  await cleanupReportWorkspaces()
  const jobs = await claimExportJobs(handle, { ...input, limit: 1 })
  for (const job of jobs) {
    const grant = { jobId: job.id, ...input, claimEpoch: job.claimEpoch }, controller = new AbortController()
    const directory = await mkdtemp(join(tmpdir(), 'cairn-report-'))
    const deadline = setTimeout(() => controller.abort(), Math.max(1, job.deadlineAt!.getTime() - Date.now()))
    let renewing = false
    const beat = async () => { if (renewing) return; renewing = true; try { if (!await renewExportJob(handle, grant)) controller.abort() } catch { controller.abort() } finally { renewing = false } }
    const stopHeartbeat = watchHeartbeat(beat)
    const abort = () => controller.abort()
    input.signal?.addEventListener('abort', abort, { once: true })
    if (input.signal?.aborted) controller.abort()
    try {
      if (job.kind === 'report_materialize') await materialize(handle, store, grant, directory, controller.signal)
      else if (job.kind === 'report_bundle') await bundle(handle, store, grant, directory, controller.signal)
      else {
        const loaded = await loadReportRevisionDocument(handle, job.reportRevisionId!, job.createdByConsoleAccountId), document = loaded.revision.document
        if (!document || !loaded.revision.sealedAt) throw new Error('报告材料尚未封存')
        const formats = job.sourceManifest.formats as Array<'docx' | 'pdf'>
        const cached = await getCachedReportArtifacts(handle, loaded.revision.id, formats, job.createdByConsoleAccountId)
        const artifactIds = cached.map((entry) => entry.artifact.id), failures: string[] = []
        const images: ImageInput[] = []
        let preparationError: Error | undefined
        try {
          if (cached.length < formats.length && loaded.revision.renderVersion !== REPORT_RENDER_VERSION) throw new Error('此历史渲染器版本已不可用；已有文件可下载，重新生成请新建修订')
          if (cached.length < formats.length) for (const material of await getExportMaterials(handle, grant)) {
            if (material.status !== 'ready') continue
            if (!material.sourceAvailable || !material.objectKey) throw new Error('已封存材料副本到期或被清理，无法重建此修订；已有文件仍可下载')
            const path = join(directory, `${material.id}.jpg`)
            await copyBoundedObject(store, material.objectKey, path, REPORT_LIMITS.imageBytes, controller.signal, material.digest)
            images.push({ id: material.id, path, width: material.width!, height: material.height!, caption: material.caption, kind: material.kind as 'logo' | 'screenshot' })
          }
        } catch (error) {
          controller.signal.throwIfAborted()
          preparationError = error instanceof Error ? error : new Error('材料准备失败')
        }
        for (const format of formats.filter((format) => !cached.some((item) => item.format === format))) {
          try {
            if (preparationError) throw preparationError
            await updateExportProgress(handle, grant, `生成 ${format.toUpperCase()}`)
            const path = join(directory, `report.${format}`)
            await renderReportInThread(document, images, format, path, controller.signal)
            const artifact = await uploadFile(handle, store, grant, path, { kind: format === 'pdf' ? 'report_pdf' : 'report_docx', fileName: `${sanitizeReportFileName(document.title)}.${format}`, contentType: format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }, controller.signal)
            artifactIds.push(artifact.id)
          } catch (error) { controller.signal.throwIfAborted(); failures.push(`${format.toUpperCase()}：${error instanceof Error ? error.message : '生成失败'}`) }
        }
        await completeExportJob(handle, { ...grant, artifactIds, status: !artifactIds.length ? 'failed' : failures.length ? 'partial' : 'complete', error: failures.length ? failures.join('；') : undefined })
      }
    } catch (error) { await completeExportJob(handle, { ...grant, artifactIds: [], status: 'failed', error: error instanceof Error ? error.message : '导出失败' }) }
    finally { clearTimeout(deadline); input.signal?.removeEventListener('abort', abort); stopHeartbeat(); await rm(directory, { recursive: true, force: true }) }
  }
  return jobs.length
}
