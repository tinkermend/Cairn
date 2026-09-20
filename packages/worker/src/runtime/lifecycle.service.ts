import { randomUUID } from "node:crypto";
import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import {
  claimRun,
  claimSessionOperation,
  hasQueuedSessionCreateOperation,
  expireRunDeadlines,
  getOrCreatePlatformConfig,
  listDueRetainedSessions,
  loadCurrentAuthProfile,
  loadAccountForExecution,
  scheduleNextAuthCheck,
  requestMaintenanceOperation,
  expireStaleRunLeases,
  heartbeatWorker,
  markLostWorkers,
  markLostApiInstances,
  markSessionsLostForWorkers,
  collectPlatformSamples,
  collectWorkerSamples,
  evaluateAlerts,
  insertMonitorSamples,
  purgeMonitorSamples,
  reapSessionLeases,
  upsertObjectStoreProbe,
  touchRuntimeWatermark,
  markWorkerDraining,
  markWorkerStopped,
  registerWorker,
  renewRunLease,
  materializeDueSchedules,
  scanCredentialReminders,
  admitScheduleOccurrence,
  expireClosedScheduleWindows,
  expireScheduledMapJobs,
  advanceDueSuiteRuns,
  generateDueSuiteReports,
  backfillModuleInvocationResults,
  backfillOutcomeResults,
  reapServiceRequestLogs,
  type DbHandle,
  getMapJobPolicy,
  getMapSafeEntry,
  getMapSummary,
  listMapJobCandidateAssets,
  settleRevokedRuns,
  sweepDriftedRuns,
  yieldUnfinishedRun,
  loadRunRow,
  DomainError,
  WORKER_ID_CONFLICT,
  type WorkerHeartbeatOutcome,
} from "@cairn/db";
import {
  SCHEDULE_TICK_INTERVAL_MS,
  WORKER_NODE_LOOP_STALE_HEARTBEATS,
  WORKER_NODE_HEALTH_PING_TIMEOUT_MS,
  workerNodeHealthResponseSchema,
  backgroundVerifyWindowSlot,
  maintenanceIdempotencyKey,
  maintenanceWindowSlot,
  deriveAuthCapability,
  platformConfigDocumentSchema,
  parseWorkerRoles,
  protocolCapabilitiesForRoles,
  isHaltedRunStatus,
  REAPER_DEADLINE_BATCH,
  REAPER_DRIFT_BATCH,
  REAPER_SESSION_LEASE_BATCH,
  REAPER_STALE_LEASE_BATCH,
  DEFAULT_SERVICE_REQUEST_LOG_PURGE_INTERVAL_MS,
  resolveWorkerAdvertiseUrl,
  type RunGrant,
  type WorkerRoleSet,
} from "@cairn/shared";
import type { LocalSecretProvider } from "@cairn/secret";
import {
  BrowserSessionManager,
  SECRET_PROVIDER,
} from "../browser/session-manager";
import { deliverNotifications } from "./notification-delivery";
import { deliverServiceWebhooks } from "./service-webhook-delivery";
import { dispatchExportJobs } from "./report-render";
import {
  claimWorkerPeriodicSlots,
  drainWhileFull,
  finishWorkerPeriodicSlot,
  periodicSlotErrorClass,
  probePeriodicSlotRequests,
  reaperPeriodicSlotRequests,
  samplePeriodicSlotRequests,
  slotOwner,
  sortReaperClaims,
} from "./periodic-slots";
import type { PeriodicSlotClaim, PeriodicSlotSkip } from "@cairn/db";
import {
  startManagedBrowserHttp,
  type ManagedBrowserHttp,
} from "../internal/http-server";
import { config } from "../config/env";
import { placementYieldExcludes } from "./placement-backoff";
import { DB_HANDLE } from "../db/db.module";
import {
  compileMapJobSlice,
  selectMapJobAssets,
  toMapJobCompileAssets,
} from "@cairn/map";
import { MapProjectionService } from "../map/projection.service";
import { MapReferenceScanService } from "../map/reference-scan.service";
import { ExecutionEngine } from "../engine/engine";
import { EvidenceSettleService } from "../evidence/settle.service";
import { ObjectService } from "../objects/object.service";
import { countManagedBrowserProcesses } from "./browser-processes";
import { sampleProfileDisk, type DiskSample } from "./disk-sample";
import { sampleProcessResources } from "./process-sample";

const TICK_INTERVAL_MS = 1_000;

type InFlight = {
  grant: RunGrant;
  controller: AbortController;
  done: Promise<void>;
};

/**
 * 执行面的进程生命周期。
 *
 * tick：容量未满则 claimRun，以 leaseId 去重后交给 Engine。
 * 心跳与 RunLease 续租共用 CAIRN_WORKER_HEARTBEAT_MS。
 * 恢复扫描挂在既有 session reaper tick 上。
 */
