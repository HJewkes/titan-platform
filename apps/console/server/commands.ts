import { z } from "zod";
import type { CommandMapOf } from "@titan-design/registry";
import { agentsCommands, type AgentsSource } from "./agents.js";
import { blockersCommands } from "./blockers.js";
import { buildInfoCommands } from "./build-info.js";
import { approvalsCommands, type FactoryNeeds } from "./approvals.js";
import { autoresearchCommands, type AutoresearchSource } from "./autoresearch.js";
import type { ActiveWork } from "./active-work.js";
import { configStoreCommands, type ConfigStoreSource } from "./config-store/compare.js";
import { configSurfacesCommands, unconfigured, type SurfaceReader } from "./config-surfaces/catalog.js";
import { coordinatorSurfaces, type CoordinatorRoots } from "./config-surfaces/coordinator.js";
import { configDriftCommands } from "./config-surfaces/drift.js";
import { hostSurfaces as hostSurfaceReaders, type HostSurfaceRoots } from "./config-surfaces/host.js";
import { hostReportsCommands, type HostReportsSource } from "./config-surfaces/host-reports.js";
import { coordinatorCommands, type CoordinatorSource } from "./coordinator.js";
import type { RoundDecisionLog } from "./decision-log.js";
import { graphCommands } from "./graph.js";
import { inboxCommands, type InboxSource } from "./inbox.js";
import { inboxActionCommands, type InboxActionOptions } from "./inbox-actions.js";
import { retireTapCommands } from "./retire-tap.js";
import { inboxViewCommands, type InboxSources } from "./inbox-view.js";
import type { Invalidation } from "./invalidation.js";
import { inboxReadCache } from "./inbox-rows.js";
import { readCommand } from "./owner-guard.js";
import { roundFrameDeltaCommands } from "./round-frame-delta.js";
import { roundFramesCommands } from "./round-frames.js";
import { roundsRevealCommands } from "./round-reveal.js";
import type { RoundListeners } from "./listeners.js";
import { reviewsCommands, type ReviewsSource } from "./reviews.js";
import type { SeatNotifier } from "./round-notice-transport.js";
import { roundsCommands } from "./rounds-commands.js";
import type { RoundsSource } from "./rounds.js";
import { roundsAnswerRecCommands } from "./round-rec-answer.js";
import { roundsSubmitCommands, submitPipeline } from "./rounds-submit.js";
import { sessionsCommands, type SessionsSource } from "./sessions.js";
import { shepherdCommands, type ShepherdSource } from "./shepherd.js";
import { shippedCommands, type ShippedOptions } from "./shipped.js";
import { tasksCommands } from "./tasks.js";
import { UPSTREAM_IDS, probeUpstreams, type Upstream } from "./upstreams.js";
import { summarizeNotes, videoNotesCommands } from "./video-notes.js";
import { videoPropsCommands } from "./video-props.js";
import { videosCommands, type VideoCatalog } from "./videos.js";
import { initiativeResult, knowledgeCommands, portfolioResult, readInitiative, readPortfolio, type WorkOptions } from "./work.js";

const upstreamHealth = z.object({
  id: z.enum(UPSTREAM_IDS),
  label: z.string(),
  target: z.string(),
  reachable: z.boolean(),
  detail: z.string(),
});

