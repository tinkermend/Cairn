import { describe, expect, it, vi } from "vitest";
import { SingleFlightTasks } from "./single-flight-tasks.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("SingleFlightTasks", () => {
  it("starts other job types while one is pending, but does not overlap the same type", async () => {
    const tasks = new SingleFlightTasks<"reports" | "schedules">();
    const reports = deferred();
    const runReports = vi.fn(() => reports.promise);
    const runSchedules = vi.fn(async () => undefined);
    const onError = vi.fn();

    expect(tasks.start("reports", runReports, onError)).toBe(true);
    expect(tasks.start("reports", runReports, onError)).toBe(false);
    expect(tasks.start("schedules", runSchedules, onError)).toBe(true);
    await Promise.resolve();
    expect(runReports).toHaveBeenCalledTimes(1);
    expect(runSchedules).toHaveBeenCalledTimes(1);

    // A completed schedule pass can run again even while report generation is stuck.
    await vi.waitFor(() => expect(tasks.start("schedules", runSchedules, onError)).toBe(true));
    await vi.waitFor(() => expect(runSchedules).toHaveBeenCalledTimes(2));

    reports.resolve();
    await tasks.close();
    expect(onError).not.toHaveBeenCalled();
  });

  it("contains a failed job and permits that job type on the next tick", async () => {
    const tasks = new SingleFlightTasks<"outbound" | "exports">();
    const error = new Error("delivery unavailable");
    const onError = vi.fn();
    const exportDone = deferred();
    const runExports = vi.fn(() => exportDone.promise);
    const runOutbound = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined);

    expect(tasks.start("outbound", runOutbound, onError)).toBe(true);
    expect(tasks.start("exports", runExports, onError)).toBe(true);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(error));
    expect(runExports).toHaveBeenCalledTimes(1);
    expect(tasks.start("outbound", runOutbound, onError)).toBe(true);
    await vi.waitFor(() => expect(runOutbound).toHaveBeenCalledTimes(2));

    exportDone.resolve();
    await tasks.close();
  });

  it("reports synchronous failures without blocking an unrelated job", async () => {
    const tasks = new SingleFlightTasks<"reports" | "outbound">();
    const error = new Error("report failed");
    const onError = vi.fn();
    const runOutbound = vi.fn(async () => undefined);
    tasks.start("reports", () => { throw error; }, onError);
    tasks.start("outbound", runOutbound, onError);
    await tasks.close();
    expect(onError).toHaveBeenCalledWith(error);
    expect(runOutbound).toHaveBeenCalledTimes(1);
  });

  it("waits for all jobs during close and rejects later starts", async () => {
    const tasks = new SingleFlightTasks<"outbound" | "exports">();
    const outbound = deferred();
    const exports = deferred();
    const onError = vi.fn();
    tasks.start("outbound", () => outbound.promise, onError);
    tasks.start("exports", () => exports.promise, onError);

    let closed = false;
    const closing = tasks.close().then(() => { closed = true; });
    expect(tasks.start("outbound", vi.fn(), onError)).toBe(false);
    outbound.resolve();
    await Promise.resolve();
    expect(closed).toBe(false);
    exports.resolve();
    await closing;
    expect(closed).toBe(true);
    expect(tasks.start("exports", vi.fn(), onError)).toBe(false);
  });
});
