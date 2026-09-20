import { Logger } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@cairn/db";
import { BrowserSessionManager } from "../browser/session-manager";
import { DB_HANDLE, DbModule } from "../db/db.module";
import { clearPlacementYields, yieldPlacement } from "./placement-backoff";
import { ExecutionEngine } from "../engine/engine";
import { EvidenceSettleService } from "../evidence/settle.service";
import { ObjectService } from "../objects/object.service";
import { parseWorkerRoles, protocolCapabilitiesForRoles } from "@cairn/shared";
import { config } from "../config/env";
import { LifecycleService } from "./lifecycle.service";

vi.mock("./browser-processes", () => ({
  countManagedBrowserProcesses: vi.fn(async () => 0),
}));

vi.mock("./service-webhook-delivery", () => ({
  deliverServiceWebhooks: vi.fn(async () => 0),
}));

vi.mock("@cairn/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cairn/db")>();
  return {
    ...actual,
    registerWorker: vi.fn(async () => ({
      worker: { id: "stub" },
      revokedRunIds: [],
    })),
    backfillModuleInvocationResults: vi.fn(async () => ({
      projected: 0,
      skipped: false,
    })),
    backfillOutcomeResults: vi.fn(async () => ({
      projected: 0,
      skipped: false,
    })),
    materializeDueSchedules: vi.fn(async () => ({
      outcome: {
        scanned: 0,
        materialized: 0,
        skipped: 0,
        admitted: 0,
        conflicts: 0,
      },
      pending: [],
    })),
    admitScheduleOccurrence: vi.fn(async () => undefined),
    expireClosedScheduleWindows: vi.fn(async () => 0),
    expireScheduledMapJobs: vi.fn(async () => 0),
    advanceDueSuiteRuns: vi.fn(async () => ({ advanced: 0 })),
    generateDueSuiteReports: vi.fn(async () => ({ generated: 0 })),
    getMapJobPolicy: vi.fn(async () => ({ revision: 0, policy: {} })),
    getMapSafeEntry: vi.fn(async () => ({ entryId: "e" })),
    getMapSummary: vi.fn(async () => ({ publishedReleaseId: undefined })),
    listMapAssets: vi.fn(async () => ({ items: [] })),
    listMapJobCandidateAssets: vi.fn(async () => []),
    settleRevokedRuns: vi.fn(async () => undefined),
    markWorkerDraining: vi.fn(async () => undefined),
    markWorkerStopped: vi.fn(async () => undefined),
    claimRun: vi.fn(async () => null),
    claimSessionOperation: vi.fn(async () => null),
    hasQueuedSessionCreateOperation: vi.fn(async () => false),
    appendSessionEvent: vi.fn(async () => {}),
    finishSessionOperation: vi.fn(async () => true),
    getSessionById: vi.fn(async () => ({
      id: "s",
      status: "OPEN",
      version: 1,
      generation: 1,
    })),
    setSessionStatus: vi.fn(async () => true),
    readLiveSessionAuth: vi.fn(async () => ({ revision: 1, sessionAuth: {} })),
    freezeAuthVerificationForRun: vi.fn(async () => ({
      capability: "IDENTITY_VERIFIED",
      profileRevision: 1,
    })),
    loadAuthProfileRevision: vi.fn(async () => ({
      definition: { renew: "verify_slides" },
    })),
    loadTargetForExecution: vi.fn(async () => ({
      id: "t",
      entryUrl: "https://example.com",
      authMethod: "password",
      captchaMode: "none",
    })),
    releaseSessionUse: vi.fn(async () => {}),
    loadAccountForExecution: vi.fn(async () => null),
    loadCurrentAuthProfile: vi.fn(async () => null),
    scheduleNextAuthCheck: vi.fn(async () => undefined),
    listDueRetainedSessions: vi.fn(async () => []),
    requestMaintenanceOperation: vi.fn(async () => ({
      operation: null,
      created: false,
      reusedRunId: null,
    })),
    getOrCreatePlatformConfig: vi.fn(async () => {
      const { FACTORY_PLATFORM_CONFIG } = await import("@cairn/shared");
      return { document: FACTORY_PLATFORM_CONFIG, revision: 1 };
    }),
    heartbeatWorker: vi.fn(async () => "ok" as const),
    collectPlatformSamples: vi.fn(async () => []),
    collectWorkerSamples: vi.fn(async () => []),
    insertMonitorSamples: vi.fn(async () => 0),
    purgeMonitorSamples: vi.fn(async () => 0),
    upsertObjectStoreProbe: vi.fn(async () => undefined),
    touchRuntimeWatermark: vi.fn(async () => undefined),
    renewRunLease: vi.fn(async () => new Date()),
    loadRunRow: vi.fn(async () => ({ status: "RUNNING" })),
    expireRunDeadlines: vi.fn(async () => ({ settled: 0, scanned: 0 })),
    markLostApiInstances: vi.fn(async () => []),
    expireStaleRunLeases: vi.fn(async () => ({ expired: 0, outcomes: [] })),
    sweepDriftedRuns: vi.fn(async () => ({ settled: 0, scanned: 0 })),
    markLostWorkers: vi.fn(async () => []),
    evaluateAlerts: vi.fn(async () => ({
      evaluated: 0,
      fired: 0,
      resolved: 0,
      interrupted: 0,
    })),
    claimDuePeriodicSlots: vi.fn(
      async (
        _db,
        requests: Array<{
          name: string;
          mode: string;
          intervalMs: number;
        }> = [],
      ) => {
        return {
          claimed: requests.map((request, index) => ({
            name: request.name,
            mode: request.mode,
            claimSeq: index + 1,
            intervalMs: request.intervalMs,
          })),
          skipped: [],
        };
      },
    ),
    finishPeriodicSlot: vi.fn(async () => true),
    reapSessionLeases: vi.fn(async () => ({ settled: 0, scanned: 0 })),
    scanCredentialReminders: vi.fn(async () => ({ opened: 0, closed: 0 })),
    reapServiceRequestLogs: vi.fn(async () => ({ scanned: 0, deleted: 0 })),
    claimNotificationDeliveries: vi.fn(async () => []),
    claimRunVideoMediaJobs: vi.fn(async () => []),
    enqueueRunVideoMediaJob: vi.fn(async () => ({ id: "job" })),
    finishRunVideoMediaJob: vi.fn(async () => ({ ok: true })),
    importLegacyNotificationNotices: vi.fn(async () => undefined),
    reconcileNotificationSuppressions: vi.fn(async () => undefined),
    purgeNotificationHistory: vi.fn(async () => 0),
    beginNotificationSubmission: vi.fn(async () => true),
    finishNotificationDelivery: vi.fn(async () => undefined),
    prepareNotificationEvents: vi.fn(async () => undefined),
    repairNotificationIntents: vi.fn(async () => undefined),
    claimDueAlertDeliveries: vi.fn(async () => []),
    finishAlertDelivery: vi.fn(async () => undefined),
    loadSecretCiphertext: vi.fn(async () => null),
    markSessionsLostForWorkers: vi.fn(async () => 0),
    listActiveLeasesForWorker: vi.fn(async () => []),
    yieldUnfinishedRun: vi.fn(async () => undefined),
    yieldClaimedRun: vi.fn(async () => "yielded" as const),
  };
});

