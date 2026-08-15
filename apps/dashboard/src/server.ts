import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ControlPlane,
  openControlPlaneDatabase,
  type RuntimeHealth,
} from "../../../packages/control-plane/src/index.ts";
import {
  parseRuntimeConfig,
  readBoundedRegularText,
  resolveProjectStatePaths,
} from "../../../packages/runtime/src/index.ts";

const PUBLIC_DIRECTORY = fileURLToPath(new URL("../public/", import.meta.url));
const MAX_BODY_BYTES = 128 * 1024;

interface DashboardOptions {
  target: string;
  port?: number;
  open?: boolean;
  quiet?: boolean;
}

export interface DashboardServer {
  url: string;
  close(): Promise<void>;
}

function send(
  response: ServerResponse,
  status: number,
  body: string | Buffer,
  contentType: string,
  extraHeaders: Record<string, string> = {},
): void {
  response.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
    "content-security-policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    ...extraHeaders,
  });
  response.end(body);
}

function json(
  response: ServerResponse,
  status: number,
  value: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  send(
    response,
    status,
    JSON.stringify(value),
    "application/json; charset=utf-8",
    extraHeaders,
  );
}

interface RateBucket {
  count: number;
  resetAt: number;
}

function allowRate(
  buckets: Map<string, RateBucket>,
  key: string,
  limit: number,
  windowMs: number,
): { allowed: boolean; retryAfter: number } {
  const timestamp = Date.now();
  const current = buckets.get(key);
  const bucket =
    !current || current.resetAt <= timestamp
      ? { count: 0, resetAt: timestamp + windowMs }
      : current;
  bucket.count += 1;
  buckets.set(key, bucket);
  return {
    allowed: bucket.count <= limit,
    retryAfter: Math.max(1, Math.ceil((bucket.resetAt - timestamp) / 1000)),
  };
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error("REQUEST_TOO_LARGE");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("INVALID_JSON_OBJECT");
  }
  return value as Record<string, unknown>;
}

function runtimeHealth(target: string): RuntimeHealth[] {
  const runtimePath = resolveProjectStatePaths(target).runtime;
  if (!existsSync(runtimePath)) {
    return [
      {
        id: "primary-model",
        kind: "model_engine",
        status: "configuration_required",
        detail: "Run the bootstrap command to configure a model engine.",
      },
      {
        id: "local-runner",
        kind: "managed_runner",
        status: "configuration_required",
        detail: "A model engine is required before work can run.",
      },
    ];
  }

  try {
    const config = parseRuntimeConfig(readBoundedRegularText(runtimePath));
    const engines: RuntimeHealth[] = config.modelEngines.map((engine) => {
      const requiresKey = Boolean(engine.apiKeyEnv);
      const keyReady = !engine.apiKeyEnv || Boolean(process.env[engine.apiKeyEnv]);
      return {
        id: engine.id ?? "unnamed-engine",
        kind: "model_engine",
        status: keyReady ? "ready" : "configuration_required",
        detail: keyReady
          ? `${engine.adapter ?? "unknown"} adapter ready${requiresKey ? "; credential found in environment" : ""}.`
          : `Set the configured credential environment variable before live use.`,
      };
    });
    const engineReady = engines.some(({ status }) => status === "ready");
    const runners: RuntimeHealth[] = config.managedRunners.map((runner) => ({
      id: runner.id ?? "unnamed-runner",
      kind: "managed_runner",
      status: engineReady ? "ready" : "configuration_required",
      detail: engineReady
        ? `Bound to ${runner.modelEngineRef ?? "a configured model engine"}.`
        : "Waiting for a ready model engine.",
    }));
    return [...engines, ...runners];
  } catch {
    return [
      {
        id: "runtime-config",
        kind: "model_engine",
        status: "configuration_required",
        detail: "runtime.json does not satisfy the runtime schema.",
      },
    ];
  }
}

