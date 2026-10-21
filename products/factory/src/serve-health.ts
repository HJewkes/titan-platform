import type { RoutedRunner, WorkflowStatus } from "@titan-design/workflow";
import type { BehindMain } from "./behind-main.js";
import { factoryStateDir } from "./config.js";
import { deployPendingHealth } from "./deploy-pacer-sweep.js";
import { readLastDeploy } from "./deploy-ports.js";
import type { DeployWatch } from "./deploy-watch.js";
import type { GateNotifyWatch } from "./gate-notify-sweep.js";
import type { GithubHealth } from "./github-health.js";
import type { SourcesReader } from "./github-sources/mode.js";
import type { FactoryHost, FactoryRoutes } from "./host.js";
import type { IngressStatus } from "./ingress/listen.js";
import type { OwnerKeys } from "./owner-keys.js";
import { busyRuns, heldSkipped, type HoldPredicate } from "./restart-drain.js";
import { heldRun } from "./serve-holds.js";
import { serveStartsHealth, type ServeStart } from "./serve-starts.js";
import type { DeployPacerOptions } from "./shepherd/deploy-pacer.js";
import { divergedPrClosed } from "./shepherd/diverged-sweep.js";
import { visualDeliveryHealth } from "./shepherd/visual-delivery-sweep.js";

const STATUSES: readonly WorkflowStatus[] = ["running", "paused", "cancelling", "recovery_required", "completed", "failed", "cancelled"];

/** The serve options health reads. */
interface HealthOptions {
  routes: FactoryRoutes;
  sources?: SourcesReader;
  deployStateDir?: string;
  deployWatch?: DeployWatch;
  deployPacer?: DeployPacerOptions;
  now?: () => number;
}

/** What serve has built by the time health is asked. */
interface HealthInputs {
  github: GithubHealth;
  build: { sha: string; status: BehindMain["status"] };
  routeFor: RoutedRunner["routeFor"];
  ownerKeys: OwnerKeys;
  start: ServeStart | undefined;
  notify: GateNotifyWatch | undefined;
  ingress: IngressStatus | undefined;
}

export function serveHealth(host: FactoryHost, options: HealthOptions, { github, build, routeFor, ownerKeys, start, notify, ingress }: HealthInputs): Record<string, unknown> {
  return {
    ...factoryHealth(host, routeFor, heldRun(options.routes.shepherd), divergedPrClosed(options.routes.shepherd)),
    github: github.status(),
    ...(options.sources && { sources: options.sources() }),
    ...(ingress && { ingress }),
    ...(options.routes.shepherd?.pacing && { snapshotTick: options.routes.shepherd.pacing.status() }),
    build: { sha: build.sha, behindMain: build.status() },
    lastDeploy: readLastDeploy(options.deployStateDir ?? factoryStateDir(process.env)),
    ...(options.deployWatch && { deploy: options.deployWatch.status() }),
    ...(options.routes.shepherd?.reviewSlots && { reviewSlots: options.routes.shepherd.reviewSlots() }),
    ...deployPendingHealth(options.deployPacer),
    ...(notify && { gateNotify: notify.status() }),
    ...visualDeliveryHealth(options.routes.shepherd),
    ownerKeys: ownerKeys.ok ? { count: ownerKeys.ids.length, ids: ownerKeys.ids } : { count: 0, refusal: ownerKeys.refusal },
    ...(start && serveStartsHealth(start, new Date((options.now ?? Date.now)()))),
  };
}

/** Without `routeFor`, `busy` cannot see park-routed steps. Finished runs are counted, not listed, so a probe never parses every one (TP-2419); recovery_required
 * runs are listed by id, so a deploy's watch can tell a run its restart interrupted, or one on a closed PR, from one that broke after it. */
export function factoryHealth(host: FactoryHost, routeFor: RoutedRunner["routeFor"] = () => undefined, isHeld?: HoldPredicate, prClosed: ReadonlySet<string> = new Set()): Record<string, unknown> {
  const runs = Object.fromEntries(host.countRuns(STATUSES));
  const running = host.runtime.list(["running"]);
  const held = isHeld ? heldSkipped(running, routeFor, isHeld) : [];
  const recoveryRequired = host.runtime.list(["recovery_required"]).map((run) => run.id);
  const busy = busyRuns(running, routeFor, isHeld);
  return { runs, recoveryRequired, recoveryPrClosed: recoveryRequired.filter((id) => prClosed.has(id)), pendingGates: host.pendingGates().length, busy, heldSkipped: held };
}