@Injectable()
export class LifecycleService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(LifecycleService.name);
  private readonly startedAt = Date.now();
  /** 每次（重新）注册换一份：旧代的 grant 与心跳都必须随之作废。 */
  private instanceId = randomUUID();
  private readonly inFlight = new Map<string, InFlight>();
  private readonly exportHeartbeats = new Set<() => Promise<void>>();
  private tick: NodeJS.Timeout | undefined;
  private scheduleTick: NodeJS.Timeout | undefined;
  private heartbeatTick: NodeJS.Timeout | undefined;
  private cleanupTick: NodeJS.Timeout | undefined;
  private reaperTick: NodeJS.Timeout | undefined;
  private notificationTick: NodeJS.Timeout | undefined;
  private notificationTask: Promise<void> | undefined;
  private serviceWebhookTick: NodeJS.Timeout | undefined;
  private serviceWebhookTask: Promise<void> | undefined;
  private videoMediaTick: NodeJS.Timeout | undefined;
  private videoMediaTask: Promise<void> | undefined;
  private readonly notificationAbort = new AbortController();
  private maintenanceTick: NodeJS.Timeout | undefined;
  private diskTick: NodeJS.Timeout | undefined;
  private sampleTick: NodeJS.Timeout | undefined;
  private probeTick: NodeJS.Timeout | undefined;
  private lastTickAt: Date | null = null;
  private diskSample: DiskSample | null = null;
  private diskSampling = false;
  private sampling = false;
  private probing = false;
  private browserProcessCount: number | null = null;
  private browserCounting: Promise<void> | undefined;
  /** 测试可覆写装配角色；生产读 CAIRN_WORKER_ROLES。 */
  rolesForAssembly: WorkerRoleSet | undefined;
  private scheduleTask: Promise<void> | undefined;
  private stopped = false;
  private claiming = false;
  private claimTask: Promise<void> | undefined;
  private pendingClaim: AbortController | undefined;
  private cleanupInFlight: Promise<{ purged: number }> | undefined;
  private reaperInFlight:
    Promise<{ leasesExpired: number; sessionsClosed: number }> | undefined;
  private healing: Promise<void> | undefined;
  private beating = false;
  private internalHttp: ManagedBrowserHttp | undefined;

  shutdownSignal: string | undefined;
  shutdownCalled = false;

  /**
   * 身份已被别的实例接管时如何结束进程。
   *
   * 这一步不能只是「不再领取」：那样进程活着却永远不干活，外部也看不出来。
   * 默认交给编排重启，测试里覆写成记录调用。
   */
  exitProcess: (code: number) => void = (code) => process.exit(code);

  constructor(
    @Inject(DB_HANDLE) private readonly handle: DbHandle,
    private readonly engine: ExecutionEngine,
    private readonly objects: ObjectService,
    private readonly evidence: EvidenceSettleService,
    private readonly sessions: BrowserSessionManager,
    @Optional() private readonly projections?: MapProjectionService,
    @Optional() private readonly referenceScans?: MapReferenceScanService,
    @Optional()
    @Inject(SECRET_PROVIDER)
    private readonly secrets?: LocalSecretProvider,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.handle.ping();
    try {
      this.instanceId = randomUUID();
      await this.bindInternalHttp();
      await this.register();
    } catch (error) {
      await this.internalHttp?.close().catch(() => undefined);
      this.internalHttp = undefined;
      // 本地最先踩到的错误路径：默认 ID 只够单进程，开第二个就撞。
      // 冒泡让 Nest 启动失败是对的，但得先说清楚是什么、怎么办；只带 ID 与秒数，不带凭证。
      if (error instanceof DomainError && error.code === WORKER_ID_CONFLICT) {
        this.logger.error(
          `CAIRN_WORKER_ID=${config.CAIRN_WORKER_ID} 已被另一个仍在心跳的实例占用，本进程不启动。` +
            `多实例部署必须每实例一个 ID；若上一个实例已经死了，等 ${config.CAIRN_WORKER_LOST_AFTER_SECONDS} 秒判失联后可重启。`,
        );
      }
      throw error;
    }
    try {
      const roles = this.roles();
      if (roles.executor) {
        await this.sessions.reconcileOwn();
        this.sessions.startHeartbeat();
      }
      if (roles.scheduler) this.startScheduling();
      // 先确认本代心跳写得进去，再领取。启动后立刻 claim 会撞上：
      // 心跳被堵住 → 判 lost → 换代，在途 PREPARE 的占用 ALS/grant 作废，操作被写成永久失败。
      await this.beat();
      if (this.shutdownCalled || this.stopped) return;
      if (roles.executor) {
        this.startClaiming();
        this.claimTask = this.pump();
        void this.pumpOperation();
        this.videoMediaTick = setInterval(
          () => this.startVideoMediaDispatch(),
          5_000,
        );
        this.startVideoMediaDispatch();
      }
      if (roles.maintenance) void this.enqueueBackgroundMaintenance();
      this.heartbeatTick = setInterval(() => {
        void this.beat();
      }, config.CAIRN_WORKER_HEARTBEAT_MS);
      if (roles.maintenance) {
        this.startMaintenance();
        this.notificationTick = setInterval(
          () => this.startNotificationDispatch(),
          5_000,
        );
        this.startNotificationDispatch();
        this.serviceWebhookTick = setInterval(
          () => this.startServiceWebhookDispatch(),
          5_000,
        );
        this.startServiceWebhookDispatch();
        this.cleanupTick = setInterval(() => {
          void this.runCleanup();
        }, config.CAIRN_OBJECT_CLEANUP_INTERVAL_MS);
        this.reaperTick = setInterval(() => {
          void this.runReaper();
        }, config.CAIRN_SESSION_REAPER_INTERVAL_MS);
      }
      this.startTelemetry();
    } catch (error) {
      await markWorkerStopped(
        this.handle,
        config.CAIRN_WORKER_ID,
        this.instanceId,
      ).catch(() => undefined);
      throw error;
    }
    this.logger.log(
      { workerId: config.CAIRN_WORKER_ID, instanceId: this.instanceId },
      "执行面已就绪，等待任务",
    );
  }

  isRunning(): boolean {
    return this.tick !== undefined;
  }

  /**
   * 注册（或以新代重新注册）本实例：撤销自己名下残留的 ACTIVE 租约，
   * 对应 Run 交回恢复扫描。启动与失联自愈走同一条路径。
   */
  private async register(): Promise<void> {
    const registered = await registerWorker(this.handle, {
      workerId: config.CAIRN_WORKER_ID,
      instanceId: this.instanceId,
      capacity: config.CAIRN_WORKER_CAPACITY,
      maxSessions: config.CAIRN_BROWSER_MAX_SESSIONS,
      lostAfterSeconds: config.CAIRN_WORKER_LOST_AFTER_SECONDS,
      internalBaseUrl: this.advertiseUrl(),
      protocolCapabilities: protocolCapabilitiesForRoles(this.roles()),
    });
    await settleRevokedRuns(
      this.handle,
      registered.revokedRunIds,
      config.CAIRN_RUN_MAX_RECOVERIES,
    );
  }

  private roles(): WorkerRoleSet {
    return this.rolesForAssembly ?? parseWorkerRoles(config.CAIRN_WORKER_ROLES);
  }

  private startClaiming(): void {
    if (this.tick || this.shutdownCalled) return;
    this.stopped = false;
    this.tick = setInterval(() => {
      this.claimTask = this.pump();
      void this.pumpOperation();
    }, TICK_INTERVAL_MS);
  }

  private startMaintenance(): void {
    if (this.maintenanceTick || this.shutdownCalled) return;
    this.maintenanceTick = setInterval(() => {
      void this.enqueueBackgroundMaintenance();
    }, TICK_INTERVAL_MS);
  }

  private startScheduling(): void {
    if (this.scheduleTick || this.shutdownCalled) return;
    this.scheduleTick = setInterval(() => {
      this.scheduleTask = this.runScheduleTick();
    }, SCHEDULE_TICK_INTERVAL_MS);
    this.scheduleTask = this.runScheduleTick();
  }

  private async runScheduleTick(): Promise<void> {
    if (this.stopped) return;
    try {
      await expireClosedScheduleWindows(this.handle);
      await expireScheduledMapJobs(this.handle);
      await advanceDueSuiteRuns(this.handle);
      await generateDueSuiteReports(this.handle);
      const { pending } = await materializeDueSchedules(this.handle);
      for (const item of pending) {
        if (this.stopped) break;
        try {
          const policy = await getMapJobPolicy(
            this.handle,
            item.definition.consumer.targetId,
          );
          const entry = await getMapSafeEntry(
            this.handle,
            item.definition.consumer.targetId,
            item.definition.consumer.entryId,
          );
          const assets = toMapJobCompileAssets(
            await listMapJobCandidateAssets(
              this.handle,
              item.definition.consumer.targetId,
            ),
          );
          const selected = selectMapJobAssets(
            "map_refresh",
            policy.policy,
            assets,
            item.definition.consumer.selectedAssetRefs,
          );
          const included = assets.filter((asset) =>
            selected.some(
              (row) =>
                row.included &&
                (row.assetRef.objectId ?? row.assetRef.pageId) ===
                  (asset.assetRef.objectId ?? asset.assetRef.pageId),
            ),
          );
          if (included.length === 0) {
            await admitScheduleOccurrence(
              this.handle,
              item.occurrence.occurrenceId,
              { steps: [], includedCount: 0 },
              { kind: "console", id: item.authorizedActorId },
            );
            continue;
          }
          const compiled = compileMapJobSlice({
            jobKind: "map_refresh",
            entry: {
              entryId: entry.entryId,
              version: entry.version,
              name: entry.name,
              url: entry.url,
              arrivalName: entry.arrivalName,
              arrivalTarget: entry.arrivalTarget,
              safetyBasis: entry.safetyBasis,
              jobKinds: entry.jobKinds,
            },
            included,
            policy: policy.policy,
          });
          if (!compiled.ok) {
            await admitScheduleOccurrence(
              this.handle,
              item.occurrence.occurrenceId,
              {
                steps: [],
                includedCount: included.length,
                skipReason: "SAFETY_BASIS_REQUIRED",
              },
              { kind: "console", id: item.authorizedActorId },
            );
            continue;
          }
          const summary = await getMapSummary(
            this.handle,
            item.definition.consumer.targetId,
            { limit: 1 },
          );
          await admitScheduleOccurrence(
            this.handle,
            item.occurrence.occurrenceId,
            {
              steps: compiled.steps,
              releaseId: summary.publishedReleaseId,
              includedCount: included.length,
            },
            { kind: "console", id: item.authorizedActorId },
          );
        } catch (error) {
          this.logger.warn(
            error instanceof Error ? error.message : error,
            "调度准入失败，窗口保持待处理",
          );
        }
      }
    } catch (error) {
      this.logger.error(
        error instanceof Error ? error.message : error,
        "调度 ticker 失败",
      );
    }
  }

  uptimeSeconds(): number {
    return (Date.now() - this.startedAt) / 1000;
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.shutdownSignal = signal;
    this.shutdownCalled = true;
    this.stopped = true;
    if (this.scheduleTick) {
      clearInterval(this.scheduleTick);
      this.scheduleTick = undefined;
    }
    await this.scheduleTask?.catch(() => undefined);
    if (this.notificationTick) {
      clearInterval(this.notificationTick);
      this.notificationTick = undefined;
    }
    if (this.serviceWebhookTick) {
      clearInterval(this.serviceWebhookTick);
      this.serviceWebhookTick = undefined;
    }
    if (this.videoMediaTick) {
      clearInterval(this.videoMediaTick);
      this.videoMediaTick = undefined;
    }
    await this.videoMediaTask?.catch(() => undefined);
    this.notificationAbort.abort();
    await this.notificationTask;
    await this.serviceWebhookTask;
    await markWorkerDraining(
      this.handle,
      config.CAIRN_WORKER_ID,
      this.instanceId,
    ).catch(() => undefined);
    if (this.tick) {
      clearInterval(this.tick);
      this.tick = undefined;
    }
    if (this.heartbeatTick) {
      clearInterval(this.heartbeatTick);
      this.heartbeatTick = undefined;
    }
    if (this.cleanupTick) {
      clearInterval(this.cleanupTick);
      this.cleanupTick = undefined;
    }
    if (this.reaperTick) {
      clearInterval(this.reaperTick);
      this.reaperTick = undefined;
    }
    if (this.maintenanceTick) {
      clearInterval(this.maintenanceTick);
      this.maintenanceTick = undefined;
    }
    if (this.diskTick) {
      clearInterval(this.diskTick);
      this.diskTick = undefined;
    }
    if (this.sampleTick) {
      clearInterval(this.sampleTick);
      this.sampleTick = undefined;
    }
    if (this.probeTick) {
      clearInterval(this.probeTick);
      this.probeTick = undefined;
    }
    this.pendingClaim?.abort();
    for (const item of this.inFlight.values()) item.controller.abort();
    // 自愈可能正在重新注册：等它结束，别让停机与注册交错。
    await this.healing?.catch(() => undefined);
    const claiming = this.claimTask;
    const cleanup = this.cleanupInFlight;
    const reaper = this.reaperInFlight;
    const owned = [...this.inFlight.values()];
    if (claiming) await claiming;
    await Promise.all(owned.map((item) => item.done));
    if (cleanup) await cleanup;
    if (reaper) await reaper;
    for (const item of owned) {
      await yieldUnfinishedRun(this.handle, item.grant).catch(() => undefined);
    }
    await markWorkerStopped(
      this.handle,
      config.CAIRN_WORKER_ID,
      this.instanceId,
    ).catch(() => undefined);
    await this.internalHttp?.close().catch(() => undefined);
    this.internalHttp = undefined;
    await this.sessions.shutdown();
    this.logger.log(`收到 ${signal ?? "停机"} 信号，已停止领取任务`);
  }

  async runCleanup(): Promise<{ purged: number }> {
    if (this.stopped) return { purged: 0 };
    if (this.cleanupInFlight) return this.cleanupInFlight;
    this.cleanupInFlight = this.runCleanupTick()
      .catch((error) => {
        this.logger.error(
          error instanceof Error ? error.stack : error,
          "对象清理失败",
        );
        return { purged: 0 };
      })
      .finally(() => {
        this.cleanupInFlight = undefined;
      });
    return this.cleanupInFlight;
  }

  private async runCleanupTick(): Promise<{ purged: number }> {
    await this.evidence.settleExpired();
    await this.projections?.tick().catch((error) => {
      this.logger.error(
        error instanceof Error ? error.message : error,
        "地图投影 tick 失败",
      );
    });
    await this.referenceScans?.tick().catch((error) => {
      this.logger.error(
        error instanceof Error ? error.message : error,
        "地图引用扫描 tick 失败",
      );
    });
    await backfillModuleInvocationResults(this.handle, { limit: 20 }).catch(
      (error) => {
        this.logger.error(
          error instanceof Error ? error.message : error,
          "模块调用结果补算失败",
        );
      },
    );
    await backfillOutcomeResults(this.handle).catch((error) => {
      this.logger.error(
        error instanceof Error ? error.message : error,
        "结果轴补算失败",
      );
    });
    return this.objects.purgeExpiredObjects({ limit: 100 });
  }

  async runReaper(): Promise<{
    leasesExpired: number;
    sessionsClosed: number;
  }> {
    if (this.stopped) return { leasesExpired: 0, sessionsClosed: 0 };
    if (this.reaperInFlight) return this.reaperInFlight;
    this.reaperInFlight = this.reapAll()
      .catch((error) => {
        this.logger.error(
          error instanceof Error ? error.message : error,
          "回收失败",
        );
        return { leasesExpired: 0, sessionsClosed: 0 };
      })
      .finally(() => {
        this.reaperInFlight = undefined;
      });
    return this.reaperInFlight;
  }

  private async reapAll(): Promise<{
    leasesExpired: number;
    sessionsClosed: number;
  }> {
    this.markTick();
    const { claimed, skipped } = await claimWorkerPeriodicSlots(
      this.handle,
      this.reaperSlotRequests().filter(
        (request) =>
          request.name !== "monitor.alerts.deliver" &&
          request.name !== "service.webhooks.deliver",
      ),
    );
    this.logSlotMismatches(skipped);
    const claimedByName = new Map(
      sortReaperClaims(claimed).map((claim) => [claim.name, claim]),
    );
    if (claimedByName.has("reaper.recovery")) {
      await this.runClaimedSlot(claimedByName.get("reaper.recovery")!, () =>
        this.runRecoverySlot(),
      );
    }
    if (claimedByName.has("reaper.session_leases")) {
      await this.runClaimedSlot(
        claimedByName.get("reaper.session_leases")!,
        () => this.runSessionLeaseSlot(),
      );
    }
    // 本进程句柄回收不在槽位内：它抛错不能吞掉下面已经领到的槽位，
    // 否则限流槽位白白空过一个周期，单飞的告警评估还会被租约占到 TTL 才放开。
    let session = { leasesExpired: 0, sessionsClosed: 0 };
    try {
      session = await this.sessions.reap({ includeGlobalLeases: false });
    } catch (error) {
      this.logger.error(
        error instanceof Error ? error.message : error,
        "本进程会话回收失败，继续执行已领取的周期槽位",
      );
    }
    if (claimedByName.has("reaper.liveness")) {
      await this.runClaimedSlot(claimedByName.get("reaper.liveness")!, () =>
        this.runLivenessSlot(),
      );
    }
    if (claimedByName.has("monitor.alerts.evaluate")) {
      await this.runClaimedSlot(
        claimedByName.get("monitor.alerts.evaluate")!,
        () => this.evaluateAlertsOnce(),
      );
    }
    if (claimedByName.has("credential.reminders")) {
      await this.runClaimedSlot(
        claimedByName.get("credential.reminders")!,
        async () => {
          await scanCredentialReminders(this.handle);
        },
      );
    }
    if (claimedByName.has("service.request_logs.purge")) {
      await this.runClaimedSlot(
        claimedByName.get("service.request_logs.purge")!,
        async () => {
          await drainWhileFull(config.CAIRN_REAPER_DRAIN_BUDGET_MS, 1000, () =>
            reapServiceRequestLogs(this.handle, { limit: 1000 }),
          );
        },
      );
    }
    // Network delivery owns a separate single-flight task. A slow peer must not delay the next reaper tick.
    this.startNotificationDispatch();
    this.startServiceWebhookDispatch();
    return session;
  }

  private async runRecoverySlot(): Promise<void> {
    const deadline = Date.now() + config.CAIRN_REAPER_DRAIN_BUDGET_MS;
    const remaining = () => Math.max(0, deadline - Date.now());
    await drainWhileFull(remaining(), REAPER_DEADLINE_BATCH, () =>
      expireRunDeadlines(this.handle),
    );
    await drainWhileFull(remaining(), REAPER_STALE_LEASE_BATCH, async () => {
      const result = await expireStaleRunLeases(this.handle, {
        limit: REAPER_STALE_LEASE_BATCH,
        maxRecoveries: config.CAIRN_RUN_MAX_RECOVERIES,
      });
      return { scanned: result.outcomes.length };
    });
    await drainWhileFull(remaining(), REAPER_DRIFT_BATCH, () =>
      sweepDriftedRuns(this.handle, {
        limit: REAPER_DRIFT_BATCH,
        leaseTtlSeconds: config.CAIRN_RUN_LEASE_TTL_SECONDS,
        maxRecoveries: config.CAIRN_RUN_MAX_RECOVERIES,
      }),
    );
    await touchRuntimeWatermark(this.handle, "global_reclaim");
  }

  private async runSessionLeaseSlot(): Promise<void> {
    await drainWhileFull(
      config.CAIRN_REAPER_DRAIN_BUDGET_MS,
      REAPER_SESSION_LEASE_BATCH,
      () =>
        reapSessionLeases(this.handle, {
          limit: REAPER_SESSION_LEASE_BATCH,
          maxRecoveries: config.CAIRN_RUN_MAX_RECOVERIES,
        }),
    );
  }

  private async runLivenessSlot(): Promise<void> {
    const lostWorkerIds = await markLostWorkers(this.handle);
    if (lostWorkerIds.length > 0) {
      await markSessionsLostForWorkers(this.handle, lostWorkerIds);
    }
    await markLostApiInstances(this.handle).catch((error) => {
      this.logger.error(
        error instanceof Error ? error.message : error,
        "API 实例失联扫描失败",
      );
    });
  }

  private async evaluateAlertsOnce(): Promise<void> {
    await evaluateAlerts(this.handle, {
      objectStoreStaleAfterMs: 2 * config.CAIRN_MONITOR_OBJECT_STORE_PROBE_MS,
    });
  }

  private async dispatchNotifications(): Promise<void> {
    await deliverNotifications({
      db: this.handle,
      secrets: this.secrets,
      workerId: config.CAIRN_WORKER_ID,
      instanceId: this.instanceId,
      signal: this.notificationAbort.signal,
      blockedHosts: webhookControlPlaneHosts(),
      smtpDestinations: config.CAIRN_NOTIFICATION_SMTP_DESTINATIONS.split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    });
    await dispatchExportJobs(
      this.handle,
      this.objects.objectStore(),
      {
        workerId: config.CAIRN_WORKER_ID,
        instanceId: this.instanceId,
        signal: this.notificationAbort.signal,
      },
      (renew) => {
        this.exportHeartbeats.add(renew);
        return () => {
          this.exportHeartbeats.delete(renew);
        };
      },
    );
  }

  private startVideoMediaDispatch(): void {
    if (this.stopped || this.videoMediaTask) return;
    this.videoMediaTask = import("../browser/run-video-media.js")
      .then((mod) => mod.processDueRunVideoMedia(this.sessions))
      .then(() => undefined)
      .catch((error) => {
        this.logger.warn(
          error instanceof Error ? error.message : error,
          "录像媒体任务领取失败",
        );
      })
      .finally(() => {
        this.videoMediaTask = undefined;
      });
  }

  private startNotificationDispatch(): void {
    if (this.stopped || this.notificationTask) return;
    this.notificationTask = this.claimAndDispatchNotifications()
      .catch((error) => {
        this.logger.error(
          error instanceof Error ? error.message : error,
          "通知维护周期失败",
        );
      })
      .finally(() => {
        this.notificationTask = undefined;
      });
  }

  private async dispatchServiceWebhooks(): Promise<void> {
    await deliverServiceWebhooks({
      db: this.handle,
      secrets: this.secrets,
      workerId: config.CAIRN_WORKER_ID,
      instanceId: this.instanceId,
      signal: this.notificationAbort.signal,
      blockedHosts: webhookControlPlaneHosts(),
    });
  }

  private startServiceWebhookDispatch(): void {
    if (this.stopped || this.serviceWebhookTask) return;
    this.serviceWebhookTask = this.claimAndDispatchServiceWebhooks()
      .catch((error) => {
        this.logger.error(
          error instanceof Error ? error.message : error,
          "服务 Webhook 维护周期失败",
        );
      })
      .finally(() => {
        this.serviceWebhookTask = undefined;
      });
  }

  private async claimAndDispatchNotifications(): Promise<void> {
    const deliver = this.reaperSlotRequests().filter(
      (request) => request.name === "monitor.alerts.deliver",
    );
    const { claimed, skipped } = await claimWorkerPeriodicSlots(
      this.handle,
      deliver,
    );
    this.logSlotMismatches(skipped);
    const claim = claimed[0];
    if (!claim) return;
    await this.runClaimedSlot(claim, () => this.dispatchNotifications());
  }

  private async claimAndDispatchServiceWebhooks(): Promise<void> {
    const deliver = this.reaperSlotRequests().filter(
      (request) => request.name === "service.webhooks.deliver",
    );
    const { claimed, skipped } = await claimWorkerPeriodicSlots(
      this.handle,
      deliver,
    );
    this.logSlotMismatches(skipped);
    const claim = claimed[0];
    if (!claim) return;
    await this.runClaimedSlot(claim, () => this.dispatchServiceWebhooks());
  }

  private async beat(): Promise<void> {
    if (this.stopped || this.healing || this.beating) return;
    this.beating = true;
    try {
      this.markTick();
      this.refreshBrowserProcessCount();
      const process = sampleProcessResources();
      const outcome = await heartbeatWorker(
        this.handle,
        config.CAIRN_WORKER_ID,
        this.instanceId,
        {
          internalBaseUrl: this.advertiseUrl(),
          liveHandleCount: this.liveHandleCount(),
          rssBytes: process.rssBytes,
          eventLoopDelayMs: process.eventLoopDelayMs,
          cpuPercent: process.cpuPercent,
          profileBytes: this.diskSample?.profileBytes ?? null,
          profileCount: this.diskSample?.profileCount ?? null,
          profileDiskFreeBytes: this.diskSample?.profileDiskFreeBytes ?? null,
          midsceneBytes: this.diskSample?.midsceneBytes ?? null,
          browserProcessCount: this.browserProcessCount,
          diskSampledAt: this.diskSample?.sampledAt ?? null,
        },
      );
      if (outcome !== "ok") {
        this.healing = this.healIdentity(outcome).finally(() => {
          this.healing = undefined;
        });
        await this.healing;
        return;
      }
      await Promise.all([...this.exportHeartbeats].map((renew) => renew()));
      for (const item of this.inFlight.values()) {
        const expiresAt = await renewRunLease(
          this.handle,
          item.grant,
          config.CAIRN_RUN_LEASE_TTL_SECONDS,
        );
        if (!expiresAt) {
          const row = await loadRunRow(this.handle, item.grant.runId).catch(
            () => null,
          );
          if (row && isHaltedRunStatus(row.status)) {
            this.logger.log(
              {
                runId: item.grant.runId,
                leaseId: item.grant.leaseId,
                status: row.status,
              },
              "Run 已终态，续租失败不中止收尾编码",
            );
            continue;
          }
          this.logger.warn(
            { runId: item.grant.runId, leaseId: item.grant.leaseId },
            "RunLease 续租失败，停手",
          );
          item.controller.abort();
        }
      }
    } catch (error) {
      this.logger.error(
        error instanceof Error ? error.message : error,
        "心跳或续租失败",
      );
    } finally {
      this.beating = false;
    }
  }

  /** 本实例不再领取；已在途的 Run 中止，等租约过期后由同伴接管。 */
  private fenceSelf(): void {
    this.stopped = true;
    this.pendingClaim?.abort();
    for (const item of this.inFlight.values()) item.controller.abort();
    if (this.tick) {
      clearInterval(this.tick);
      this.tick = undefined;
    }
  }

  /**
   * 心跳写不进去之后的处置。
   *
   * 先无条件停手——本实例手上的每个 grant 都已不可信，续租必然 0 行。
   * 之后按原因分流，两条路都不允许留下「进程活着但永远不干活」的僵尸：
   *
   * - 被同伴判失联（抖动、长 GC、主机挂起超过 LOST_AFTER）：用新代重新注册，恢复领取。
   *   这条必须自愈，否则一次网络抖动就永久少掉一份集群容量。
   * - 身份被另一个活实例接管：按 D4 不得抢回，退出进程交给编排。
   */
  private async healIdentity(outcome: WorkerHeartbeatOutcome): Promise<void> {
    this.fenceSelf();
    if (this.shutdownCalled) return;

    if (outcome === "instance_taken") {
      this.logger.error(
        { workerId: config.CAIRN_WORKER_ID, instanceId: this.instanceId },
        "Worker 身份已被另一个实例接管，本进程退出；多实例部署必须每实例一个 CAIRN_WORKER_ID",
      );
      this.exitProcess(1);
      return;
    }

    this.logger.warn(
      { workerId: config.CAIRN_WORKER_ID, instanceId: this.instanceId },
      "Worker 心跳未写入（已被判失联），停手并以新代重新注册",
    );
    await this.sessions.stopAllLocal().catch((error) => {
      this.logger.warn(
        { err: error instanceof Error ? error.message : error },
        "自愈停浏览器失败，继续重新注册",
      );
    });
    this.instanceId = randomUUID();
    try {
      await this.bindInternalHttp();
      await this.register();
    } catch (error) {
      // 重新注册被 WORKER_ID_CONFLICT 挡住 = 自愈期间别人拿走了这个 ID，等同身份被接管。
      this.logger.error(
        {
          workerId: config.CAIRN_WORKER_ID,
          err: error instanceof Error ? error.message : error,
        },
        "重新注册失败，本进程退出",
      );
      this.exitProcess(1);
      return;
    }
    this.stopped = false;
    if (this.roles().executor) {
      try {
        await this.sessions.reconcileOwn();
      } catch (error) {
        this.logger.error(
          {
            workerId: config.CAIRN_WORKER_ID,
            err: error instanceof Error ? error.message : error,
          },
          "自愈后会话核对失败，本进程退出",
        );
        this.exitProcess(1);
        return;
      }
      this.startClaiming();
    }
    this.logger.log(
      {
        workerId: config.CAIRN_WORKER_ID,
        instanceId: this.instanceId,
        roles: this.roles(),
      },
      this.roles().executor
        ? "Worker 已以新代重新注册，恢复领取"
        : "Worker 已以新代重新注册，恢复角色循环",
    );
  }

  private advertiseUrl(): string | null {
    return resolveWorkerAdvertiseUrl({
      networkMode: config.CAIRN_WORKER_NETWORK_MODE,
      advertiseUrl: config.CAIRN_WORKER_ADVERTISE_URL,
      internalPort: config.CAIRN_WORKER_INTERNAL_PORT,
    });
  }

  private async bindInternalHttp(): Promise<void> {
    this.sessions.setWorkerInstance(this.instanceId);
    if (config.CAIRN_WORKER_INTERNAL_PORT <= 0) return;
    await this.internalHttp?.close().catch(() => undefined);
    this.markTick();
    this.internalHttp = await startManagedBrowserHttp({
      host: config.CAIRN_WORKER_INTERNAL_HOST,
      port: config.CAIRN_WORKER_INTERNAL_PORT,
      secret: config.CAIRN_INTERNAL_AUTH_SECRET,
      workerId: config.CAIRN_WORKER_ID,
      workerInstanceId: this.instanceId,
      sessions: this.sessions,
      engine: this.engine,
      nodeHealth: () => this.nodeHealth(),
    });
  }

  private markTick(): void {
    this.lastTickAt = new Date();
  }

  private liveHandleCount(): number | null {
    const count = this.sessions.liveHandleCount;
    return typeof count === "function" ? count.call(this.sessions) : null;
  }

  private refreshBrowserProcessCount(): void {
    if (this.browserCounting) return;
    this.browserCounting = countManagedBrowserProcesses(
      config.CAIRN_BROWSER_PROFILE_DIR,
    )
      .then((count) => {
        this.browserProcessCount = count;
      })
      .catch(() => {
        this.browserProcessCount = null;
      })
      .finally(() => {
        this.browserCounting = undefined;
      });
  }

  private startTelemetry(): void {
    void this.sampleDisk();
    void this.sampleSeries();
    this.diskTick = setInterval(() => {
      void this.sampleDisk();
    }, config.CAIRN_MONITOR_DISK_SAMPLE_MS);
    this.sampleTick = setInterval(() => {
      void this.sampleSeries();
    }, config.CAIRN_MONITOR_SAMPLE_INTERVAL_MS);
    if (this.roles().maintenance) {
      void this.probeObjectStore();
      this.probeTick = setInterval(() => {
        void this.probeObjectStore();
      }, config.CAIRN_MONITOR_OBJECT_STORE_PROBE_MS);
    }
  }

  private async sampleDisk(): Promise<void> {
    if (this.stopped || this.diskSampling) return;
    this.diskSampling = true;
    try {
      this.diskSample = await sampleProfileDisk(
        config.CAIRN_BROWSER_PROFILE_DIR,
        config.CAIRN_WORKER_ID,
      );
      this.markTick();
    } catch (error) {
      this.diskSample = null;
      this.logger.warn(
        error instanceof Error ? error.message : error,
        "profile 磁盘采样失败",
      );
    } finally {
      this.diskSampling = false;
    }
  }

  private async sampleSeries(): Promise<void> {
    if (this.stopped || this.sampling) return;
    this.sampling = true;
    try {
      this.markTick();
      const worker = await collectWorkerSamples(
        this.handle,
        config.CAIRN_WORKER_ID,
      );
      if (this.roles().maintenance) {
        const { claimed, skipped } = await claimWorkerPeriodicSlots(
          this.handle,
          this.sampleSlotRequests(),
        );
        this.logSlotMismatches(skipped);
        for (const claim of claimed) {
          await this.runClaimedSlot(claim, async () => {
            if (claim.name === "monitor.sample.platform") {
              const platform = await collectPlatformSamples(this.handle, {
                objectStoreStaleAfterMs:
                  2 * config.CAIRN_MONITOR_OBJECT_STORE_PROBE_MS,
              });
              await insertMonitorSamples(
                this.handle,
                platform,
                config.CAIRN_MONITOR_SAMPLE_INTERVAL_MS,
              );
            }
            if (claim.name === "monitor.sample.purge") {
              await purgeMonitorSamples(
                this.handle,
                config.CAIRN_MONITOR_SAMPLE_RETENTION_DAYS,
              );
            }
          });
        }
      }
      await insertMonitorSamples(
        this.handle,
        worker,
        config.CAIRN_MONITOR_SAMPLE_INTERVAL_MS,
      );
    } catch (error) {
      this.logger.warn(
        error instanceof Error ? error.message : error,
        "监控采样失败",
      );
    } finally {
      this.sampling = false;
    }
  }

  private async probeObjectStore(): Promise<void> {
    if (this.stopped || this.probing) return;
    this.probing = true;
    try {
      this.markTick();
      if (!this.roles().maintenance) return;
      const { claimed, skipped } = await claimWorkerPeriodicSlots(
        this.handle,
        this.probeSlotRequests(),
      );
      this.logSlotMismatches(skipped);
      const claim = claimed[0];
      if (!claim) return;
      await this.runClaimedSlot(claim, async () => {
        const result = await this.objects.probeStore();
        await upsertObjectStoreProbe(this.handle, {
          status: result.ok ? "ok" : "failed",
          latencyMs: result.latencyMs,
          errorClass: result.errorClass,
          probedBy: slotOwner(config.CAIRN_WORKER_ID),
        });
      });
    } catch (error) {
      this.logger.warn(
        error instanceof Error ? error.message : error,
        "对象存储探测失败",
      );
    } finally {
      this.probing = false;
    }
  }

  private slotOwnerId(): string {
    return slotOwner(config.CAIRN_WORKER_ID);
  }

  private reaperSlotRequests() {
    return reaperPeriodicSlotRequests({
      owner: this.slotOwnerId(),
      reaperIntervalMs: config.CAIRN_SESSION_REAPER_INTERVAL_MS,
      reminderIntervalMs: config.CAIRN_CREDENTIAL_REMINDER_SCAN_INTERVAL_MS,
      serviceRequestLogPurgeIntervalMs:
        DEFAULT_SERVICE_REQUEST_LOG_PURGE_INTERVAL_MS,
      leaseTtlMs: config.CAIRN_PERIODIC_SLOT_LEASE_TTL_MS,
    });
  }

  private sampleSlotRequests() {
    return samplePeriodicSlotRequests({
      owner: this.slotOwnerId(),
      sampleIntervalMs: config.CAIRN_MONITOR_SAMPLE_INTERVAL_MS,
      purgeIntervalMs: config.CAIRN_MONITOR_PURGE_INTERVAL_MS,
      leaseTtlMs: config.CAIRN_PERIODIC_SLOT_LEASE_TTL_MS,
    });
  }

  private probeSlotRequests() {
    return probePeriodicSlotRequests({
      owner: this.slotOwnerId(),
      probeIntervalMs: config.CAIRN_MONITOR_OBJECT_STORE_PROBE_MS,
      leaseTtlMs: config.CAIRN_PERIODIC_SLOT_LEASE_TTL_MS,
    });
  }

  private logSlotMismatches(skipped: PeriodicSlotSkip[]): void {
    for (const skip of skipped) {
      if (skip.reason === "mode_mismatch") {
        this.logger.warn(
          { slot: skip.name },
          "周期槽位 mode 与登记不一致，本 tick 不领取",
        );
      }
    }
  }

  private async runClaimedSlot(
    claim: PeriodicSlotClaim,
    fn: () => Promise<void>,
  ): Promise<void> {
    try {
      await fn();
      await finishWorkerPeriodicSlot(this.handle, claim, {
        outcome: "ok",
        failureRetryMs: config.CAIRN_PERIODIC_SLOT_FAILURE_RETRY_MS,
      });
    } catch (error) {
      this.logger.error(
        error instanceof Error ? error.message : error,
        `周期槽位 ${claim.name} 失败`,
      );
      await finishWorkerPeriodicSlot(this.handle, claim, {
        outcome: "failed",
        errorClass: periodicSlotErrorClass(error),
        failureRetryMs: config.CAIRN_PERIODIC_SLOT_FAILURE_RETRY_MS,
      }).catch((finishError) => {
        this.logger.error(
          finishError instanceof Error ? finishError.message : finishError,
          `周期槽位 ${claim.name} 收尾失败`,
        );
      });
    }
  }

  private async nodeHealth() {
    const lastTickAt = this.lastTickAt;
    const staleMs =
      WORKER_NODE_LOOP_STALE_HEARTBEATS * config.CAIRN_WORKER_HEARTBEAT_MS;
    const loopAlive = Boolean(
      lastTickAt && Date.now() - lastTickAt.getTime() <= staleMs,
    );
    return workerNodeHealthResponseSchema.parse({
      status: loopAlive && !this.shutdownCalled ? "ok" : "degraded",
      service: "cairn-worker",
      uptimeSeconds: this.uptimeSeconds(),
      checks: { database: await this.pingDatabase(), changeHint: "unused" },
      node: {
        workerId: config.CAIRN_WORKER_ID,
        instanceId: this.instanceId,
        lastTickAt: lastTickAt?.toISOString() ?? null,
        loopAlive,
        runningRunCount: this.inFlight.size,
        liveHandleCount: this.liveHandleCount() ?? 0,
        shuttingDown: this.shutdownCalled,
      },
    });
  }

  private async pingDatabase(): Promise<"up" | "down"> {
    try {
      const ok = await new Promise<boolean>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("ping timeout")),
          WORKER_NODE_HEALTH_PING_TIMEOUT_MS,
        );
        timer.unref();
        void this.handle.ping().then(
          (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          (error) => {
            clearTimeout(timer);
            reject(error);
          },
        );
      });
      return ok ? "up" : "down";
    } catch {
      return "down";
    }
  }

  private async pump(): Promise<void> {
    this.markTick();
    if (this.stopped || this.claiming) return;
    if (this.inFlight.size >= config.CAIRN_WORKER_CAPACITY) return;
    this.claiming = true;
    const controller = new AbortController();
    this.pendingClaim = controller;
    try {
      const grant = await claimRun(this.handle, {
        workerId: config.CAIRN_WORKER_ID,
        instanceId: this.instanceId,
        leaseTtlSeconds: config.CAIRN_RUN_LEASE_TTL_SECONDS,
        excludeRunIds: placementYieldExcludes(),
      });
      if (!grant) return;
      if (this.stopped || this.shutdownCalled) {
        await yieldUnfinishedRun(this.handle, grant).catch(() => undefined);
        return;
      }
      if (this.inFlight.has(grant.leaseId)) return;
      this.logger.log(
        { runId: grant.runId, leaseId: grant.leaseId },
        "领取到运行",
      );
      const done = this.engine
        .execute(grant.runId, { grant, signal: controller.signal })
        .catch((error) => {
          this.logger.error(
            {
              runId: grant.runId,
              leaseId: grant.leaseId,
              err: error instanceof Error ? error.message : error,
            },
            "执行失败",
          );
        })
        .finally(() => {
          this.inFlight.delete(grant.leaseId);
        });
      this.inFlight.set(grant.leaseId, { grant, controller, done });
    } catch (error) {
      this.logger.error(
        error instanceof Error ? error.message : error,
        "领取失败",
      );
    } finally {
      if (this.pendingClaim === controller) this.pendingClaim = undefined;
      this.claiming = false;
    }
  }

  private async pumpOperation(): Promise<void> {
    this.markTick();
    if (this.stopped) return;
    try {
      if (await hasQueuedSessionCreateOperation(this.handle)) {
        await this.sessions.evictIfAtCapacity().catch(() => undefined);
      }
      const claimed = await claimSessionOperation(this.handle, {
        workerId: config.CAIRN_WORKER_ID,
        instanceId: this.instanceId,
        leaseTtlSeconds: config.CAIRN_RUN_LEASE_TTL_SECONDS,
      });
      if (!claimed) return;
      if (claimed.operation.kind === "VALIDATE_AUTH_PROFILE") {
        if (!claimed.grant || !claimed.session) return;
        await this.sessions.attachValidationOperation({
          operation: claimed.operation,
          grant: claimed.grant,
          session: claimed.session,
        });
        this.logger.log(
          { operationId: claimed.operation.id },
          "领取到认证验收操作",
        );
        return;
      }
      await this.sessions.attachMaintenanceOperation(claimed);
      this.logger.log(
        { operationId: claimed.operation.id, kind: claimed.operation.kind },
        "领取到会话维护操作",
      );
    } catch (error) {
      this.logger.error(
        error instanceof Error ? error.message : error,
        "领取会话操作失败",
      );
    }
  }

  private async enqueueBackgroundMaintenance(): Promise<void> {
    if (this.stopped) return;
    try {
      const due = await listDueRetainedSessions(
        this.handle,
        config.CAIRN_WORKER_ID,
      );
      const current = await getOrCreatePlatformConfig(this.handle);
      const document = platformConfigDocumentSchema.parse(current.document);
      const interval = document.sessionRetention.maintenanceIntervalSeconds;
      const renewBefore = document.sessionRetention.renewBeforeSeconds;
      const slot = maintenanceWindowSlot(Date.now(), interval);
      for (const { session } of due) {
        const nearExpiry =
          session.authValidUntil != null &&
          session.authValidUntil.getTime() - Date.now() <= renewBefore * 1000;
        const profile = await loadCurrentAuthProfile(
          this.handle,
          session.targetId,
        );
        const account = await loadAccountForExecution(
          this.handle,
          session.targetAccountId,
        );
        const tier = deriveAuthCapability({
          definition: profile?.definition ?? null,
          validation: profile?.validation ?? null,
          expectedIdentity: account?.expectedIdentity ?? null,
        });
        const maxAge =
          Date.now() - session.createdAt.getTime() >=
          session.maxLifetimeSeconds * 1000;
        const kind = maxAge
          ? "RESTART"
          : nearExpiry &&
              session.authState === "AUTHENTICATED" &&
              tier === "IDENTITY_VERIFIED" &&
              profile?.definition.renew !== "none" &&
              profile
            ? "RENEW_AUTH"
            : "VERIFY_AUTH";
        const prefix =
          kind === "RESTART"
            ? "bg-restart"
            : kind === "RENEW_AUTH"
              ? "bg-renew"
              : "bg-verify";
        const verifySlot =
          kind === "VERIFY_AUTH"
            ? backgroundVerifyWindowSlot(
                Date.now(),
                session.authProbeIntervalSeconds,
                interval,
              )
            : slot;
        await scheduleNextAuthCheck(this.handle, session.id);
        await requestMaintenanceOperation(this.handle, {
          key: {
            targetId: session.targetId,
            targetAccountId: session.targetAccountId,
          },
          body: {
            kind,
            idempotencyKey: maintenanceIdempotencyKey(
              prefix,
              session.targetAccountId,
              verifySlot,
            ),
            expectedSessionId: session.id,
            expectedGeneration: session.generation,
          },
          origin: "BACKGROUND",
        }).catch(() => undefined);
      }
    } catch (error) {
      this.logger.error(
        error instanceof Error ? error.message : error,
        "排队后台会话维护失败",
      );
    }
  }
}

function webhookControlPlaneHosts(): string[] {
  const hosts = [config.CAIRN_WORKER_INTERNAL_HOST];
  if (config.CAIRN_WORKER_ADVERTISE_URL) {
    try {
      hosts.push(new URL(config.CAIRN_WORKER_ADVERTISE_URL).hostname);
    } catch {
      /* 启动时已校验广告 URL */
    }
  }
  return hosts.filter((host) => host.length > 0);
}