function safeMessage(error: unknown): string {
  if (!(error instanceof Error)) return "The command failed.";
  if (error.message === "REQUEST_TOO_LARGE") return "Request body is too large.";
  if (error.message === "INVALID_JSON_OBJECT") return "A JSON object is required.";
  if (error instanceof SyntaxError) return "Request body is not valid JSON.";
  if (/^[\w .,'():-]{1,300}$/u.test(error.message)) return error.message;
  return "The command failed.";
}

export async function startDashboard(
  options: DashboardOptions,
): Promise<DashboardServer> {
  const paths = resolveProjectStatePaths(options.target, {
    requireInitialized: true,
  });
  const target = paths.projectRoot;
  const stateDirectory = paths.root;

  const database = openControlPlaneDatabase(paths.database);
  let budgets:
    | {
        monthlyCostLimitUsd: number;
        maxConcurrentRuns: number;
        maxDailyModelStarts: number;
        unknownCostPolicy?: "block" | "warn" | "estimate";
        maxArtifactBytes?: number;
        maxWorkItemArtifactBytes?: number;
      }
    | undefined;
  try {
    const organization = JSON.parse(
      readBoundedRegularText(paths.organization),
    ) as { spec?: { budgets?: typeof budgets } };
    budgets = organization.spec?.budgets;
  } catch {
    // The dashboard remains available so the user can diagnose configuration.
  }
  const controlPlane = new ControlPlane(
    database,
    paths.artifacts,
    { budgets },
  );
  controlPlane.recoverExpiredLeases("system:dashboard-start");
  const sessionToken = randomBytes(32).toString("base64url");
  const rateBuckets = new Map<string, RateBucket>();
  let port = options.port ?? 4173;

  const server = createServer(async (request, response) => {
    const host = request.headers.host ?? "";
    const allowedHosts = new Set([
      `127.0.0.1:${port}`,
      `localhost:${port}`,
      `[::1]:${port}`,
    ]);
    if (!allowedHosts.has(host)) {
      json(response, 400, { error: "Invalid Host header." });
      return;
    }

    const url = new URL(request.url ?? "/", `http://${host}`);
    const method = request.method ?? "GET";
    const isApi = url.pathname.startsWith("/api/");
    const isMutation = !["GET", "HEAD", "OPTIONS"].includes(method);
    if (
      isApi &&
      request.headers["x-chartermesh-session"] !== sessionToken
    ) {
      json(response, 403, { error: "Invalid dashboard session." });
      return;
    }
    if (isApi) {
      const remote = request.socket.remoteAddress ?? "loopback";
      const checks = [
        allowRate(rateBuckets, `${remote}:api`, 120, 60_000),
        ...(isMutation
          ? [allowRate(rateBuckets, `${remote}:mutation`, 30, 60_000)]
          : []),
        ...(isMutation && url.pathname.endsWith("/run")
          ? [allowRate(rateBuckets, `${remote}:run`, 6, 60_000)]
          : []),
      ];
      const denied = checks.find(({ allowed }) => !allowed);
      if (denied) {
        json(
          response,
          429,
          { error: "Dashboard request rate limit exceeded." },
          { "retry-after": String(denied.retryAfter) },
        );
        return;
      }
    }
    if (isMutation) {
      const allowedOrigins = new Set([
        `http://127.0.0.1:${port}`,
        `http://localhost:${port}`,
        `http://[::1]:${port}`,
      ]);
      if (!allowedOrigins.has(request.headers.origin ?? "")) {
        json(response, 403, { error: "Invalid mutation origin." });
        return;
      }
      if (
        !String(request.headers["content-type"] ?? "")
          .toLowerCase()
          .startsWith("application/json")
      ) {
        json(response, 415, { error: "Mutations require application/json." });
        return;
      }
    }

    try {
      if (method === "GET" && url.pathname === "/api/dashboard") {
        const requestedLimit = Number(url.searchParams.get("limit") ?? 200);
        json(
          response,
          200,
          controlPlane.dashboard({
            cursor: url.searchParams.get("cursor") ?? undefined,
            limit: Number.isFinite(requestedLimit)
              ? requestedLimit
              : 200,
          }),
        );
        return;
      }
      if (method === "GET" && url.pathname === "/api/runtime") {
        json(response, 200, runtimeHealth(target));
        return;
      }
      const workMatch = url.pathname.match(/^\/api\/work-items\/([^/]+)$/u);
      if (method === "GET" && workMatch) {
        json(response, 200, controlPlane.get(decodeURIComponent(workMatch[1])));
        return;
      }
      const toolEvidenceMatch = url.pathname.match(
        /^\/api\/work-items\/([^/]+)\/tool-evidence$/u,
      );
      if (method === "GET" && toolEvidenceMatch) {
        const id = decodeURIComponent(toolEvidenceMatch[1]);
        const pendingToolCalls = controlPlane
          .listPendingToolCalls(id)
          .map((pending) => ({
            ...pending,
            approved: controlPlane.isToolCallApproved(
              id,
              pending.callHash,
              pending.toolName,
            ),
          }));
        json(response, 200, {
          items: controlPlane.listToolEvidence(id),
          pendingToolCalls,
        });
        return;
      }
      const reviewDecisionMatch = url.pathname.match(
        /^\/api\/work-items\/([^/]+)\/review-decision$/u,
      );
      if (method === "GET" && reviewDecisionMatch) {
        json(
          response,
          200,
          controlPlane.latestArtifactDecision(
            decodeURIComponent(reviewDecisionMatch[1]),
          ),
        );
        return;
      }
      const decisionPacketMatch = url.pathname.match(
        /^\/api\/work-items\/([^/]+)\/decision-packet$/u,
      );
      if (method === "GET" && decisionPacketMatch) {
        const packet = controlPlane.decisionPacket(
          decodeURIComponent(decisionPacketMatch[1]),
        );
        if (!packet) {
          json(response, 404, { error: "No current decision packet exists." });
          return;
        }
        json(response, 200, packet);
        return;
      }
      if (method === "POST" && url.pathname === "/api/work-items") {
        const body = await readJson(request);
        const title = typeof body.title === "string" ? body.title : "";
        const summary = typeof body.summary === "string" ? body.summary : title;
        const idempotencyKey =
          typeof request.headers["x-idempotency-key"] === "string"
            ? request.headers["x-idempotency-key"]
            : randomUUID();
        const item = controlPlane.intake({
          title,
          summary,
          actor: "human:dashboard",
          idempotencyKey,
        });
        json(response, 201, item);
        return;
      }
      const actionMatch = url.pathname.match(
        /^\/api\/work-items\/([^/]+)\/(triage|run|cancel|retry|decision|complete|archive|approve-tool|deny-tool|provide-input)$/u,
      );
      if (method === "POST" && actionMatch) {
        const id = decodeURIComponent(actionMatch[1]);
        const action = actionMatch[2];
        const body = await readJson(request);
        const idempotencyKey =
          typeof request.headers["x-idempotency-key"] === "string"
            ? request.headers["x-idempotency-key"]
            : randomUUID();
        if (action === "triage") {
          const item = controlPlane.triage({
            id,
            ownerRole:
              typeof body.ownerRole === "string" ? body.ownerRole : "operator",
            executionTarget:
              typeof body.executionTarget === "string"
                ? body.executionTarget
                : "local",
            actor: "human:dashboard",
            idempotencyKey,
          });
          json(response, 200, item);
          return;
        }
        if (action === "run") {
          const { runWork } = await import("../../cli/src/main.ts");
          void runWork(target, id, { quiet: true }).catch(() => {
            // Durable Run/Attempt records expose the failure.
          });
          json(response, 202, { workItemId: id, started: true });
          return;
        }
        if (action === "cancel") {
          json(
            response,
            202,
            controlPlane.requestRunCancellation({
              id,
              actor: "human:dashboard",
              idempotencyKey,
            }),
          );
          return;
        }
        if (action === "retry") {
          json(
            response,
            200,
            controlPlane.retry({
              id,
              actor: "human:dashboard",
              idempotencyKey,
              acknowledgeUnknownToolOutcome:
                body.acknowledgeUnknownToolOutcome === true,
            }),
          );
          return;
        }
        if (action === "approve-tool") {
          const callHash =
            typeof body.callHash === "string" ? body.callHash : "";
          const toolName =
            typeof body.toolName === "string" ? body.toolName : "";
          const packetHash =
            typeof body.packetHash === "string" ? body.packetHash : "";
          const note =
            typeof body.note === "string"
              ? body.note
              : "Reviewed exact tool arguments in the local dashboard.";
          json(
            response,
            200,
            controlPlane.approveToolCall({
              id,
              callHash,
              toolName,
              packetHash,
              note,
              actor: "human:dashboard",
              idempotencyKey,
              activeReviewMs:
                typeof body.activeReviewMs === "number"
                  ? body.activeReviewMs
                  : undefined,
              detailsOpenCount:
                typeof body.detailsOpenCount === "number"
                  ? body.detailsOpenCount
                  : undefined,
            }),
          );
          return;
        }
        if (action === "deny-tool") {
          const callHash =
            typeof body.callHash === "string" ? body.callHash : "";
          const toolName =
            typeof body.toolName === "string" ? body.toolName : "";
          const packetHash =
            typeof body.packetHash === "string" ? body.packetHash : "";
          const note =
            typeof body.note === "string"
              ? body.note
              : "Rejected the exact tool call from the local dashboard.";
          json(
            response,
            200,
            controlPlane.denyToolCall({
              id,
              callHash,
              toolName,
              packetHash,
              note,
              actor: "human:dashboard",
              idempotencyKey,
              activeReviewMs:
                typeof body.activeReviewMs === "number"
                  ? body.activeReviewMs
                  : undefined,
              detailsOpenCount:
                typeof body.detailsOpenCount === "number"
                  ? body.detailsOpenCount
                  : undefined,
            }),
          );
          return;
        }
        if (action === "provide-input") {
          const packetHash =
            typeof body.packetHash === "string" ? body.packetHash : "";
          const inputResponse =
            typeof body.response === "string" ? body.response : "";
          json(
            response,
            200,
            controlPlane.provideUserInput({
              id,
              packetHash,
              response: inputResponse,
              actor: "human:dashboard",
              idempotencyKey,
              activeReviewMs:
                typeof body.activeReviewMs === "number"
                  ? body.activeReviewMs
                  : undefined,
              detailsOpenCount:
                typeof body.detailsOpenCount === "number"
                  ? body.detailsOpenCount
                  : undefined,
            }),
          );
          return;
        }
        if (action === "decision") {
          const decision = body.decision;
          if (
            decision !== "approve" &&
            decision !== "changes_requested" &&
            decision !== "reject"
          ) {
            throw new Error(
              "decision must be approve, changes_requested, or reject.",
            );
          }
          const artifactHash =
            typeof body.artifactHash === "string" ? body.artifactHash : "";
          const packetHash =
            typeof body.packetHash === "string" ? body.packetHash : "";
          const note =
            typeof body.note === "string"
              ? body.note
              : "Reviewed from the local dashboard.";
          const decided = controlPlane.decide({
              id,
              decision,
              artifactHash,
              packetHash,
              note,
              actor: "human:dashboard",
              idempotencyKey,
              activeReviewMs:
                typeof body.activeReviewMs === "number"
                  ? body.activeReviewMs
                  : undefined,
              detailsOpenCount:
                typeof body.detailsOpenCount === "number"
                  ? body.detailsOpenCount
                  : undefined,
              completeOnApprove:
                decision === "approve" && body.completeOnApprove === true,
            });
          json(response, 200, decided);
          return;
        }
        if (action === "complete") {
          json(
            response,
            200,
            controlPlane.complete({
              id,
              actor: "human:dashboard",
              idempotencyKey,
            }),
          );
          return;
        }
        if (action === "archive") {
          json(
            response,
            200,
            controlPlane.archive({
              id,
              actor: "human:dashboard",
              idempotencyKey,
            }),
          );
          return;
        }
      }
      const artifactMatch = url.pathname.match(
        /^\/api\/work-items\/([^/]+)\/artifact$/u,
      );
      if (method === "GET" && artifactMatch) {
        const artifact = controlPlane.latestArtifact(
          decodeURIComponent(artifactMatch[1]),
        );
        if (!artifact) {
          json(response, 404, { error: "Artifact not found." });
          return;
        }
        json(response, 200, artifact);
        return;
      }
      if (method === "GET" && url.pathname === "/") {
        const template = readFileSync(resolve(PUBLIC_DIRECTORY, "index.html"), "utf8");
        send(
          response,
          200,
          template.replace("__SESSION_TOKEN__", sessionToken),
          "text/html; charset=utf-8",
        );
        return;
      }
      if (
        method === "GET" &&
        ["/app.js", "/styles.css"].includes(url.pathname)
      ) {
        const path = resolve(PUBLIC_DIRECTORY, url.pathname.slice(1));
        const type =
          extname(path) === ".js"
            ? "text/javascript; charset=utf-8"
            : "text/css; charset=utf-8";
        send(response, 200, readFileSync(path), type);
        return;
      }
      json(response, 404, { error: "Not found." });
    } catch (error) {
      json(
        response,
        error instanceof SyntaxError ? 400 : 422,
        { error: safeMessage(error) },
      );
    }
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    database.close();
    throw new Error("Dashboard server did not expose a TCP address.");
  }
  port = address.port;
  const url = `http://127.0.0.1:${port}`;
  if (!options.quiet) {
    console.log(`CharterMesh dashboard: ${url}`);
    if (options.open) {
      console.log("Open the URL in your browser. Automatic browser launch is disabled.");
    }
  }

  return {
    url,
    close: () =>
      new Promise<void>((resolveClose, reject) => {
        server.close((error) => {
          database.close();
          if (error) reject(error);
          else resolveClose();
        });
      }),
  };
}
