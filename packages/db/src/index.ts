export {
  createDatabase as createDb,
  type Database,
  type Database as DbHandle,
  type Database as Db,
  type PoolStats,
} from "./database.js";
export {
  latestLogicalVersion,
  latestLogicalVersionForDriver,
} from "./migrate.js";
export { newId } from "./id.js";
export type { AuditActor } from "./audit/record.js";
export { TargetsStore } from "./console/targets.js";
import * as notificationConfig from "./notifications/config.js";
import * as notificationCore from "./notifications/core.js";
import * as notificationDelivery from "./notifications/delivery.js";
import * as notificationQuery from "./notifications/query.js";
import * as notificationMaintenance from "./notifications/maintenance.js";
export const importLegacyNotificationNotices = operation(
  notificationMaintenance.importLegacyNotificationNotices,
);
export const reconcileNotificationSuppressions = operation(
  notificationMaintenance.reconcileNotificationSuppressions,
);
export const purgeNotificationHistory = operation(
  notificationMaintenance.purgeNotificationHistory,
);
export const writeNotificationConfig = operation(
  notificationConfig.writeNotificationConfig,
);
export const readNotificationPolicy = operation(
  notificationConfig.readNotificationPolicy,
);
export const writeNotificationPolicy = operation(
  notificationConfig.writeNotificationPolicy,
);
export const prepareNotificationEvents = operation(
  notificationCore.prepareNotificationEvents,
);
export const repairNotificationIntents = operation(
  notificationCore.repairNotificationIntents,
);
export const claimNotificationDeliveries = operation(
  notificationDelivery.claimNotificationDeliveries,
);
export const beginNotificationSubmission = operation(
  notificationDelivery.beginNotificationSubmission,
);
export const finishNotificationDelivery = operation(
  notificationDelivery.finishNotificationDelivery,
);
export type {
  NotificationClaim,
  NotificationJob,
} from "./notifications/delivery.js";
export const listNotificationEvents = operation(
  notificationQuery.listNotificationEvents,
);
export const getNotificationEvent = operation(
  notificationQuery.getNotificationEvent,
);
export const getNotificationChannels = operation(
  notificationQuery.getNotificationChannels,
);
export const createNotificationTest = operation(
  notificationQuery.createNotificationTest,
);
export const operateNotificationDelivery = operation(
  notificationQuery.operateNotificationDelivery,
);
export { RbacStore } from "./console/rbac.js";
export type * from "./records.js";
import { operation, nativeHandle, type Database } from "./database.js";
import * as targetAuthorization from "./console/target-authorization.js";
export const assertTargetPermission = operation(
  targetAuthorization.assertTargetPermission,
);
export const targetScopeFor = operation(targetAuthorization.targetScopeFor);
export const authorizeTargetRequest = operation(
  targetAuthorization.authorizeTargetRequest,
);

import * as impl0 from "./runs/index.js";
export { DomainError } from "./runs/index.js";
export { badRequest } from "./runs/index.js";
export { conflict } from "./runs/index.js";
export { forbidden } from "./runs/index.js";
export { notFound } from "./runs/index.js";
export { computeIdempotencyDigest } from "./runs/index.js";
export { computeSnapshotDigest } from "./runs/index.js";
export { sha256Hex } from "./runs/index.js";
export const appendScenarioVersion = operation(impl0.appendScenarioVersion);
export const countRunsForScenario = operation(impl0.countRunsForScenario);
export const countScenariosForTarget = operation(impl0.countScenariosForTarget);
export const createScenarioWithVersion = operation(
  impl0.createScenarioWithVersion,
);
export const deleteScenario = operation(impl0.deleteScenario);
export const getScenario = operation(impl0.getScenario);
export const listScenarioVersions = operation(impl0.listScenarioVersions);
export const listScenarios = operation(impl0.listScenarios);
export const loadScenarioVersion = operation(impl0.loadScenarioVersion);
export const prepareTrialVersion = operation(impl0.prepareTrialVersion);
export const publishScenarioDraft = operation(impl0.publishScenarioDraft);
export const saveScenarioDraft = operation(impl0.saveScenarioDraft);
export const updateScenarioMeta = operation(impl0.updateScenarioMeta);
export const previewDeleteScenario = operation(impl0.previewDeleteScenario);
export const previewScenarioExpansion = operation(
  impl0.previewScenarioExpansion,
);
export const inlineScenarioModuleInvocation = operation(
  impl0.inlineScenarioModuleInvocation,
);
export const getOrCreateModuleVerificationScenario = operation(
  impl0.getOrCreateModuleVerificationScenario,
);
export const prepareModuleDraftTrial = operation(impl0.prepareModuleDraftTrial);
export const cancelPendingStepRuns = operation(impl0.cancelPendingStepRuns);
export const countRunsForAccount = operation(impl0.countRunsForAccount);
export const createRunWithSnapshot = operation(impl0.createRunWithSnapshot);
export const createTrialRunFromDraft = operation(impl0.createTrialRunFromDraft);
export const reserveAiModelCall = operation(impl0.reserveAiModelCall);
export const completeAiModelCall = operation(impl0.completeAiModelCall);
export type { ReserveAiModelCallInput } from "./runs/index.js";
export type { ReserveAiModelCallResult } from "./runs/index.js";
export const failRunValidation = operation(impl0.failRunValidation);
export const finishAttempt = operation(impl0.finishAttempt);
export const writeRunAuthCheckpoint = operation(impl0.writeRunAuthCheckpoint);
export const finishRunIfDrained = operation(impl0.finishRunIfDrained);
export const getRun = operation(impl0.getRun);
export const previewDeleteRun = operation(impl0.previewDeleteRun);
export const deleteRun = operation(impl0.deleteRun);
export const getRunCleanupStatus = operation(impl0.getRunCleanupStatus);
export const retryRunCleanup = operation(impl0.retryRunCleanup);
export const listRunEvidence = operation(impl0.listRunEvidence);
export const listRuns = operation(impl0.listRuns);
export const loadRunDetail = operation(impl0.loadRunDetail);
export const computeRunPlacement = operation(impl0.computeRunPlacement);
export const loadRunRow = operation(impl0.loadRunRow);
export const readOverviewAnalytics = operation(impl0.readOverviewAnalytics);
export const markRunCancelled = operation(impl0.markRunCancelled);
export const markRunWaitingForAuth = operation(impl0.markRunWaitingForAuth);
export const requestRunCancel = operation(impl0.requestRunCancel);
export const skipRemainingStepRuns = operation(impl0.skipRemainingStepRuns);
export const skipStepRuns = operation(impl0.skipStepRuns);
export const startAttempt = operation(impl0.startAttempt);
export const enterRunHolding = operation(impl0.enterRunHolding);
export const updateRunDebugOverlay = operation(impl0.updateRunDebugOverlay);
export const stopRunDebug = operation(impl0.stopRunDebug);
export const continueRunDebug = operation(impl0.continueRunDebug);
export type { FinishAttemptInput } from "./runs/index.js";
export type { FinishAttemptResult } from "./runs/index.js";
export type { RunWriteAuthority } from "./runs/index.js";
export const expireStaleRunLeases = operation(impl0.expireStaleRunLeases);
export const reconcileOrphanAttempts = operation(impl0.reconcileOrphanAttempts);
export const resumeRunAfterAuth = operation(impl0.resumeRunAfterAuth);
export const reviewRun = operation(impl0.reviewRun);
export const settleLeaselessRun = operation(impl0.settleLeaselessRun);
export const settleRevokedRuns = operation(impl0.settleRevokedRuns);
export const sweepDriftedRuns = operation(impl0.sweepDriftedRuns);
export const yieldClaimedRun = operation(impl0.yieldClaimedRun);
export const yieldUnfinishedRun = operation(impl0.yieldUnfinishedRun);
export const settleRunOutcome = operation(impl0.settleRunOutcome);
export const backfillOutcomeResults = operation(impl0.backfillOutcomeResults);
export type { OutcomeResultInsertItem } from "./runs/index.js";
export type { SettleOutcome } from "./runs/index.js";
export type { YieldClaimReason } from "./runs/index.js";
export type { YieldClaimResult } from "./runs/index.js";
export type { ScanBatchResult } from "./runtime/scan-batch.js";

