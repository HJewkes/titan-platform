import type { GitHubPort, RepoSlug } from "@titan-design/github";
import type { StepRoute } from "@titan-design/workflow";
import { z } from "zod";
import type { FreezeGuard } from "./freeze.js";
import { HOLD_POLL_MS, type HoldTiming } from "./hold.js";

/** True for a repo where Shepherd reviews, watches CI and notifies, but never writes to a branch; read fresh on every call. */
export type IsAdvisory = (repo: RepoSlug) => boolean;

/** The `shepherd.repos` map as one read of the config finds it; undefined when no config file is there. */
export type AdvisoryRead = () => Readonly<Record<string, { advisory?: boolean }>> | undefined;

export class AdvisoryRefused extends Error {
  override readonly name = "AdvisoryRefused";
}

/** Keys match in any case; when two keys differ only in case and either is advisory, the repo is. */
const advisoryKeys = (repos: Readonly<Record<string, { advisory?: boolean }>>): Set<string> =>
  new Set(Object.entries(repos).flatMap(([repo, config]) => (config.advisory === true ? [repo.toLowerCase()] : [])));

/** Where the last good advisory set outlives the process; `load` gives undefined when nothing usable is remembered. */
export interface AdvisoryMemory {
  load(): readonly string[] | undefined;
  save(repos: readonly string[]): void;
}

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => a.size === b.size && [...a].every((repo) => b.has(repo));

function remembered(memory: AdvisoryMemory | undefined): Set<string> {
  try {
    return new Set((memory?.load() ?? []).map((repo) => repo.toLowerCase()));
  } catch {
    return new Set();
  }
}

/**
 * Fail closed: the advisory repos are those the last read that succeeded named, and the first read happens at once.
 * A config file that is absent, unreadable or invalid, as while it is moved or rewritten, keeps every flag it last set.
 * With a memory, that last good set also outlives the process, so a serve started with no config file still holds;
 * deleting the config on purpose therefore leaves its flags in force until a config without them is read.
 */
export function stickyAdvisory(read: AdvisoryRead, memory?: AdvisoryMemory): IsAdvisory {
  let advisory = remembered(memory);
  let saved = advisory;
  const remember = (): void => {
    if (!memory || sameSet(advisory, saved)) return;
    try {
      memory.save([...advisory].sort());
      saved = advisory;
    } catch {
      return;
    }
  };
  const refresh = (): void => {
    try {
      const repos = read();
      if (repos === undefined) return;
      advisory = advisoryKeys(repos);
    } catch {
      return;
    }
    remember();
  };
  refresh();
  return (repo) => {
    refresh();
    return advisory.has(repo.toLowerCase());
  };
}

/** Holds every merge of an advisory repo, so its run waits held instead of failing. */
export function advisoryGuard(isAdvisory: IsAdvisory): FreezeGuard {
  return {
    reason: async (_port, repo) => (isAdvisory(repo) ? `${repo} is advisory: Shepherd reviews and reports but never merges` : undefined),
  };
}

const UpdateTarget = z.looseObject({ repo: z.string() });

/** Wraps the `update-branch` route so an advisory repo's update waits, abort-safe, until the flag is removed. */
export function advisoryUpdates(route: StepRoute, isAdvisory: IsAdvisory, timing: HoldTiming): StepRoute {
  return {
    ...route,
    runner: {
      run: async (input) => {
        const { repo } = UpdateTarget.parse(JSON.parse(input.prompt));
        while (isAdvisory(repo)) {
          input.signal.throwIfAborted();
          await timing.sleep(timing.pollMs ?? HOLD_POLL_MS, input.signal);
        }
        return route.runner.run(input);
      },
    },
  };
}

/** The fail-closed backstop under the guard: no merge, branch update, push or ref delete for an advisory repo reaches GitHub by any route. */
export function advisoryPort(port: GitHubPort, isAdvisory: IsAdvisory): GitHubPort {
  const refuse = (repo: RepoSlug, write: string): void => {
    if (isAdvisory(repo)) throw new AdvisoryRefused(`${repo} is advisory: Shepherd never ${write}`);
  };
  return {
    ...port,
    merge: async (repo, ...rest) => (refuse(repo, "merges"), port.merge(repo, ...rest)),
    updateBranch: async (repo, ...rest) => (refuse(repo, "updates a branch"), port.updateBranch(repo, ...rest)),
    pushEmptyCommit: async (repo, ...rest) => (refuse(repo, "pushes"), port.pushEmptyCommit(repo, ...rest)),
    deleteRef: async (repo, ...rest) => (refuse(repo, "deletes a ref"), port.deleteRef(repo, ...rest)),
  };
}
