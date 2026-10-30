import { z } from "zod";
import type { CoordinatorRoots } from "./config-surfaces/coordinator.js";
import { cardsResult, readCards, type CardsSource } from "./coord-cards.js";
import { dateArg } from "./coord-day.js";
import { poolsResult, readPools } from "./coord-pools.js";
import { readCommand } from "./owner-guard.js";

export interface CoordinatorSource {
  /** Absent, `coord.pools` answers one gap; the same roots `config.surfaces` reads. */
  roots: CoordinatorRoots | undefined;
  /** `HH:MM` local time a coordinator day starts at. */
  dayStart: string;
  /** Absent, `coord.cards` is not served. */
  cards?: CardsSource;
  now?: () => number;
}

/** The coordinator view's reads, which are local file reads of agent-chat's and the autonomy tree's files. */
export function coordinatorCommands({ roots, dayStart, cards, now = Date.now }: CoordinatorSource) {
  return {
    "coord.pools": readCommand({
      name: "coord.pools",
      description: "Each agent-chat account's seven-day use before and during a coordinator day, its reserve line, glide target, level and per-day guard",
      args: z.object({ date: dateArg }),
      result: poolsResult,
      run: ({ date }) => readPools({ roots, dayStart, now: now(), ...(date !== undefined && { date }) }),
    }),
    ...(cards === undefined ? {} : cardsCommands(cards, { roots, dayStart, now })),
  };
}

function cardsCommands(cards: CardsSource, { roots, dayStart, now }: Pick<Required<CoordinatorSource>, "dayStart" | "now"> & Pick<CoordinatorSource, "roots">) {
  return {
    "coord.cards": readCommand({
      name: "coord.cards",
      description: "One card per coordinator that spawned agents in a coordinator day: agents run, live now, cost, PRs merged through Shepherd and tasks with titles",
      args: z.object({ date: dateArg }),
      result: cardsResult,
      run: ({ date }) => readCards(cards, { roots, dayStart, now: now(), ...(date !== undefined && { date }) }),
    }),
  };
}
