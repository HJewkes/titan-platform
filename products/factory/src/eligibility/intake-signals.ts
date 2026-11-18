import type { Task } from "@titan-design/pm";
import type { Verbs } from "../cli-types.js";
import { EXIT } from "../exit-codes.js";
import { runFinished, watchRows } from "../shepherd/watch-rows.js";

/** Of the given `owner/repo#n` refs, the ones whose Shepherd run ended stopped; throws when Shepherd could not be read. */
export type StoppedPrRead = (prs: ReadonlySet<string>) => Promise<ReadonlySet<string>>;

/** The `from_pr` refs the tasks were filed from; only follow-up and review work carries one. */
export function citedPrs(tasks: readonly Task[]): Set<string> {
  return new Set(tasks.flatMap((task) => (typeof task.source_ref === "object" ? [task.source_ref.from_pr] : [])));
}

/** Reads finished Shepherd runs for the cited PRs only, from the factory's own store; reads only. */
export function liveStoppedPrs(verbs: Verbs): StoppedPrRead {
  return async (prs) => {
    if (prs.size === 0) return new Set();
    let stopped: Set<string> | undefined;
    await verbs.withHost(async (host, routes) => {
      if (!routes.shepherd) throw new Error("this host was opened without the shepherd routes");
      const rows = await watchRows(host, routes.shepherd, (registration, status) => runFinished(status) && prs.has(`${registration.repo}#${registration.pr}`));
      stopped = new Set(rows.filter((row) => row.outcome?.kind === "stopped").map((row) => `${row.repo}#${row.pr}`));
      return EXIT.OK;
    });
    if (stopped === undefined) throw new Error("Shepherd's runs could not be read");
    return stopped;
  };
}
