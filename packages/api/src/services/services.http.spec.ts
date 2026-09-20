import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { JwtService } from "@nestjs/jwt";
import request from "supertest";
import { chromium } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { openIsolatedDb, type DbHandle } from "@cairn/db/testing";
import {
  RbacStore,
  TargetsStore,
  createScenarioWithVersion,
  listScenarioVersions,
  newId,
} from "@cairn/db";
import { createTargetBodySchema } from "@cairn/shared";
import { AppModule } from "../app.module";
import { DB_HANDLE } from "../db/db.module";
import { CHANGE_HINT } from "../observe/change-hint.module";
import { listenForSupertest, unusedChangeHint } from "../__tests__/http-app";
import { configureBodyParsers } from "../config/body-parsers";
import { gzipSync } from "node:zlib";
let peer: INestApplication;
let app: INestApplication,
  db: DbHandle,
  jwt: string,
  key: string,
  callerId: string,
  credentialId: string,
  targetId: string;
let body: {
  scenarioId: string;
  scenarioVersionId: string;
  targetAccountId: string;
  input: object;
  idempotencyKey: string;
};
async function waitForServiceLogs(
  id: string,
  predicate: (items: Array<Record<string, unknown>>) => boolean,
): Promise<Array<Record<string, unknown>>> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const response = await request(app.getHttpServer())
      .get(`/api/services/${id}/logs?limit=100`)
      .auth(jwt, { type: "bearer" })
      .expect(200);
    if (predicate(response.body.items)) return response.body.items;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("等待服务请求排障日志超时");
}
beforeAll(async () => {
  db = await openIsolatedDb(`service_http_${Date.now()}`);
  const rbac = new RbacStore(db, {
    hash: async (s) => s,
    verify: async (s, hash) => s === hash,
  });
  const roles = await rbac.listRoles();
  const actor = await rbac.createAccount(
    {
      email: "service-http-admin",
      displayName: "服务管理员",
      password: "test-password",
      roleIds: [roles.items.find((r) => r.key === "admin")!.id],
    },
    null,
  );
  const targets = new TargetsStore(db, () => Buffer.from("encrypted"));
  const target = await targets.createTarget(
    createTargetBodySchema.parse({
      code: "http-target",
      name: "接口测试目标",
      entryUrl: "https://example.com",
      account: {
        username: "test",
        displayName: "目标账号",
        password: "hidden-target-secret",
        validity: { mode: "permanent" },
      },
    }),
    actor,
  );
  targetId = target.id;
  const account = (await targets.listAccounts(target.id)).items[0]!;
  const scenario = await createScenarioWithVersion(db, {
    targetId,
    name: "公开测试场景",
    actor,
    steps: [
      {
        id: newId(),
        name: "echo",
        type: "echo",
        effectType: "READ_ONLY",
        input: { value: "hello" },
      },
    ],
  });
  body = {
    scenarioId: scenario.id,
    scenarioVersionId: (await listScenarioVersions(db, scenario.id)).items[0]!
      .id,
    targetAccountId: account.id,
    input: {},
    idempotencyKey: "http-retry-key",
  };
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DB_HANDLE)
    .useValue(db)
    .overrideProvider(CHANGE_HINT)
    .useValue(unusedChangeHint)
    .compile();
  app = moduleRef.createNestApplication({ logger: false });
  app.setGlobalPrefix("api", { exclude: ["health"] });
  configureBodyParsers(app);
  await listenForSupertest(app);
  const peerModule = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DB_HANDLE)
    .useValue(db)
    .overrideProvider(CHANGE_HINT)
    .useValue(unusedChangeHint)
    .compile();
  peer = peerModule.createNestApplication({ logger: false });
  peer.setGlobalPrefix("api", { exclude: ["health"] });
  configureBodyParsers(peer);
  await listenForSupertest(peer);
  jwt = await app.get(JwtService).signAsync({ sub: actor.id });
  const caller = await request(app.getHttpServer())
    .post("/api/services")
    .auth(jwt, { type: "bearer" })
    .send({ name: "接口调用方", owner: "测试", maxOutstandingRuns: 2 })
    .expect(201);
  callerId = caller.body.caller.id;
  const issued = await request(app.getHttpServer())
    .post(`/api/services/${callerId}/credentials`)
    .auth(jwt, { type: "bearer" })
    .send({
      name: "API Key",
      scopes: ["run:execute", "run:read", "run:cancel", "evidence:read"],
      grants: [{ targetId, accountIds: [account.id] }],
    })
    .expect(201);
  expect(issued.headers["cache-control"]).toBe("no-store");
  key = issued.body.token;
  credentialId = issued.body.credential.id;
});
afterAll(async () => {
  await peer?.close();
  await app?.close();
});
it("real global guards separate console JWT from service credentials and expose only declared GET/POST execution routes", async () => {
  await request(app.getHttpServer()).get("/api/open/v1/targets").expect(401);
  await request(app.getHttpServer())
    .get("/api/open/v1/targets")
    .auth(jwt, { type: "bearer" })
    .expect(401);
  for (const path of [
    "/api/me",
    "/api/rbac/roles",
    "/api/services",
    "/api/targets",
    "/api/runs",
  ]) {
    const response = await request(app.getHttpServer())
      .get(path)
      .auth(key, { type: "bearer" });
    expect(response.status).toBe(401);
    expect(JSON.stringify(response.body)).not.toContain(key);
  }
  await request(app.getHttpServer())
    .post(`/api/services/${callerId}/status`)
    .auth(key, { type: "bearer" })
    .send({ status: "disabled" })
    .expect(401);
  const targets = await request(app.getHttpServer())
    .get("/api/open/v1/targets")
    .auth(key, { type: "bearer" })
    .expect(200);
  expect(targets.body.items[0]).toMatchObject({
    id: targetId,
    accounts: [{ id: body.targetAccountId }],
  });
  expect(JSON.stringify(targets.body)).not.toMatch(
    /secret|password|loginFields|username/,
  );
  const list = await request(app.getHttpServer())
    .get(`/api/services/${callerId}`)
    .auth(jwt, { type: "bearer" })
    .expect(200);
  expect(JSON.stringify(list.body)).not.toContain(key);
  expect(JSON.stringify(list.body)).not.toContain("secretDigest");
});
it("concurrent HTTP retries create one persistent Run, keep request IDs, whitelist output and reject malformed/unbounded bodies", async () => {
  const responses = await Promise.all(
    Array.from({ length: 5 }, (_, n) =>
      request((n % 2 ? peer : app).getHttpServer())
        .post("/api/open/v1/runs")
        .auth(key, { type: "bearer" })
        .set("X-Cairn-Request-Id", `service-request-${n}`)
        .send(body),
    ),
  );
  expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
  expect(responses.every((r) => [200, 201].includes(r.status))).toBe(true);
  expect(new Set(responses.map((r) => r.body.id)).size).toBe(1);
  expect(responses[0]!.body).not.toHaveProperty("snapshot");
  expect(responses[0]!.body).not.toHaveProperty("context");
  const id = responses[0]!.body.id;
  await request(peer.getHttpServer())
    .get(`/api/open/v1/runs/${id}`)
    .auth(key, { type: "bearer" })
    .expect(200);
  await request(app.getHttpServer())
    .post("/api/open/v1/runs")
    .auth(key, { type: "bearer" })
    .send({ ...body, policy: { retries: 99 } })
    .expect(400);
  await request(app.getHttpServer())
    .post("/api/open/v1/runs")
    .auth(key, { type: "bearer" })
    .send({ ...body, input: { x: "a".repeat(65536) } })
    .expect(413);
  await request(app.getHttpServer())
    .get(`/api/open/v1/runs/${newId()}`)
    .auth(key, { type: "bearer" })
    .expect(404);
  await request(app.getHttpServer())
    .get(`/api/open/v1/runs/${id}/evidence`)
    .auth(key, { type: "bearer" })
    .expect(200, { items: [] });
  await request(app.getHttpServer())
    .post(`/api/open/v1/runs/${id}/cancel`)
    .auth(key, { type: "bearer" })
    .expect(200);
  await request(app.getHttpServer())
    .get(`/api/open/v1/runs/${id}/browser`)
    .auth(key, { type: "bearer" })
    .expect(404);
  await request(app.getHttpServer())
    .post(`/api/open/v1/runs/${id}/resume-auth`)
    .auth(key, { type: "bearer" })
    .send({})
    .expect(404);
});
it("production parsers bound raw and inflated service bodies before parsing", async () => {
  const json = JSON.stringify({ ...body, idempotencyKey: "body-boundary-key" });
  const exact = " ".repeat(65536 - Buffer.byteLength(json)) + json;
  const url = `${await app.getUrl()}/api/open/v1/runs`;
  const headers = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
  const accepted = await fetch(url, { method: "POST", headers, body: exact });
  expect(accepted.status).toBe(201);
  await accepted.arrayBuffer();
  for (const [payload, extra] of [
    [" " + exact, {}],
    [gzipSync(" " + exact), { "Content-Encoding": "gzip" }],
    [
      "input=" + "%20".repeat(30000),
      { "Content-Type": "application/x-www-form-urlencoded" },
    ],
  ] as const) {
    const response = await fetch(url, {
      method: "POST",
      headers: { ...headers, ...extra },
      body: payload,
    });
    expect(response.status).toBe(413);
    await response.arrayBuffer();
  }
});
it("keeps service Webhook secrets write-only, exports caller-scoped OpenAPI, and admits Playground runs through the service authorization path", async () => {
  const webhook = await request(app.getHttpServer())
    .post(`/api/services/${callerId}/webhook`)
    .auth(jwt, { type: "bearer" })
    .send({
      url: "https://hooks.example.test/cairn",
      events: ["run.completed", "run.failed"],
      enabled: true,
      secret: "whsec-http-test",
    })
    .expect(200);
  expect(webhook.body).toMatchObject({
    callerId,
    host: "hooks.example.test",
    secretConfigured: true,
    status: "active",
  });
  expect(JSON.stringify(webhook.body)).not.toContain("whsec-http-test");
  const readWebhook = await request(app.getHttpServer())
    .get(`/api/services/${callerId}/webhook`)
    .auth(jwt, { type: "bearer" })
    .expect(200);
  expect(readWebhook.body).not.toHaveProperty("secret");
  expect(readWebhook.body).not.toHaveProperty("secretId");
  await request(app.getHttpServer())
    .get(`/api/services/${callerId}/webhook/deliveries?limit=20`)
    .auth(jwt, { type: "bearer" })
    .expect(200)
    .expect((response) => expect(response.body.items).toEqual([]));
  const openapi = await request(app.getHttpServer())
    .get(`/api/services/${callerId}/openapi.json`)
    .auth(jwt, { type: "bearer" })
    .expect(200);
  expect(openapi.body).toMatchObject({ openapi: "3.0.3" });
  const catalog = openapi.body["x-cairn-authorized-catalog"];
  expect(catalog).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ credentialId, targetId }),
    ]),
  );
  expect(JSON.stringify(openapi.body)).not.toContain(key);

  const playgroundBody = {
    ...body,
    credentialId,
    idempotencyKey: "playground-http-001",
  };
  const accepted = await request(app.getHttpServer())
    .post(`/api/services/${callerId}/playground/runs`)
    .auth(jwt, { type: "bearer" })
    .send(playgroundBody)
    .expect(201);
  const replay = await request(app.getHttpServer())
    .post(`/api/services/${callerId}/playground/runs`)
    .auth(jwt, { type: "bearer" })
    .send(playgroundBody)
    .expect(200);
  expect(replay.body.id).toBe(accepted.body.id);
  await request(app.getHttpServer())
    .post(`/api/services/${callerId}/playground/runs`)
    .auth(jwt, { type: "bearer" })
    .send({ ...playgroundBody, credentialId: newId() })
    .expect(404);
  await request(app.getHttpServer())
    .post(`/api/services/${callerId}/runs/${accepted.body.id}/cancel`)
    .auth(jwt, { type: "bearer" })
    .expect(200);
});
it("console service governance filters safely, separates metadata, and enforces run permissions before archive", async () => {
  await request(app.getHttpServer())
    .get(
      "/api/services?includeArchived=true&status=all&sortBy=createdAt&sortOrder=desc",
    )
    .auth(jwt, { type: "bearer" })
    .expect(200);
  await request(app.getHttpServer())
    .get("/api/services?includeArchived=false")
    .auth(jwt, { type: "bearer" })
    .expect(200);
  for (const query of [
    "includeArchived=FALSE",
    "includeArchived=1",
    "includeArchived=",
    "includeArchived=true&includeArchived=false",
    "status=unknown",
    "sortBy=name",
    "unexpected=value",
  ]) {
    await request(app.getHttpServer())
      .get(`/api/services?${query}`)
      .auth(jwt, { type: "bearer" })
      .expect(400);
  }

  const managed = await request(app.getHttpServer())
    .post("/api/services")
    .auth(jwt, { type: "bearer" })
    .send({ name: "治理验收调用方", owner: "接口验收", maxOutstandingRuns: 2 })
    .expect(201);
  const managedId = managed.body.caller.id as string;
  const issued = await request(app.getHttpServer())
    .post(`/api/services/${managedId}/credentials`)
    .auth(jwt, { type: "bearer" })
    .send({
      name: "治理 Key",
      scopes: ["run:execute", "run:read", "run:cancel"],
      grants: [{ targetId, accountIds: [body.targetAccountId] }],
    })
    .expect(201);
  const managedToken = issued.body.token as string;
  const managedCredentialId = issued.body.credential.id as string;
  await request(app.getHttpServer())
    .post(
      `/api/services/${managedId}/credentials/${managedCredentialId}/rename`,
    )
    .auth(jwt, { type: "bearer" })
    .send({
      name: "生产治理 Key",
      notes: "轮换窗口：周三",
      expectedMetadataRevision: 1,
    })
    .expect(200)
    .expect((response) => {
      expect(response.body).toMatchObject({
        name: "生产治理 Key",
        notes: "轮换窗口：周三",
        revision: 1,
        metadataRevision: 2,
      });
    });
  await request(app.getHttpServer())
    .post(
      `/api/services/${managedId}/credentials/${managedCredentialId}/update`,
    )
    .auth(jwt, { type: "bearer" })
    .send({
      name: "错误的授权改名",
      scopes: ["run:execute", "run:read", "run:cancel"],
      grants: [{ targetId, accountIds: [body.targetAccountId] }],
    })
    .expect(409)
    .expect((response) =>
      expect(response.body.code).toBe("CREDENTIAL_METADATA_UPDATE_REQUIRED"),
    );

  await request(app.getHttpServer())
    .post(`/api/services/${managedId}/status`)
    .auth(jwt, { type: "bearer" })
    .send({ status: "disabled" })
    .expect(200)
    .expect((response) =>
      expect(response.body).toMatchObject({
        id: managedId,
        status: "disabled",
      }),
    );
  await request(app.getHttpServer())
    .get("/api/open/v1/targets")
    .auth(managedToken, { type: "bearer" })
    .expect(401);
  await request(app.getHttpServer())
    .post(`/api/services/${managedId}/status`)
    .auth(jwt, { type: "bearer" })
    .send({ status: "active" })
    .expect(200);
  await request(app.getHttpServer())
    .get("/api/open/v1/targets")
    .auth(managedToken, { type: "bearer" })
    .expect(200);

  const run = await request(app.getHttpServer())
    .post("/api/open/v1/runs")
    .auth(managedToken, { type: "bearer" })
    .send({ ...body, idempotencyKey: "governance-cancel-key" })
    .expect(201);
  await request(app.getHttpServer())
    .get(`/api/services/${managedId}/outstanding-runs?limit=20`)
    .auth(jwt, { type: "bearer" })
    .expect(200)
    .expect((response) => {
      expect(response.body.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: run.body.id,
            scenarioId: body.scenarioId,
            targetId,
            currentStepIndex: null,
            currentStepName: null,
            durationSeconds: expect.any(Number),
            idempotencyKey: "governance-cancel-key",
            credentialId: managedCredentialId,
            credentialName: "生产治理 Key",
            canCancel: true,
            canReview: false,
          }),
        ]),
      );
      expect(response.body).toMatchObject({
        outstandingRuns: 1,
        visibleOutstandingRuns: 1,
        observedAt: expect.any(String),
      });
    });

  const rbac = new RbacStore(db, {
    hash: async (s) => s,
    verify: async (s, hash) => s === hash,
  });
  const serviceOnlyRole = await rbac.createRole(
    {
      key: `service-only-${Date.now()}`,
      name: "仅服务查看",
      permissions: ["service:read"],
    },
    null,
  );
  const serviceOnly = await rbac.createAccount(
    {
      email: `service-only-${Date.now()}@example.test`,
      displayName: "仅服务查看",
      password: "test-password",
      roleIds: [serviceOnlyRole.id],
    },
    null,
  );
  const serviceOnlyJwt = await app
    .get(JwtService)
    .signAsync({ sub: serviceOnly.id });
  await request(app.getHttpServer())
    .get(`/api/services/${managedId}/outstanding-runs`)
    .auth(serviceOnlyJwt, { type: "bearer" })
    .expect(403);

  await request(app.getHttpServer())
    .post(`/api/services/${managedId}/archive`)
    .auth(jwt, { type: "bearer" })
    .expect(409)
    .expect((response) =>
      expect(response.body.code).toBe("SERVICE_HAS_OUTSTANDING_RUNS"),
    );
  await request(app.getHttpServer())
    .post(`/api/services/${managedId}/runs/${run.body.id}/cancel`)
    .auth(jwt, { type: "bearer" })
    .expect(200)
    .expect((response) => {
      expect(response.body).toMatchObject({
        runId: run.body.id,
        cancelRequested: true,
        occupiesServiceCapacity: false,
      });
    });
  await request(app.getHttpServer())
    .post(`/api/services/${managedId}/archive`)
    .auth(jwt, { type: "bearer" })
    .expect(200)
    .expect((response) =>
      expect(response.body.archivedAt).toEqual(expect.any(String)),
    );
  await request(app.getHttpServer())
    .get("/api/open/v1/targets")
    .auth(managedToken, { type: "bearer" })
    .expect(401);
  await request(app.getHttpServer())
    .post(`/api/services/${managedId}/credentials`)
    .auth(jwt, { type: "bearer" })
    .send({ name: "归档后 Key", scopes: ["run:execute"], grants: [] })
    .expect(409)
    .expect((response) => expect(response.body.code).toBe("SERVICE_ARCHIVED"));
  const hidden = await request(app.getHttpServer())
    .get("/api/services?includeArchived=false")
    .auth(jwt, { type: "bearer" })
    .expect(200);
  expect(
    hidden.body.items.map((item: { id: string }) => item.id),
  ).not.toContain(managedId);
  const visible = await request(app.getHttpServer())
    .get("/api/services?includeArchived=true")
    .auth(jwt, { type: "bearer" })
    .expect(200);
  expect(visible.body.items.map((item: { id: string }) => item.id)).toContain(
    managedId,
  );
});
it("records only verified service requests with safe diagnostics, source policy, and credential lifecycle facts", async () => {
  const observer = await request(app.getHttpServer())
    .post("/api/services")
    .auth(jwt, { type: "bearer" })
    .send({
      name: "排障验收调用方",
      owner: "接口验收",
      maxOutstandingRuns: 20,
      requestsPerMinute: 60,
    })
    .expect(201);
  const observerId = observer.body.caller.id as string;
  const issued = await request(app.getHttpServer())
    .post(`/api/services/${observerId}/credentials`)
    .auth(jwt, { type: "bearer" })
    .send({
      name: "排障 Key",
      scopes: ["run:execute", "run:read", "run:cancel"],
      grants: [{ targetId, accountIds: [body.targetAccountId] }],
    })
    .expect(201);
  const observerToken = issued.body.token as string;
  const observerCredentialId = issued.body.credential.id as string;

  // Default proxy policy is zero trusted hops. A client-supplied X-Forwarded-For
  // must not satisfy a whitelist that the actual loopback peer does not match.
  await request(app.getHttpServer())
    .post(`/api/services/${observerId}/ip-whitelist`)
    .auth(jwt, { type: "bearer" })
    .send({ entries: ["203.0.113.8/24"] })
    .expect(200)
    .expect((response) =>
      expect(response.body.ipWhitelist).toEqual(["203.0.113.0/24"]),
    );
  const ipDenied = await request(app.getHttpServer())
    .get("/api/open/v1/targets")
    .auth(observerToken, { type: "bearer" })
    .set("X-Forwarded-For", "203.0.113.8")
    .set("X-Cairn-Request-Id", "observability-ip-forbidden")
    .expect(403);
  expect(ipDenied.body.code).toBe("IP_FORBIDDEN");
  await request(app.getHttpServer())
    .post(`/api/services/${observerId}/ip-whitelist`)
    .auth(jwt, { type: "bearer" })
    .send({ entries: [] })
    .expect(200);

  const restricted = await request(app.getHttpServer())
    .post(`/api/services/${observerId}/credentials`)
    .auth(jwt, { type: "bearer" })
    .send({
      name: "无目标授权 Key",
      scopes: ["run:execute"],
      grants: [],
    })
    .expect(201);
  const restrictedToken = restricted.body.token as string;
  await request(app.getHttpServer())
    .post("/api/open/v1/runs")
    .auth(restrictedToken, { type: "bearer" })
    .set("X-Cairn-Request-Id", "observability-target-denied")
    .send({ ...body, idempotencyKey: "observability-target-denied" })
    .expect(403)
    .expect((response) =>
      expect(response.body.code).toBe("TARGET_SCOPE_DENIED"),
    );

  const bodySecret = "do-not-store-this-service-input-value";
  const created = await request(app.getHttpServer())
    .post("/api/open/v1/runs")
    .auth(observerToken, { type: "bearer" })
    .set("X-Cairn-Request-Id", "observability-created")
    .send({
      ...body,
      input: { privateValue: bodySecret },
      idempotencyKey: "observability-created",
    })
    .expect(201);
  expect(created.body).toHaveProperty("id");

  await request(app.getHttpServer())
    .post(
      `/api/services/${observerId}/credentials/${observerCredentialId}/suspend`,
    )
    .auth(jwt, { type: "bearer" })
    .expect(200)
    .expect((response) => expect(response.body.status).toBe("suspended"));
  await request(app.getHttpServer())
    .get("/api/open/v1/targets")
    .auth(observerToken, { type: "bearer" })
    .set("X-Cairn-Request-Id", "observability-suspended")
    .expect(401)
    .expect((response) =>
      expect(response.body.code).toBe("CREDENTIAL_SUSPENDED"),
    );
  await request(app.getHttpServer())
    .post(
      `/api/services/${observerId}/credentials/${observerCredentialId}/reactivate`,
    )
    .auth(jwt, { type: "bearer" })
    .expect(200)
    .expect((response) => expect(response.body.status).toBe("active"));

  // A malformed secret cannot create a caller-attributed diagnostic record.
  await request(app.getHttpServer())
    .get("/api/open/v1/targets")
    .auth(`cairn_sk_${observerCredentialId}.${"A".repeat(43)}`, {
      type: "bearer",
    })
    .set("X-Cairn-Request-Id", "observability-unverified")
    .expect(401);

  const logs = await waitForServiceLogs(observerId, (items) =>
    [
      "observability-ip-forbidden",
      "observability-target-denied",
      "observability-created",
      "observability-suspended",
    ].every((requestId) => items.some((item) => item.requestId === requestId)),
  );
  expect(
    logs.some((item) => item.requestId === "observability-unverified"),
  ).toBe(false);
  const forbiddenLog = logs.find(
    (item) => item.requestId === "observability-ip-forbidden",
  )!;
  expect(forbiddenLog).toMatchObject({
    method: "GET",
    statusCode: 403,
    errorCode: "IP_FORBIDDEN",
    diagnostic: { category: "network" },
  });
  expect(forbiddenLog.clientIp).not.toBe("203.0.113.8");
  const createdLog = logs.find(
    (item) => item.requestId === "observability-created",
  )!;
  expect(createdLog).toMatchObject({
    method: "POST",
    path: "/api/open/v1/runs",
    statusCode: 201,
    requestSummary: {
      scenarioId: body.scenarioId,
      scenarioVersionId: body.scenarioVersionId,
      targetAccountId: body.targetAccountId,
      idempotencyKey: "observability-created",
      inputKeys: ["privateValue"],
    },
  });
  expect(JSON.stringify(logs)).not.toContain(bodySecret);
  expect(JSON.stringify(logs)).not.toContain(observerToken);
  const detail = await request(app.getHttpServer())
    .get(`/api/services/${observerId}/logs/${createdLog.id}`)
    .auth(jwt, { type: "bearer" })
    .expect(200);
  expect(detail.body.requestSummary).toEqual(createdLog.requestSummary);
  await request(app.getHttpServer())
    .get(
      `/api/services/${observerId}/logs?statusCategory=4xx&requestId=observability-ip-forbidden`,
    )
    .auth(jwt, { type: "bearer" })
    .expect(200)
    .expect((response) => expect(response.body.items).toHaveLength(1));
  await request(app.getHttpServer())
    .get(
      `/api/services/${observerId}/credentials/${observerCredentialId}/catalog`,
    )
    .auth(jwt, { type: "bearer" })
    .expect(200)
    .expect((response) => {
      expect(response.body.credentialId).toBe(observerCredentialId);
      expect(response.body.items[0].scenarios).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            scenarioId: body.scenarioId,
            versionId: body.scenarioVersionId,
          }),
        ]),
      );
    });
});
it("rate limits include failed validation; Retry-After is returned; revocation prevents new requests", async () => {
  await request(app.getHttpServer())
    .post(`/api/services/${callerId}/update`)
    .auth(jwt, { type: "bearer" })
    .send({ name: "接口调用方", owner: "测试", requestsPerMinute: 1 })
    .expect(200);
  const limit = await request(app.getHttpServer())
    .get("/api/open/v1/targets")
    .auth(key, { type: "bearer" })
    .expect(429);
  expect(Number(limit.headers["retry-after"])).toBeGreaterThan(0);
  await request(app.getHttpServer())
    .post(`/api/services/${callerId}/credentials/${credentialId}/revoke`)
    .auth(jwt, { type: "bearer" })
    .expect(200);
  await request(app.getHttpServer())
    .get("/api/open/v1/targets")
    .auth(key, { type: "bearer" })
    .expect(401);
});

