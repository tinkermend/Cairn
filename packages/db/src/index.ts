export {
  createDatabase as createDb,
  type Database,
  type Database as DbHandle,
  type Database as Db,
} from './database.js'
export { newId } from './id.js'
export type { AuditActor } from './audit/record.js'
export { TargetsStore } from './console/targets.js'
export { RbacStore } from './console/rbac.js'
export type * from './records.js'
import { operation, nativeHandle, type Database } from './database.js'

import * as impl0 from './runs/index.js'
export { DomainError } from './runs/index.js'
export { badRequest } from './runs/index.js'
export { conflict } from './runs/index.js'
export { notFound } from './runs/index.js'
export { computeIdempotencyDigest } from './runs/index.js'
export { computeSnapshotDigest } from './runs/index.js'
export { sha256Hex } from './runs/index.js'
export const appendScenarioVersion = operation(impl0.appendScenarioVersion)
export const countRunsForScenario = operation(impl0.countRunsForScenario)
export const countScenariosForTarget = operation(impl0.countScenariosForTarget)
export const createScenarioWithVersion = operation(impl0.createScenarioWithVersion)
export const deleteScenario = operation(impl0.deleteScenario)
export const getScenario = operation(impl0.getScenario)
export const listScenarioVersions = operation(impl0.listScenarioVersions)
export const listScenarios = operation(impl0.listScenarios)
export const loadScenarioVersion = operation(impl0.loadScenarioVersion)
export const prepareTrialVersion = operation(impl0.prepareTrialVersion)
export const publishScenarioDraft = operation(impl0.publishScenarioDraft)
export const saveScenarioDraft = operation(impl0.saveScenarioDraft)
export const updateScenarioMeta = operation(impl0.updateScenarioMeta)
export const cancelPendingStepRuns = operation(impl0.cancelPendingStepRuns)
export const countRunsForAccount = operation(impl0.countRunsForAccount)
export const createRunWithSnapshot = operation(impl0.createRunWithSnapshot)
export const createTrialRunFromDraft = operation(impl0.createTrialRunFromDraft)
export const failRunAuthTimeout = operation(impl0.failRunAuthTimeout)
export const failRunValidation = operation(impl0.failRunValidation)
export const finishAttempt = operation(impl0.finishAttempt)
export const finishRunIfDrained = operation(impl0.finishRunIfDrained)
export const getRun = operation(impl0.getRun)
export const listRunEvidence = operation(impl0.listRunEvidence)
export const listRuns = operation(impl0.listRuns)
export const listRunsWaitingForAuthByAccount = operation(impl0.listRunsWaitingForAuthByAccount)
export const loadRunDetail = operation(impl0.loadRunDetail)
export const computeRunPlacement = operation(impl0.computeRunPlacement)
export const loadRunRow = operation(impl0.loadRunRow)
export const markRunCancelled = operation(impl0.markRunCancelled)
export const markRunWaitingForAuth = operation(impl0.markRunWaitingForAuth)
export const requestRunCancel = operation(impl0.requestRunCancel)
export const skipRemainingStepRuns = operation(impl0.skipRemainingStepRuns)
export const startAttempt = operation(impl0.startAttempt)
export type { FinishAttemptInput } from './runs/index.js'
export type { FinishAttemptResult } from './runs/index.js'
export type { RunWriteAuthority } from './runs/index.js'
export const expireStaleRunLeases = operation(impl0.expireStaleRunLeases)
export const reconcileOrphanAttempts = operation(impl0.reconcileOrphanAttempts)
export const resumeRunAfterAuth = operation(impl0.resumeRunAfterAuth)
export const reviewRun = operation(impl0.reviewRun)
export const settleLeaselessRun = operation(impl0.settleLeaselessRun)
export const settleRevokedRuns = operation(impl0.settleRevokedRuns)
export const sweepDriftedRuns = operation(impl0.sweepDriftedRuns)
export const yieldClaimedRun = operation(impl0.yieldClaimedRun)
export const yieldUnfinishedRun = operation(impl0.yieldUnfinishedRun)
export type { SettleOutcome } from './runs/index.js'
export type { YieldClaimReason } from './runs/index.js'
export type { YieldClaimResult } from './runs/index.js'

import * as impl1 from './leases/index.js'
export { WORKER_ID_CONFLICT } from './leases/index.js'
export const registerWorker = operation(impl1.registerWorker)
export const heartbeatWorker = operation(impl1.heartbeatWorker)
export const markWorkerDraining = operation(impl1.markWorkerDraining)
export const markWorkerStopped = operation(impl1.markWorkerStopped)
export const markLostWorkers = operation(impl1.markLostWorkers)
export const claimRun = (
  database: Database,
  ...args: Parameters<typeof impl1.claimRun> extends [unknown, ...infer A] ? A : never
) => impl1.claimRun(nativeHandle(database), ...args)
export const renewRunLease = operation(impl1.renewRunLease)
export const findActiveLeaseForRun = operation(impl1.findActiveLeaseForRun)
export const listActiveLeasesByRunIds = operation(impl1.listActiveLeasesByRunIds)
export const listActiveLeasesForWorker = operation(impl1.listActiveLeasesForWorker)
export const listExpiredActiveLeases = operation(impl1.listExpiredActiveLeases)
export const listDriftedRunningIds = operation(impl1.listDriftedRunningIds)
export { isFinishedOrNeedsReview } from './leases/index.js'
export type { WorkerRecord } from './leases/index.js'
export type { WorkerHeartbeatOutcome } from './leases/index.js'
export type { RegisterWorkerResult } from './leases/index.js'