import * as impl1 from "./leases/index.js";
export { WORKER_ID_CONFLICT } from "./leases/index.js";
export const registerWorker = operation(impl1.registerWorker);
export const heartbeatWorker = operation(impl1.heartbeatWorker);
export const getWorkerById = operation(impl1.getWorkerById);
export const markWorkerDraining = operation(impl1.markWorkerDraining);
export const markWorkerStopped = operation(impl1.markWorkerStopped);
export const markLostWorkers = operation(impl1.markLostWorkers);
export type { WorkerHeartbeatTelemetry } from "./leases/index.js";
export const isolateOrphanedSessions = operation(impl1.isolateOrphanedSessions);
export const resolveWorkerRoute = operation(impl1.resolveWorkerRoute);
export const listWorkers = operation(impl1.listWorkers);
export const getWorkerDetail = operation(impl1.getWorkerDetail);
export type { WorkerRouteResolution } from "./leases/index.js";
export {
  CLAIM_SCAN_LIMIT,
  CLAIM_EXCLUDE_LIMIT,
  takeLastClaimDiagnostics,
} from "./leases/index.js";
export type { ClaimRunDiagnostics } from "./leases/index.js";
export const claimRun = (
  database: Database,
  ...args: Parameters<typeof impl1.claimRun> extends [unknown, ...infer A]
    ? A
    : never
) => impl1.claimRun(nativeHandle(database), ...args);
export const renewRunLease = operation(impl1.renewRunLease);
export const findActiveLeaseForRun = operation(impl1.findActiveLeaseForRun);
export const listActiveLeasesByRunIds = operation(
  impl1.listActiveLeasesByRunIds,
);
export const listActiveLeasesForWorker = operation(
  impl1.listActiveLeasesForWorker,
);
export const listExpiredActiveLeases = operation(impl1.listExpiredActiveLeases);
export const listDriftedRunningIds = operation(impl1.listDriftedRunningIds);
export { isFinishedOrNeedsReview } from "./leases/index.js";
export type { WorkerRecord } from "./leases/index.js";
export type { WorkerHeartbeatOutcome } from "./leases/index.js";
export type { RegisterWorkerResult } from "./leases/index.js";

