import { z } from "zod";
import type { CommandMapOf } from "@titan-design/registry";
import { agentsCommands, type AgentsSource } from "./agents.js";
import { approvalsCommands, type FactoryNeeds } from "./approvals.js";
import type { ActiveWork } from "./active-work.js";
import { configSurfacesCommands, unconfigured } from "./config-surfaces/catalog.js";
import { coordinatorSurfaces, type CoordinatorRoots } from "./config-surfaces/coordinator.js";
import type { DecisionLog } from "./decision-log.js";
import { graphCommands } from "./graph.js";
import { inboxCommands, type InboxSource } from "./inbox.js";
import { inboxViewCommands, type InboxSources } from "./inbox-view.js";
import { readCommand } from "./owner-guard.js";
import { roundFramesCommands } from "./round-frames.js";
import type { RoundListeners } from "./listeners.js";
import { roundsCommands, type RoundsSource } from "./rounds.js";
import { roundsSubmitCommands } from "./rounds-submit.js";
import { sessionsCommands, type SessionsSource } from "./sessions.js";
import { shepherdCommands, type ShepherdSource } from "./shepherd.js";
import { tasksCommands } from "./tasks.js";
import { UPSTREAM_IDS, probeUpstreams, type Upstream } from "./upstreams.js";
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
  inbox: InboxSource;
  rounds: RoundsSource;
  shepherd: ShepherdSource;
  /** Optional so test sources need not build one; absent, `config.surfaces` answers one gap. */
  coordinatorRoots?: CoordinatorRoots;
  /** Optional so test sources need not build one; absent reads as a `factory:` gap in `approvals.flow`. */
  factory?: FactoryNeeds;
  /** Optional so test sources need not build one; absent, `rounds.submit` records nothing and returns no `log`. */
  decisionLog?: DecisionLog;
  /** Optional so test sources need not build one; absent, a submitted round triggers nothing. */
  listeners?: RoundListeners;
  work?: WorkOptions;
}

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

/** The owner's merged queue, as the raw Flow and as the inbox with its actions. */
function ownerQueueCommands(sources: InboxSources) {
  return { ...approvalsCommands(sources), ...inboxViewCommands(sources) };
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

/** Every command the console daemon serves, keyed by name so the browser's hooks can be typed from it. */
export function consoleCommands({ upstreams, agents, sessions, activeWork, inbox, rounds, shepherd, coordinatorRoots, factory, decisionLog, listeners, work }: ConsoleSources) {
  return {
    ...upstreamsCommands(upstreams),
    ...agentsCommands(agents),
    ...sessionsCommands(sessions),
    ...tasksCommands({ activeWork, sessions, work }),
    ...graphCommands({ activeWork, sessions }),
    ...knowledgeCommands(activeWork, work),
    ...inboxCommands(inbox),
    ...roundsCommands(rounds),
    ...roundFramesCommands(rounds),
    ...roundsSubmitCommands(rounds, decisionLog, listeners),
    ...ownerQueueCommands({ factory, rounds, inbox, shepherd }),
    ...shepherdCommands(shepherd),
    ...configSurfacesCommands([coordinatorRoots === undefined ? unconfigured("coordinator surfaces") : coordinatorSurfaces(coordinatorRoots)]),
    ...workCommands(activeWork, work),
  };
}

export type ConsoleCommands = CommandMapOf<ReturnType<typeof consoleCommands>>;
