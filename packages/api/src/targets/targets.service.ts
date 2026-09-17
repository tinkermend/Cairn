import { Inject, Injectable, Optional } from '@nestjs/common'
import {
  findAuthWaitLeaseForOperation,
  getSessionById,
  getTargetAccessPolicy,
  getTargetAuthProfileView,
  updateTargetAccessPolicy,
  getWorkerById,
  conflict,
  observeAuthProfileValidation,
  publishTargetAuthProfile,
  startAuthProfileValidation,
  getAuthProfileValidation,
  TargetsStore,
  updateTargetAccountIdentity,
  type DbHandle,
} from '@cairn/db'
import {
  authObservationSchema,
  evaluateWorkerRoute,
  parseWorkerEndpoints,
  workerInternalPath,
  type ObserveAuthProfileValidationBody,
  type TargetAccessPolicyUpdateBody,
  type PublishTargetAuthProfileBody,
  type StartAuthProfileValidationBody,
  type UpdateTargetAccountIdentityBody,
} from '@cairn/shared'
import { config } from '../config/env'
import { DB_HANDLE } from '../db/db.module'
import { rethrowDomain } from '../common/domain-error'
import type { RequestAccount } from '../common/request-account'
import { LocalSecretProvider } from '../secrets/local-secret-provider'
import { WorkerForwardError, WorkerInternalClient } from '../runs/worker-internal.client'

