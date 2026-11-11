import { request } from "node:https";
import { errorMessage } from "../narrow.js";
import { safeConsoleOrigin } from "./gate-alarm.js";

const PROBE_TIMEOUT_MS = 5_000;
/** 200 is the signed-in page and 401 the sign-in gate, the rule `titan-console link gate` uses (apps/console/server/cli-link-gate.ts). */
const REACHABLE = new Set([200, 401]);
export const LINKS_OMITTED = "digest.consoleOrigin unset: alarm links omitted";

/** Resolves to the HTTP status of a GET on the url; rejects on an empty reply, a timeout or a connection error. */
export type HttpsProbe = (url: string) => Promise<number>;

export const httpsProbe: HttpsProbe = (url) =>
  new Promise((resolve, reject) => {
    const req = request(url, { method: "GET", timeout: PROBE_TIMEOUT_MS }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("timeout", () => req.destroy(new Error("probe timed out")));
    req.on("error", reject);
    req.end();
  });

type AlarmLinks = { origin: string } | { gap: string };

/** Every gate link is `<origin>/#/inbox/...` and the fragment never leaves the browser, so one GET on `<origin>/` checks them all. */
export async function alarmLinks(configured: string | undefined, probe: HttpsProbe): Promise<AlarmLinks> {
  const origin = configured === undefined ? undefined : safeConsoleOrigin(configured);
  if (origin === undefined) return { gap: LINKS_OMITTED };
  try {
    const status = await probe(`${origin}/`);
    return REACHABLE.has(status) ? { origin } : { gap: `digest.consoleOrigin ${origin} answered ${status}, expected 200 or 401: alarm links omitted` };
  } catch (error) {
    return { gap: `digest.consoleOrigin ${origin} did not answer over https (${errorMessage(error)}): alarm links omitted` };
  }
}
