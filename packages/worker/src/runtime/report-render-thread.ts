import { parentPort, workerData } from 'node:worker_threads'
import { readFile, writeFile } from 'node:fs/promises'
import { REPORT_LIMITS, reportDocumentSchema } from '@cairn/shared'
import { renderReportHtml, type ReportImage } from './report-html.js'

async function render() {
  const document = reportDocumentSchema.parse(workerData.document)
  const images: ReportImage[] = []
  let total = 0
  for (const input of workerData.images) {
    const body = await readFile(input.path)
    total += body.length
    if (body.length > REPORT_LIMITS.imageBytes || total > REPORT_LIMITS.fileBytes || images.length > REPORT_LIMITS.screenshots) {
      throw new Error('图片超过文件生成上限，请新建修订减少截图')
    }
    images.push({ ...input, body })
  }
  const html = renderReportHtml(document, images)
  const bytes = Buffer.from(html, 'utf-8')
  await writeFile(workerData.path, bytes)
  parentPort!.postMessage({ ok: true })
}

render().catch((error) => {
  console.error('[THREAD ERROR]', error)
  parentPort!.postMessage({ ok: false, error: error instanceof Error ? (error.stack || error.message) : String(error) })
})
