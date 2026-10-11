/**
 * `/mcp` on the raw Node server. It is spliced in ahead of hono, so nothing hono mounts, the
 * auth gate included, ever sees these requests; only the loopback listener takes it.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServerType } from "@hono/node-server";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { EXIT, errorEnvelope, type BaseContext } from "@titan-design/registry";
import { CLIENT_HEADER, type GuardRefusal, type RequestGuard } from "./guards.js";
import { createMcpServer, type McpServerOptions } from "./mcp.js";

/**
 * Serve one `/mcp` request from a fresh server + transport.
 *
 * This bypasses hono because `StreamableHTTPServerTransport` takes ownership of the raw
 * Node response object. `sessionIdGenerator: undefined` keeps it stateless: every request
 * is self-contained, so no session state outlives the response.
 */
export async function handleMcpRequest<Ctx extends BaseContext>(
  options: McpServerOptions<Ctx>,
  guard: RequestGuard,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const refusal = guardNodeRequest(guard, req);
  if (refusal) return respondJson(res, refusal.status, refusal.message);

  let body: unknown;
  if (req.method === "POST") {
    try {
      body = await readJsonBody(req);
    } catch {
      return respondJson(res, 400, "Invalid JSON body");
    }
  }
  const server = createMcpServer(options);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

function guardNodeRequest(guard: RequestGuard, req: IncomingMessage): GuardRefusal | null {
  return guard({
    method: req.method ?? "GET",
    host: req.headers.host,
    origin: req.headers.origin,
    client: headerValue(req.headers[CLIENT_HEADER]),
    contentType: req.headers["content-type"],
  });
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(",") : value;
}

function respondJson(res: ServerResponse, status: number, error: string, code: number = EXIT.USAGE): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(errorEnvelope(error, code)));
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

/** Route `/mcp` to the transport ahead of hono, falling through for everything else. */
export function spliceMcpRoute(server: ServerType, mcp: (req: IncomingMessage, res: ServerResponse) => Promise<void>): void {
  const honoHandler = server.listeners("request")[0] as ((req: IncomingMessage, res: ServerResponse) => void) | undefined;
  server.removeAllListeners("request");
  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    if (url === "/mcp" || url.startsWith("/mcp?") || url.startsWith("/mcp/")) {
      void mcp(req, res).catch((err) => failRequest(res, err));
      return;
    }
    honoHandler?.(req, res);
  });
}

function failRequest(res: ServerResponse, err: unknown): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  respondJson(res, 500, String(err), EXIT.SOFTWARE);
}
