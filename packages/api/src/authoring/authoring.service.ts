import { Inject, Injectable } from '@nestjs/common'
import { badRequest, loadTargetForExecution, notFound, type DbHandle } from '@cairn/db'
import {
  normalizeAuthoringObservation,
  originsFromTargetUrls,
  urlBelongsToTargetOrigins,
  type AuthoringObservationSubmit,
  type TargetObservation,
} from '@cairn/shared'
import { DB_HANDLE } from '../db/db.module'
import { rethrowDomain } from '../common/domain-error'

@Injectable()
export class AuthoringService {
  constructor(@Inject(DB_HANDLE) private readonly db: DbHandle) {}

  async normalizeObservation(body: AuthoringObservationSubmit): Promise<TargetObservation> {
    try {
      const target = await loadTargetForExecution(this.db, body.targetId)
      if (!target) throw notFound('TARGET_NOT_FOUND', '目标系统不存在')
      const allowed = originsFromTargetUrls(target.entryUrl, target.loginUrl)
      if (!urlBelongsToTargetOrigins(body.url, allowed)) {
        throw badRequest('OBSERVE_TARGET_MISMATCH', '观察页地址不属于该目标系统，未发起外部请求')
      }
      return normalizeAuthoringObservation(body)
    } catch (error) {
      rethrowDomain(error)
    }
  }
}
