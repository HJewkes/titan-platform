import { existsSync, readFileSync } from "node:fs";
import type { RoutedRunner, WorkflowStatus } from "@titan-design/workflow";
import type { BehindMain } from "./behind-main.js";
import type { BotHealth } from "./bot-identity.js";
import { factoryStateDir } from "./config.js";
import { deployPendingHealth } from "./deploy-pacer-sweep.js";
import { deployHeldHealth, deployPausedHealth } from "./deploy-pause.js";
import { readLastDeploy } from "./deploy-ports.js";
import type { DeployWatch } from "./deploy-watch.js";
import type { GateNotifyWatch } from "./gate-notify-sweep.js";
import type { GithubApiHealth } from "./github-api/status.js";
import type { GithubHealth } from "./github-health.js";
import type { PassStamp, SourcesReader } from "./github-sources/mode.js";
import type { ReconcilerHealth } from "./serve-reconciler.js";
import type { FactoryHost, FactoryRoutes } from "./host.js";
import type { IngressStatus } from "./ingress/listen.js";
import type { OwnerKeys } from "./owner-keys.js";
import { busyRuns, heldSkipped, type HoldPredicate, type QueuedPredicate } from "./restart-drain.js";
import { gateQueuedRun, heldRun } from "./serve-holds.js";
import { serveStartsHealth, type ServeStart } from "./serve-starts.js";
import type { DeployPacerOptions } from "./shepherd/deploy-pacer.js";
import { divergedPrClosed, divergedRestarts, type DivergedRestart } from "./shepherd/diverged-sweep.js";
import { isReplayDiverged } from "./shepherd/restart.js";
import { visualDeliveryHealth } from "./shepherd/visual-delivery-sweep.js";

const fsPauseReads = { exists: existsSync, readFile: (path: string) => readFileSync(path, "utf8") };

const STATUSES: readonly WorkflowStatus[] = ["running", "paused", "cancelling", "recovery_required", "completed", "failed", "cancelled"];

/** The serve options health reads. */
interface HealthOptions {
  routes: FactoryRoutes;
  sources?: SourcesReader;
  githubApi?: () => GithubApiHealth;
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
  passStamp: PassStamp;
  bot: BotHealth;
  reconciler: ReconcilerHealth;
}

export function serveHealth(host: FactoryHost, options: HealthOptions, inputs: HealthInputs): Record<string, unknown> {
  const { github, build, routeFor, ownerKeys, start, notify, ingress, passStamp, bot, reconciler } = inputs;
  const deployStateDir = options.deployStateDir ?? factoryStateDir(process.env);
  return {
    ...factoryHealth(host, routeFor, heldRun(options.routes.shepherd), divergedPrClosed(options.routes.shepherd), divergedRestarts(options.routes.shepherd), gateQueuedRun(options.routes.shepherd)),
    github: github.status(),
    ...(options.sources && { sources: { ...options.sources(), lastPassAt: passStamp.read(), reconciler } }),
    ...(options.githubApi && { githubApi: options.githubApi() }),
    ...(ingress && { ingress }),
    ...(options.routes.shepherd?.pacing && { snapshotTick: options.routes.shepherd.pacing.status() }),
    build: { sha: build.sha, behindMain: build.status() },
    ...(options.routes.config && { config: options.routes.config.stamp() }),
    lastDeploy: readLastDeploy(deployStateDir),
    deployPaused: deployPausedHealth(fsPauseReads, deployStateDir),
    deployHeld: deployHeldHealth(fsPauseReads, deployStateDir),
    ...(options.deployWatch && { deploy: options.deployWatch.status() }),
    ...(options.routes.shepherd?.reviewSlots && { reviewSlots: options.routes.shepherd.reviewSlots() }),
    ...deployPendingHealth(options.deployPacer),
    ...(notify && { gateNotify: notify.status() }),
    ...visualDeliveryHealth(options.routes.shepherd),
    bot,
    ownerKeys: ownerKeys.ok ? { count: ownerKeys.ids.length, ids: ownerKeys.ids } : { count: 0, refusal: ownerKeys.refusal },
    ...(start && serveStartsHealth(start, new Date((options.now ?? Date.now)()))),
  };
}

/** Without `routeFor`, `busy` cannot see park-routed steps. Finished runs are counted, not listed, so a probe never parses every one (TP-2419); recovery_required
 * runs are listed by id, so a deploy's watch can tell a run its restart interrupted, one on a closed PR, or one strict replay parked for the diverged sweep,
 * from one that broke after it. Only restarts whose successor run exists are listed (TP-3889). A review spawn the gate still queues is not busy (TP-4474). */
export function factoryHealth(
  host: FactoryHost,
  routeFor: RoutedRunner["routeFor"] = () => undefined,
  isHeld?: HoldPredicate,
  prClosed: ReadonlySet<string> = new Set(),
  restarts: readonly DivergedRestart[] = [],
  isQueued?: QueuedPredicate,
): Record<string, unknown> {
  const runs = Object.fromEntries(host.countRuns(STATUSES));
  const running = host.runtime.list(["running"]);
  const held = isHeld ? heldSkipped(running, routeFor, isHeld) : [];
  const parked = host.runtime.list(["recovery_required"]);
  const recoveryRequired = parked.map((run) => run.id);
  const busy = busyRuns(running, routeFor, isHeld, isQueued);
  return {
    runs,
    recoveryRequired,
    recoveryPrClosed: recoveryRequired.filter((id) => prClosed.has(id)),
    recoveryReplayDiverged: parked.filter(isReplayDiverged).map((run) => run.id),
    divergedRestarts: restarts.filter((restart) => host.runtime.status(restart.newRunId) !== undefined),
    pendingGates: host.pendingGates().length,
    busy,
    heldSkipped: held,
  };
}
