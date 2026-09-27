import { afterEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@cairn/db";
import {
  generateDueReports,
  materializeDueSchedules,
} from "@cairn/db";
import { BrowserSessionManager } from "../browser/session-manager.js";
import { ExecutionEngine } from "../engine/engine.js";
import { EvidenceSettleService } from "../evidence/settle.service.js";
import { ObjectService } from "../objects/object.service.js";
import { deliverNotifications } from "./notification-delivery.js";
import { dispatchExportJobs } from "./report-render.js";
import { dispatchReportAiJobs } from "./report-ai-runner.js";
import { LifecycleService } from "./lifecycle.service.js";

vi.mock("@cairn/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cairn/db")>();
  return {
    ...actual,
    expireClosedScheduleWindows: vi.fn(async () => 0),
    expireScheduledMapJobs: vi.fn(async () => 0),
    advanceDueSuiteRuns: vi.fn(async () => ({ advanced: 0 })),
    generateDueReports: vi.fn(async () => 0),
    materializeDueSchedules: vi.fn(async () => ({
      outcome: { scanned: 0, materialized: 0, skipped: 0, admitted: 0, conflicts: 0 },
      pending: [],
    })),
    listPendingScheduleAdmits: vi.fn(async () => []),
  };
});

vi.mock("./notification-delivery", () => ({
  deliverNotifications: vi.fn(async () => 0),
}));
vi.mock("./report-render", () => ({
  dispatchExportJobs: vi.fn(async () => 0),
}));
vi.mock("./report-ai-runner", () => ({
  dispatchReportAiJobs: vi.fn(async () => 0),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function lifecycle(): LifecycleService {
  const store = {} as ReturnType<ObjectService["objectStore"]>;
  return new LifecycleService(
    {} as DbHandle,
    {} as ExecutionEngine,
    { objectStore: () => store } as ObjectService,
    {} as EvidenceSettleService,
    {} as BrowserSessionManager,
  );
}

type SchedulingAccess = {
  startScheduling(): void;
  scheduleTick: NodeJS.Timeout | undefined;
};
type NotificationAccess = {
  startNotificationDispatch(): void;
};

afterEach(() => {
  vi.mocked(generateDueReports).mockReset();
  vi.mocked(generateDueReports).mockResolvedValue(0);
  vi.mocked(materializeDueSchedules).mockClear();
  vi.mocked(deliverNotifications).mockReset();
  vi.mocked(deliverNotifications).mockResolvedValue(0);
  vi.mocked(dispatchExportJobs).mockClear();
  vi.mocked(dispatchReportAiJobs).mockClear();
});

describe("LifecycleService 领域周期隔离", () => {
  it("报表生成悬挂时仍物化到期调度", async () => {
    const reports = deferred<Awaited<ReturnType<typeof generateDueReports>>>();
    vi.mocked(generateDueReports).mockImplementation(() => reports.promise);
    const service = lifecycle();
    const scheduling = service as unknown as SchedulingAccess;
    try {
      scheduling.startScheduling();
      await vi.waitFor(() => expect(generateDueReports).toHaveBeenCalled());
      await vi.waitFor(() => expect(materializeDueSchedules).toHaveBeenCalled());
    } finally {
      if (scheduling.scheduleTick) clearInterval(scheduling.scheduleTick);
      reports.resolve(0);
    }
  });

  it("通知与导出悬挂时仍启动报告 AI", async () => {
    const delivery = deferred<Awaited<ReturnType<typeof deliverNotifications>>>();
    const exports = deferred<Awaited<ReturnType<typeof dispatchExportJobs>>>();
    vi.mocked(deliverNotifications).mockImplementation(() => delivery.promise);
    vi.mocked(dispatchExportJobs).mockImplementation(() => exports.promise);
    const service = lifecycle();
    try {
      (service as unknown as NotificationAccess).startNotificationDispatch();
      await vi.waitFor(() => expect(deliverNotifications).toHaveBeenCalled());
      await vi.waitFor(() => expect(dispatchExportJobs).toHaveBeenCalled());
      await vi.waitFor(() => expect(dispatchReportAiJobs).toHaveBeenCalled());
    } finally {
      delivery.resolve(0);
      exports.resolve(0);
    }
  });
});