import * as impl2 from "./sessions/index.js";
import * as implSecrets from "./secrets/store.js";
export { SessionDomainError } from "./sessions/index.js";
export { isReusable } from "./sessions/index.js";
export { isClaimable } from "./sessions/index.js";
export { profileKeyFor } from "./sessions/index.js";
export const findLiveSession = operation(impl2.findLiveSession);
export const getSessionById = operation(impl2.getSessionById);
export const getLeaseById = operation(impl2.getLeaseById);
export const countOpenSessionsForWorker = operation(
  impl2.countOpenSessionsForWorker,
);
export const nextGenerationForKey = operation(impl2.nextGenerationForKey);
export const createSession = operation(impl2.createSession);
export const requireCreatedSession = operation(impl2.requireCreatedSession);
export const findEvictableSession = operation(impl2.findEvictableSession);
export const setSessionStatus = operation(impl2.setSessionStatus);
export const setSessionProbe = operation(impl2.setSessionProbe);
export const setSessionAuthSummary = operation(impl2.setSessionAuthSummary);
export const touchSessionUsed = operation(impl2.touchSessionUsed);
export const enterRunWaitingForAuth = operation(impl2.enterRunWaitingForAuth);
export const acquireAuthControl = operation(impl2.acquireAuthControl);
export const heartbeatAuthControl = operation(impl2.heartbeatAuthControl);
export const releaseAuthControl = operation(impl2.releaseAuthControl);
export const expireStaleAuthControl = operation(impl2.expireStaleAuthControl);
export const findSessionByAuthWaitRun = operation(
  impl2.findSessionByAuthWaitRun,
);
export {
  hashAuthControlToken,
  newAuthControlToken,
  authHoldFromLease,
  authWaitLeaseLive,
} from "./sessions/index.js";
export const listReapableSessions = operation(impl2.listReapableSessions);
export const listRequestedCloseSessions = operation(
  impl2.listRequestedCloseSessions,
);
export const markSessionsClosing = operation(impl2.markSessionsClosing);
export const markSessionsLostForWorkers = operation(
  impl2.markSessionsLostForWorkers,
);
export const revokeWorkerLeases = operation(impl2.revokeWorkerLeases);
export const closeWorkerSessions = operation(impl2.closeWorkerSessions);
export const verifySessionLeaseForCommit = operation(
  impl2.verifySessionLeaseForCommit,
);
export const findActiveLeaseForSession = operation(
  impl2.findActiveLeaseForSession,
);
export const listActiveSessionLeasesForWorker = operation(
  impl2.listActiveSessionLeasesForWorker,
);
export const listOwnedLiveSessions = operation(impl2.listOwnedLiveSessions);
export const listOwnedOpenSessions = operation(impl2.listOwnedOpenSessions);
export const loadSecretCiphertext = operation(implSecrets.loadSecretCiphertext);
export const registerStandaloneSecret = operation(
  implSecrets.registerStandaloneSecret,
);
export const upsertStandaloneSecret = operation(
  implSecrets.upsertStandaloneSecret,
);
export const listSessions = operation(impl2.listSessions);
export const getSessionDto = operation(impl2.getSessionDto);
export { toSessionDto } from "./sessions/index.js";
export const disposeStuckSession = operation(impl2.disposeStuckSession);
export { DISPOSABLE_SESSION_STATUSES } from "./sessions/index.js";
export const readSessionScheduling = operation(impl2.readSessionScheduling);
export const getSessionProfile = operation(impl2.getSessionProfile);
export const upsertSessionProfile = operation(impl2.upsertSessionProfile);
export const invalidateSessionProfile = operation(
  impl2.invalidateSessionProfile,
);
export const evaluateRunSessionEligibility = operation(
  impl2.evaluateRunSessionEligibility,
);
export const computeOccupancyPlacement = operation(
  impl2.computeOccupancyPlacement,
);
export const claimSessionUse = operation(impl2.claimSessionUse);
export const transitionSessionUse = operation(impl2.transitionSessionUse);
export const renewSessionUse = operation(impl2.renewSessionUse);
export const releaseSessionUse = operation(impl2.releaseSessionUse);
export const reapSessionLeases = operation(impl2.reapSessionLeases);
export const requestSessionOperation = operation(impl2.requestSessionOperation);
export const recordCaptchaLoginAttempt = operation(
  impl2.recordCaptchaLoginAttempt,
);
export const claimSessionOperation = operation(impl2.claimSessionOperation);
export const hasQueuedSessionCreateOperation = operation(
  impl2.hasQueuedSessionCreateOperation,
);
export const finishSessionOperation = operation(impl2.finishSessionOperation);
export const requestMaintenanceOperation = operation(
  impl2.requestMaintenanceOperation,
);
export const cancelSessionOperation = operation(impl2.cancelSessionOperation);
export const setSessionRetention = operation(impl2.setSessionRetention);
export const applyPendingRetentionIntent = operation(
  impl2.applyPendingRetentionIntent,
);
export const adoptSessionRetention = operation(impl2.adoptSessionRetention);
export const scheduleNextAuthCheck = operation(impl2.scheduleNextAuthCheck);
export const abandonSessionKeepAlive = operation(impl2.abandonSessionKeepAlive);
export const listDueRetainedSessions = operation(impl2.listDueRetainedSessions);
export const listAccountSessionOverview = operation(
  impl2.listAccountSessionOverview,
);
export const listSessionSystemOverview = operation(
  impl2.listSessionSystemOverview,
);
export const getAccountSessionDetail = operation(impl2.getAccountSessionDetail);
export const listSessionEvents = operation(impl2.listSessionEvents);
export const listSessionEventsAfter = operation(impl2.listSessionEventsAfter);
export const appendSessionEvent = operation(impl2.appendSessionEvent);
export const countSessionEventWatermark = operation(
  impl2.countSessionEventWatermark,
);
export type { ClaimedSessionOperation } from "./sessions/index.js";
export { occupancyGrantFromLease } from "./sessions/index.js";
export { contentDigestFor } from "./sessions/index.js";
export {
  workerHasOccupancyProtocol,
  workerHasMaintenanceProtocol,
  toSessionOperationDto,
} from "./sessions/index.js";
export const findActiveLeaseRow = operation(impl2.findActiveLeaseRow);
export const findAuthWaitLeaseForRun = operation(impl2.findAuthWaitLeaseForRun);
export const findAuthWaitLeaseForOperation = operation(
  impl2.findAuthWaitLeaseForOperation,
);
export const getSessionOperation = operation(impl2.getSessionOperation);
export const markSessionOperationWaitingForAuth = operation(
  impl2.markSessionOperationWaitingForAuth,
);
export const readLiveSessionAuth = operation(impl2.readLiveSessionAuth);
export const loadAuthProfileRevision = operation(impl2.loadAuthProfileRevision);
export const loadCurrentAuthProfile = operation(impl2.loadCurrentAuthProfile);
export const freezeAuthVerificationForRun = operation(
  impl2.freezeAuthVerificationForRun,
);
export const getTargetAuthProfileView = operation(
  impl2.getTargetAuthProfileView,
);
export const publishTargetAuthProfile = operation(
  impl2.publishTargetAuthProfile,
);
export const updateTargetAccountIdentity = operation(
  impl2.updateTargetAccountIdentity,
);
export const resetAuthBudgetAfterCredentialChange = operation(
  impl2.resetAuthBudgetAfterCredentialChange,
);
export const occupyAutoLoginBudget = operation(impl2.occupyAutoLoginBudget);
export const recordAutoLoginOutcome = operation(impl2.recordAutoLoginOutcome);
export const startAuthProfileValidation = operation(
  impl2.startAuthProfileValidation,
);
export const getAuthProfileValidation = operation(
  impl2.getAuthProfileValidation,
);
export const observeAuthProfileValidation = operation(
  impl2.observeAuthProfileValidation,
);
export const listTargetsOutsideFreshnessRange = operation(
  impl2.listTargetsOutsideFreshnessRange,
);
export const loadAccountAuthDisplay = operation(impl2.loadAccountAuthDisplay);
export const assertLiveAuthConfiguration = operation(
  impl2.assertLiveAuthConfiguration,
);
export type { OccupancyOwner } from "./sessions/index.js";
export type { ClaimSessionUseInput } from "./sessions/index.js";
export type { ClaimSessionUseResult } from "./sessions/index.js";
export type { PlacementFacts } from "./sessions/index.js";
export type { SessionKey } from "./sessions/index.js";
export type { SessionRecord } from "./sessions/index.js";
export type { LeaseRecord } from "./sessions/index.js";
export type { LeaseBusyInfo } from "./sessions/index.js";
export type { LeaseOutcome } from "./sessions/index.js";
export type { CreateSessionInput } from "./sessions/index.js";
export type { CreateSessionResult } from "./sessions/index.js";

import * as impl3 from "./objects/index.js";
export const bumpEvidenceUploadAttempts = operation(
  impl3.bumpEvidenceUploadAttempts,
);
export const commitObjectEvidence = operation(impl3.commitObjectEvidence);
export const commitStoredObject = operation(impl3.commitStoredObject);
export const findObjectEvidenceByAttemptType = operation(
  impl3.findObjectEvidenceByAttemptType,
);
export const findObjectEvidenceByArtifactKey = operation(
  impl3.findObjectEvidenceByArtifactKey,
);
export const findObjectEvidenceByRunType = operation(
  impl3.findObjectEvidenceByRunType,
);
export const findPendingObjectEvidence = operation(
  impl3.findPendingObjectEvidence,
);
export const getStoredObjectById = operation(impl3.getStoredObjectById);
export const getStoredObjectByKey = operation(impl3.getStoredObjectByKey);
export const listPurgeCandidates = operation(impl3.listPurgeCandidates);
export const markEvidenceMissing = operation(impl3.markEvidenceMissing);
export const markStoredObjectPurgeFailed = operation(
  impl3.markStoredObjectPurgeFailed,
);
export const markStoredObjectPurged = operation(impl3.markStoredObjectPurged);
export const recordMissingObjectEvidence = operation(
  impl3.recordMissingObjectEvidence,
);
export const recordObjectEvidence = operation(impl3.recordObjectEvidence);
export const reserveObjectEvidence = operation(impl3.reserveObjectEvidence);
export const reopenAvailableRunVideo = operation(impl3.reopenAvailableRunVideo);
export const enqueueRunVideoMediaJob = operation(impl3.enqueueRunVideoMediaJob);
export const claimRunVideoMediaJobs = operation(impl3.claimRunVideoMediaJobs);
export const finishRunVideoMediaJob = operation(impl3.finishRunVideoMediaJob);
export const getRunVideoMediaJob = operation(impl3.getRunVideoMediaJob);
export const listDueRunVideoMediaJobIds = operation(
  impl3.listDueRunVideoMediaJobIds,
);
export type { RunVideoMediaJob, RunVideoMediaClaim } from "./objects/index.js";
export const reserveStoredObject = operation(impl3.reserveStoredObject);
export type { PurgeCandidate } from "./objects/index.js";
export type { StoredObjectRecord } from "./objects/index.js";
export const getEvidenceForRun = operation(impl3.getEvidenceForRun);
export const listPendingEvidence = operation(impl3.listPendingEvidence);
export const markOrphanedRunVideoLost = operation(
  impl3.markOrphanedRunVideoLost,
);
export const settleExpiredPendingEvidence = operation(
  impl3.settleExpiredPendingEvidence,
);
export const settleFinishedPendingRuns = operation(
  impl3.settleFinishedPendingRuns,
);
export const settleRunEvidence = operation(impl3.settleRunEvidence);
export const recordInlineLogEvidence = operation(impl3.recordInlineLogEvidence);
export type { PendingEvidenceRow } from "./objects/index.js";
export type { SettleEvidenceOptions } from "./objects/index.js";
export { toEvidenceMetadata } from "./objects/index.js";

