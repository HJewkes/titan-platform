import type { Logger } from "@titan-design/daemon";
import { resolveSources, type SourcesReader } from "./github-sources/mode.js";
import type { FactoryHost } from "./host.js";
import type { Projector } from "./ingress/answer.js";
import { projectDelivery } from "./ingress/kinds.js";
import { listenIngress, type IngressListener } from "./ingress/listen.js";
import { trackWebhookSecret } from "./ingress/secret.js";

export interface ServeIngressOptions {
  /** Defaults to `INGRESS_PORT`; 0 binds an ephemeral port. */
  port?: number;
  /** The webhook secret file; `webhookSecretPath(env)` in production. */
  secretPath: string;
  /** Replaces `INGRESS_REQUEST_TIMEOUT_MS`; tests shorten it. */
  requestTimeoutMs?: number;
  /** Defaults to `projectDelivery`, the declared `INGRESS_KINDS` table. */
  project?: Projector;
}

interface IngressServeOptions {
  ingress?: ServeIngressOptions;
  sources?: SourcesReader;
  now?: () => number;
}

const SWITCH_OFF: SourcesReader = () => resolveSources({});

/**
 * Bound even while the kill switch is off, so flipping it applies to the next delivery with no restart. It shares serve's
 * sources reader, so health's `sources` and the ingress never disagree; without one the switch stays off.
 */
export async function startServeIngress(host: FactoryHost, options: IngressServeOptions, log: Logger): Promise<IngressListener | undefined> {
  const ingress = options.ingress;
  if (ingress === undefined) return undefined;
  return listenIngress({
    port: ingress.port,
    requestTimeoutMs: ingress.requestTimeoutMs,
    sources: options.sources ?? SWITCH_OFF,
    secret: trackWebhookSecret(ingress.secretPath),
    project: ingress.project ?? projectDelivery,
    db: host.db,
    now: options.now,
    log,
  });
}
