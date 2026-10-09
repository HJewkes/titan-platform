/**
 * The remote listener's options, and the checks that run on them before anything binds.
 */
import { isIPv6 } from "node:net";
import { createDaemonAuth, type DaemonAuth } from "./auth.js";
import { assertRemoteHost, isLoopbackHost, RemoteBindError } from "./bind-guard.js";
import type { RequestGuardOptions } from "./guards.js";
import { trackTlsFiles, type RemoteTlsOptions, type TlsFileTracker } from "./tls-files.js";

export const DEFAULT_TLS_RELOAD_MS = 60_000;

/**
 * The remote listener speaks only TLS, then runs the Host/Origin guard, then the auth gate,
 * before every route, and never serves `/mcp`. Its Host allowlist is `host` plus `allowedHosts`
 * and nothing else, each matched only with the bound port, and its origins are the `https://`
 * forms of that list alone. The loopback listener is unchanged and never learns these names.
 * `mountRoutes` runs once per listener, each on its own app.
 */
export interface RemoteListenerOptions {
  /** A bare IP address on one of this host's interfaces. Loopback, wildcards and names throw `RemoteBindError`. */
  host: string;
  /** The shared secret. It must already exist; see `ensureTokenFile`. */
  tokenFile: string;
  /** Names the remote listener also answers to, such as a tailnet name. The certificate must cover each. */
  allowedHosts?: string[];
  /**
   * Required: a remote listener without it throws `RemoteBindError`, so no setting serves plain
   * HTTP beyond loopback. The files are checked before anything binds and stat'd every
   * `tlsReloadMs`; a changed pair that fails its checks is logged and the last good pair stays.
   */
  tls: RemoteTlsOptions;
  /** How often the TLS files are checked for a change. Defaults to 60000. */
  tlsReloadMs?: number;
}

export interface RemoteListener {
  options: RemoteListenerOptions;
  gate: DaemonAuth;
  tls: TlsFileTracker;
}

/** Checked, and the token and TLS files read, before anything binds: a bad remote config never half-starts. */
export function remoteListener(remote: RemoteListenerOptions | undefined, mainHost: string): RemoteListener | null {
  if (!remote) return null;
  if (!isLoopbackHost(mainHost)) {
    throw new RemoteBindError(remote.host, "the main listener is already unauthenticated beyond loopback");
  }
  assertRemoteHost(remote.host);
  // Checked at runtime too: a JavaScript caller, or a cast, can leave out the typed field.
  if (!remote.tls?.certFile || !remote.tls.keyFile) throw new RemoteBindError(remote.host, "it has no TLS; pass remote.tls with certFile and keyFile");
  const gate = createDaemonAuth({ tokenFile: remote.tokenFile });
  return { options: remote, gate, tls: trackTlsFiles(remote.tls, remote.allowedHosts ?? []) };
}

export function remoteGuardOptions(remote: RemoteListenerOptions): RequestGuardOptions {
  const literal = isIPv6(remote.host) ? `[${remote.host}]` : remote.host;
  return { allowedHosts: [literal, ...(remote.allowedHosts ?? [])], portOnly: true, httpsOnly: true };
}
