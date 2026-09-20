import { describe, expect, it, vi } from "vitest";
import {
  drainWhileFull,
  periodicSlotErrorClass,
  reaperPeriodicSlotRequests,
  slotOwner,
  sortReaperClaims,
} from "./periodic-slots.js";

describe("周期槽位辅助", () => {
  it("排空在未打满或预算用尽时停止", async () => {
    const scans = [50, 50, 20];
    const fn = vi.fn(async () => ({ scanned: scans.shift() ?? 0 }));
    expect(await drainWhileFull(5_000, 50, fn)).toBe(true);
    expect(fn).toHaveBeenCalledTimes(3);

    const full = vi.fn(async () => ({ scanned: 50 }));
    expect(await drainWhileFull(0, 50, full)).toBe(false);
    expect(full).toHaveBeenCalledTimes(1);

    let remaining = 300;
    const drain300 = vi.fn(async () => {
      const scanned = Math.min(50, remaining);
      remaining -= scanned;
      return { scanned };
    });
    expect(await drainWhileFull(5_000, 50, drain300)).toBe(true);
    expect(drain300).toHaveBeenCalledTimes(7);
  });

  it("同 tick 回收先于告警投递", () => {
    expect(
      sortReaperClaims([
        {
          name: "monitor.alerts.deliver",
          mode: "throttle",
          claimSeq: 1,
          intervalMs: 15_000,
        },
        {
          name: "reaper.recovery",
          mode: "throttle",
          claimSeq: 2,
          intervalMs: 15_000,
        },
        {
          name: "credential.reminders",
          mode: "throttle",
          claimSeq: 3,
          intervalMs: 15_000,
        },
        {
          name: "monitor.alerts.evaluate",
          mode: "single_flight",
          claimSeq: 4,
          intervalMs: 15_000,
        },
        {
          name: "service.request_logs.purge",
          mode: "throttle",
          claimSeq: 5,
          intervalMs: 86_400_000,
        },
        {
          name: "service.webhooks.deliver",
          mode: "throttle",
          claimSeq: 6,
          intervalMs: 15_000,
        },
      ]).map((item) => item.name),
    ).toEqual([
      "reaper.recovery",
      "monitor.alerts.evaluate",
      "credential.reminders",
      "service.request_logs.purge",
      "service.webhooks.deliver",
      "monitor.alerts.deliver",
    ]);
  });

  it("uses an independent daily persisted slot for request-log retention", () => {
    expect(
      reaperPeriodicSlotRequests({
        owner: "worker:test",
        reaperIntervalMs: 15_000,
        reminderIntervalMs: 60_000,
        serviceRequestLogPurgeIntervalMs: 86_400_000,
        leaseTtlMs: 30_000,
      }).find((request) => request.name === "service.request_logs.purge"),
    ).toEqual({
      name: "service.request_logs.purge",
      mode: "throttle",
      intervalMs: 86_400_000,
      owner: "worker:test",
    });
  });

  it("uses an independent persisted throttle slot for service Webhook delivery", () => {
    expect(
      reaperPeriodicSlotRequests({
        owner: "worker:test",
        reaperIntervalMs: 15_000,
        reminderIntervalMs: 60_000,
        serviceRequestLogPurgeIntervalMs: 86_400_000,
        leaseTtlMs: 30_000,
      }).find((request) => request.name === "service.webhooks.deliver"),
    ).toEqual({
      name: "service.webhooks.deliver",
      mode: "throttle",
      intervalMs: 15_000,
      owner: "worker:test",
    });
  });

  it("错误类别不带消息", () => {
    expect(
      periodicSlotErrorClass(
        Object.assign(new Error("secret=1"), { code: "SLOT_FAIL" }),
      ),
    ).toBe("SLOT_FAIL");
    expect(periodicSlotErrorClass(new TypeError("x"))).toBe("TypeError");
    expect(slotOwner("w1")).toBe("worker:w1");
  });
});
