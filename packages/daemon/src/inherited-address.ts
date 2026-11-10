import type { ServerType } from "@hono/node-server";
import { isLoopbackHost, NonLoopbackBindError, RemoteBindError } from "./bind-guard.js";
import type { Logger } from "./logger.js";
import type { RemoteListener } from "./remote-listener.js";
import { closeServer } from "./server-close.js";

export interface InheritedAddressPolicy {
  allowNonLoopback: boolean;
  remote: RemoteListener | null;
}

/**
 * An inherited socket listens wherever its owner bound it, so the host string says nothing about it.
 * The address it really has is checked after the bind and before the pid file is written.
 */
export async function assertInheritedAddress(server: ServerType, policy: InheritedAddressPolicy, graceMs: number, log: Logger): Promise<void> {
  const address = server.address();
  if (!address || typeof address !== "object" || isLoopbackHost(address.address)) return;
  const refusal = refusalFor(address.address, policy);
  if (!refusal) return;
  await closeServer(server, graceMs).catch((err: unknown) => log.error({ err }, "error closing an inherited socket that was refused"));
  throw refusal;
}

function refusalFor(address: string, { allowNonLoopback, remote }: InheritedAddressPolicy): Error | null {
  if (!allowNonLoopback) return new NonLoopbackBindError(address);
  return remote ? new RemoteBindError(remote.options.host, "the inherited socket is already unauthenticated beyond loopback") : null;
}
