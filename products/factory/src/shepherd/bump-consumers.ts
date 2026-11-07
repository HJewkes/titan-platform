import type { RepoSlug } from "@titan-design/github";
import { bumpBranch, consumerDepNames, planConsumerBump, readConsumerTree, type ConsumerBumpPlan, type ConsumerTree, type LatestRegistry } from "./consumer-bump.js";
import { failureOf } from "./error-class.js";
import { lookupSeat, type SeatBook } from "./seats.js";
import type { ShepherdServices } from "./services.js";

/** One behind consumer: the tree read at its default branch, the edits that raise it, and the branch they go on. */
interface PlannedBump {
  repo: RepoSlug;
  tree: ConsumerTree;
  plan: ConsumerBumpPlan;
  branch: string;
}

/** A consumer with nothing to open: already on npm latest, or a read or lookup that failed. */
type ConsumerBumpNote = { repo: RepoSlug; current: true } | { repo: RepoSlug; error: string };

interface ConsumerBumpPlans {
  bumps: PlannedBump[];
  notes: ConsumerBumpNote[];
}

/** Reads only: each seat-book consumer at its default branch, planned against npm latest; one repo's failure is its note and never stops the others. */
export async function planConsumerBumps(services: Pick<ShepherdServices, "port" | "seats">, registry: LatestRegistry): Promise<ConsumerBumpPlans> {
  const latest = memoized(registry);
  const result: ConsumerBumpPlans = { bumps: [], notes: [] };
  for (const repo of consumerRepos(services.seats())) {
    try {
      const planned = await planOne(services, repo, latest);
      if (planned.plan.edits.length === 0) result.notes.push({ repo, current: true });
      else result.bumps.push(planned);
    } catch (error) {
      result.notes.push({ repo, error: failureOf(error) });
    }
  }
  return result;
}

/** Every remote some seat lists, minus the ones a deny or charter hard stop forbids, so a denied repo is never read. */
function consumerRepos(book: SeatBook): RepoSlug[] {
  const remotes = new Set(book.seats.flatMap((seat) => seat.remotes));
  return [...remotes].filter((remote) => lookupSeat(book, remote).kind === "seat").sort();
}

async function planOne(services: Pick<ShepherdServices, "port">, repo: RepoSlug, latest: LatestRegistry): Promise<PlannedBump> {
  const ref = await services.port.defaultBranch(repo);
  const tree = await readConsumerTree(services.port, repo, ref);
  const names = consumerDepNames(tree);
  const versions = new Map(await Promise.all(names.map(async (name) => [name, await latest(name)] as const)));
  const plan = planConsumerBump(tree, versions);
  return { repo, tree, plan, branch: bumpBranch(plan.edits) };
}

/** Consumers share most names, so one sweep asks npm once per name. */
function memoized(registry: LatestRegistry): LatestRegistry {
  const seen = new Map<string, Promise<string | null>>();
  return (name) => {
    let answer = seen.get(name);
    if (!answer) seen.set(name, (answer = registry(name)));
    return answer;
  };
}
