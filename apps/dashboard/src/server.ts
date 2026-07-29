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
): void {
  response.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
    "content-security-policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
  response.end(body);
}

function json(response: ServerResponse, status: number, value: unknown): void {
  send(response, status, JSON.stringify(value), "application/json; charset=utf-8");
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
  const runtimePath = resolve(target, ".chartermesh", "runtime.json");
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
    const config = JSON.parse(readFileSync(runtimePath, "utf8")) as {
      modelEngines?: Array<{
        id?: string;
        adapter?: string;
        apiKeyEnv?: string;
      }>;
      managedRunners?: Array<{ id?: string; modelEngineRef?: string }>;
    };
    const engines: RuntimeHealth[] = (config.modelEngines ?? []).map((engine) => {
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
    const runners: RuntimeHealth[] = (config.managedRunners ?? []).map((runner) => ({
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
        detail: "runtime.json is not valid JSON.",
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
  const target = resolve(options.target);
  const stateDirectory = resolve(target, ".chartermesh");
  if (!existsSync(resolve(stateDirectory, "runtime.json"))) {
    throw new Error("CharterMesh is not initialized. Run bootstrap first.");
  }

  const database = openControlPlaneDatabase(resolve(stateDirectory, "state.db"));
  const controlPlane = new ControlPlane(
    database,
    resolve(stateDirectory, "artifacts"),
  );
  const sessionToken = randomBytes(32).toString("base64url");
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
    const isMutation = !["GET", "HEAD", "OPTIONS"].includes(method);
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
      if (request.headers["x-chartermesh-session"] !== sessionToken) {
        json(response, 403, { error: "Invalid dashboard session." });
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
        json(response, 200, controlPlane.dashboard());
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