import * as impl4 from "./recordings/index.js";
export const createRecordingDraft = operation(impl4.createRecordingDraft);
export const createDemonstration = operation(impl4.createDemonstration);
export const getDemonstration = operation(impl4.getDemonstration);
export const previewDemonstrationImport = operation(
  impl4.previewDemonstrationImport,
);
export const applyDemonstrationImport = operation(
  impl4.applyDemonstrationImport,
);
export const reserveRecordingArtifactUpload = operation(
  impl4.reserveRecordingArtifactUpload,
);
export const commitRecordingArtifactUpload = operation(
  impl4.commitRecordingArtifactUpload,
);
export const abandonRecordingArtifactUpload = operation(
  impl4.abandonRecordingArtifactUpload,
);
export const readRecordingArtifact = operation(impl4.readRecordingArtifact);
export const claimRecordingArtifactCleanup = operation(
  impl4.claimRecordingArtifactCleanup,
);
export const settleRecordingArtifactCleanup = operation(
  impl4.settleRecordingArtifactCleanup,
);
export { RECORDING_UPLOAD_DEADLINE_MS } from "./recordings/index.js";
export const getRecordingDraft = operation(impl4.getRecordingDraft);
export const listRecordingDrafts = operation(impl4.listRecordingDrafts);
export const renameRecordingDraft = operation(impl4.renameRecordingDraft);
export const deleteRecordingDraft = operation(impl4.deleteRecordingDraft);
export const createRecordingBinding = operation(impl4.createRecordingBinding);
export const claimRecordingBinding = operation(impl4.claimRecordingBinding);
export const closeRecordingBinding = operation(impl4.closeRecordingBinding);
export const getOpenRecordingBinding = operation(impl4.getOpenRecordingBinding);
export const listScenarioRecordingImports = operation(
  impl4.listScenarioRecordingImports,
);
export const previewRecordingImport = operation(impl4.previewRecordingImport);
export const applyRecordingImport = operation(impl4.applyRecordingImport);
export const continueRecordingMapIngest = operation(
  impl4.continueRecordingMapIngest,
);
export {
  RECORDING_MAP_INGEST_SERVICE_ID,
  recordingMapIngestTestHooks,
} from "./recordings/index.js";
export {
  encodeCursor,
  decodeCursor,
  cursorFilter,
  paginateResults,
} from "./cursor.js";

import * as impl5 from "./console/lookups.js";
export const findLocalIdentity = operation(impl5.findLocalIdentity);
export const touchLocalIdentity = operation(impl5.touchLocalIdentity);
export const loadTargetForExecution = operation(impl5.loadTargetForExecution);
export const loadAccountForExecution = operation(impl5.loadAccountForExecution);

import * as services from "./services/access.js";
import * as serviceWebhooks from "./services/webhooks.js";
export const listServiceCallers = operation(services.listServiceCallers);
export const getServiceCaller = operation(services.getServiceCaller);
export const saveServiceCaller = operation(services.saveServiceCaller);
export const setServiceCallerStatus = operation(
  services.setServiceCallerStatus,
);
export const archiveServiceCaller = operation(services.archiveServiceCaller);
export const issueServiceCredential = operation(
  services.issueServiceCredential,
);
export const updateServiceCredential = operation(
  services.updateServiceCredential,
);
export const updateServiceCredentialMetadata = operation(
  services.updateServiceCredentialMetadata,
);
export const setServiceCredentialSuspended = operation(
  services.setServiceCredentialSuspended,
);
export const setServiceCallerIpWhitelist = operation(
  services.setServiceCallerIpWhitelist,
);
export const listServiceOutstandingRuns = operation(
  services.listServiceOutstandingRuns,
);
export const cancelServiceOutstandingRun = operation(
  services.cancelServiceOutstandingRun,
);
export const authenticateService = operation(services.authenticateService);
export const recordServiceRequestLog = operation(
  services.recordServiceRequestLog,
);
export const listServiceRequestLogs = operation(
  services.listServiceRequestLogs,
);
export const getServiceRequestLog = operation(services.getServiceRequestLog);
export const reapServiceRequestLogs = operation(
  services.reapServiceRequestLogs,
);
export const getServiceCredentialCatalog = operation(
  services.getServiceCredentialCatalog,
);
export const createServiceRun = operation(services.createServiceRun);
export const getServiceRun = operation(services.getServiceRun);
export const listServiceRuns = operation(services.listServiceRuns);
export const serviceCatalog = operation(services.serviceCatalog);
export const getServiceWebhook = operation(serviceWebhooks.getServiceWebhook);
export const getServiceWebhookSecretId = operation(
  serviceWebhooks.getServiceWebhookSecretId,
);
export const saveServiceWebhook = operation(serviceWebhooks.saveServiceWebhook);
export const listServiceWebhookDeliveries = operation(
  serviceWebhooks.listServiceWebhookDeliveries,
);
export const retryServiceWebhookDelivery = operation(
  serviceWebhooks.retryServiceWebhookDelivery,
);
export const enqueueServiceWebhookDeliveries = operation(
  serviceWebhooks.enqueueServiceWebhookDeliveries,
);
export const claimServiceWebhookDeliveries = operation(
  serviceWebhooks.claimServiceWebhookDeliveries,
);
export const beginServiceWebhookSubmission = operation(
  serviceWebhooks.beginServiceWebhookSubmission,
);
export const finishServiceWebhookDelivery = operation(
  serviceWebhooks.finishServiceWebhookDelivery,
);
export const createServicePlaygroundRun = operation(
  serviceWebhooks.createServicePlaygroundRun,
);
export const buildServiceOpenApi = operation(serviceWebhooks.buildServiceOpenApi);
export type {
  ServiceWebhookClaim,
  ServiceWebhookJob,
} from "./services/webhooks.js";
export const releaseServiceEvidence = operation(
  services.releaseServiceEvidence,
);
export const serviceEvidence = operation(services.serviceEvidence);

import { expireRunDeadlines as expireDeadlines } from "./runs/deadline.js";
export const expireRunDeadlines = operation(expireDeadlines);

import * as observe from "./observe/index.js";
export const appendRunEvents = operation(observe.appendRunEvents);
export const loadRunObservation = operation(observe.loadRunObservation);
export const listRunEventsAfter = operation(observe.listRunEventsAfter);
export const loadRunEventWatermark = operation(observe.loadRunEventWatermark);
export const listRunEventWatermarks = operation(observe.listRunEventWatermarks);
export const purgeExpiredRunEvents = operation(observe.purgeExpiredRunEvents);
export const diagnoseRunEventCursor = observe.diagnoseRunEventCursor;
export const createChangeHint = observe.createChangeHint;
export const setChangeHintPublisher = observe.setChangeHintPublisher;
export const resetChangeHintPublisher = observe.resetChangeHintPublisher;
export type { ChangeHintBus } from "./observe/index.js";
export type { RunEventDraft } from "./observe/index.js";