/** What the commands read from; built once per daemon from the config. `work` options apply to every `work.*` command. */
export interface ConsoleSources {
  upstreams: readonly Upstream[];
  agents: AgentsSource;
  sessions: SessionsSource;
  activeWork: ActiveWork;
  /** Optional so test sources need not build one; absent, relay frames drop no cached read. */
  invalidation?: Invalidation;
  inbox: InboxSource;
  rounds: RoundsSource;
  shepherd: ShepherdSource;
  /** Optional so test sources need not build one; absent, the `autoresearch.*` reads are not served. */
  autoresearch?: AutoresearchSource;
  /** Optional so test sources need not build one; absent, `config.surfaces` answers one gap for the coordinator files. */
  coordinatorRoots?: CoordinatorRoots;
  /** Optional so test sources need not build one; absent reads as a `factory:` gap in `approvals.flow`. */
  factory?: FactoryNeeds;
  /** Optional so test sources need not build one; absent, `rounds.submit` records nothing and returns no `log`. */
  decisionLog?: RoundDecisionLog;
  /** Optional so test sources need not build one; absent, a submitted round triggers nothing. */
  listeners?: RoundListeners;
  /** Optional so test sources need not build one; absent, `config.surfaces` answers one gap for this host's files. */
  hostSurfaces?: HostSurfaceRoots;
  /** Optional so test sources need not build one; absent, `inbox.prepare`, `inbox.act`, `taps.prepare` and `taps.act` answer that inbox actions are off. */
  inboxActions?: Omit<InboxActionOptions, "decisionLog">;
  /** Optional so test sources need not build one; absent, `config.report` and `config.hosts` are not served. */
  hostReports?: HostReportsSource;
  /** Optional so test sources need not build one; absent, `videos.list` answers that no roots are set. */
  videos?: VideoCatalog;
  /** Optional so test sources need not build one; absent, `videos.note` stores comments and tells no seat. */
  videoNotify?: SeatNotifier;
  /** Optional so test sources need not set one; absent, `videos.props`, `videos.edit-check`, `videos.edit` and `videos.edits` answer one gap naming the setting. */
  explainerBin?: string;
  /** Optional so test sources need not build one; absent, `reviews.list` is not served. */
  reviews?: ReviewsSource;
  work?: WorkOptions;
  /** Optional so test sources need not build one; absent, `coord.pools` is not served. */
  coordinator?: CoordinatorSource;
  /** Optional so test sources need not build one; absent, `coord.shipped` is not served. */
  shipped?: ShippedOptions;
  /** Optional so test sources need not build one; absent, `config.compareTree` is `not-configured`. */
  configStore?: ConfigStoreSource;
  /** Hours before `blockers.banner` shows an item; absent means 12. */
  blockerHours?: number;
}

const ACTIONS_UNWIRED: InboxActionOptions = { enabled: false, actionsDir: "", client: { post: async () => ({ status: "off" }) } };

function upstreamsCommands(upstreams: readonly Upstream[]) {
  return {
    "upstreams.health": readCommand({
      name: "upstreams.health",
      description: "Reachability of the active-work daemon, the agent-chat broker and the session graph",
      args: z.object({}),
      result: z.object({ checkedAt: z.string(), upstreams: z.array(upstreamHealth) }),
      run: async () => ({ checkedAt: new Date().toISOString(), upstreams: await probeUpstreams(upstreams) }),
    }),
  };
}

type OwnerAnswerSources = Pick<ConsoleSources, "factory" | "rounds" | "inbox" | "shepherd" | "agents" | "decisionLog" | "listeners" | "inboxActions">;

/**
 * The owner's merged queue, as the raw Flow, as the inbox with its actions, and every write that answers it: the inbox
 * taps and a round's submit, by hand or by its recommendations. Each write drops the reads the inbox view keeps, and
 * approvals.flow shares the kept factory read; the taps themselves read the factory fresh.
 */
function ownerQueueCommands({ factory, rounds, inbox, shepherd, agents, decisionLog, listeners, inboxActions }: OwnerAnswerSources, invalidation: Invalidation | undefined) {
  const sources: InboxSources = { factory, rounds, inbox, shepherd, agents };
  const cache = inboxReadCache(sources);
  invalidation?.on("factory", cache.invalidate);
  const actions = { ...(inboxActions ?? ACTIONS_UNWIRED), ...(decisionLog && { decisionLog }) };
  return {
    ...roundsSubmitCommands(rounds, decisionLog, listeners, inbox.dir, cache.invalidate),
    ...roundsAnswerRecCommands(rounds, submitPipeline(rounds, decisionLog, listeners, inbox.dir, cache.invalidate)),
    ...approvalsCommands({ ...sources, factory: cache.factory }),
    ...inboxViewCommands(sources, cache),
    ...inboxActionCommands(sources, actions, cache.invalidate),
    ...retireTapCommands({ agents, shepherd }, actions, cache.invalidate),
  };
}

