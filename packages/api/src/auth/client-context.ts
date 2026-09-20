import type { AuditClient, AuditClientKind } from "@cairn/shared";
import { AUDIT_USER_AGENT_MAX, normalizeIpAddress } from "@cairn/shared";

export type RequestLike = {
  ip?: string;
  socket?: { remoteAddress?: string | null };
  headers: Record<string, string | string[] | undefined>;
};

function header(req: RequestLike, name: string): string | undefined {
  const value = req.headers[name] ?? req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

export function normalizeClientIp(
  raw: string | undefined | null,
): string | null {
  return normalizeIpAddress(raw);
}

export function clientContextFromRequest(
  req: RequestLike,
  hops = 0,
): AuditClient {
  const ip =
    hops > 0
      ? normalizeClientIp(req.ip)
      : normalizeClientIp(req.socket?.remoteAddress ?? undefined);
  const userAgent = header(req, "user-agent");
  const origin = header(req, "origin");
  const kind: AuditClientKind = origin?.startsWith("chrome-extension://")
    ? "extension"
    : "web";
  return {
    ip,
    userAgent: userAgent ? userAgent.slice(0, AUDIT_USER_AGENT_MAX) : null,
    kind,
  };
}