import * as platformConfig from "./platform-config/index.js";
export const getPlatformConfig = operation(platformConfig.getPlatformConfig);
export const getOrCreatePlatformConfig = operation(
  platformConfig.getOrCreatePlatformConfig,
);
export const getPlatformConfigRevision = operation(
  platformConfig.getPlatformConfigRevision,
);
export const updatePlatformConfig = operation(
  platformConfig.updatePlatformConfig,
);
export const restorePlatformConfig = operation(
  platformConfig.restorePlatformConfig,
);
export const listPlatformConfigRevisions = operation(
  platformConfig.listPlatformConfigRevisions,
);
export const registerPlatformAiSecret = operation(
  platformConfig.registerPlatformAiSecret,
);
export const loadPlatformAiSecret = operation(
  platformConfig.loadPlatformAiSecret,
);
export type { PlatformBootstrap } from "./platform-config/index.js";

import * as assistant from "./assistant/index.js";
export const createAssistantConversation = operation(
  assistant.createAssistantConversation,
);
export const listAssistantConversations = operation(
  assistant.listAssistantConversations,
);
export const getAssistantConversation = operation(
  assistant.getAssistantConversation,
);
export const beginAssistantTurn = operation(assistant.beginAssistantTurn);
export const completeAssistantTurn = operation(assistant.completeAssistantTurn);
export const getAssistantTurn = operation(assistant.getAssistantTurn);
export const getAssistantTurnRecord = operation(
  assistant.getAssistantTurnRecord,
);
export const listAssistantTurns = operation(assistant.listAssistantTurns);
export const listAssistantTurnRecords = operation(
  assistant.listAssistantTurnRecords,
);
export const recordPlatformAiCall = operation(assistant.recordPlatformAiCall);
export const interruptExpiredAssistantTurns = operation(
  assistant.interruptExpiredAssistantTurns,
);
export const purgeExpiredAssistantBodies = operation(
  assistant.purgeExpiredAssistantBodies,
);

import * as mapFacts from "./map/index.js";
export const appendMapObservation = operation(mapFacts.appendMapObservation);
export const appendMapVerification = operation(mapFacts.appendMapVerification);
export const appendMapFacts = operation(mapFacts.appendMapFacts);
export const readMapFacts = operation(mapFacts.readMapFacts);
export const captureMapWatermark = operation(mapFacts.captureMapWatermark);
export const getMapFact = operation(mapFacts.getMapFact);
export const previewMapFactRetention = operation(
  mapFacts.previewMapFactRetention,
);
export const expireMapFactContents = operation(mapFacts.expireMapFactContents);
export const isMapFactWriteOpen = mapFacts.isMapFactWriteOpen;
export const setMapFactWriteOpen = mapFacts.setMapFactWriteOpen;
export const setMapFactCommitListener = mapFacts.setMapFactCommitListener;
export { MAP_FACTS_PROTOCOL } from "./map/index.js";
export const resolveMapRunSourceType = operation(
  mapFacts.resolveMapRunSourceType,
);
export { mapFactTestHooks } from "./map/index.js";
export type { AppendMapFactResult } from "./map/index.js";
export type { MapStoredFact } from "./map/index.js";
export type { MapFactCommitHint } from "./map/index.js";
export const applyMapIdentityCommand = operation(
  mapFacts.applyMapIdentityCommand,
);
export const ensureMapProjection = operation(mapFacts.ensureMapProjection);
export const startMapProjectionRebuild = operation(
  mapFacts.startMapProjectionRebuild,
);
export const listMapProjectionWork = operation(mapFacts.listMapProjectionWork);
export const loadMapProjectionState = operation(
  mapFacts.loadMapProjectionState,
);
export const loadMapProjectionWorkingSet = operation(
  mapFacts.loadMapProjectionWorkingSet,
);
export const commitMapProjectionBatch = operation(
  mapFacts.commitMapProjectionBatch,
);
export const recordMapProjectionFailure = operation(
  mapFacts.recordMapProjectionFailure,
);
export const promoteMapProjection = operation(mapFacts.promoteMapProjection);
export const getMapProjection = operation(mapFacts.getMapProjection);
export const sealMapRelease = operation(mapFacts.sealMapRelease);
export const getMapRelease = operation(mapFacts.getMapRelease);
export const loadMapQueryView = operation(mapFacts.loadMapQueryView);
export const resolveMapView = operation(mapFacts.resolveMapView);
export const getMapSummary = operation(mapFacts.getMapSummary);
export const listMapAssets = operation(mapFacts.listMapAssets);
export const listMapJobCandidateAssets = operation(
  mapFacts.listMapJobCandidateAssets,
);
export const getMapAssetDetail = operation(mapFacts.getMapAssetDetail);
export const listMapChanges = operation(mapFacts.listMapChanges);
export const requestMapProjectionRebuild = operation(
  mapFacts.requestMapProjectionRebuild,
);
export const previewMapGovernance = operation(mapFacts.previewMapGovernance);
export const applyMapGovernanceCommand = operation(
  mapFacts.applyMapGovernanceCommand,
);
export const getMapGovernanceCommand = operation(
  mapFacts.getMapGovernanceCommand,
);
export const loadLifecycleOverrides = operation(
  mapFacts.loadLifecycleOverrides,
);
export const sealAndPublishMapRelease = operation(
  mapFacts.sealAndPublishMapRelease,
);
export const publishMapRelease = operation(mapFacts.publishMapRelease);
export const withdrawMapRelease = operation(mapFacts.withdrawMapRelease);
export const getMapReleasePublication = operation(
  mapFacts.getMapReleasePublication,
);
export const listMapReleases = operation(mapFacts.listMapReleases);
export const upsertMapScenarioBinding = operation(
  mapFacts.upsertMapScenarioBinding,
);
export const removeMapScenarioBinding = operation(
  mapFacts.removeMapScenarioBinding,
);
export const listMapReferences = operation(mapFacts.listMapReferences);
export const loadMapImpactSource = operation(mapFacts.loadMapImpactSource);
export const startMapReferenceScan = operation(mapFacts.startMapReferenceScan);
export const listMapReferenceScanWork = operation(
  mapFacts.listMapReferenceScanWork,
);
export const advanceMapReferenceScan = operation(
  mapFacts.advanceMapReferenceScan,
);
export const loadTargetScanAssets = operation(mapFacts.loadTargetScanAssets);
export const loadTargetScanScenarios = operation(
  mapFacts.loadTargetScanScenarios,
);
export const loadTargetScanSource = operation(mapFacts.loadTargetScanSource);
export const loadRunMapClues = operation(mapFacts.loadRunMapClues);
export const getMapConsumptionPolicy = operation(
  mapFacts.getMapConsumptionPolicy,
);
export const updateMapConsumptionPolicy = operation(
  mapFacts.updateMapConsumptionPolicy,
);
export const grantMapConsumptionEligibility = operation(
  mapFacts.grantMapConsumptionEligibility,
);
export const findMapConsumptionAttemptObservation = operation(
  mapFacts.findMapConsumptionAttemptObservation,
);
export const hasReadyMapConsumptionWorker = operation(
  mapFacts.hasReadyMapConsumptionWorker,
);
export const appendMapSelectionDecision = operation(
  mapFacts.appendMapSelectionDecision,
);
export const listMapSelectionDecisions = operation(
  mapFacts.listMapSelectionDecisions,
);
export const loadFrozenMapCandidates = operation(
  mapFacts.loadFrozenMapCandidates,
);
export const getTargetAccessPolicy = operation(mapFacts.getTargetAccessPolicy);
export const updateTargetAccessPolicy = operation(
  mapFacts.updateTargetAccessPolicy,
);
export const getMapJobPolicy = operation(mapFacts.getMapJobPolicy);
export const updateMapJobPolicy = operation(mapFacts.updateMapJobPolicy);
export const getExplorationPolicy = operation(mapFacts.getExplorationPolicy);
export const updateExplorationPolicy = operation(
  mapFacts.updateExplorationPolicy,
);
export const listMapSafeEntries = operation(mapFacts.listMapSafeEntries);
export const createMapSafeEntry = operation(mapFacts.createMapSafeEntry);
export const getMapSafeEntry = operation(mapFacts.getMapSafeEntry);
export const getMapJob = operation(mapFacts.getMapJob);
export const hasReadyMapJobWorker = operation(mapFacts.hasReadyMapJobWorker);
export const hasReadyMapExploreWorker = operation(
  mapFacts.hasReadyMapExploreWorker,
);
export const createMapJob = operation(mapFacts.createMapJob);
export const cancelMapJob = operation(mapFacts.cancelMapJob);
export const completeMapJobSlice = operation(mapFacts.completeMapJobSlice);
export const hasClaimableUserRun = operation(mapFacts.hasClaimableUserRun);
export type { FrozenMapCandidate } from "./map/index.js";
export {
  mapProjectionTestHooks,
  MAP_ASSETS_POLICY_VERSION,
} from "./map/index.js";
export type { MapProjectionWorkItem } from "./map/index.js";