function stubDb(close = vi.fn(async () => {})): DbHandle {
  return { driver: "postgres", ping: async () => true, close };
}

function stubSessions() {
  return {
    reconcileOwn: vi.fn(async () => ({ leasesRevoked: 0, sessionsClosed: 0 })),
    setWorkerInstance: vi.fn(),
    startHeartbeat: vi.fn(),
    stopHeartbeat: vi.fn(),
    shutdown: vi.fn(async () => {}),
    reap: vi.fn(async () => ({ leasesExpired: 0, sessionsClosed: 0 })),
    stopAllLocal: vi.fn(async () => []),
    liveHandleCount: vi.fn(() => 0),
    attachValidationOperation: vi.fn(async () => {}),
    attachMaintenanceOperation: vi.fn(async () => {}),
    evictIfAtCapacity: vi.fn(async () => false),
  };
}

describe("LifecycleService", () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;

  async function buildApp(handle: DbHandle) {
    const moduleRef = await Test.createTestingModule({
      providers: [
        LifecycleService,
        { provide: DB_HANDLE, useValue: handle },
        {
          provide: ExecutionEngine,
          useValue: { execute: vi.fn(async () => {}) },
        },
        {
          provide: ObjectService,
          useValue: {
            purgeExpiredObjects: vi.fn(async () => ({ purged: 0 })),
            probeStore: vi.fn(async () => ({
              ok: true,
              latencyMs: 1,
              errorClass: null,
            })),
          },
        },
        {
          provide: EvidenceSettleService,
          useValue: { settleExpired: vi.fn(async () => ({ marked: 0 })) },
        },
        { provide: BrowserSessionManager, useValue: stubSessions() },
      ],
    }).compile();
    const application = moduleRef.createNestApplication();
    await application.init();
    return application;
  }

  afterEach(async () => {
    clearPlacementYields();
    const { heartbeatWorker, claimRun, claimSessionOperation, registerWorker } =
      await import("@cairn/db");
    vi.mocked(heartbeatWorker).mockReset();
    vi.mocked(heartbeatWorker).mockResolvedValue("ok");
    vi.mocked(claimRun).mockReset();
    vi.mocked(claimRun).mockResolvedValue(null);
    vi.mocked(claimSessionOperation).mockReset();
    vi.mocked(claimSessionOperation).mockResolvedValue(null);
    vi.mocked(registerWorker).mockReset();
    vi.mocked(registerWorker).mockResolvedValue({
      worker: { id: "stub" },
      revokedRunIds: [],
    });
    const {
      collectPlatformSamples,
      insertMonitorSamples,
      finishPeriodicSlot,
      scanCredentialReminders,
      reapServiceRequestLogs,
      claimNotificationDeliveries,
    } = await import("@cairn/db");
    vi.mocked(collectPlatformSamples).mockReset();
    vi.mocked(collectPlatformSamples).mockResolvedValue([]);
    vi.mocked(insertMonitorSamples).mockReset();
    vi.mocked(insertMonitorSamples).mockResolvedValue(0);
    vi.mocked(finishPeriodicSlot).mockReset();
    vi.mocked(finishPeriodicSlot).mockResolvedValue(true);
    vi.mocked(scanCredentialReminders).mockReset();
    vi.mocked(scanCredentialReminders).mockResolvedValue({
      opened: 0,
      closed: 0,
    });
    vi.mocked(reapServiceRequestLogs).mockReset();
    vi.mocked(reapServiceRequestLogs).mockResolvedValue({
      scanned: 0,
      deleted: 0,
    });
    vi.mocked(claimNotificationDeliveries).mockReset();
    vi.mocked(claimNotificationDeliveries).mockResolvedValue([]);
    const { deliverServiceWebhooks } = await import("./service-webhook-delivery");
    vi.mocked(deliverServiceWebhooks).mockReset();
    vi.mocked(deliverServiceWebhooks).mockResolvedValue(0);
    await app?.close().catch(() => {});
    app = undefined;
  });

  it("启动时探活数据库并持有存活句柄", async () => {
    app = await buildApp(stubDb());
    expect(app.get(LifecycleService).isRunning()).toBe(true);
  });

  it("框架关闭应用时自动触发停机钩子并释放句柄", async () => {
    app = await buildApp(stubDb());
    const svc = app.get(LifecycleService);

    await app.close(); // 不手工调用钩子，验证框架确实会触发
    app = undefined;

    expect(svc.shutdownCalled).toBe(true);
    expect(svc.isRunning()).toBe(false);
  });

  it("停机钩子拿得到信号名", async () => {
    app = await buildApp(stubDb());
    const svc = app.get(LifecycleService);
    svc.onApplicationShutdown("SIGTERM");
    expect(svc.shutdownSignal).toBe("SIGTERM");
  });

  it("停机等待在途对象清理结束", async () => {
    let release!: () => void;
    const purgeHold = new Promise<{ purged: number }>((resolve) => {
      release = () => resolve({ purged: 1 });
    });
    const sessions = stubSessions();
    const moduleRef = await Test.createTestingModule({
      providers: [
        LifecycleService,
        { provide: DB_HANDLE, useValue: stubDb() },
        {
          provide: ExecutionEngine,
          useValue: { execute: vi.fn(async () => {}) },
        },
        {
          provide: ObjectService,
          useValue: {
            purgeExpiredObjects: vi.fn(() => purgeHold),
            probeStore: vi.fn(async () => ({
              ok: true,
              latencyMs: 1,
              errorClass: null,
            })),
          },
        },
        {
          provide: EvidenceSettleService,
          useValue: { settleExpired: vi.fn(async () => ({ marked: 0 })) },
        },
        { provide: BrowserSessionManager, useValue: sessions },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    const svc = app.get(LifecycleService);
    const running = svc.runCleanup();
    const closing = svc.onApplicationShutdown("SIGTERM");
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(closed).toBe(false);
    release();
    await running;
    await closing;
    expect(svc.shutdownCalled).toBe(true);
    expect(sessions.shutdown).toHaveBeenCalledOnce();
  });

  it("启动时 reconcileOwn 并启动心跳", async () => {
    const sessions = stubSessions();
    const moduleRef = await Test.createTestingModule({
      providers: [
        LifecycleService,
        { provide: DB_HANDLE, useValue: stubDb() },
        {
          provide: ExecutionEngine,
          useValue: { execute: vi.fn(async () => {}) },
        },
        {
          provide: ObjectService,
          useValue: {
            purgeExpiredObjects: vi.fn(async () => ({ purged: 0 })),
            probeStore: vi.fn(async () => ({
              ok: true,
              latencyMs: 1,
              errorClass: null,
            })),
          },
        },
        {
          provide: EvidenceSettleService,
          useValue: { settleExpired: vi.fn(async () => ({ marked: 0 })) },
        },
        { provide: BrowserSessionManager, useValue: sessions },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    expect(sessions.reconcileOwn).toHaveBeenCalledOnce();
    expect(sessions.startHeartbeat).toHaveBeenCalledOnce();
  });

  it("启动时先绑定内部入口再登记", async () => {
    const { registerWorker } = await import("@cairn/db");
    vi.mocked(registerWorker).mockClear();
    const svc = await buildLifecycle();
    const sessions = app!.get(BrowserSessionManager);
    expect(sessions.setWorkerInstance).toHaveBeenCalledWith(instanceIdOf(svc));
    expect(
      vi.mocked(registerWorker).mock.invocationCallOrder[0]!,
    ).toBeGreaterThan(
      vi.mocked(sessions.setWorkerInstance).mock.invocationCallOrder[0]!,
    );
    expect(vi.mocked(registerWorker).mock.calls.at(-1)?.[1]).toEqual(
      expect.objectContaining({
        protocolCapabilities: protocolCapabilitiesForRoles(
          parseWorkerRoles(undefined),
        ),
      }),
    );
  });

  it("启动时仅为到期保留会话排队后台维护", async () => {
    const { listDueRetainedSessions, requestMaintenanceOperation } =
      await import("@cairn/db");
    vi.mocked(listDueRetainedSessions).mockResolvedValueOnce([
      {
        session: {
          id: "11111111-1111-4111-8111-111111111111",
          targetId: "22222222-2222-4222-8222-222222222222",
          targetAccountId: "33333333-3333-4333-8333-333333333333",
          generation: 2,
          createdAt: new Date(),
          maxLifetimeSeconds: 14400,
          observedTier: "LOGIN_VERIFIED",
          authValidUntil: null,
          authProbeIntervalSeconds: 900,
        },
      } as never,
    ]);
    const {
      backgroundVerifyWindowSlot,
      FACTORY_SESSION_RETENTION,
      maintenanceIdempotencyKey,
    } = await import("@cairn/shared");
    const verifySlot = backgroundVerifyWindowSlot(
      Date.now(),
      900,
      FACTORY_SESSION_RETENTION.maintenanceIntervalSeconds,
    );
    app = await buildApp(stubDb());
    await vi.waitFor(() => {
      expect(requestMaintenanceOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          origin: "BACKGROUND",
          body: expect.objectContaining({
            kind: "VERIFY_AUTH",
            expectedSessionId: "11111111-1111-4111-8111-111111111111",
            expectedGeneration: 2,
            idempotencyKey: maintenanceIdempotencyKey(
              "bg-verify",
              "33333333-3333-4333-8333-333333333333",
              verifySlot,
            ),
          }),
        }),
      );
    });
  });

  it("uptime 非负且随时间增长", async () => {
    app = await buildApp(stubDb());
    const svc = app.get(LifecycleService);
    const first = svc.uptimeSeconds();
    expect(first).toBeGreaterThanOrEqual(0);
    await new Promise((r) => setTimeout(r, 10));
    expect(svc.uptimeSeconds()).toBeGreaterThan(first);
  });

  it("被判失联：停手、以新代重新注册、恢复领取，不留僵尸进程", async () => {
    const { heartbeatWorker, registerWorker } = await import("@cairn/db");
    const svc = await buildLifecycle();
    // 启动注册已经发生过一次，计数从这里重新起算
    vi.mocked(registerWorker).mockClear();
    vi.mocked(heartbeatWorker).mockResolvedValueOnce("lost");
    const exit = vi.fn();
    svc.exitProcess = exit;
    const abort = injectInFlight(svc);
    const instanceBefore = instanceIdOf(svc);
    const sessions = app!.get(BrowserSessionManager);
    vi.mocked(sessions.setWorkerInstance).mockClear();
    vi.mocked(sessions.reconcileOwn).mockClear();

    await beat(svc);

    // 在途 grant 已随失联作废，必须中止；但领取能力要回来。
    expect(abort).toHaveBeenCalledOnce();
    expect(registerWorker).toHaveBeenCalledOnce();
    expect(instanceIdOf(svc)).not.toBe(instanceBefore);
    expect(svc.isRunning()).toBe(true);
    expect(exit).not.toHaveBeenCalled();
    expect(sessions.stopAllLocal).toHaveBeenCalled();
    expect(sessions.setWorkerInstance).toHaveBeenCalledWith(instanceIdOf(svc));
    expect(sessions.reconcileOwn).toHaveBeenCalledOnce();
    expect(
      vi.mocked(registerWorker).mock.invocationCallOrder[0]!,
    ).toBeGreaterThan(
      vi.mocked(sessions.stopAllLocal).mock.invocationCallOrder[0]!,
    );
    expect(
      vi.mocked(registerWorker).mock.invocationCallOrder[0]!,
    ).toBeGreaterThan(
      vi.mocked(sessions.setWorkerInstance).mock.invocationCallOrder[0]!,
    );
  });

  it("数据库阻塞跨过多个心跳周期时，只执行一个心跳和一次重新注册", async () => {
    const { heartbeatWorker, registerWorker } = await import("@cairn/db");
    const svc = await buildLifecycle();
    const internals = svc as unknown as { heartbeatTick?: NodeJS.Timeout };
    if (internals.heartbeatTick) {
      clearInterval(internals.heartbeatTick);
      internals.heartbeatTick = undefined;
    }
    vi.mocked(registerWorker).mockClear();
    vi.mocked(heartbeatWorker).mockClear();
    let release!: () => void;
    const blocked = new Promise<"lost">((resolve) => {
      release = () => resolve("lost");
    });
    vi.mocked(heartbeatWorker).mockImplementationOnce(() => blocked);
    const exit = vi.fn();
    svc.exitProcess = exit;
    const pending = beat(svc);
    await Promise.all([beat(svc), beat(svc), beat(svc)]);
    const calls = vi.mocked(heartbeatWorker).mock.calls.length;
    release();
    await pending;
    expect(calls).toBe(1);
    expect(registerWorker).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
    expect(svc.isRunning()).toBe(true);
  });

  it("登记时写入 maxSessions 与广告入口，不从监听地址拼接", async () => {
    const { claimRun, registerWorker } = await import("@cairn/db");
    const svc = await buildLifecycle();
    expect(registerWorker).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        maxSessions: config.CAIRN_BROWSER_MAX_SESSIONS,
        internalBaseUrl: null,
      }),
    );
    await (svc as unknown as { claimTask?: Promise<void> }).claimTask;
    vi.mocked(claimRun).mockClear();
    const { yieldClaimedRun } = await import("@cairn/db");
    vi.mocked(yieldClaimedRun).mockResolvedValueOnce("yielded");
    await yieldPlacement({} as never, {
      runId: "run-yielded",
      leaseId: "lease-yielded",
      fencingToken: 1,
      holderWorkerId: "w",
      expiresAt: new Date().toISOString(),
    });
    await (svc as unknown as { pump: () => Promise<void> }).pump();
    expect(claimRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        excludeRunIds: expect.arrayContaining(["run-yielded"]),
      }),
    );
  });

  it("Run 已终态后续租失败不中止收尾编码", async () => {
    const { renewRunLease, loadRunRow } = await import("@cairn/db");
    const svc = await buildLifecycle();
    vi.mocked(renewRunLease).mockResolvedValueOnce(null);
    vi.mocked(loadRunRow).mockResolvedValueOnce({
      status: "SUCCEEDED",
    } as never);
    const abort = injectInFlight(svc);
    await beat(svc);
    expect(abort).not.toHaveBeenCalled();
    expect(loadRunRow).toHaveBeenCalled();
  });

  it("运行中续租失败仍停手", async () => {
    const { renewRunLease, loadRunRow } = await import("@cairn/db");
    const svc = await buildLifecycle();
    vi.mocked(renewRunLease).mockResolvedValueOnce(null);
    vi.mocked(loadRunRow).mockResolvedValueOnce({ status: "RUNNING" } as never);
    const abort = injectInFlight(svc);
    await beat(svc);
    expect(abort).toHaveBeenCalledOnce();
  });

  it("身份被另一实例接管：不抢回，退出进程", async () => {
    const { heartbeatWorker, registerWorker } = await import("@cairn/db");
    const svc = await buildLifecycle();
    vi.mocked(registerWorker).mockClear();
    vi.mocked(heartbeatWorker).mockResolvedValueOnce("instance_taken");
    const exit = vi.fn();
    svc.exitProcess = exit;
    const abort = injectInFlight(svc);

    await beat(svc);

    expect(abort).toHaveBeenCalledOnce();
    expect(svc.isRunning()).toBe(false);
    expect(registerWorker).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("登记后先写心跳，成功才领取会话操作", async () => {
    const { heartbeatWorker, claimSessionOperation, registerWorker } =
      await import("@cairn/db");
    const order: string[] = [];
    vi.mocked(registerWorker).mockImplementation(async () => {
      order.push("register");
      return { worker: { id: "stub" }, revokedRunIds: [] };
    });
    vi.mocked(heartbeatWorker).mockImplementation(async () => {
      order.push("heartbeat");
      return "ok";
    });
    vi.mocked(claimSessionOperation).mockImplementation(async () => {
      order.push("claim");
      return null;
    });

    app = await buildApp(stubDb());
    await (
      app.get(LifecycleService) as unknown as { claimTask?: Promise<void> }
    ).claimTask;
    await Promise.resolve();

    expect(order.indexOf("heartbeat")).toBeGreaterThan(
      order.indexOf("register"),
    );
    expect(order.indexOf("claim")).toBeGreaterThan(order.indexOf("heartbeat"));
    vi.mocked(heartbeatWorker).mockResolvedValue("ok");
    vi.mocked(claimSessionOperation).mockResolvedValue(null);
    vi.mocked(registerWorker).mockResolvedValue({
      worker: { id: "stub" },
      revokedRunIds: [],
    });
  });

  it("启动心跳判失联：自愈完成前不领取", async () => {
    const { heartbeatWorker, claimSessionOperation, registerWorker } =
      await import("@cairn/db");
    const order: string[] = [];
    vi.mocked(heartbeatWorker).mockImplementationOnce(async () => {
      order.push("heartbeat-lost");
      return "lost";
    });
    vi.mocked(heartbeatWorker).mockImplementation(async () => {
      order.push("heartbeat-ok");
      return "ok";
    });
    vi.mocked(registerWorker).mockImplementation(async () => {
      order.push("register");
      return { worker: { id: "stub" }, revokedRunIds: [] };
    });
    vi.mocked(claimSessionOperation).mockImplementation(async () => {
      order.push("claim");
      return null;
    });

    app = await buildApp(stubDb());
    await (
      app.get(LifecycleService) as unknown as { claimTask?: Promise<void> }
    ).claimTask;
    await Promise.resolve();

    const firstClaim = order.indexOf("claim");
    const healRegister = order.lastIndexOf("register");
    expect(order.indexOf("heartbeat-lost")).toBeGreaterThan(
      order.indexOf("register"),
    );
    expect(healRegister).toBeGreaterThan(order.indexOf("heartbeat-lost"));
    expect(firstClaim).toBeGreaterThan(healRegister);
    vi.mocked(heartbeatWorker).mockResolvedValue("ok");
    vi.mocked(claimSessionOperation).mockResolvedValue(null);
    vi.mocked(registerWorker).mockResolvedValue({
      worker: { id: "stub" },
      revokedRunIds: [],
    });
  });

  it("自愈期间 ID 被别人拿走：重新注册失败也要退出，不静默停工", async () => {
    const { heartbeatWorker, registerWorker } = await import("@cairn/db");
    const svc = await buildLifecycle();
    // 只对自愈那次注册注入冲突：启动注册必须先正常走完
    vi.mocked(registerWorker).mockRejectedValueOnce(
      new Error("WORKER_ID_CONFLICT"),
    );
    vi.mocked(heartbeatWorker).mockResolvedValueOnce("lost");
    const exit = vi.fn();
    svc.exitProcess = exit;

    await beat(svc);

    expect(svc.isRunning()).toBe(false);
    expect(exit).toHaveBeenCalledWith(1);
  });

  /** 验收 21：容量满就不再领取，否则一个实例会把自己撑爆、租约全部续不上。 */
  it("容量已满时不再领取", async () => {
    const { claimRun } = await import("@cairn/db");
    const svc = await buildLifecycle();
    // 等启动那次领取跑完，否则 pump 会被 claiming 挡住，用例就测不到容量这一层
    await (svc as unknown as { claimTask?: Promise<void> }).claimTask;
    vi.mocked(claimRun).mockClear();
    injectInFlight(svc);

    await (svc as unknown as { pump: () => Promise<void> }).pump();

    // 默认容量 1，已有一条在途
    expect(claimRun).not.toHaveBeenCalled();
  });

  /** S6：同 ID 双开是本地最先踩到的错误路径，必须给出可读原因且不带凭证。 */
  it("启动撞同 ID 冲突：给出可读原因后仍让启动失败", async () => {
    const { registerWorker, DomainError } = await import("@cairn/db");
    vi.mocked(registerWorker).mockRejectedValueOnce(
      new DomainError(
        "conflict",
        "WORKER_ID_CONFLICT",
        "Worker local-worker 仍有新鲜心跳",
      ),
    );
    const errors: string[] = [];
    const spy = vi
      .spyOn(Logger.prototype, "error")
      .mockImplementation((message: unknown) => {
        errors.push(String(message));
      });

    try {
      await expect(
        Test.createTestingModule({
          providers: [
            LifecycleService,
            { provide: DB_HANDLE, useValue: stubDb() },
            {
              provide: ExecutionEngine,
              useValue: { execute: vi.fn(async () => {}) },
            },
            {
              provide: ObjectService,
              useValue: {
                purgeExpiredObjects: vi.fn(async () => ({ purged: 0 })),
              },
            },
            {
              provide: EvidenceSettleService,
              useValue: { settleExpired: vi.fn(async () => ({ marked: 0 })) },
            },
            { provide: BrowserSessionManager, useValue: stubSessions() },
          ],
        })
          .compile()
          .then((moduleRef) => moduleRef.createNestApplication().init()),
      ).rejects.toThrow(/WORKER_ID_CONFLICT|仍有新鲜心跳/);
    } finally {
      spy.mockRestore();
    }

    const explained = errors.join("\n");
    expect(explained).toContain("CAIRN_WORKER_ID=local-worker");
    expect(explained).toContain("每实例一个 ID");
    expect(explained).not.toMatch(/password|CairnDB/i);
  });

  it("停机按本实例收尾，不按 Worker ID 重查租约", async () => {
    const { markWorkerDraining, markWorkerStopped, listActiveLeasesForWorker } =
      await import("@cairn/db");
    const svc = await buildLifecycle();
    const instanceId = instanceIdOf(svc);
    injectInFlight(svc);

    await svc.onApplicationShutdown("SIGTERM");

    expect(markWorkerDraining).toHaveBeenCalledWith(
      expect.anything(),
      config.CAIRN_WORKER_ID,
      instanceId,
    );
    expect(markWorkerStopped).toHaveBeenCalledWith(
      expect.anything(),
      config.CAIRN_WORKER_ID,
      instanceId,
    );
    expect(listActiveLeasesForWorker).not.toHaveBeenCalled();
  });

  it("领取维护后调用真实 BrowserSessionManager.attachMaintenanceOperation", async () => {
    const { claimSessionOperation } = await import("@cairn/db");
    const manager = new BrowserSessionManager(stubDb(), {
      workerId: "w",
      workerInstanceId: "i",
      profileRoot: "/tmp/cairn-session-cd-v2",
      headless: true,
      maxSessions: 1,
      defaultLeaseTtlSeconds: 60,
      defaultAuthWaitSeconds: 600,
      heartbeatMs: 60_000,
    });
    expect(Object.getPrototypeOf(manager)).toBe(
      BrowserSessionManager.prototype,
    );
    vi.spyOn(manager, "reconcileOwn").mockResolvedValue({
      leasesRevoked: 0,
      sessionsClosed: 0,
    });
    vi.spyOn(manager, "startHeartbeat").mockImplementation(() => undefined);
    vi.spyOn(manager, "stopHeartbeat").mockImplementation(() => undefined);
    vi.spyOn(manager, "shutdown").mockResolvedValue(undefined);
    vi.spyOn(manager, "reap").mockResolvedValue({
      leasesExpired: 0,
      sessionsClosed: 0,
    });
    const stubPage = {
      isClosed: () => false,
      url: () => "https://example.com/login",
      on: vi.fn(),
      off: vi.fn(),
    };
    (manager as unknown as { lives: Map<string, unknown> }).lives.set("s", {
      handle: { basePage: stubPage },
      sessionId: "s",
      runPageIds: new Set(),
      runPages: new Map(),
      pages: new Map(),
      currentPageIdByLease: new Map(),
      currentPageIdByRun: new Map(),
      autoInputClosed: false,
      inputAccepting: false,
      serial: Promise.resolve(),
      allowedOrigins: [],
      receipts: new Map(),
      lastSeq: 0,
      controlEpoch: 0,
      screencasts: new Map(),
      screencastObservers: new Map(),
    });
    vi.spyOn(manager, "runMaintenanceAuth").mockResolvedValue({ ok: true });
    const finish = vi.spyOn(manager, "finishMaintenance");
    const attached = vi.spyOn(manager, "attachMaintenanceOperation");
    const claimed = {
      operation: {
        id: "op-v2",
        kind: "VERIFY_AUTH",
        targetId: "t",
        targetAccountId: "a",
      },
      grant: {
        sessionId: "s",
        leaseId: "l",
        generation: 1,
        sessionFencingToken: 1,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        purpose: "MAINTENANCE",
        ownerKind: "SESSION_OPERATION",
        operationId: "op-v2",
      },
      session: { id: "s", status: "OPEN", generation: 1 },
      reusedRunId: null,
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        LifecycleService,
        { provide: DB_HANDLE, useValue: stubDb() },
        {
          provide: ExecutionEngine,
          useValue: { execute: vi.fn(async () => {}) },
        },
        {
          provide: ObjectService,
          useValue: {
            purgeExpiredObjects: vi.fn(async () => ({ purged: 0 })),
            probeStore: vi.fn(async () => ({
              ok: true,
              latencyMs: 1,
              errorClass: null,
            })),
          },
        },
        {
          provide: EvidenceSettleService,
          useValue: { settleExpired: vi.fn(async () => ({ marked: 0 })) },
        },
        { provide: BrowserSessionManager, useValue: manager },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    vi.mocked(claimSessionOperation).mockResolvedValueOnce(claimed as never);
    await (
      app.get(LifecycleService) as unknown as {
        pumpOperation: () => Promise<void>;
      }
    ).pumpOperation();
    expect(attached).toHaveBeenCalledWith(claimed);
    expect(attached.mock.contexts[0]).toBe(manager);
    expect(finish).toHaveBeenCalledWith(
      "op-v2",
      { targetId: "t", targetAccountId: "a" },
      "SUCCEEDED",
      expect.objectContaining({ sessionId: "s" }),
      undefined,
    );
  });

  it("仅在排队会建会话的维护时腾位", async () => {
    const { hasQueuedSessionCreateOperation } = await import("@cairn/db");
    let queued = false;
    vi.mocked(hasQueuedSessionCreateOperation).mockImplementation(
      async () => queued,
    );
    const sessions = stubSessions();
    const moduleRef = await Test.createTestingModule({
      providers: [
        LifecycleService,
        { provide: DB_HANDLE, useValue: stubDb() },
        {
          provide: ExecutionEngine,
          useValue: { execute: vi.fn(async () => {}) },
        },
        {
          provide: ObjectService,
          useValue: {
            purgeExpiredObjects: vi.fn(async () => ({ purged: 0 })),
            probeStore: vi.fn(async () => ({
              ok: true,
              latencyMs: 1,
              errorClass: null,
            })),
          },
        },
        {
          provide: EvidenceSettleService,
          useValue: { settleExpired: vi.fn(async () => ({ marked: 0 })) },
        },
        { provide: BrowserSessionManager, useValue: sessions },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    sessions.evictIfAtCapacity.mockClear();
    await (
      app.get(LifecycleService) as unknown as {
        pumpOperation: () => Promise<void>;
      }
    ).pumpOperation();
    expect(sessions.evictIfAtCapacity).not.toHaveBeenCalled();
    queued = true;
    await (
      app.get(LifecycleService) as unknown as {
        pumpOperation: () => Promise<void>;
      }
    ).pumpOperation();
    expect(sessions.evictIfAtCapacity).toHaveBeenCalled();
    vi.mocked(hasQueuedSessionCreateOperation).mockResolvedValue(false);
  });

  it("执行失败日志带 runId 与 leaseId", async () => {
    const { claimRun } = await import("@cairn/db");
    const execute = vi.fn(async () => {
      throw new Error("boom");
    });
    const moduleRef = await Test.createTestingModule({
      providers: [
        LifecycleService,
        { provide: DB_HANDLE, useValue: stubDb() },
        { provide: ExecutionEngine, useValue: { execute } },
        {
          provide: ObjectService,
          useValue: {
            purgeExpiredObjects: vi.fn(async () => ({ purged: 0 })),
            probeStore: vi.fn(async () => ({
              ok: true,
              latencyMs: 1,
              errorClass: null,
            })),
          },
        },
        {
          provide: EvidenceSettleService,
          useValue: { settleExpired: vi.fn(async () => ({ marked: 0 })) },
        },
        { provide: BrowserSessionManager, useValue: stubSessions() },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    const svc = app.get(LifecycleService);
    vi.mocked(claimRun).mockResolvedValueOnce({
      runId: "run-log-1",
      leaseId: "lease-log-1",
      fencingToken: 1,
      holderWorkerId: "w",
      expiresAt: new Date().toISOString(),
    } as never);
    const error = vi.spyOn(Logger.prototype, "error");
    await (svc as unknown as { pump: () => Promise<void> }).pump();
    await execute.mock.results[0]?.value.catch(() => undefined);
    await vi.waitFor(() => {
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({ runId: "run-log-1", leaseId: "lease-log-1" }),
        "执行失败",
      );
    });
    error.mockRestore();
  });

  it("RMC04 磁盘统计不在心跳同步路径", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(
      join(process.cwd(), "src/runtime/lifecycle.service.ts"),
      "utf8",
    );
    const beatStart = src.indexOf("private async beat()");
    const beatEnd = src.indexOf("private async", beatStart + 1);
    const beatFn = src.slice(beatStart, beatEnd);
    expect(beatFn).toMatch(/diskSample/);
    expect(beatFn).not.toMatch(/sampleProfileDisk|sampleDisk\(/);
    const { heartbeatWorker } = await import("@cairn/db");
    const svc = await buildLifecycle();
    await beat(svc);
    expect(heartbeatWorker).toHaveBeenCalled();
  });

  it("节点健康数据库 ping 短超时，会话领取会刷新 lastTick", async () => {
    const handle = stubDb();
    app = await buildApp(handle);
    let settlePing!: (value: boolean) => void;
    handle.ping = () =>
      new Promise((resolve) => {
        settlePing = resolve;
      });
    const svc = app.get(LifecycleService);
    (svc as unknown as { lastTickAt: Date }).lastTickAt = new Date(
      Date.now() - 60_000,
    );
    const started = Date.now();
    const health = await (
      svc as unknown as {
        nodeHealth: () => Promise<{
          checks: { database: string };
          node: { liveHandleCount: number };
        }>;
      }
    ).nodeHealth();
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(health.checks.database).toBe("down");
    expect(health.node.liveHandleCount).toBe(0);
    settlePing(true);
    await (
      svc as unknown as { pumpOperation: () => Promise<void> }
    ).pumpOperation();
    expect(
      Date.now() -
        (svc as unknown as { lastTickAt: Date }).lastTickAt.getTime(),
    ).toBeLessThan(1_000);
  });

  it("生产路径不向控制面发 HTTP", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(
      join(process.cwd(), "src/runtime/lifecycle.service.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/@cairn\/api|\/api\/workers|fetch\(/);
  });

  it("RJ-01 缺省角色装配全部循环与协议", async () => {
    const svc = await buildLifecycle();
    expect(svc.isRunning()).toBe(true);
    const { registerWorker } = await import("@cairn/db");
    expect(vi.mocked(registerWorker).mock.calls.at(-1)?.[1]).toEqual(
      expect.objectContaining({
        protocolCapabilities: expect.arrayContaining([
          "map-jobs@1",
          "map-scheduler@1",
        ]),
      }),
    );
  });

  it("maintenance 角色通过独立单飞周期派发服务 Webhook", async () => {
    const { deliverServiceWebhooks } = await import("./service-webhook-delivery");
    vi.mocked(deliverServiceWebhooks).mockClear();
    const svc = await buildLifecycle();
    await vi.waitFor(() => expect(deliverServiceWebhooks).toHaveBeenCalled());
    expect(vi.mocked(deliverServiceWebhooks).mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        workerId: config.CAIRN_WORKER_ID,
        instanceId: instanceIdOf(svc),
        blockedHosts: expect.any(Array),
      }),
    );
    await svc.onApplicationShutdown();
  });

  it("scheduler 角色不领取，只广告调度协议", async () => {
    const { registerWorker, claimRun } = await import("@cairn/db");
    vi.mocked(claimRun).mockClear();
    const moduleRef = await Test.createTestingModule({
      providers: [
        LifecycleService,
        { provide: DB_HANDLE, useValue: stubDb() },
        {
          provide: ExecutionEngine,
          useValue: { execute: vi.fn(async () => {}) },
        },
        {
          provide: ObjectService,
          useValue: {
            purgeExpiredObjects: vi.fn(async () => ({ purged: 0 })),
            probeStore: vi.fn(async () => ({
              ok: true,
              latencyMs: 1,
              errorClass: null,
            })),
          },
        },
        {
          provide: EvidenceSettleService,
          useValue: { settleExpired: vi.fn(async () => ({ marked: 0 })) },
        },
        { provide: BrowserSessionManager, useValue: stubSessions() },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    const svc = moduleRef.get(LifecycleService);
    svc.rolesForAssembly = {
      executor: false,
      scheduler: true,
      maintenance: false,
    };
    svc.exitProcess = vi.fn();
    await svc.onApplicationBootstrap();
    expect(svc.isRunning()).toBe(false);
    expect(
      moduleRef.get(BrowserSessionManager).reconcileOwn,
    ).not.toHaveBeenCalled();
    expect(vi.mocked(registerWorker).mock.calls.at(-1)?.[1]).toEqual(
      expect.objectContaining({
        protocolCapabilities: protocolCapabilitiesForRoles({
          executor: false,
          scheduler: true,
          maintenance: false,
        }),
      }),
    );
    expect(claimRun).not.toHaveBeenCalled();
    await svc.onApplicationShutdown();
  });

  it("scheduler 失联自愈后恢复调度循环，不退出进程", async () => {
    const { heartbeatWorker, registerWorker, materializeDueSchedules } =
      await import("@cairn/db");
    vi.mocked(materializeDueSchedules).mockClear();
    const moduleRef = await Test.createTestingModule({
      providers: [
        LifecycleService,
        { provide: DB_HANDLE, useValue: stubDb() },
        {
          provide: ExecutionEngine,
          useValue: { execute: vi.fn(async () => {}) },
        },
        {
          provide: ObjectService,
          useValue: {
            purgeExpiredObjects: vi.fn(async () => ({ purged: 0 })),
            probeStore: vi.fn(async () => ({
              ok: true,
              latencyMs: 1,
              errorClass: null,
            })),
          },
        },
        {
          provide: EvidenceSettleService,
          useValue: { settleExpired: vi.fn(async () => ({ marked: 0 })) },
        },
        { provide: BrowserSessionManager, useValue: stubSessions() },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    const svc = moduleRef.get(LifecycleService);
    svc.rolesForAssembly = {
      executor: false,
      scheduler: true,
      maintenance: false,
    };
    svc.exitProcess = vi.fn();
    await svc.onApplicationBootstrap();
    vi.mocked(registerWorker).mockClear();
    vi.mocked(heartbeatWorker).mockResolvedValueOnce("lost");
    await beat(svc);
    expect(registerWorker).toHaveBeenCalledOnce();
    expect(svc.exitProcess).not.toHaveBeenCalled();
    vi.mocked(materializeDueSchedules).mockClear();
    await (
      svc as unknown as { runScheduleTick: () => Promise<void> }
    ).runScheduleTick();
    expect(materializeDueSchedules).toHaveBeenCalled();
    await svc.onApplicationShutdown();
  });

  it("maintenance 角色写全局回收水位，不领取", async () => {
    const { touchRuntimeWatermark, claimRun } = await import("@cairn/db");
    vi.mocked(claimRun).mockClear();
    vi.mocked(touchRuntimeWatermark).mockClear();
    const moduleRef = await Test.createTestingModule({
      providers: [
        LifecycleService,
        { provide: DB_HANDLE, useValue: stubDb() },
        {
          provide: ExecutionEngine,
          useValue: { execute: vi.fn(async () => {}) },
        },
        {
          provide: ObjectService,
          useValue: {
            purgeExpiredObjects: vi.fn(async () => ({ purged: 0 })),
            probeStore: vi.fn(async () => ({
              ok: true,
              latencyMs: 1,
              errorClass: null,
            })),
          },
        },
        {
          provide: EvidenceSettleService,
          useValue: { settleExpired: vi.fn(async () => ({ marked: 0 })) },
        },
        { provide: BrowserSessionManager, useValue: stubSessions() },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    const svc = moduleRef.get(LifecycleService);
    svc.rolesForAssembly = {
      executor: false,
      scheduler: false,
      maintenance: true,
    };
    svc.exitProcess = vi.fn();
    await svc.onApplicationBootstrap();
    expect(svc.isRunning()).toBe(false);
    await (
      svc as unknown as {
        runReaper: () => Promise<{
          leasesExpired: number;
          sessionsClosed: number;
        }>;
      }
    ).runReaper();
    const { evaluateAlerts, claimNotificationDeliveries, reapSessionLeases } =
      await import("@cairn/db");
    expect(evaluateAlerts).toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(claimNotificationDeliveries).toHaveBeenCalled(),
    );
    expect(reapSessionLeases).toHaveBeenCalled();
    expect(touchRuntimeWatermark).toHaveBeenCalledWith(
      expect.anything(),
      "global_reclaim",
    );
    expect(moduleRef.get(BrowserSessionManager).reap).toHaveBeenCalledWith({
      includeGlobalLeases: false,
    });
    expect(claimRun).not.toHaveBeenCalled();
    await svc.onApplicationShutdown();
  });

  it("PS09 executor 不领平台槽位，仍写本节点样本", async () => {
    const {
      collectPlatformSamples,
      collectWorkerSamples,
      claimDuePeriodicSlots,
    } = await import("@cairn/db");
    vi.mocked(collectPlatformSamples).mockClear();
    vi.mocked(collectWorkerSamples).mockClear();
    vi.mocked(claimDuePeriodicSlots).mockClear();
    const objects = {
      purgeExpiredObjects: vi.fn(async () => ({ purged: 0 })),
      probeStore: vi.fn(async () => ({
        ok: true,
        latencyMs: 1,
        errorClass: null,
      })),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        LifecycleService,
        { provide: DB_HANDLE, useValue: stubDb() },
        {
          provide: ExecutionEngine,
          useValue: { execute: vi.fn(async () => {}) },
        },
        { provide: ObjectService, useValue: objects },
        {
          provide: EvidenceSettleService,
          useValue: { settleExpired: vi.fn(async () => ({ marked: 0 })) },
        },
        { provide: BrowserSessionManager, useValue: stubSessions() },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    const svc = moduleRef.get(LifecycleService);
    svc.rolesForAssembly = {
      executor: true,
      scheduler: false,
      maintenance: false,
    };
    svc.exitProcess = vi.fn();
    await svc.onApplicationBootstrap();
    await vi.waitFor(() => {
      expect(collectWorkerSamples).toHaveBeenCalled();
    });
    expect(collectPlatformSamples).not.toHaveBeenCalled();
    expect(claimDuePeriodicSlots).not.toHaveBeenCalled();
    expect(objects.probeStore).not.toHaveBeenCalled();
    const { insertMonitorSamples } = await import("@cairn/db");
    expect(insertMonitorSamples).toHaveBeenCalled();
    await svc.onApplicationShutdown();
  });

  it("平台样本写入在单飞槽位内完成后再 finish", async () => {
    const { collectPlatformSamples, insertMonitorSamples, finishPeriodicSlot } =
      await import("@cairn/db");
    const calls: string[] = [];
    vi.mocked(collectPlatformSamples).mockImplementation(async () => {
      calls.push("collect");
      return [{ key: "queue.recovering", scope: "platform", value: 1 }];
    });
    vi.mocked(insertMonitorSamples).mockImplementation(async () => {
      calls.push("insert");
      return 0;
    });
    vi.mocked(finishPeriodicSlot).mockImplementation(async (_db, input) => {
      if (input.name === "monitor.sample.platform") calls.push("finish");
      return true;
    });
    const moduleRef = await Test.createTestingModule({
      providers: [
        LifecycleService,
        { provide: DB_HANDLE, useValue: stubDb() },
        {
          provide: ExecutionEngine,
          useValue: { execute: vi.fn(async () => {}) },
        },
        {
          provide: ObjectService,
          useValue: {
            purgeExpiredObjects: vi.fn(async () => ({ purged: 0 })),
            probeStore: vi.fn(async () => ({
              ok: true,
              latencyMs: 1,
              errorClass: null,
            })),
          },
        },
        {
          provide: EvidenceSettleService,
          useValue: { settleExpired: vi.fn(async () => ({ marked: 0 })) },
        },
        { provide: BrowserSessionManager, useValue: stubSessions() },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    const svc = moduleRef.get(LifecycleService);
    svc.rolesForAssembly = {
      executor: false,
      scheduler: false,
      maintenance: true,
    };
    svc.exitProcess = vi.fn();
    await svc.onApplicationBootstrap();
    await vi.waitFor(() => {
      expect(calls).toContain("finish");
    });
    expect(calls.indexOf("collect")).toBeLessThan(calls.indexOf("insert"));
    expect(calls.indexOf("insert")).toBeLessThan(calls.indexOf("finish"));
    await svc.onApplicationShutdown();
  });

  it("慢通知任务单独执行，不阻塞下一轮回收与凭据维护", async () => {
    const { scanCredentialReminders, claimNotificationDeliveries } =
      await import("@cairn/db");
    const calls: string[] = [];
    vi.mocked(scanCredentialReminders).mockImplementation(async () => {
      calls.push("reminders");
      return { opened: 0, closed: 0 };
    });
    let release: () => void = () => undefined;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(claimNotificationDeliveries).mockImplementation(async () => {
      calls.push("deliver");
      await waiting;
      return [];
    });
    const moduleRef = await Test.createTestingModule({
      providers: [
        LifecycleService,
        { provide: DB_HANDLE, useValue: stubDb() },
        {
          provide: ExecutionEngine,
          useValue: { execute: vi.fn(async () => {}) },
        },
        {
          provide: ObjectService,
          useValue: {
            purgeExpiredObjects: vi.fn(async () => ({ purged: 0 })),
            probeStore: vi.fn(async () => ({
              ok: true,
              latencyMs: 1,
              errorClass: null,
            })),
          },
        },
        {
          provide: EvidenceSettleService,
          useValue: { settleExpired: vi.fn(async () => ({ marked: 0 })) },
        },
        { provide: BrowserSessionManager, useValue: stubSessions() },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    const svc = moduleRef.get(LifecycleService);
    svc.rolesForAssembly = {
      executor: false,
      scheduler: false,
      maintenance: true,
    };
    svc.exitProcess = vi.fn();
    await svc.onApplicationBootstrap();
    try {
      await vi.waitFor(() => expect(calls).toContain("deliver"));
      for (let i = 0; i < 2; i++)
        await (
          svc as unknown as { runReaper: () => Promise<unknown> }
        ).runReaper();
      expect(calls.filter((c) => c === "reminders")).toHaveLength(2);
      expect(calls.filter((c) => c === "deliver")).toHaveLength(1);
    } finally {
      release();
      await svc.onApplicationShutdown();
    }
  });

  it("PS06 一个槽位抛错不吞掉同 tick 其它扫描", async () => {
    const {
      expireRunDeadlines,
      markLostWorkers,
      evaluateAlerts,
      finishPeriodicSlot,
    } = await import("@cairn/db");
    vi.mocked(expireRunDeadlines).mockRejectedValueOnce(
      new Error("injected recovery"),
    );
    vi.mocked(markLostWorkers).mockClear();
    vi.mocked(evaluateAlerts).mockClear();
    vi.mocked(finishPeriodicSlot).mockClear();
    const moduleRef = await Test.createTestingModule({
      providers: [
        LifecycleService,
        { provide: DB_HANDLE, useValue: stubDb() },
        {
          provide: ExecutionEngine,
          useValue: { execute: vi.fn(async () => {}) },
        },
        {
          provide: ObjectService,
          useValue: {
            purgeExpiredObjects: vi.fn(async () => ({ purged: 0 })),
            probeStore: vi.fn(async () => ({
              ok: true,
              latencyMs: 1,
              errorClass: null,
            })),
          },
        },
        {
          provide: EvidenceSettleService,
          useValue: { settleExpired: vi.fn(async () => ({ marked: 0 })) },
        },
        { provide: BrowserSessionManager, useValue: stubSessions() },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    const svc = moduleRef.get(LifecycleService);
    svc.rolesForAssembly = {
      executor: false,
      scheduler: false,
      maintenance: true,
    };
    svc.exitProcess = vi.fn();
    await svc.onApplicationBootstrap();
    await (
      svc as unknown as {
        runReaper: () => Promise<{
          leasesExpired: number;
          sessionsClosed: number;
        }>;
      }
    ).runReaper();
    expect(markLostWorkers).toHaveBeenCalled();
    expect(evaluateAlerts).toHaveBeenCalled();
    expect(finishPeriodicSlot).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        name: "reaper.recovery",
        outcome: "failed",
        errorClass: "Error",
      }),
    );
    await svc.onApplicationShutdown();
  });

  it("PS06 本进程会话回收抛错不烧掉同 tick 已领取的槽位", async () => {
    const {
      markLostWorkers,
      evaluateAlerts,
      finishPeriodicSlot,
      reapServiceRequestLogs,
    } = await import("@cairn/db");
    const sessions = stubSessions();
    sessions.reap = vi.fn(async () => {
      throw new Error("injected local reap");
    });
    const moduleRef = await Test.createTestingModule({
      providers: [
        LifecycleService,
        { provide: DB_HANDLE, useValue: stubDb() },
        {
          provide: ExecutionEngine,
          useValue: { execute: vi.fn(async () => {}) },
        },
        {
          provide: ObjectService,
          useValue: {
            purgeExpiredObjects: vi.fn(async () => ({ purged: 0 })),
            probeStore: vi.fn(async () => ({
              ok: true,
              latencyMs: 1,
              errorClass: null,
            })),
          },
        },
        {
          provide: EvidenceSettleService,
          useValue: { settleExpired: vi.fn(async () => ({ marked: 0 })) },
        },
        { provide: BrowserSessionManager, useValue: sessions },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    const svc = moduleRef.get(LifecycleService);
    svc.rolesForAssembly = {
      executor: false,
      scheduler: false,
      maintenance: true,
    };
    svc.exitProcess = vi.fn();
    await svc.onApplicationBootstrap();
    vi.mocked(markLostWorkers).mockClear();
    vi.mocked(evaluateAlerts).mockClear();
    vi.mocked(reapServiceRequestLogs).mockClear();
    vi.mocked(finishPeriodicSlot).mockClear();
    await (
      svc as unknown as {
        runReaper: () => Promise<{
          leasesExpired: number;
          sessionsClosed: number;
        }>;
      }
    ).runReaper();
    expect(sessions.reap).toHaveBeenCalled();
    expect(markLostWorkers).toHaveBeenCalled();
    expect(evaluateAlerts).toHaveBeenCalled();
    expect(reapServiceRequestLogs).toHaveBeenCalled();
    const finished = vi
      .mocked(finishPeriodicSlot)
      .mock.calls.map((call) => (call[1] as { name: string }).name);
    expect(finished).toEqual(
      expect.arrayContaining([
        "reaper.recovery",
        "reaper.session_leases",
        "reaper.liveness",
        "monitor.alerts.evaluate",
        "credential.reminders",
        "service.request_logs.purge",
      ]),
    );
    await svc.onApplicationShutdown();
  });

  async function buildLifecycle(): Promise<LifecycleService> {
    const moduleRef = await Test.createTestingModule({
      providers: [
        LifecycleService,
        { provide: DB_HANDLE, useValue: stubDb() },
        {
          provide: ExecutionEngine,
          useValue: { execute: vi.fn(async () => {}) },
        },
        {
          provide: ObjectService,
          useValue: {
            purgeExpiredObjects: vi.fn(async () => ({ purged: 0 })),
            probeStore: vi.fn(async () => ({
              ok: true,
              latencyMs: 1,
              errorClass: null,
            })),
          },
        },
        {
          provide: EvidenceSettleService,
          useValue: { settleExpired: vi.fn(async () => ({ marked: 0 })) },
        },
        { provide: BrowserSessionManager, useValue: stubSessions() },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    const svc = app.get(LifecycleService);
    expect(svc.isRunning()).toBe(true);
    return svc;
  }

  /** 注入一条在途运行，返回它的 abort 探针。 */
  function injectInFlight(svc: LifecycleService): ReturnType<typeof vi.fn> {
    const abort = vi.fn();
    (
      svc as unknown as {
        inFlight: Map<
          string,
          {
            controller: { abort: () => void };
            grant: unknown;
            done: Promise<void>;
          }
        >;
      }
    ).inFlight.set("lease-1", {
      grant: {
        runId: "r1",
        leaseId: "lease-1",
        fencingToken: 1,
        holderWorkerId: "w",
        expiresAt: new Date().toISOString(),
      },
      controller: { abort },
      done: Promise.resolve(),
    });
    return abort;
  }

  function beat(svc: LifecycleService): Promise<void> {
    return (svc as unknown as { beat: () => Promise<void> }).beat();
  }

  function instanceIdOf(svc: LifecycleService): string {
    return (svc as unknown as { instanceId: string }).instanceId;
  }
});

describe("DbModule", () => {
  it("停机时关闭连接池（所有权在创建者）", async () => {
    const close = vi.fn(async () => {});
    const moduleRef = await Test.createTestingModule({ imports: [DbModule] })
      .overrideProvider(DB_HANDLE)
      .useValue(stubDb(close))
      .compile();
    const application = moduleRef.createNestApplication();
    await application.init();

    await application.close();

    expect(close).toHaveBeenCalledOnce();
  });
});
