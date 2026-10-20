import { dirname, join } from "node:path";
import { configPath } from "../config.js";

/** The one route the ingress listener answers; Funnel forwards only this path (TP-3100 §0). */
export const INGRESS_PATH = "/ingress/github";

/** A second loopback listener beside serve's 7410, so the daemon's Host and Origin guards stay as they are. */
export const INGRESS_PORT = 7411;

/** GitHub caps a delivery at 25 MB, but no kind the factory projects comes near 1 MiB. */
export const MAX_INGRESS_BODY_BYTES = 1024 * 1024;

/** GitHub times a delivery out at 10 s: this cap plus SQLite's 5 s busy wait leaves margin. */
export const INGRESS_REQUEST_TIMEOUT_MS = 4_000;

/** Named `.token` so the tool-guard's existing titan-factory token glob already refuses agent reads of it. */
export function webhookSecretPath(env: NodeJS.ProcessEnv): string {
  return join(dirname(configPath(env)), "secrets", "github-webhook.token");
}
