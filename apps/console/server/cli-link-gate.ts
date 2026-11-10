/**
 * `titan-console link gate <run>/<step>`: the https link that opens the inbox on one gate (TP-4737), printed only
 * after an https request to it answers 200 or 401. The LAN listener is TLS-only, so a plain-http link gets an empty
 * reply and the owner sees no page; a link that fails this probe is never handed to a seat.
 */
import { request } from "node:https";
import type { ConsoleConfig } from "./config.js";
import { inboxLink } from "./cli-inbox-link.js";

const PROBE_TIMEOUT_MS = 5_000;
/** 200 is the signed-in page; 401 is the sign-in gate. Anything else, or no reply, means the owner cannot load it. */
const REACHABLE = new Set([200, 401]);

/** Resolves to the HTTP status of a GET on the url, and rejects on an empty reply or a connection error. */
type HttpsProbe = (url: string) => Promise<number>;

export function linkGateArgs(argv: readonly string[]): { gate: string } | null {
  const [noun, verb, gate, ...rest] = argv;
  if (noun !== "link" || verb !== "gate" || gate === undefined || !/^[^/\s]+\/[^/\s]+$/.test(gate) || rest.length > 0) return null;
  return { gate };
}

const httpsProbe: HttpsProbe = (url) =>
  new Promise((resolve, reject) => {
    const req = request(url, { method: "GET", timeout: PROBE_TIMEOUT_MS }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("timeout", () => req.destroy(new Error("probe timed out")));
    req.on("error", reject);
    req.end();
  });

type LinkGateResult = { ok: true; link: string } | { ok: false; reason: string };

export async function linkGate(config: ConsoleConfig, gate: string, probe: HttpsProbe): Promise<LinkGateResult> {
  const link = inboxLink(config, `gate:${gate}`);
  if (!link.startsWith("https://")) return { ok: false, reason: `${link} is not https: this console has no LAN listener, so the owner's phone cannot open it` };
  try {
    const status = await probe(link);
    return REACHABLE.has(status) ? { ok: true, link } : { ok: false, reason: `${link} answered ${status}, expected 200 or 401` };
  } catch (error) {
    return { ok: false, reason: `${link} did not answer over https: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Prints the link and returns 0, or prints why to stderr and returns 1. */
export async function linkGateCli(config: ConsoleConfig, args: { gate: string }, probe: HttpsProbe = httpsProbe): Promise<number> {
  const result = await linkGate(config, args.gate, probe);
  if (result.ok) console.log(result.link);
  else console.error(result.reason);
  return result.ok ? 0 : 1;
}