import * as actionModuleImpl from "./action-modules/index.js";
export const listActionModules = operation(actionModuleImpl.listActionModules);
export const getActionModule = operation(actionModuleImpl.getActionModule);
export const createActionModule = operation(
  actionModuleImpl.createActionModule,
);
export const updateActionModuleMeta = operation(
  actionModuleImpl.updateActionModuleMeta,
);
export const saveActionModuleDraft = operation(
  actionModuleImpl.saveActionModuleDraft,
);
export const publishActionModule = operation(
  actionModuleImpl.publishActionModule,
);
export const listActionModuleVersions = operation(
  actionModuleImpl.listActionModuleVersions,
);
export const getActionModuleVersion = operation(
  actionModuleImpl.getActionModuleVersion,
);
export const deleteActionModule = operation(
  actionModuleImpl.deleteActionModule,
);
export const listModuleReferences = operation(
  actionModuleImpl.listModuleReferences,
);
export const previewScenarioModuleUpgrade = operation(
  actionModuleImpl.previewScenarioModuleUpgrade,
);
export const upgradeScenarioModuleDraft = operation(
  actionModuleImpl.upgradeScenarioModuleDraft,
);
export const batchUpgradeModuleDrafts = operation(
  actionModuleImpl.batchUpgradeModuleDrafts,
);
export const updateModulePublication = operation(
  actionModuleImpl.updateModulePublication,
);
export const disableAffectedScenarios = operation(
  actionModuleImpl.disableAffectedScenarios,
);
export const previewDeleteActionModule = operation(
  actionModuleImpl.previewDeleteActionModule,
);
export const extractModuleFromScenario = operation(
  actionModuleImpl.extractModuleFromScenario,
);
export const previewReplaceStepsWithModule = operation(
  actionModuleImpl.previewReplaceStepsWithModule,
);
export const replaceStepsWithModule = operation(
  actionModuleImpl.replaceStepsWithModule,
);
export const proposeExtractFromScenario = operation(
  actionModuleImpl.proposeExtractFromScenario,
);
export const resolveActionModules = operation(
  actionModuleImpl.resolveActionModules,
);
export const getModuleResolution = operation(
  actionModuleImpl.getModuleResolution,
);
export const closeModuleResolution = operation(
  actionModuleImpl.closeModuleResolution,
);
export const acceptModuleResolution = operation(
  actionModuleImpl.acceptModuleResolution,
);
export const purgeExpiredModuleResolutions = operation(
  actionModuleImpl.purgeExpiredModuleResolutions,
);
export const projectModuleInvocationResults = operation(
  actionModuleImpl.projectModuleInvocationResults,
);
export const backfillModuleInvocationResults = operation(
  actionModuleImpl.backfillModuleInvocationResults,
);
export const getActionModuleQuality = operation(
  actionModuleImpl.getActionModuleQuality,
);
export const listModuleInvocations = operation(
  actionModuleImpl.listModuleInvocations,
);
export const attachModuleListHealth = operation(
  actionModuleImpl.attachModuleListHealth,
);
export const requireModuleQualityConfig = operation(
  actionModuleImpl.requireModuleQualityConfig,
);
export {
  computeContractDigest,
  computeImplementationDigest,
  computeSingleImplementationDigest,
  computeContentDigest,
} from "./action-modules/index.js";

import * as knowledgeImpl from "./knowledge/index.js";
export const validateKnowledgeSources = operation(
  knowledgeImpl.validateKnowledgeSources,
);
export const listTerminology = operation(knowledgeImpl.listTerminology);
export const getTerminology = operation(knowledgeImpl.getTerminology);
export const matchTerminology = operation(knowledgeImpl.matchTerminology);
export const createTerminology = operation(knowledgeImpl.createTerminology);
export const updateTerminology = operation(knowledgeImpl.updateTerminology);
export const retireTerminology = operation(knowledgeImpl.retireTerminology);
export const listTerminologyForCompose = operation(
  knowledgeImpl.listTerminologyForCompose,
);
export const findKnowledgeProposalRequest = operation(
  knowledgeImpl.findKnowledgeProposalRequest,
);
export const getKnowledgeProposal = operation(
  knowledgeImpl.getKnowledgeProposal,
);
export const startKnowledgeProposal = operation(
  knowledgeImpl.startKnowledgeProposal,
);
export const completeKnowledgeProposal = operation(
  knowledgeImpl.completeKnowledgeProposal,
);
export const acceptKnowledgeProposal = operation(
  knowledgeImpl.acceptKnowledgeProposal,
);
export const rejectKnowledgeProposal = operation(
  knowledgeImpl.rejectKnowledgeProposal,
);
export const listPublishedModuleKnowledge = operation(
  knowledgeImpl.listPublishedModuleKnowledge,
);
export const loadKnowledgeMapContext = operation(
  knowledgeImpl.loadKnowledgeMapContext,
);
export type {
  KnowledgeComposePersist,
  PublishedModuleKnowledgeRow,
} from "./knowledge/index.js";

