import { z } from "zod";
import type { CoordinatorRoots } from "./config-surfaces/coordinator.js";
import { isCalendarDate } from "./coord-day.js";
import { poolsResult, readPools } from "./coord-pools.js";
import { readCommand } from "./owner-guard.js";

export interface CoordinatorSource {
  /** Absent, `coord.pools` answers one gap; the same roots `config.surfaces` reads. */
  roots: CoordinatorRoots | undefined;
  /** `HH:MM` local time a coordinator day starts at. */
  dayStart: string;
  now?: () => number;
}

const dateArg = z.string().refine(isCalendarDate, "a date as YYYY-MM-DD").optional();

/** The coordinator view's reads, which are local file reads of agent-chat's and the autonomy tree's files. */
export function coordinatorCommands({ roots, dayStart, now = Date.now }: CoordinatorSource) {
  return {
    "coord.pools": readCommand({
      name: "coord.pools",
      description: "Each agent-chat account's seven-day use before and during a coordinator day, its reserve line, glide target, level and per-day guard",
      args: z.object({ date: dateArg }),
      result: poolsResult,
      run: ({ date }) => readPools({ roots, dayStart, now: now(), ...(date !== undefined && { date }) }),
    }),
  };
}
