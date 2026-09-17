/**
 * Host, Origin, and Content-Type guards for the daemon's request surfaces.
 *
 * An unauthenticated daemon on loopback is reachable from every browser on the machine.
 * A page that re-resolves its own name to 127.0.0.1 makes requests the browser treats as
 * same-origin, so no CORS rule stops them. What the browser cannot forge is the `Host`
 * header (it carries the attacker's name) or the `Origin` header, and what it cannot send
 * without a preflight is a JSON body. Checking all three is what keeps a cross-origin page
 * from running a command.
 *
 * The Host-allowlist shape is adapted from beads (MIT), `internal/httpapi/server.go`.
 */

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
  // An opaque origin arrives as the literal string "null", which no allowlist entry matches.
  if (request.origin != null && !policy.origins.has(request.origin.toLowerCase())) {
    return { status: 403, message: "Origin is not one this daemon answers to" };
  }
  if (mediaType(request.contentType) !== JSON_MEDIA_TYPE) {
    return { status: 415, message: `Content-Type must be ${JSON_MEDIA_TYPE}` };
  }
  return null;
}

function mediaType(header: string | null | undefined): string {
  return (header ?? "").split(";")[0]!.trim().toLowerCase();
}
