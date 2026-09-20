import {
  claimDuePeriodicSlots,
  finishPeriodicSlot,
  type DbHandle,
  type PeriodicSlotClaim,
  type PeriodicSlotRequest,
  type PeriodicSlotSkip,
} from "@cairn/db";
import {
  REAPER_PERIODIC_SLOT_ORDER,
  type PeriodicSlotName,
} from "@cairn/shared";

export function reaperPeriodicSlotRequests(input: {
  owner: string;
  reaperIntervalMs: number;
  reminderIntervalMs: number;
  serviceRequestLogPurgeIntervalMs: number;
  leaseTtlMs: number;
}): PeriodicSlotRequest[] {
  return [
    {
      name: "reaper.recovery",
      mode: "throttle",
      intervalMs: input.reaperIntervalMs,
      owner: input.owner,
    },
    {
      name: "reaper.session_leases",
      mode: "throttle",
      intervalMs: input.reaperIntervalMs,
      owner: input.owner,
    },
    {
      name: "reaper.liveness",
      mode: "throttle",
      intervalMs: input.reaperIntervalMs,
      owner: input.owner,
    },
    {
      name: "monitor.alerts.evaluate",
      mode: "single_flight",
      intervalMs: input.reaperIntervalMs,
      leaseTtlMs: input.leaseTtlMs,
      owner: input.owner,
    },
    {
      name: "credential.reminders",
      mode: "throttle",
      intervalMs: input.reminderIntervalMs,
      owner: input.owner,
    },
    {
      name: "service.request_logs.purge",
      mode: "throttle",
      intervalMs: input.serviceRequestLogPurgeIntervalMs,
      owner: input.owner,
    },
    {
      name: "monitor.alerts.deliver",
      mode: "throttle",
      intervalMs: input.reaperIntervalMs,
      owner: input.owner,
    },
    {
      name: "service.webhooks.deliver",
      mode: "throttle",
      intervalMs: input.reaperIntervalMs,
      owner: input.owner,
    },
  ];
}

export function samplePeriodicSlotRequests(input: {
  owner: string;
  sampleIntervalMs: number;
  purgeIntervalMs: number;
  leaseTtlMs: number;
}): PeriodicSlotRequest[] {
  return [
    {
      name: "monitor.sample.platform",
      mode: "single_flight",
      intervalMs: input.sampleIntervalMs,
      leaseTtlMs: input.leaseTtlMs,
      owner: input.owner,
    },
    {
      name: "monitor.sample.purge",
      mode: "single_flight",
      intervalMs: input.purgeIntervalMs,
      leaseTtlMs: input.leaseTtlMs,
      owner: input.owner,
    },
  ];
}

export function probePeriodicSlotRequests(input: {
  owner: string;
  probeIntervalMs: number;
  leaseTtlMs: number;
}): PeriodicSlotRequest[] {
  return [
    {
      name: "monitor.objectstore.probe",
      mode: "single_flight",
      intervalMs: input.probeIntervalMs,
      leaseTtlMs: input.leaseTtlMs,
      owner: input.owner,
    },
  ];
}

export async function claimWorkerPeriodicSlots(
  db: DbHandle,
  requests: PeriodicSlotRequest[],
): Promise<{ claimed: PeriodicSlotClaim[]; skipped: PeriodicSlotSkip[] }> {
  return claimDuePeriodicSlots(db, requests);
}

export function sortReaperClaims(
  claimed: PeriodicSlotClaim[],
): PeriodicSlotClaim[] {
  const rank = new Map<PeriodicSlotName, number>(
    REAPER_PERIODIC_SLOT_ORDER.map((name, index) => [name, index]),
  );
  return [...claimed].sort(
    (a, b) => (rank.get(a.name) ?? 99) - (rank.get(b.name) ?? 99),
  );
}

export async function finishWorkerPeriodicSlot(
  db: DbHandle,
  claim: PeriodicSlotClaim,
  input: {
    outcome: "ok" | "failed";
    errorClass?: string | null;
    failureRetryMs: number;
  },
): Promise<boolean> {
  return finishPeriodicSlot(db, {
    name: claim.name,
    claimSeq: claim.claimSeq,
    outcome: input.outcome,
    errorClass: input.errorClass,
    failureRetryMs: input.failureRetryMs,
  });
}

export async function drainWhileFull(
  budgetMs: number,
  limit: number,
  fn: () => Promise<{ scanned: number }>,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  do {
    const result = await fn();
    if (result.scanned < limit) return true;
  } while (Date.now() < deadline);
  return false;
}

export function periodicSlotErrorClass(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string"
  ) {
    return String((error as { code: string }).code).slice(0, 64);
  }
  if (error instanceof Error && error.name) return error.name.slice(0, 64);
  return "Error";
}

export function slotOwner(workerId: string): string {
  return `worker:${workerId}`;
}

export function isReaperSlot(name: PeriodicSlotName): boolean {
  return (REAPER_PERIODIC_SLOT_ORDER as readonly string[]).includes(name);
}