function workCommands(activeWork: ActiveWork, work: WorkOptions | undefined) {
  return {
    "work.portfolio": readCommand({
      name: "work.portfolio",
      description: "Every active-work initiative with its open-task rollup, note, source and session counts, newest activity and personal flag",
      args: z.object({}),
      result: portfolioResult,
      run: () => readPortfolio(activeWork, work),
    }),
    "work.initiative": readCommand({
      name: "work.initiative",
      description: "One active-work initiative: its brief, open tasks, recent sessions, open loops, notes and sources",
      args: z.object({ slug: z.string().min(1) }),
      result: initiativeResult,
      run: ({ slug }) => readInitiative(activeWork, slug, work),
    }),
  };
}

function surfaceReaders(coordinatorRoots: CoordinatorRoots | undefined, hostSurfaces: HostSurfaceRoots | undefined): SurfaceReader[] {
  return [
    coordinatorRoots === undefined ? unconfigured("coordinator surfaces") : coordinatorSurfaces(coordinatorRoots),
    ...(hostSurfaces === undefined ? [unconfigured("host config surfaces")] : hostSurfaceReaders(hostSurfaces)),
  ];
}

/** The coordinator view's reads, each served only when its source is wired. */
function coordinatorReads(coordinator: CoordinatorSource | undefined, shipped: ShippedOptions | undefined, shepherd: ShepherdSource) {
  return {
    ...(coordinator === undefined ? {} : coordinatorCommands(coordinator)),
    ...(shipped === undefined ? {} : shippedCommands(shepherd, shipped)),
  };
}

/** Every command the console daemon serves, keyed by name so the browser's hooks can be typed from it. */
export function consoleCommands({ upstreams, agents, sessions, activeWork, inbox, rounds, shepherd, autoresearch, coordinatorRoots, factory, decisionLog, listeners, hostSurfaces, hostReports, reviews, inboxActions, videos, videoNotify, explainerBin, work, coordinator, configStore, shipped, invalidation, blockerHours }: ConsoleSources) {
  const configReaders = surfaceReaders(coordinatorRoots, hostSurfaces);
  return {
    ...upstreamsCommands(upstreams),
    ...buildInfoCommands(),
    ...configStoreCommands(configStore),
    ...agentsCommands(agents),
    ...sessionsCommands(sessions),
    ...tasksCommands({ activeWork, sessions, work }),
    ...graphCommands({ activeWork, sessions }),
    ...knowledgeCommands(activeWork, work),
    ...inboxCommands(inbox),
    ...roundsCommands(rounds),
    ...roundFramesCommands(rounds),
    ...roundFrameDeltaCommands(rounds),
    ...roundsRevealCommands(rounds),
    ...ownerQueueCommands({ factory, rounds, inbox, shepherd, agents, decisionLog, listeners, inboxActions }, invalidation),
    ...shepherdCommands(shepherd),
    ...blockersCommands({ spoolDir: inbox.dir, shepherd, ...(blockerHours !== undefined && { thresholdHours: blockerHours }) }, invalidation),
    ...(autoresearch === undefined ? {} : autoresearchCommands(autoresearch)),
    ...configSurfacesCommands(configReaders),
    ...configDriftCommands(configReaders),
    ...(hostReports === undefined ? {} : hostReportsCommands(hostReports)),
    ...videosCommands(videos, summarizeNotes),
    ...videoNotesCommands(videos, videoNotify),
    ...videoPropsCommands(videos, explainerBin),
    ...(reviews === undefined ? {} : reviewsCommands(reviews)),
    ...workCommands(activeWork, work),
    ...coordinatorReads(coordinator, shipped, shepherd),
  };
}

export type ConsoleCommands = CommandMapOf<ReturnType<typeof consoleCommands>>;
