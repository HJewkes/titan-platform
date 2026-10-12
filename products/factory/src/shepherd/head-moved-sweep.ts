import type { Logger } from "@titan-design/daemon";
import type { FactoryHost } from "../host.js";
import { startSweep, type Sweep } from "../sweep.js";
import type { ShepherdServices } from "./commands.js";
import { supersedeMovedGates } from "./head-moved.js";

/** Matches the PR snapshot's tick, so a quiet sweep reads only the shared, ETag'd open list and an owner never sees a gate stale for more than a minute. */
const HEAD_MOVED_SWEEP_MS = 60_000;

export interface HeadMovedSweepOptions {
  /** How often head-bound gates are checked for a PR head that moved under them; defaults to 1 minute. */
  headMovedSweepMs?: number;
}

/** Its own sweep, apart from the merged-elsewhere one, so a merged-elsewhere read that throws never skips it. Ticks once before it returns. */
export async function startHeadMovedSweep(host: FactoryHost, services: ShepherdServices, { headMovedSweepMs }: HeadMovedSweepOptions, log: Logger): Promise<Sweep> {
  const supersede = async (): Promise<void> => {
    for (const moved of await supersedeMovedGates(host, services)) log.info({ ...moved }, "superseded a head gate whose PR head moved");
  };
  const sweep = startSweep(supersede, headMovedSweepMs ?? HEAD_MOVED_SWEEP_MS, "head-moved sweep", log);
  await sweep.tick();
  return sweep;
}
