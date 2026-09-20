import { Injectable, Logger, type NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import type { ServiceRequestLogRecord } from "@cairn/shared";
import { ServicesService } from "./services.service";
import {
  serviceRequestOutcomeFor,
  serviceRequestPath,
  serviceRequestSummaryFromRequest,
} from "./service-request-log";

@Injectable()
export class ServiceRequestLogMiddleware implements NestMiddleware {
  private readonly logger = new Logger(ServiceRequestLogMiddleware.name);

  constructor(private readonly services: ServicesService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    req.serviceRequestStartedAt = Date.now();
    res.once("finish", () => {
      const context = req.serviceRequestLog;
      const path = serviceRequestPath(req);
      const requestId = req.requestId;
      if (
        !context ||
        !path ||
        !requestId ||
        (req.method !== "GET" && req.method !== "POST")
      )
        return;
      const statusCode =
        res.statusCode >= 100 && res.statusCode <= 599 ? res.statusCode : 500;
      const method = req.method === "POST" ? "POST" : "GET";
      const failed = statusCode < 200 || statusCode >= 300;
      const outcome = failed
        ? (req.serviceRequestOutcome ??
          serviceRequestOutcomeFor(undefined, statusCode))
        : undefined;
      const record: ServiceRequestLogRecord = {
        callerId: context.callerId,
        credentialId: context.credentialId,
        requestId,
        method,
        path,
        statusCode,
        latencyMs: Math.min(
          86_400_000,
          Math.max(0, Date.now() - (req.serviceRequestStartedAt ?? Date.now())),
        ),
        clientIp: context.clientIp,
        errorCode: outcome?.errorCode ?? null,
        errorMessage: outcome?.errorMessage ?? null,
        diagnostic: outcome?.diagnostic ?? null,
        requestSummary: serviceRequestSummaryFromRequest(req),
      };
      void this.services.recordRequestLog(record).catch(() => {
        // A write failure must not turn a completed open API response into a retry or
        // leak its request body through the process log.
        this.logger.warn(
          {
            requestId,
            serviceCallerId: context.callerId,
            serviceCredentialId: context.credentialId,
          },
          "服务请求排障日志写入失败",
        );
      });
    });
    next();
  }
}
