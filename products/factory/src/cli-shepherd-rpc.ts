import { invokeCommand, type JsonEnvelope } from "@titan-design/registry";
import { postRpc, type Verbs } from "./cli.js";
import { EXIT } from "./exit-codes.js";
import { createFactoryRegistry, factoryContext } from "./registry.js";
import { probeServe, type ServeProbe } from "./serve-probe.js";
import type { ShepherdCommandName } from "./shepherd/commands.js";

/** The status rows for owner/repo#N: from titan-factory serve when one answers, else from the database here. */
export async function statusRows(verbs: Verbs, args: { repo: string; pr: number }, port: number): Promise<JsonEnvelope<unknown>> {
  const probe = await probeServe(port, verbs.deps.serveWaitMs);
  return probe.state === "up" ? postRpc(port, "shepherd.status", args) : localEnvelope(verbs, "shepherd.status", args);
}

export async function localEnvelope(verbs: Verbs, name: ShepherdCommandName, args: object): Promise<JsonEnvelope<unknown>> {
  let result: JsonEnvelope<unknown> | undefined;
  await verbs.withHost(async (host, routes) => {
    result = (await invokeCommand(createFactoryRegistry().get(name)!, args, factoryContext(host, routes))).envelope;
    return EXIT.OK;
  });
  return result!;
}

export function unansweredMessage(probe: ServeProbe, port: number): string {
  if (probe.state === "slow") return `titan-factory serve on port ${port} is busy, not down: it took the connection but did not answer within ${probe.waitedMs / 1000} s, so retry`;
  if (probe.state === "unready") return `titan-factory serve on port ${port} is not ready: /health answered HTTP ${probe.status}`;
  return `no titan-factory serve answered on port ${port}: connection refused, so serve is down`;
}