export const assertSessionAccountActive = operation(
  impl2.assertSessionAccountActive,
);
export const assertSessionActorPermission = operation(
  impl2.assertSessionActorPermission,
);
export const assertMaintenanceAuthorized = operation(
  impl2.assertMaintenanceAuthorized,
);
export const recoverSessionOperations = operation(
  impl2.recoverSessionOperations,
);
export const markMaintenanceLoginSubmitted = operation(
  impl2.markMaintenanceLoginSubmitted,
);

export const bindOperationSession = operation(impl2.bindOperationSession);

import * as scheduleImpl from "./schedules/index.js";
export const getSchedule = operation(scheduleImpl.getSchedule);
export const listSchedules = operation(scheduleImpl.listSchedules);
export const writeSchedule = operation(scheduleImpl.writeSchedule);
export const setScheduleEnabled = operation(scheduleImpl.setScheduleEnabled);
export const listScheduleOccurrences = operation(
  scheduleImpl.listScheduleOccurrences,
);
export const listScheduleEvents = operation(scheduleImpl.listScheduleEvents);
export const previewScheduleDefinition = operation(
  scheduleImpl.previewScheduleDefinition,
);
export const materializeDueSchedules = operation(
  scheduleImpl.materializeDueSchedules,
);
export const admitScheduleOccurrence = operation(
  scheduleImpl.admitScheduleOccurrence,
);
export const expireClosedScheduleWindows = operation(
  scheduleImpl.expireClosedScheduleWindows,
);
export const expireScheduledMapJobs = operation(
  scheduleImpl.expireScheduledMapJobs,
);
export const actorCanAdmitSchedules = operation(
  scheduleImpl.actorCanAdmitSchedules,
);
export type { PendingScheduleAdmit } from "./schedules/index.js";

export const recreateSessionForOperation = operation(
  impl2.recreateSessionForOperation,
);

import * as monitoringImpl from "./monitoring/index.js";
export const summarizeFleet = operation(monitoringImpl.summarizeFleet);
export const summarizeQueues = operation(monitoringImpl.summarizeQueues);
export const summarizeAnomalies = operation(monitoringImpl.summarizeAnomalies);
export const listMonitorProfiles = operation(
  monitoringImpl.listMonitorProfiles,
);
export const countSessionOperationBacklog = operation(
  monitoringImpl.countSessionOperationBacklog,
);
export const readMonitorClock = operation(monitoringImpl.readMonitorClock);
export const readAppliedSchemaPrefix = (database: Database) =>
  monitoringImpl.readAppliedSchemaPrefix(nativeHandle(database));
export const readSchemaVersion = (database: Database) =>
  monitoringImpl.readSchemaVersion(nativeHandle(database));
export type { AppliedSchemaVersion } from "./monitoring/index.js";
export const heartbeatApiInstance = operation(
  monitoringImpl.heartbeatApiInstance,
);
export const markApiInstanceStopped = operation(
  monitoringImpl.markApiInstanceStopped,
);
export const markLostApiInstances = operation(
  monitoringImpl.markLostApiInstances,
);
export const listApiInstanceCard = operation(
  monitoringImpl.listApiInstanceCard,
);
export const upsertObjectStoreProbe = operation(
  monitoringImpl.upsertObjectStoreProbe,
);
export const readObjectStoreCard = operation(
  monitoringImpl.readObjectStoreCard,
);
export const recordManualObjectStoreProbe = operation(
  monitoringImpl.recordManualObjectStoreProbe,
);
export const insertMonitorSamples = operation(
  monitoringImpl.insertMonitorSamples,
);
export const purgeMonitorSamples = operation(
  monitoringImpl.purgeMonitorSamples,
);
export const readMonitorSeries = operation(monitoringImpl.readMonitorSeries);
export const summarizeAi = operation(monitoringImpl.summarizeAi);
export const collectPlatformSamples = operation(
  monitoringImpl.collectPlatformSamples,
);
export const collectWorkerSamples = operation(
  monitoringImpl.collectWorkerSamples,
);
export const collectAlertReadings = operation(
  monitoringImpl.collectAlertReadings,
);
export const evaluateAlerts = operation(monitoringImpl.evaluateAlerts);
export const listMonitorAlerts = operation(monitoringImpl.listMonitorAlerts);
export const listMonitorAlertRules = operation(
  monitoringImpl.listMonitorAlertRules,
);
export const updateAlertingRules = operation(
  monitoringImpl.updateAlertingRules,
);
export const upsertAlertChannel = operation(monitoringImpl.upsertAlertChannel);
export const silenceMonitorAlert = operation(
  monitoringImpl.silenceMonitorAlert,
);
export const claimDueAlertDeliveries = operation(
  monitoringImpl.claimDueAlertDeliveries,
);
export const finishAlertDelivery = operation(
  monitoringImpl.finishAlertDelivery,
);
export const resolveAlerting = monitoringImpl.resolveAlerting;
export const findAlertChannel = monitoringImpl.findAlertChannel;
export type { ApiInstanceHeartbeatInput } from "./monitoring/index.js";
export type { ObjectStoreProbeWrite } from "./monitoring/index.js";
export type { MonitorSampleWrite } from "./monitoring/index.js";
export type { AlertDeliveryJob } from "./monitoring/index.js";

import * as watermarkImpl from "./runtime/watermarks.js";
export const GLOBAL_RECLAIM_WATERMARK = watermarkImpl.GLOBAL_RECLAIM_WATERMARK;
export const touchRuntimeWatermark = operation(
  watermarkImpl.touchRuntimeWatermark,
);
export const readRuntimeWatermark = operation(
  watermarkImpl.readRuntimeWatermark,
);
import * as periodicSlotImpl from "./runtime/periodic-slots.js";
export const claimDuePeriodicSlots = operation(
  periodicSlotImpl.claimDuePeriodicSlots,
);
export const finishPeriodicSlot = operation(
  periodicSlotImpl.finishPeriodicSlot,
);
export const readPeriodicSlots = operation(periodicSlotImpl.readPeriodicSlots);
export type {
  PeriodicSlotClaim,
  PeriodicSlotRecord,
  PeriodicSlotRequest,
  PeriodicSlotSkip,
} from "./runtime/periodic-slots.js";
import * as accountUsageImpl from "./console/account-usage.js";
export const requireMapCapableAccount = operation(
  accountUsageImpl.requireMapCapableAccount,
);
export const requireTargetHasMapCapableAccount = operation(
  accountUsageImpl.requireTargetHasMapCapableAccount,
);

