import { ts } from "ts-morph";

export type ProtocolKind = "http" | "mcp" | "sse";

/** One source file by its graph file id (repo-relative path) and its text. */
export interface ProtocolSourceFile {
  path: string;
  text: string;
}

/** Something a server declares: an HTTP route or SSE stream (`GET /a/:id`) or an MCP tool name. */
export interface ProtocolEndpoint {
  kind: ProtocolKind;
  name: string;
  fileId: string;
  line: number;
}

/** A runtime call from the file that makes it to the file that serves it, one way. */
export interface ProtocolEdge {
  srcId: string;
  dstId: string;
  kind: ProtocolKind;
  /** The endpoint's name, as in {@link ProtocolEndpoint.name}. */
  endpoint: string;
  /** What the arrow reads, such as `HTTP GET /a/:id`, `SSE /events` or `MCP search`. */
  label: string;
  /** The caller's 1-based line. */
  line: number;
}

/** Named so a consumer (RX2) can surface it: no file declares a route, a stream or a tool. */
export const NO_PROTOCOL_SOURCE = "no-protocol-source";

export interface ProtocolDiagnostic {
  code: typeof NO_PROTOCOL_SOURCE;
  message: string;
}

export interface ProtocolEdgeResult {
  endpoints: ProtocolEndpoint[];
  edges: ProtocolEdge[];
  diagnostics: ProtocolDiagnostic[];
}

type CallKind = "fetch" | "event-source" | "tool";

interface ProtocolCall {
  kind: CallKind;
  /** A path with `*` for each run-time segment, or a tool name. */
  target: string;
  /** Upper case, or null when the method is not a literal. */
  method: string | null;
  fileId: string;
  line: number;
}