@Injectable()
export class TargetsService {
  private readonly store: TargetsStore
  constructor(
    @Inject(DB_HANDLE) private readonly database: DbHandle,
    secretProvider: LocalSecretProvider,
    @Optional() private readonly workers?: WorkerInternalClient,
  ) {
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

  updateSessionPolicy(...args: Parameters<TargetsStore['updateSessionPolicy']>) {
    return this.store.updateSessionPolicy(...args).catch(rethrowDomain)
  }

  deleteTarget(...args: Parameters<TargetsStore['deleteTarget']>) {
    return this.store.deleteTarget(...args).catch(rethrowDomain)
  }

  previewDeleteTarget(...args: Parameters<TargetsStore['previewDeleteTarget']>) {
    return this.store.previewDeleteTarget(...args).catch(rethrowDomain)
  }

  getTargetCleanupStatus(...args: Parameters<TargetsStore['getTargetCleanupStatus']>) {
    return this.store.getTargetCleanupStatus(...args).catch(rethrowDomain)
  }

  retryTargetCleanup(...args: Parameters<TargetsStore['retryTargetCleanup']>) {
    return this.store.retryTargetCleanup(...args).catch(rethrowDomain)
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

  getAccessPolicy(targetId: string) {
    return getTargetAccessPolicy(this.database, targetId).catch(rethrowDomain)
  }

  updateAccessPolicy(targetId: string, body: TargetAccessPolicyUpdateBody, actor: RequestAccount) {
    return updateTargetAccessPolicy(this.database, targetId, body, { kind: 'console', id: actor.id }).catch(rethrowDomain)
  }

  getAuthProfile(targetId: string) {
    return getTargetAuthProfileView(this.database, targetId).catch(rethrowDomain)
  }

  publishAuthProfile(targetId: string, body: PublishTargetAuthProfileBody, actor: RequestAccount) {
    return publishTargetAuthProfile(this.database, {
      targetId,
      expectedRevision: body.expectedRevision,
      definition: body.definition,
      actor: { id: actor.id },
    }).catch(rethrowDomain)
  }

  updateAccountIdentity(
    targetId: string,
    accountId: string,
    body: UpdateTargetAccountIdentityBody,
    actor: RequestAccount,
  ) {
    return updateTargetAccountIdentity(this.database, {
      targetId,
      accountId,
      expectedRevision: body.expectedRevision,
      expectedIdentity: body.expectedIdentity,
      actor: { id: actor.id },
    })
      .then(() => this.store.getAccount(targetId, accountId))
      .catch(rethrowDomain)
  }

  startAuthValidation(targetId: string, body: StartAuthProfileValidationBody, actor: RequestAccount) {
    return startAuthProfileValidation(this.database, {
      targetId,
      targetAccountId: body.targetAccountId,
      expectedRevision: body.expectedRevision,
      idempotencyKey: body.idempotencyKey,
      actor: { id: actor.id },
    }).catch(rethrowDomain)
  }

  getAuthValidation(targetId: string, operationId: string) {
    return getAuthProfileValidation(this.database, { targetId, operationId }).catch(rethrowDomain)
  }

  async observeAuthValidation(
    targetId: string,
    operationId: string,
    body: ObserveAuthProfileValidationBody,
    actor: RequestAccount,
  ) {
    try {
      const observation = await this.verifyOnWorker(targetId, operationId, actor)
      return await observeAuthProfileValidation(this.database, {
        targetId,
        operationId,
        step: body.step,
        observation,
        actor: { id: actor.id },
      })
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async validationBrowserMeta(targetId: string, operationId: string, actor: RequestAccount) {
    try {
      const target = await this.resolveValidationWorker(targetId, operationId)
      if (!this.workers || !target.session || !target.worker || !target.endpoint) {
        return { operationId, sessionId: target.session?.id ?? null, framesAvailable: false }
      }
      return await this.workers.requestJson({
        workerId: target.session.ownerWorkerId,
        workerInstanceId: target.worker.instanceId,
        actorId: actor.id,
        runId: operationId,
        sessionGeneration: target.session.generation,
        path: workerInternalPath('/meta'),
        method: 'GET',
        endpoint: target.endpoint,
        timeout: 'headers',
      })
    } catch (error) {
      if (error instanceof WorkerForwardError) {
        return { operationId, framesAvailable: false, degradedReason: error.code }
      }
      rethrowDomain(error)
    }
  }

  private async verifyOnWorker(targetId: string, operationId: string, actor: RequestAccount) {
    const target = await this.resolveValidationWorker(targetId, operationId)
    if (!this.workers || !target.session || !target.worker || !target.endpoint) {
      throw conflict('SESSION_NOT_CLAIMABLE', '验收会话尚未就绪')
    }
    const raw = await this.workers.requestJson({
      workerId: target.session.ownerWorkerId,
      workerInstanceId: target.worker.instanceId,
      actorId: actor.id,
      runId: operationId,
      sessionGeneration: target.session.generation,
      path: workerInternalPath('/auth/verify'),
      method: 'POST',
      endpoint: target.endpoint,
      timeout: 'auth',
      body: '{}',
    })
    return authObservationSchema.parse(raw)
  }

  private async resolveValidationWorker(targetId: string, operationId: string) {
    await getAuthProfileValidation(this.database, { targetId, operationId })
    const lease = await findAuthWaitLeaseForOperation(this.database, operationId)
    const session = lease ? await getSessionById(this.database, lease.sessionId) : null
    const worker = session ? await getWorkerById(this.database, session.ownerWorkerId) : null
    const endpoints = parseWorkerEndpoints(config.CAIRN_WORKER_ENDPOINTS, {
      networkMode: config.CAIRN_WORKER_NETWORK_MODE,
    })
    const evaluation = worker
      ? evaluateWorkerRoute({
          workerStatus: worker.status,
          workerInstanceId: worker.instanceId,
          sessionOwnerInstanceId: session?.ownerWorkerInstanceId ?? null,
          lostAfterSeconds: worker.lostAfterSeconds,
          heartbeatExpiresAt: worker.heartbeatExpiresAt,
          internalBaseUrl: worker.internalBaseUrl,
          asOf: new Date(),
          networkMode: config.CAIRN_WORKER_NETWORK_MODE,
          envEndpoint: endpoints[worker.id],
        })
      : null
    return {
      session,
      worker: evaluation?.availability === 'eligible' ? worker : null,
      endpoint: evaluation?.availability === 'eligible' ? evaluation.endpoint : null,
    }
  }
}
