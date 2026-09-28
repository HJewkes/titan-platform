/**
 * Host, Origin, client-header, and Content-Type guards for the daemon's request surfaces.
 *
 * An unauthenticated daemon on loopback is reachable from every browser on the machine.
 * A page that re-resolves its own name to 127.0.0.1 makes requests the browser treats as
 * same-origin, so no CORS rule stops them. What the browser cannot forge is the `Host`
 * header (it carries the attacker's name) or the `Origin` header, and what it cannot send
 * without a preflight is a JSON body or a custom header.
 *
 * Threat model for a state-changing request (POST, PUT, PATCH, DELETE):
 *
 * - A present `Origin` must be allowlisted. Browsers set it and page script cannot.
 * - A missing `Origin` proves nothing. Current browsers attach one to every non-GET
 *   request, but older browsers, privacy extensions, and embedded webviews have omitted
 *   it. So absence says "probably not a browser"; it does not say "not a browser".
 * - A missing `Origin` must therefore come with {@link CLIENT_HEADER}. Any value passes,
 *   because the header is not a secret: its proof is that a page can only attach a custom
 *   header after a CORS preflight, and this daemon answers no preflight. A request that
 *   carries it came from a non-browser client, or from a page that already passed the
 *   Origin check. Adding CORS headers that allow it would void this proof.
 * - Loopback alone is not enough, and the guard does not look at the peer address. The
 *   attacker's page runs in a browser on this machine, so its requests arrive from
 *   127.0.0.1 exactly as a CLI's do.
 * - None of this authenticates anyone. Any local process can send the header; the
 *   guards only keep web pages out, and the OS account stays the trust boundary.
 *
 * The Host-allowlist shape is adapted from beads (MIT), `internal/httpapi/server.go`.
 */
import { CLIENT_HEADER } from "@titan-design/rpc-protocol";

export { CLIENT_HEADER };

export interface RequestGuardOptions {
  /** Host values answered to, each matched with and without the bound port. */
  allowedHosts?: string[];
  /** Origins accepted beyond the http/https forms of `allowedHosts`. */
  allowedOrigins?: string[];
}

export interface GuardRefusal {
  status: 403 | 415;
  message: string;
}

/** The headers a guard reads, from either a hono context or a raw Node request. */
export interface GuardedRequest {
  method: string;
  host: string | null | undefined;
  origin: string | null | undefined;
  /** The {@link CLIENT_HEADER} value, which stands in for `Origin` on non-browser calls. */
  client: string | null | undefined;
  contentType: string | null | undefined;
}

export type RequestGuard = (request: GuardedRequest) => GuardRefusal | null;

/** Every loopback spelling a client can dial without the operator configuring anything. */
export const DEFAULT_ALLOWED_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const JSON_MEDIA_TYPE = "application/json";

interface Policy {
  port: number;
  hosts: Set<string>;
  origins: Set<string>;
}

/**
 * Build the guard. `port` is a thunk because `port: 0` is only resolved once bound, and
 * the policy is rebuilt whenever that answer changes.
 */
export function createRequestGuard(options: RequestGuardOptions = {}, port: () => number = () => 0): RequestGuard {
  const hosts = (options.allowedHosts ?? DEFAULT_ALLOWED_HOSTS).map((host) => host.toLowerCase());
  const extraOrigins = (options.allowedOrigins ?? []).map((origin) => origin.toLowerCase());
  let cached: Policy | null = null;

  return (request) => {
    const bound = port();
    if (!cached || cached.port !== bound) cached = buildPolicy(hosts, extraOrigins, bound);
    return refuse(request, cached);
  };
}

function buildPolicy(hosts: string[], extraOrigins: string[], port: number): Policy {
  const withPort = hosts.flatMap((host) => [host, `${host}:${port}`]);
  const derivedOrigins = withPort.flatMap((host) => [`http://${host}`, `https://${host}`]);
  return { port, hosts: new Set(withPort), origins: new Set([...derivedOrigins, ...extraOrigins]) };
}

function refuse(request: GuardedRequest, policy: Policy): GuardRefusal | null {
  if (!policy.hosts.has((request.host ?? "").toLowerCase())) {
    return { status: 403, message: "Host header is not one this daemon answers to" };
  }
  if (!STATE_CHANGING.has(request.method.toUpperCase())) return null;
  const originRefusal = refuseOrigin(request, policy);
  if (originRefusal) return originRefusal;
  if (mediaType(request.contentType) !== JSON_MEDIA_TYPE) {
    return { status: 415, message: `Content-Type must be ${JSON_MEDIA_TYPE}` };
  }
  return null;
}

function refuseOrigin(request: GuardedRequest, policy: Policy): GuardRefusal | null {
  if (request.origin == null) {
    if (request.client) return null;
    return { status: 403, message: "State-changing request needs an Origin header or an X-Titan-Client header" };
  }
  // An opaque origin arrives as the literal string "null", which no allowlist entry matches.
  if (!policy.origins.has(request.origin.toLowerCase())) {
    return { status: 403, message: "Origin is not one this daemon answers to" };
  }
  return null;
}

function mediaType(header: string | null | undefined): string {
  return (header ?? "").split(";")[0]!.trim().toLowerCase();
}
