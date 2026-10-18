import type { IsolationName, SurfaceName, SubscribableKind, WakeSource } from "./names.js";

export type SubscriptionSelector = { all: true } | { name: string } | { tag: string } | { spawnedBy: 'self' }

export interface Subscription {
  selector: SubscriptionSelector
  kinds: SubscribableKind[]
}

export interface ExperimentArm {
  id: string
  arm: string
}

export type SpawnRequest = {
      t: 'spawn'
      name: string
      profile: string
      brief: string
      cwd?: string
      isolation?: IsolationName
      surface?: SurfaceName
      /**
       * An active-work initiative slug, or `auto`, whose brief, open tasks and
       * latest session are prepended to `brief` by the broker (CC-63), followed by
       * what the active-work daemon ranks as related to `brief` (CC-101). Sent as a
       * pointer rather than as text so the requester cannot use it to have
       * arbitrary files read back to it — the broker resolves what it will read.
       */
      briefing?: string
      /**
       * A worktree the TASK SYSTEM assigned, rather than one the profile's
       * isolation strategy chose (CC-72). Isolation is a property of the work,
       * not of the agent: several tasks can share one worktree under file
       * ownership, and a child task inherits its parent's. agent-chat's side of
       * that is ACCEPTING an assignment, never computing one — so this is an
       * absolute path that must already exist, and the strategy is bypassed
       * rather than asked.
       */
      worktree?: string
      /**
       * Path globs, relative to the worktree, that this agent owns (CC-81).
       * Turns `file-ownership` isolation from a no-op into a real assignment:
       * they become the agent's claim, checked against what live peers already
       * hold in the same worktree.
       */
      owns?: string[]
      /**
       * CC-952: path globs, relative to the agent's own worktree, the broker
       * claims as a `files` claim held by the agent's name, so the burndown tick
       * sees them before the agent registers. Unlike `owns` it isolates nothing
       * and is accepted with a worktree profile.
       */
      claimPaths?: string[]
      /** CC-1158: the `origin/<branch>` a worktree spawn is cut from; a stacked slice names its parent's PR branch. */
      baseRef?: string
      /**
       * CC-44: start the agent from a COPY of the requester's own conversation
       * instead of from an empty one. `'context'` is the only value, and there
       * is deliberately no field naming WHOSE conversation — the broker resolves
       * that from the requesting connection, the same discipline `anchor` and
       * `parentAgentId` follow, because a fork hands an entire conversation to a
       * new process and only the session that owns one may do that.
       */
      inherit?: 'context'
      /** H-12: explicit opt-in to `--remote-control` for an interactive agent; headless ignores it. */
      remoteControl?: boolean
      /**
       * The Claude Code session id the requester claims to be forking, checked
       * against the one the broker observed for this connection and REFUSED when
       * they differ.
       *
       * Exists only to make that refusal explicit. The MCP tool never sends it —
       * a model has no way to name a transcript — but the socket is one client
       * among several (see `sanitizeSubscriptions` for the same reasoning), and a
       * raw client asking to fork a peer should be told no rather than quietly
       * getting its own transcript back.
       */
      forkFrom?: string
      /** Tags and subscriptions the spawned agent starts with, before it runs. */
      tags?: string[]
      subscriptions?: Subscription[]
      /**
       * CC-100: the Claude config dir — and therefore the ACCOUNT — this agent
       * should run on, named explicitly. An absolute path under the user's home
       * that already exists; anything else is refused rather than corrected,
       * because running on a different account than the one asked for is the
       * failure this field exists to prevent.
       */
      configDir?: string
      /**
       * The REQUESTER's own `CLAUDE_CONFIG_DIR`, observed by its MCP server from
       * its own environment (CC-100).
       *
       * Sent rather than only read from the registry because the human at the CLI
       * holds no registry entry to read it from, and they are the caller most
       * likely to have switched accounts in their shell. For a registered session
       * the broker falls back to what that session reported on `register`, which
       * is the same value from the same environment.
       */
      spawnerConfigDir?: string
      /**
       * CC-126: a Claude Code session uuid to continue instead of minting a new
       * one. Its transcript must already exist under the chosen config dir and
       * cwd; the broker refuses otherwise and names the path it checked.
       */
      resumeSession?: string
      /**
       * CC-133: the name of the agent whose work this one takes over. Sent as a
       * name, not text: the broker reads its last report, branch and transcript
       * from the log, and refuses unless the requester spawned it.
       */
      predecessor?: string
      /** CC-168: the experiment and arm this spawn runs; both must be non-empty or the spawn is refused. */
      experiment?: ExperimentArm
      /** CC-286: `none` stops the broker appending its return contract to `brief`. */
      returnContract?: 'none'
      /** CC-774: the class-of-service tier the burndown plan placed the task in; recorded on the `dispatched` row. */
      tier?: number
      /**
       * CC-802: who a CLI spawn is on behalf of. Only an unregistered connection's claim is read, since a
       * session is already named by its registration; the row then records it in place of the human.
       */
      spawnedAs?: 'burndown' | 'shepherd'
      /** CC-1206: the agent identity in the CLI caller's env; only lowers trust, read only from an unregistered connection. */
      callerAgent?: string
      /** CC-915: the task id the agent runs, recorded on its spawn row; a burndown spawn without one is refused. */
      task?: string
      /** CC-915: implementer, reviewer, fix-round-N, shepherd-review, planner or other; inferred when absent. */
      workRole?: string
      /** CC-932: `fix-round` states that a spawn on a claimed or brief-ready task is the seat's own fix round. */
      override?: 'fix-round'
      /** CC-1059: the requester's own OS, sent by its process and never by the model; picks a remote surface. */
      hostPlatform?: string
      /** CC-1059: the requester can launch a spawn on its own host; absent is an older client, launched here. */
      launchesHere?: true
      /** CC-1059: the machine to launch on, a config `machines` alias or a hostname. */
      host?: string
      /** CC-1059: the CLI's own hostname. Read only from an unregistered connection; a session's comes from its registration. */
      callerHost?: string
      /** CC-1059: the requester's home, which the broker's lexical cwd check holds a remote cwd under. */
      callerHome?: string
    };

export type ResumeRequest = {
      t: 'resume'
      name: string
      surface?: SurfaceName
      message?: string
      source?: WakeSource
      /** CC-883: run with `--remote-control` if the agent is a coordinator; a worker resumes without it. */
      remoteControl?: boolean
    };

export type RetireRequest = { t: 'retire'; name: string; force?: boolean; caller?: string; agentId?: string };

export type AgentListRequest = { t: 'agents'; includeRetired?: boolean };

export type SurfaceRequest = { t: 'surface'; name: string };