import * as credentialImpl from "./credentials/index.js";
export const listCredentials = operation(credentialImpl.listCredentials);
export const getCredential = operation(credentialImpl.getCredential);
export const updateCredentialMetadata = operation(
  credentialImpl.updateCredentialMetadata,
);
export const setCredentialEnabled = operation(
  credentialImpl.setCredentialEnabled,
);
export const revokeCredentialVersion = operation(
  credentialImpl.revokeCredentialVersion,
);
export const listCredentialUsages = operation(
  credentialImpl.listCredentialUsages,
);
export const listCredentialHistory = operation(
  credentialImpl.listCredentialHistory,
);
export const loadAccountCredentialView = operation(
  credentialImpl.loadAccountCredentialView,
);
export const registerCredential = operation(credentialImpl.registerCredential);
export const replaceCredentialMaterial = operation(
  credentialImpl.replaceCredentialMaterial,
);
export const clearCredential = operation(credentialImpl.clearCredential);
export const resolveCredentialImport = operation(
  credentialImpl.resolveCredentialImport,
);
export const credentialOwnerCandidates = operation(
  credentialImpl.credentialOwnerCandidates,
);
export const createCredentialBatch = operation(
  credentialImpl.createCredentialBatch,
);
export const getCredentialBatch = operation(credentialImpl.getCredentialBatch);
export const submitCredentialBatchItem = operation(
  credentialImpl.submitCredentialBatchItem,
);
export const submitSealedBatchPassword = operation(
  credentialImpl.submitSealedBatchPassword,
);
export const ensureTargetAccountCredential = operation(
  credentialImpl.ensureTargetAccountCredential,
);
export const replaceTargetAccountSecret = operation(
  credentialImpl.replaceTargetAccountSecret,
);
export const clearTargetAccountSecrets = operation(
  credentialImpl.clearTargetAccountSecrets,
);
export const markIdentityReconfirm = operation(
  credentialImpl.markIdentityReconfirm,
);
export const confirmIdentityMaterial = operation(
  credentialImpl.confirmIdentityMaterial,
);
export const syncModelKeyCredential = operation(
  credentialImpl.syncModelKeyCredential,
);
export const replaceAlertWebhookSecret = operation(
  credentialImpl.replaceAlertWebhookSecret,
);
export const syncServiceKeyProjection = operation(
  credentialImpl.syncServiceKeyProjection,
);
export const authorizeSecretConsume = operation(
  credentialImpl.authorizeSecretConsume,
);
export const resolveSnapshotCredential = operation(
  credentialImpl.resolveSnapshotCredential,
);
export const resolveAccountCurrentCredential = operation(
  credentialImpl.resolveAccountCurrentCredential,
);
export const secretIdsStillReferenced = operation(
  credentialImpl.secretIdsStillReferenced,
);
export const recordCredentialVerification = operation(
  credentialImpl.recordCredentialVerification,
);
export const scanCredentialReminders = operation(
  credentialImpl.scanCredentialReminders,
);
export const listOpenCredentialReminders = operation(
  credentialImpl.listOpenCredentialReminders,
);
export const markReminderDelivered = operation(
  credentialImpl.markReminderDelivered,
);
export { CredentialConsumeDenied } from "./credentials/index.js";

import * as suiteImpl from "./suites/index.js";
export const listSuites = operation(suiteImpl.listSuites);
export const getSuite = operation(suiteImpl.getSuite);
export const createSuite = operation(suiteImpl.createSuite);
export const saveSuiteDraft = operation(suiteImpl.saveSuiteDraft);
export const validateSuite = operation(suiteImpl.validateSuite);
export const publishSuite = operation(suiteImpl.publishSuite);
export const updateSuiteEnabled = operation(suiteImpl.updateSuiteEnabled);
export const previewDeleteSuite = operation(suiteImpl.previewDeleteSuite);
export const deleteSuite = operation(suiteImpl.deleteSuite);
export const previewSuiteRun = operation(suiteImpl.previewSuiteRun);
export const createSuiteRun = operation(suiteImpl.createSuiteRun);
export const listSuiteRuns = operation(suiteImpl.listSuiteRuns);
export const getSuiteRunObservation = operation(
  suiteImpl.getSuiteRunObservation,
);
export const listSuiteRunEventsAfter = operation(
  suiteImpl.listSuiteRunEventsAfter,
);
export const cancelSuiteRun = operation(suiteImpl.cancelSuiteRun);
export const advanceSuiteRun = operation(suiteImpl.advanceSuiteRun);
export const advanceDueSuiteRuns = operation(suiteImpl.advanceDueSuiteRuns);

import * as reportImpl from "./reports/index.js";
export const listReports = operation(reportImpl.listReports);
export const getReport = operation(reportImpl.getReport);
export const previewReport = operation(reportImpl.previewReport);
export const createReport = operation(reportImpl.createReport);
export const createReportRevision = operation(reportImpl.createReportRevision);
export const enqueueReportExport = operation(reportImpl.enqueueReportExport);
export const getExportJob = operation(reportImpl.getExportJob);
export const claimExportJobs = operation(reportImpl.claimExportJobs);
export const renewExportJob = operation(reportImpl.renewExportJob);
export const completeExportJob = operation(reportImpl.completeExportJob);
export const loadReportRevisionDocument = operation(
  reportImpl.loadReportRevisionDocument,
);
export const deleteReport = operation(reportImpl.deleteReport);
export const previewDeleteReport = operation(reportImpl.previewDeleteReport);
export const getReportProfile = operation(reportImpl.getReportProfile);
export const listReportProfiles = operation(reportImpl.listReportProfiles);
export const listReportProfileVersions = operation(reportImpl.listReportProfileVersions);
export const saveReportProfile = operation(reportImpl.saveReportProfile);
export const getScenarioReportDefaults = operation(reportImpl.getScenarioReportDefaults);
export const saveScenarioReportDefaults = operation(reportImpl.saveScenarioReportDefaults);
export const getExportMaterials = operation(reportImpl.getExportMaterials);
export const reserveExportArtifact = operation(reportImpl.reserveExportArtifact);
export const commitReportMaterial = operation(reportImpl.commitReportMaterial);
export const finishReportMaterials = operation(reportImpl.finishReportMaterials);
export const getCachedReportArtifacts = operation(reportImpl.getCachedReportArtifacts);
export const updateExportProgress = operation(reportImpl.updateExportProgress);
export const cancelExportJob = operation(reportImpl.cancelExportJob);
export const retryExportJob = operation(reportImpl.retryExportJob);
export const deriveMemberReport = operation(reportImpl.deriveMemberReport);
export const createReportBundle = operation(reportImpl.createReportBundle);
export const getReportBundleFiles = operation(reportImpl.getReportBundleFiles);
export const generateDueSuiteReports = operation(reportImpl.generateDueSuiteReports);
export const listReportRevisions = operation(reportImpl.listReportRevisions);
export const listReportExportJobs = operation(reportImpl.listReportExportJobs);
export const getReportSourceOptions = operation(reportImpl.getReportSourceOptions);
export const reserveReportLogo = operation(reportImpl.reserveReportLogo);
export const recordReportDownload = operation(reportImpl.recordReportDownload);

import * as artifactImpl from "./objects/artifacts.js";
export const createArtifact = operation(artifactImpl.createArtifact);
export const getArtifact = operation(artifactImpl.getArtifact);
export const getArtifactObject = operation(artifactImpl.getArtifactObject);
export const attachArtifactBytes = operation(artifactImpl.attachArtifactBytes);

import * as evidenceCenterImpl from "./evidence/index.js";
export const searchEvidence = operation(evidenceCenterImpl.searchEvidence);
export const getEvidence = operation(evidenceCenterImpl.getEvidence);
export const summarizeEvidenceRetention = operation(
  evidenceCenterImpl.summarizeEvidenceRetention,
);
export const listRetentionObjects = operation(
  evidenceCenterImpl.listRetentionObjects,
);
export { assertRelatedIds } from "./evidence/index.js";
import * as validationImpl from "./runs/validation.js";
export const getScenarioValidation = operation(
  validationImpl.getScenarioValidation,
);
