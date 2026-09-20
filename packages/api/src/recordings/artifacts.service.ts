import { BadRequestException, Inject, Injectable, RequestTimeoutException } from '@nestjs/common'
import {
  abandonRecordingArtifactUpload,
  commitRecordingArtifactUpload,
  getDemonstration,
  readRecordingArtifact,
  reserveRecordingArtifactUpload,
  type DbHandle,
} from '@cairn/db'
import {
  DEMONSTRATION_LIMITS,
  entityIdSchema,
  inspectRecordingImage,
  syncSha256Bytes,
} from '@cairn/shared'
import type { ObjectStore } from '@cairn/storage'
import sharp from 'sharp'
import { OBJECT_STORE } from '../objects/object-store.token'
import { DB_HANDLE } from '../db/db.module'
import { rethrowDomain } from '../common/domain-error'

@Injectable()
export class RecordingArtifactsService {
  constructor(
    @Inject(DB_HANDLE) private readonly handle: DbHandle,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
  ) {}

  async upload(
    recordingId: string,
    artifactId: string,
    generationId: string,
    bytes: Buffer,
    actorId: string,
  ) {
    if (!Buffer.isBuffer(bytes) || !entityIdSchema.safeParse(generationId).success)
      throw new BadRequestException('需要图片正文和合法的 X-Upload-Generation')
    try {
      const reservation = await reserveRecordingArtifactUpload(
        this.handle,
        { recordingId, artifactId, generationId },
        actorId,
      )
      const { manifest } = reservation
      let size
      try {
        size = inspectRecordingImage(bytes, manifest.contentType)
      } catch {
        throw new BadRequestException('图片不符合已脱敏 PNG/JPEG 规范')
      }
      if (
        bytes.length !== manifest.byteSize ||
        syncSha256Bytes(bytes) !== manifest.digest ||
        size.width !== manifest.width ||
        size.height !== manifest.height
      )
        throw new BadRequestException('图片与本地确认清单不一致')
      try {
        // Header inspection alone cannot detect truncated/corrupt compressed pixels.
        await sharp(bytes, {
          limitInputPixels: DEMONSTRATION_LIMITS.imagePixels,
          failOn: 'warning',
        })
          .raw()
          .toBuffer()
      } catch {
        throw new BadRequestException('图片像素无法完整解码')
      }
      if (reservation.alreadyAvailable) return getDemonstration(this.handle, recordingId, actorId)
      let timer: ReturnType<typeof setTimeout> | undefined
      const work = (async () => {
        try {
          const head = await this.store.put({
            key: reservation.objectKey,
            body: bytes,
            contentType: manifest.contentType,
          })
          if (head.digest !== `sha256:${manifest.digest}` || head.byteSize !== manifest.byteSize)
            throw new BadRequestException('对象存储返回的内容摘要不一致')
          const committed = await commitRecordingArtifactUpload(
            this.handle,
            {
              recordingId,
              artifactId,
              generationId,
              digest: manifest.digest,
              byteSize: head.byteSize,
            },
            actorId,
          )
          if (!committed) throw new BadRequestException('上传代次已失效，请刷新附件状态')
        } catch (error) {
          const abandoned = await abandonRecordingArtifactUpload(this.handle, generationId).catch(
            () => false,
          )
          // If a put completed after timeout/deletion, its immutable key still has a cleanup tombstone.
          if (abandoned) await this.store.delete(reservation.objectKey).catch(() => undefined)
          throw error
        }
      })()
      try {
        await Promise.race([
          work,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new RequestTimeoutException('附件上传超时，稍后可重试')),
              Math.max(1, reservation.deadlineAt.getTime() - Date.now()),
            )
          }),
        ])
      } catch (error) {
        await abandonRecordingArtifactUpload(this.handle, generationId).catch(() => undefined)
        throw error
      } finally {
        if (timer) clearTimeout(timer)
      }
      return getDemonstration(this.handle, recordingId, actorId)
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async read(recordingId: string, artifactId: string, actorId: string) {
    try {
      const artifact = await readRecordingArtifact(this.handle, recordingId, artifactId, actorId)
      const object = await this.store.get(artifact.objectKey)
      if (
        object.head.digest !== `sha256:${artifact.manifest.digest}` ||
        object.head.byteSize !== artifact.manifest.byteSize
      )
        throw new BadRequestException('附件内容校验失败')
      await readRecordingArtifact(this.handle, recordingId, artifactId, actorId)
      return { bytes: Buffer.from(object.body), contentType: artifact.manifest.contentType }
    } catch (error) {
      rethrowDomain(error)
    }
  }
}
