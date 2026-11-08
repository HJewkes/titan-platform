import { type GitHubPort } from "@titan-design/github";
import type { AuditPorts } from "./audit/ports.js";
import { type Live } from "./config-ref.js";
import { type MergeWake } from "./merge-wake.js";
import { type GhGateway } from "./shepherd/gh-gateway.js";
import type { PrFilesRead } from "./shepherd/git-pr-files.js";
import { type FreezeStoreRef } from "./shepherd/freeze.js";
import { type MachineStopWatch } from "./shepherd/machine-stop.js";
import { type MainRedWiring } from "./shepherd/main-red.js";
import { type PackageRegistry } from "./shepherd/release.js";
import type { VersionRegistry } from "./shepherd/release-follow.js";
import type { IsFrozen } from "./shepherd/merge-facts.js";
import type { ParkPort } from "./shepherd/park.js";
import { type MergeOrderRules } from "./shepherd/merge-order.js";
import { type Deployer } from "./shepherd/redeploy.js";
import type { ReviewWiring } from "./shepherd/review.js";
import { type SeatBook } from "./shepherd/seats.js";
import { type IsAdvisory } from "./shepherd/advisory.js";
import { type StackRestackOn } from "./shepherd/stack-land.js";
import { type AccountLimitStoreRef } from "./shepherd/account-store.js";
import { type ShepherdStoreRef } from "./shepherd/store.js";
import { type MergeTrainRef } from "./shepherd/train.js";
import { type LandPrDeps } from "./workflows/land-pr.js";
import { type TickPacing } from "./tick-pacing.js";
import type { ThawAlertPorts, VisualDeliveryWatch } from "./shepherd/services.js";
import type { VisualThreshold } from "./shepherd/visual-delta-read.js";
import type { DiagnosisPorts, ReplanPorts, VisualPacketPorts } from "./shepherd/spawn-ports.js";
import type { CleanupPorts, ExitNoticePorts, RosterReader, SpawnGate, SuiteRules, TaskClose } from "./shepherd/ports.js";

