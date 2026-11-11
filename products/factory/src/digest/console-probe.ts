import { request } from "node:https";
import { errorMessage } from "../narrow.js";
import { safeConsoleOrigin } from "./gate-alarm.js";

const PROBE_TIMEOUT_MS = 5_000;
/** 200 is the signed-in page and 401 the sign-in gate, the rule `titan-console link gate` uses (apps/console/server/cli-link-gate.ts). */
const REACHABLE = new Set([200, 401]);
export const LINKS_OMITTED = "digest.consoleOrigin unset: alarm links omitted";

/** Resolves to the HTTP status of a GET on the url; rejects on an empty reply, a timeout or a connection error. */
export type HttpsProbe = (url: string) => Promise<number>;

/** The deadline covers the whole exchange: a server that drips bytes keeps a socket-idle timeout from ever firing. */
export const httpsProbe = (url: string, deadlineMs: number = PROBE_TIMEOUT_MS): Promise<number> =>
  new Promise((resolve, reject) => {
    const req = request(url, { method: "GET" }, (res) => {
      clearTimeout(deadline);
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    const deadline = setTimeout(() => req.destroy(new Error("probe timed out")), deadlineMs);
    req.on("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
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