import * as impl2 from './sessions/index.js'
export { SessionDomainError } from './sessions/index.js'
export { isReusable } from './sessions/index.js'
export { isClaimable } from './sessions/index.js'
export { profileKeyFor } from './sessions/index.js'
export const findLiveSession = operation(impl2.findLiveSession)
export const getSessionById = operation(impl2.getSessionById)
export const getLeaseById = operation(impl2.getLeaseById)
export const countOpenSessionsForWorker = operation(impl2.countOpenSessionsForWorker)
export const nextGenerationForKey = operation(impl2.nextGenerationForKey)
export const createSession = operation(impl2.createSession)
export const requireCreatedSession = operation(impl2.requireCreatedSession)
export const findEvictableSession = operation(impl2.findEvictableSession)
export const setSessionStatus = operation(impl2.setSessionStatus)
export const setSessionProbe = operation(impl2.setSessionProbe)
export const touchSessionUsed = operation(impl2.touchSessionUsed)
export const claimAuthHold = operation(impl2.claimAuthHold)
export const releaseAuthHold = operation(impl2.releaseAuthHold)
export const acquireSessionLease = operation(impl2.acquireSessionLease)
export const renewSessionLease = operation(impl2.renewSessionLease)
export const releaseSessionLease = operation(impl2.releaseSessionLease)
export const expireStaleLeases = operation(impl2.expireStaleLeases)
export const listReapableSessions = operation(impl2.listReapableSessions)
export const markSessionsClosing = operation(impl2.markSessionsClosing)
export const markSessionsLostForWorkers = operation(impl2.markSessionsLostForWorkers)
export const revokeWorkerLeases = operation(impl2.revokeWorkerLeases)
export const closeWorkerSessions = operation(impl2.closeWorkerSessions)
export const verifySessionLeaseForCommit = operation(impl2.verifySessionLeaseForCommit)
export const findActiveLeaseForSession = operation(impl2.findActiveLeaseForSession)
export const listActiveSessionLeasesForWorker = operation(impl2.listActiveSessionLeasesForWorker)
export const listOwnedLiveSessions = operation(impl2.listOwnedLiveSessions)
export const listOwnedOpenSessions = operation(impl2.listOwnedOpenSessions)
export const listExpiredAuthHolds = operation(impl2.listExpiredAuthHolds)
export const expireAuthHold = operation(impl2.expireAuthHold)
export const loadSecretCiphertext = operation(impl2.loadSecretCiphertext)
export const listSessions = operation(impl2.listSessions)
export { toSessionDto } from './sessions/index.js'
export const disposeStuckSession = operation(impl2.disposeStuckSession)
export { DISPOSABLE_SESSION_STATUSES } from './sessions/index.js'
export type { SessionKey } from './sessions/index.js'
export type { SessionRecord } from './sessions/index.js'
export type { LeaseRecord } from './sessions/index.js'
export type { LeaseBusyInfo } from './sessions/index.js'
export type { LeaseOutcome } from './sessions/index.js'
export type { CreateSessionInput } from './sessions/index.js'
export type { CreateSessionResult } from './sessions/index.js'

import * as impl3 from './objects/index.js'
export const bumpEvidenceUploadAttempts = operation(impl3.bumpEvidenceUploadAttempts)
export const commitObjectEvidence = operation(impl3.commitObjectEvidence)
export const commitStoredObject = operation(impl3.commitStoredObject)
export const findObjectEvidenceByAttemptType = operation(impl3.findObjectEvidenceByAttemptType)
export const findPendingObjectEvidence = operation(impl3.findPendingObjectEvidence)
export const getStoredObjectById = operation(impl3.getStoredObjectById)
export const getStoredObjectByKey = operation(impl3.getStoredObjectByKey)
export const listPurgeCandidates = operation(impl3.listPurgeCandidates)
export const markEvidenceMissing = operation(impl3.markEvidenceMissing)
export const markStoredObjectPurgeFailed = operation(impl3.markStoredObjectPurgeFailed)
export const markStoredObjectPurged = operation(impl3.markStoredObjectPurged)
export const recordMissingObjectEvidence = operation(impl3.recordMissingObjectEvidence)
export const recordObjectEvidence = operation(impl3.recordObjectEvidence)
export const reserveObjectEvidence = operation(impl3.reserveObjectEvidence)
export const reserveStoredObject = operation(impl3.reserveStoredObject)
export type { PurgeCandidate } from './objects/index.js'
export type { StoredObjectRecord } from './objects/index.js'
export const getEvidenceForRun = operation(impl3.getEvidenceForRun)
export const listPendingEvidence = operation(impl3.listPendingEvidence)
export const settleExpiredPendingEvidence = operation(impl3.settleExpiredPendingEvidence)
export const settleFinishedPendingRuns = operation(impl3.settleFinishedPendingRuns)
export const settleRunEvidence = operation(impl3.settleRunEvidence)
export type { PendingEvidenceRow } from './objects/index.js'
export type { SettleEvidenceOptions } from './objects/index.js'
export { toEvidenceMetadata } from './objects/index.js'

import * as impl4 from './recordings/index.js'
export const createRecordingDraft = operation(impl4.createRecordingDraft)
export const getRecordingDraft = operation(impl4.getRecordingDraft)
export const listRecordingDrafts = operation(impl4.listRecordingDrafts)

import * as impl5 from './console/lookups.js'
export const findLocalIdentity = operation(impl5.findLocalIdentity)
export const touchLocalIdentity = operation(impl5.touchLocalIdentity)
export const loadTargetForExecution = operation(impl5.loadTargetForExecution)
export const loadAccountForExecution = operation(impl5.loadAccountForExecution)