export interface FactoryRouteDeps extends Omit<LandPrDeps, "gitCache">, Partial<Pick<LandPrDeps, "gitCache">> {
  port: GitHubPort;
  store: ShepherdStoreRef;
  freeze?: FreezeStoreRef;
  /** The per-repo merge train shepherd-pr runs merge through; defaults to one bound with the store. */
  train?: MergeTrainRef;
  holdPollMs?: number;
  /** Paces the snapshot tick and is reported in `/health`; `configuredRoutes` wires one on the `rate_limit` reading. */
  pacing?: TickPacing;
  /** Reads a head's changed files from Shepherd's git cache; absent means the serve process's cached reader. */
  prFiles?: PrFilesRead;
  agentChatBin?: string;
  /** The Claude config directory successors spawn under; the fixer's, since a successor is a fixer in a new session. */
  agentChatConfigDir?: string;
  /** The one roster reader every port over `agentChatBin` shares; absent means each wake reads through its own. */
  roster?: RosterReader;
  /** The one gate every factory-started agent passes; absent means spawns are not gated. */
  spawnGate?: SpawnGate;
  /** The one ledger of machine stops the spawn gate and the broker's refusals feed, read when a reviewer ends with no verdict. */
  machineStop?: MachineStopWatch;
  /** The seat book `shepherd.register` resolves policy against; defaults to no seats, so every registration is refused. */
  seats?: () => SeatBook;
  /** The reviewer reader and dispatch; absent means `sh-review` answers none and the owner gate decides. */
  review?: Omit<ReviewWiring, "isFrozen">;
  /** Read by the merge evidence step, which runs only after a wired review; defaults to no repo frozen. */
  isFrozen?: IsFrozen;
  /** The task and agent ports `sh-cleanup` uses; absent means it deletes the head ref only. */
  cleanup?: CleanupPorts;
  /** How `sh-park` parks the implementer's worktree; defaults to `agent-chat agent park`. */
  park?: ParkPort;
  /** Where the release preflight looks packages up; defaults to registry.npmjs.org. */
  registry?: PackageRegistry;
  /** Where a merged release's versions are looked up; defaults to registry.npmjs.org. */
  versions?: VersionRegistry;
  /** The fix-task and fixer ports a red main uses; absent ports still freeze, and leave the rest to the owner. */
  mainRed?: Omit<MainRedWiring, "freezes">;
  /** The App-token port `sh-publish-review` posts through; absent means it records `published: false`. */
  reviewCheck?: GitHubPort;
  /** Starts `service deploy` after a green merge into the factory's own repo; absent means sh-redeploy spawns nothing. */
  redeploy?: Deployer;
  /** Which reviewer accounts are out of usage; defaults to one bound with the store. */
  accountLimits?: AccountLimitStoreRef;
  /** Tells a repo's seat that a woken fixer exited with no push; absent means the owner gate takes every such exit. */
  exitNotice?: ExitNoticePorts;
  /** The test rules Shepherd's briefs carry; `configuredRoutes` resolves them once from the host serve starts on. */
  suiteRules?: SuiteRules;
  /** What measurement-audit reads and asks; defaults to this checkout's machine and `claude -p`. */
  audit?: AuditPorts;
  /** Repos whose merges, branch updates and pushes Shepherd never makes; defaults to none. */
  advisory?: IsAdvisory;
  /** Repos whose stacked children Shepherd restacks after its own merge; defaults to none. */
  stackRestack?: StackRestackOn;
  /** Serve's GitHub gateway for `shepherd.ghRead` and `shepherd.ghBudget`; absent means those refuse as unavailable. */
  gateway?: GhGateway;
  /** `on` lets a g10 hold gate only the merge, so a held run repairs as usual; absent means `off`. A getter is read per check. */
  heldRepair?: Live<"off" | "on" | undefined>;
  /** `on` lets a vacuous fix-proof on a test-only PR with a tests-only diff proceed to review; absent means `off`. A getter is read per check. */
  noReproProceed?: Live<"off" | "on" | undefined>;
  /** `record-fact` sends a NO_REPRO on a diff with no source path on to review; absent means `keep-owner`. A getter is read per check. */
  nonSourceNoRepro?: Live<"keep-owner" | "record-fact" | undefined>;
  /** `last-slice-only` closes a merged PR's task only on its last slice; absent means `keep`, every merge closes. A getter is read per cleanup. */
  taskClose?: Live<TaskClose | undefined>;
  /** `shepherd.visualPacket` and the ports its spawn uses; absent means `off`. */
  visualPacket?: VisualPacketPorts;
  /** The planner failed rounds with no adversary verdict spawn; absent means ops hears instead. */
  diagnosis?: DiagnosisPorts;
  /** The planner a dead-end gate's replan answer spawns; absent records a refused spawn, so the seat is asked again. */
  replan?: ReplanPorts;
  /** `shepherd.visualDelivery`'s sweep, carried to serve on the services; absent means none runs. */
  visualDelivery?: VisualDeliveryWatch;
  /** True when `shepherd.consoleAnswers` is configured: approve-merge gates then offer `send-back`. */
  consoleAnswers?: boolean;
  /** Where `shepherd thaw` alerts the repo's red seat; absent means each hand thaw only logs its alert. */
  thawAlert?: ThawAlertPorts;
  /** Which repos order overlapping merges behind a conflicted PR's reservation; absent means `merge-order.json`. */
  mergeOrderRules?: MergeOrderRules;
  /** `shepherd.visualThreshold` for `shepherd visual-delta`; absent means the review wiring's, and with neither that command refuses. */
  visualThreshold?: (repo: string) => VisualThreshold | undefined;
  /** Told of each recorded `sh-landed`, to wake the burndown tick; absent means no wake (TP-1433, replaced by TP-1558). */
  mergeWake?: MergeWake;
}
