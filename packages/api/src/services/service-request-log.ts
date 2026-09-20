import type {
  ServiceRequestLogDiagnostic,
  ServiceRequestSummary,
} from "@cairn/shared";
import type { Request } from "express";
import type { ServicePrincipal } from "@cairn/shared";

export type ServiceRequestLogContext = {
  callerId: string;
  credentialId: string;
  clientIp: string | null;
};
export type ServiceRequestOutcome = {
  errorCode: string;
  errorMessage: string;
  diagnostic: ServiceRequestLogDiagnostic | null;
};

declare module "express" {
  interface Request {
    servicePrincipal?: ServicePrincipal;
    serviceRequestLog?: ServiceRequestLogContext;
    serviceRequestOutcome?: ServiceRequestOutcome;
    serviceRequestStartedAt?: number;
  }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const text = (value: unknown, max: number) =>
  typeof value === "string" && value.length > 0 && value.length <= max
    ? value
    : undefined;
const identifier = (value: unknown) => {
  const candidate = text(value, 36);
  return candidate && uuid.test(candidate) ? candidate : undefined;
};

function publicPath(req: Request): string | null {
  try {
    const path = new URL(req.originalUrl || req.url, "http://cairn.local")
      .pathname;
    return /^\/api\/open\/v1(?:\/|$)/.test(path) && path.length <= 255
      ? path
      : null;
  } catch {
    return null;
  }
}

/** Only records identifiers and input keys for the one body-bearing open API route. */
export function serviceRequestSummaryFromRequest(
  req: Request,
): ServiceRequestSummary {
  if (req.method !== "POST" || publicPath(req) !== "/api/open/v1/runs")
    return null;
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  const summary: NonNullable<ServiceRequestSummary> = {};
  const scenarioId = identifier(value.scenarioId);
  const scenarioVersionId = identifier(value.scenarioVersionId);
  const targetAccountId =
    value.targetAccountId === null ? null : identifier(value.targetAccountId);
  const idempotencyKey = text(value.idempotencyKey, 128);
  if (scenarioId) summary.scenarioId = scenarioId;
  if (scenarioVersionId) summary.scenarioVersionId = scenarioVersionId;
  if (targetAccountId !== undefined) summary.targetAccountId = targetAccountId;
  if (idempotencyKey) summary.idempotencyKey = idempotencyKey;
  if (
    value.input &&
    typeof value.input === "object" &&
    !Array.isArray(value.input)
  ) {
    summary.inputKeys = Object.keys(value.input)
      .filter((key) => key.length > 0 && key.length <= 128)
      .slice(0, 64);
  }
  return Object.keys(summary).length ? summary : null;
}

const outcomeMessages: Record<
  string,
  { category: ServiceRequestLogDiagnostic["category"]; message: string }
> = {
  CREDENTIAL_SUSPENDED: { category: "credential", message: "服务凭据已被冻结" },
  IP_FORBIDDEN: {
    category: "network",
    message: "请求来源 IP 不在调用方白名单中",
  },
  SERVICE_SCOPE_DENIED: {
    category: "authorization",
    message: "服务凭据缺少所需权限",
  },
  TARGET_SCOPE_DENIED: {
    category: "authorization",
    message: "凭据未获授权访问该目标系统",
  },
  ACCOUNT_SCOPE_DENIED: {
    category: "authorization",
    message: "凭据未获授权访问该目标账号",
  },
  SERVICE_RATE_LIMIT: {
    category: "rate_limit",
    message: "调用频率超过配置限制",
  },
  SERVICE_RUN_CAPACITY: {
    category: "rate_limit",
    message: "未结束运行数已达到调用方上限",
  },
  RUN_IDEMPOTENCY_CONFLICT: {
    category: "request",
    message: "幂等键对应的请求内容不一致",
  },
  SCENARIO_VERSION_NOT_PUBLISHED: {
    category: "request",
    message: "只能调用已发布场景版本",
  },
  SCENARIO_NOT_FOUND: { category: "request", message: "场景或版本不存在" },
  PAYLOAD_TOO_LARGE: { category: "request", message: "请求体超过大小限制" },
  VALIDATION_ERROR: { category: "request", message: "请求不符合接口契约" },
};

function safeCode(code: unknown, statusCode: number): string {
  return typeof code === "string" &&
    /^[A-Z0-9_]{1,128}$/.test(code) &&
    Object.hasOwn(outcomeMessages, code)
    ? code
    : `HTTP_${statusCode}`;
}

function retryAfter(details: unknown): number | undefined {
  if (!details || typeof details !== "object" || !("retryAfter" in details))
    return undefined;
  const value = Number((details as { retryAfter?: unknown }).retryAfter);
  return Number.isInteger(value) && value > 0 && value <= 86_400
    ? value
    : undefined;
}

/** Maps HTTP failures to a stable, non-secret diagnostic record. */
export function serviceRequestOutcomeFor(
  code: unknown,
  statusCode: number,
  details?: unknown,
): ServiceRequestOutcome {
  const errorCode = safeCode(code, statusCode);
  const mapped = outcomeMessages[errorCode];
  const retry = retryAfter(details);
  return {
    errorCode,
    errorMessage:
      mapped?.message ??
      (statusCode >= 500 ? "服务端未能完成请求" : "请求未被接受"),
    diagnostic: {
      category:
        mapped?.category ?? (statusCode >= 500 ? "internal" : "request"),
      ...(retry ? { retryAfter: retry } : {}),
    },
  };
}

export function setServiceRequestFailure(
  req: Request,
  code: unknown,
  statusCode: number,
  details?: unknown,
): void {
  if (!req.serviceRequestLog) return;
  req.serviceRequestOutcome = serviceRequestOutcomeFor(
    code,
    statusCode,
    details,
  );
}

export function serviceRequestPath(req: Request): string | null {
  return publicPath(req);
}