it(
  "real console UI persists caller/grants, shows a key once, rotates/revokes, and fits desktop and narrow screens",
  { timeout: 120_000 },
  async () => {
    const { spawn } = await import("node:child_process");
    const { mkdirSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const { createServer } = await import("node:net");
    const repo = resolve(__dirname, "../../../..");
    const socket = createServer().listen(0, "127.0.0.1");
    await new Promise<void>((r) => socket.once("listening", r));
    const port = (socket.address() as { port: number }).port;
    await new Promise<void>((r) => socket.close(() => r()));
    const apiPort = (app.getHttpServer().address() as { port: number }).port;
    const vite = spawn(
      process.execPath,
      [
        resolve(repo, "packages/web/node_modules/vite/bin/vite.js"),
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--strictPort",
      ],
      {
        cwd: resolve(repo, "packages/web"),
        env: {
          ...process.env,
          CAIRN_API_ORIGIN: `http://127.0.0.1:${apiPort}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const viteReady = new Promise<void>((ready, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Vite startup timeout")),
        20000,
      );
      vite.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("Vite exited"));
      });
      vite.stdout.on("data", (data) => {
        if (String(data).includes("Local:")) {
          clearTimeout(timer);
          ready();
        }
      });
    });
    const browser = await chromium.launch({ headless: true });
    const origin = `http://127.0.0.1:${port}`,
      artifacts = resolve(repo, ".run/service-access/ui");
    mkdirSync(artifacts, { recursive: true });
    try {
      await viteReady;
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
      });
      await context.addCookies([
        {
          name: "thisisjustarandomstring",
          value: JSON.stringify(jwt),
          url: origin,
        },
      ]);
      const page = await context.newPage(),
        errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      // Exercise the empty-state presentation against a deterministic empty list.
      await page.route(
        "**/api/services?*",
        (route) =>
          route.fulfill({
            status: 200,
            contentType: "application/json",
            body: '{"items":[]}',
          }),
        { times: 1 },
      );
      await page.goto(`${origin}/services`);
      await page.getByText("还没有服务调用方", { exact: true }).waitFor();
      await page.getByRole("button", { name: "新建调用方" }).focus();
      await page.keyboard.press("Enter");
      await page
        .getByLabel("应用名称", { exact: true })
        .fill("外部巡检应用 · 受控执行验收");
      await page.getByLabel("负责人", { exact: true }).fill("平台联调负责人");
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "保存", exact: true })
        .click();
      await page.getByRole("button", { name: "签发凭据", exact: true }).click();
      await page.getByLabel("凭据名称", { exact: true }).fill("巡检 Key");
      await page.getByLabel("接口测试目标", { exact: true }).check();
      await page.getByLabel("目标账号 (test)", { exact: true }).check();
      await page.screenshot({
        path: resolve(artifacts, "grants-desktop.png"),
        fullPage: true,
      });
      await page.getByRole("button", { name: "签发 Key", exact: true }).click();
      const raw = await page.getByTestId("issued-service-token").textContent();
      expect(raw).toMatch(/^cairn_sk_/);
      await page.getByRole("button", { name: "已保存，关闭" }).click();
      expect(await page.getByTestId("issued-service-token").count()).toBe(0);
      expect(
        await page.evaluate<string>("JSON.stringify(localStorage)"),
      ).not.toContain(raw!);
      await request(app.getHttpServer())
        .get("/api/open/v1/targets")
        .auth(raw!, { type: "bearer" })
        .expect(200);
      await page.getByRole("button", { name: "展示信息", exact: true }).click();
      await page
        .getByRole("dialog")
        .getByLabel("凭据名称", { exact: true })
        .fill("巡检生产 Key");
      await page
        .getByRole("dialog")
        .getByLabel("备注", { exact: true })
        .fill("生产轮换窗口");
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "保存展示信息", exact: true })
        .click();
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      await page.getByText("巡检生产 Key", { exact: true }).waitFor();
      await page.getByRole("button", { name: "编辑授权", exact: true }).click();
      await page.getByLabel("查看本应用的运行", { exact: true }).uncheck();
      await page.getByRole("button", { name: "保存授权", exact: true }).click();
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      await request(app.getHttpServer())
        .get("/api/open/v1/runs")
        .auth(raw!, { type: "bearer" })
        .expect(403);
      await page.getByRole("button", { name: "轮换", exact: true }).click();
      await page.getByRole("button", { name: "签发 Key", exact: true }).click();
      const rotated = await page
        .getByTestId("issued-service-token")
        .textContent();
      await page.getByRole("button", { name: "已保存，关闭" }).click();
      await page
        .getByRole("button", { name: "吊销", exact: true })
        .first()
        .click();
      await page
        .getByRole("alertdialog")
        .getByRole("button", { name: "吊销", exact: true })
        .click();
      await page.getByRole("alertdialog").waitFor({ state: "hidden" });
      await request(app.getHttpServer())
        .get("/api/open/v1/targets")
        .auth(raw!, { type: "bearer" })
        .expect(401);
      await request(app.getHttpServer())
        .get("/api/open/v1/targets")
        .auth(rotated!, { type: "bearer" })
        .expect(200);
      await page
        .getByRole("tab", { name: "网络安全策略", exact: true })
        .click();
      await page
        .getByRole("button", { name: "编辑白名单", exact: true })
        .click();
      await page
        .getByLabel("来源 IP/CIDR 白名单", { exact: true })
        .fill("203.0.113.8/24");
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "保存白名单", exact: true })
        .click();
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      await page.getByText("203.0.113.0/24", { exact: true }).waitFor();
      await page
        .getByRole("button", { name: "编辑白名单", exact: true })
        .click();
      await page.getByLabel("来源 IP/CIDR 白名单", { exact: true }).fill("");
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "保存白名单", exact: true })
        .click();
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      await page.getByText("未限制来源 IP", { exact: false }).waitFor();
      await page
        .getByRole("tab", { name: "调用排障日志", exact: true })
        .click();
      await page
        .getByRole("button", { name: "详情", exact: true })
        .first()
        .waitFor({ state: "visible" });
      await page
        .getByRole("button", { name: "详情", exact: true })
        .first()
        .click();
      await page.getByText("调用排障详情", { exact: true }).waitFor();
      await page.waitForTimeout(600);
      await page.screenshot({
        path: resolve(artifacts, "service-observability-desktop.png"),
        fullPage: true,
      });
      await page.getByRole("button", { name: "关闭", exact: true }).click();
      await page.getByRole("tab", { name: "概览与凭据", exact: true }).click();
      await page
        .getByRole("button", { name: "可用场景", exact: true })
        .first()
        .click();
      await page.getByText("可用场景与调用模板", { exact: true }).waitFor();
      await page
        .getByRole("button", { name: "复制 JSON 模板", exact: true })
        .first()
        .waitFor({ state: "visible" });
      await page.getByRole("button", { name: "关闭", exact: true }).click();
      await page.getByRole("button", { name: "冻结", exact: true }).click();
      await page
        .getByRole("alertdialog")
        .getByRole("button", { name: "冻结凭据", exact: true })
        .click();
      await page.getByRole("alertdialog").waitFor({ state: "hidden" });
      await request(app.getHttpServer())
        .get("/api/open/v1/targets")
        .auth(rotated!, { type: "bearer" })
        .expect(401);
      await page
        .locator("summary")
        .filter({ hasText: "已冻结、过期或已吊销的凭据" })
        .click();
      await page.getByRole("button", { name: "恢复", exact: true }).click();
      await page
        .getByRole("alertdialog")
        .getByRole("button", { name: "恢复凭据", exact: true })
        .click();
      await page.getByRole("alertdialog").waitFor({ state: "hidden" });
      await request(app.getHttpServer())
        .get("/api/open/v1/targets")
        .auth(rotated!, { type: "bearer" })
        .expect(200);
      await page
        .getByText("凭据已吊销", { exact: true })
        .waitFor({ state: "hidden" });
      await page.screenshot({
        path: resolve(artifacts, "services-desktop.png"),
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({
        path: resolve(artifacts, "services-narrow.png"),
        fullPage: true,
      });
      await page
        .getByRole("tab", { name: "调用排障日志", exact: true })
        .click();
      await page.screenshot({
        path: resolve(artifacts, "service-observability-narrow.png"),
        fullPage: true,
      });
      expect(
        await page.evaluate<boolean>(
          "document.documentElement.scrollWidth <= innerWidth",
        ),
      ).toBe(true);
      await page.getByRole("tab", { name: "概览与凭据", exact: true }).click();
      await page
        .getByRole("button", { name: "编辑调用方", exact: true })
        .click();
      await page
        .getByLabel("负责人", { exact: true })
        .fill("更新后的平台联调负责人");
      // Deliberate transport failure: verify the form preserves data and allows retry.
      await page.route(
        "**/api/services/*/update",
        (route) =>
          route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({
              code: "UNAVAILABLE",
              message: "测试：服务暂不可用",
              requestId: "test-ui-failure",
            }),
          }),
        { times: 1 },
      );
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "保存", exact: true })
        .click();
      await page
        .getByRole("alert")
        .filter({ hasText: "测试：服务暂不可用" })
        .waitFor();
      expect(
        await page.getByLabel("负责人", { exact: true }).inputValue(),
      ).toBe("更新后的平台联调负责人");
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "保存", exact: true })
        .click();
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      await page.getByRole("switch", { name: "服务状态", exact: true }).click();
      await page
        .getByRole("alertdialog")
        .getByRole("button", { name: "停用", exact: true })
        .click();
      await page.getByRole("alertdialog").waitFor({ state: "hidden" });
      await request(app.getHttpServer())
        .get("/api/open/v1/targets")
        .auth(rotated!, { type: "bearer" })
        .expect(401);
      await page.getByRole("button", { name: "归档", exact: true }).click();
      await page
        .getByRole("alertdialog")
        .getByRole("button", { name: "归档调用方", exact: true })
        .click();
      await page.getByRole("alertdialog").waitFor({ state: "hidden" });
      await page.getByText(/归档，历史运行和凭据仅供审计查看/).waitFor();
      await page.getByRole("button", { name: "吊销", exact: true }).click();
      await page
        .getByRole("alertdialog")
        .getByRole("button", { name: "吊销", exact: true })
        .click();
      await page.getByRole("alertdialog").waitFor({ state: "hidden" });
      expect(errors).toEqual([]);
      const rbac = new RbacStore(db, {
        hash: async (s) => s,
        verify: async (s, hash) => s === hash,
      });
      const viewerRole = (await rbac.listRoles()).items.find(
        (r) => r.key === "viewer",
      )!;
      const viewer = await rbac.createAccount(
        {
          email: "service-ui-viewer",
          displayName: "只读验收",
          password: "test-password",
          roleIds: [viewerRole.id],
        },
        null,
      );
      const viewerJwt = await app.get(JwtService).signAsync({ sub: viewer.id });
      await request(app.getHttpServer())
        .get("/api/services")
        .auth(viewerJwt, { type: "bearer" })
        .expect(403);
      await context.clearCookies();
      await context.addCookies([
        {
          name: "thisisjustarandomstring",
          value: JSON.stringify(viewerJwt),
          url: origin,
        },
      ]);
      await page.goto(`${origin}/services`);
      await page.waitForURL("**/403");
      expect(
        await page.getByRole("button", { name: "新建调用方" }).count(),
      ).toBe(0);
    } finally {
      await browser.close();
      vite.kill("SIGTERM");
    }
  },
);