const ROUTE_METHODS = new Set(["get", "post", "put", "patch", "delete", "all"]);
const TOOL_REGISTRARS = new Set(["tool", "registerTool"]);
const SCRIPT = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const SSE_MARKER = /\bstreamSSE\s*\(|text\/event-stream/;
const DYNAMIC = "*";

// Code-unit order, not localeCompare, so the output cannot vary with the host locale.
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function literalText(node: ts.Node | undefined): string | null {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
}

/** A path with every run-time part as `*`; a leading run-time part (a base URL) is dropped. */
function pathText(node: ts.Node | undefined): string | null {
  const literal = literalText(node);
  if (literal !== null) return literal;
  if (!node || !ts.isTemplateExpression(node)) return null;
  const parts = [node.head.text, ...node.templateSpans.flatMap((s) => [DYNAMIC, s.literal.text])];
  const joined = node.head.text === "" ? parts.slice(2).join("") : parts.join("");
  return joined.startsWith("/") ? joined : null;
}

function segments(path: string): string[] {
  return path.replace(/[?#].*$/, "").split("/").filter(Boolean);
}

/** A route's name with its path normalised: no query, no trailing slash. */
function routeName(method: string, path: string): string {
  return `${method.toUpperCase()} /${segments(path).join("/")}`;
}

function propertyName(callee: ts.Expression): string | null {
  return ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
}

function objectProperty(node: ts.Node | undefined, key: string): ts.Expression | undefined {
  if (!node || !ts.isObjectLiteralExpression(node)) return undefined;
  for (const p of node.properties) {
    if (ts.isPropertyAssignment(p) && literalOrIdentifier(p.name) === key) return p.initializer;
  }
  return undefined;
}

function literalOrIdentifier(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) ? name.text : literalText(name);
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function routeEndpoint(call: ts.CallExpression, source: ts.SourceFile): ProtocolEndpoint | null {
  const method = propertyName(call.expression);
  const path = literalText(call.arguments[0]);
  // A route always takes a handler, so `cache.get("/a")` on a Map is not one.
  const handled = call.arguments.length > 1;
  if (!method || !ROUTE_METHODS.has(method) || !handled || path === null || !path.startsWith("/")) return null;
  const handlers = call.arguments.slice(1).map((a) => a.getText(source)).join("\n");
  const kind = SSE_MARKER.test(handlers) ? "sse" : "http";
  return { kind, name: routeName(method, path), fileId: source.fileName, line: lineOf(source, call) };
}

function toolEndpoint(call: ts.CallExpression, source: ts.SourceFile): ProtocolEndpoint | null {
  const registrar = propertyName(call.expression);
  const name = literalText(call.arguments[0]);
  if (!registrar || !TOOL_REGISTRARS.has(registrar) || name === null) return null;
  return { kind: "mcp", name, fileId: source.fileName, line: lineOf(source, call) };
}

function fetchCall(call: ts.CallExpression, source: ts.SourceFile): ProtocolCall | null {
  const callee = call.expression;
  const isFetch = ts.isIdentifier(callee) ? callee.text === "fetch" : propertyName(callee) === "fetch";
  const target = isFetch ? pathText(call.arguments[0]) : null;
  if (target === null) return null;
  const init = call.arguments[1];
  const methodNode = objectProperty(init, "method");
  const literal = literalText(methodNode);
  const method = methodNode === undefined ? "GET" : (literal?.toUpperCase() ?? null);
  return { kind: "fetch", target, method, fileId: source.fileName, line: lineOf(source, call) };
}

function toolCall(call: ts.CallExpression, source: ts.SourceFile): ProtocolCall | null {
  if (propertyName(call.expression) !== "callTool") return null;
  const [first] = call.arguments;
  const target = literalText(first) ?? literalText(objectProperty(first, "name"));
  if (target === null) return null;
  return { kind: "tool", target, method: null, fileId: source.fileName, line: lineOf(source, call) };
}

function eventSourceCall(node: ts.NewExpression, source: ts.SourceFile): ProtocolCall | null {
  if (!ts.isIdentifier(node.expression) || node.expression.text !== "EventSource") return null;
  const target = pathText(node.arguments?.[0]);
  if (target === null) return null;
  return { kind: "event-source", target, method: "GET", fileId: source.fileName, line: lineOf(source, node) };
}

interface FileScan {
  endpoints: ProtocolEndpoint[];
  calls: ProtocolCall[];
}

function scanNode(node: ts.Node, source: ts.SourceFile, out: FileScan): void {
  if (ts.isCallExpression(node)) {
    const endpoint = routeEndpoint(node, source) ?? toolEndpoint(node, source);
    if (endpoint) out.endpoints.push(endpoint);
    const call = fetchCall(node, source) ?? toolCall(node, source);
    if (call) out.calls.push(call);
  } else if (ts.isNewExpression(node)) {
    const call = eventSourceCall(node, source);
    if (call) out.calls.push(call);
  }
  ts.forEachChild(node, (child) => scanNode(child, source, out));
}

function scanFile(file: ProtocolSourceFile): FileScan {
  const out: FileScan = { endpoints: [], calls: [] };
  if (!SCRIPT.test(file.path)) return out;
  const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  scanNode(source, source, out);
  return out;
}

const isParam = (segment: string): boolean => /^(?::|\{|\*)/.test(segment);

/**
 * Whether a called path reaches a route. A route with a literal segment also matches a call
 * with extra leading segments, the prefix a router is mounted under; a route of parameters
 * only must match the whole path, or `/:slug` would catch every call.
 */
function pathMatches(called: string, route: string): boolean {
  const want = segments(route.slice(route.indexOf(" ") + 1));
  const got = segments(called);
  const mounted = want.some((s) => !isParam(s));
  if (got.length < want.length || (!mounted && got.length !== want.length)) return false;
  const tail = got.slice(got.length - want.length);
  return want.every((s, i) => isParam(s) || tail[i] === DYNAMIC || tail[i] === s);
}

function methodMatches(call: ProtocolCall, route: string): boolean {
  const method = route.slice(0, route.indexOf(" "));
  return call.method === null || method === "ALL" || method === call.method;
}

function serves(endpoint: ProtocolEndpoint, call: ProtocolCall): boolean {
  if (call.kind === "tool") return endpoint.kind === "mcp" && endpoint.name === call.target;
  if (endpoint.kind === "mcp" || (call.kind === "event-source" && endpoint.kind !== "sse")) return false;
  return methodMatches(call, endpoint.name) && pathMatches(call.target, endpoint.name);
}

function labelOf(endpoint: ProtocolEndpoint): string {
  if (endpoint.kind === "mcp") return `MCP ${endpoint.name}`;
  if (endpoint.kind === "sse") return `SSE ${endpoint.name.slice(endpoint.name.indexOf(" ") + 1)}`;
  return `HTTP ${endpoint.name}`;
}

function edgesFor(calls: readonly ProtocolCall[], endpoints: readonly ProtocolEndpoint[]): ProtocolEdge[] {
  const edges = new Map<string, ProtocolEdge>();
  for (const call of calls) {
    for (const endpoint of endpoints) {
      if (endpoint.fileId === call.fileId || !serves(endpoint, call)) continue;
      const key = JSON.stringify([call.fileId, endpoint.fileId, endpoint.kind, endpoint.name]);
      const { kind, name, fileId: dstId } = endpoint;
      if (!edges.has(key)) edges.set(key, { srcId: call.fileId, dstId, kind, endpoint: name, label: labelOf(endpoint), line: call.line });
    }
  }
  return [...edges.values()];
}

const byLine = (a: { line: number }, b: { line: number }): number => a.line - b.line;

/**
 * The HTTP route, SSE stream and MCP tool edges between a repo's files, read from source
 * text alone (no type checker), so it runs on any checkout. A call becomes an edge only when
 * its path or tool name is literal enough to match one declared endpoint; a route whose
 * handler streams `text/event-stream` (or calls hono's `streamSSE`) is an SSE endpoint.
 * With no endpoint declared anywhere, the result carries {@link NO_PROTOCOL_SOURCE}: a map
 * drawn from it has import arrows only.
 */
export function extractProtocolEdges(files: readonly ProtocolSourceFile[]): ProtocolEdgeResult {
  const ordered = [...files].sort((a, b) => byText(a.path, b.path));
  const scans = ordered.map(scanFile);
  const endpoints = scans.flatMap((s) => s.endpoints);
  const calls = scans.flatMap((s) => s.calls.sort(byLine));
  const edges = edgesFor(calls, endpoints).sort(
    (a, b) => byText(a.srcId, b.srcId) || byText(a.dstId, b.dstId) || byText(a.label, b.label),
  );
  endpoints.sort((a, b) => byText(a.kind, b.kind) || byText(a.name, b.name) || byText(a.fileId, b.fileId));
  const diagnostics: ProtocolDiagnostic[] =
    endpoints.length > 0
      ? []
      : [{ code: NO_PROTOCOL_SOURCE, message: "no HTTP route, SSE stream or MCP tool is declared; the map shows imports only" }];
  return { endpoints, edges, diagnostics };
}
