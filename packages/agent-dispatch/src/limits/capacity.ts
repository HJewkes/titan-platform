import type { ParsedLimits } from "./parse.js";
import type { BriefGate } from "./schema.js";

/** `unset` leaves the product's own default in force; the limits block names no code default for these. */
export type SettingSource = "capacity" | "shepherd" | "seat" | "unset";

export interface ResolvedSetting<T> {
  value: T | null;
  source: SettingSource;
}

export interface ResolvedCapacity {
  max_agents: ResolvedSetting<number>;
  reserve_slots: ResolvedSetting<number>;
  max_worktrees_per_repo: ResolvedSetting<number>;
  reserve_worktrees: ResolvedSetting<number>;
  hand_reserve: ResolvedSetting<number>;
  brief_gate: ResolvedSetting<BriefGate>;
}

export interface ResolvedShepherd {
  spawn_gate: { load5: ResolvedSetting<number>; build_load5: ResolvedSetting<number> };
  review: { max_concurrent: ResolvedSetting<number> };
}

function setting<T>(value: T | undefined, source: Exclude<SettingSource, "unset">): ResolvedSetting<T> {
  return value === undefined ? { value: null, source: "unset" } : { value, source };
}

/** The host's agent and worktree slots, plus the seat's own hand reserve and brief gate when a seat is named. */
export function resolveCapacity(parsed: ParsedLimits, seat?: string): ResolvedCapacity {
  const capacity = parsed.limits.capacity ?? {};
  const seatLimits = seat === undefined ? undefined : parsed.limits.seats[seat];
  return {
    max_agents: setting(capacity.max_agents, "capacity"),
    reserve_slots: setting(capacity.reserve_slots, "capacity"),
    max_worktrees_per_repo: setting(capacity.max_worktrees_per_repo, "capacity"),
    reserve_worktrees: setting(capacity.reserve_worktrees, "capacity"),
    hand_reserve: setting(seatLimits?.hand_reserve, "seat"),
    brief_gate: setting(seatLimits?.brief_gate, "seat"),
  };
}

/** Shepherd's spawn gate and review cap; an unset field keeps Shepherd's own config value. */
export function resolveShepherd(parsed: ParsedLimits): ResolvedShepherd {
  const shepherd = parsed.limits.shepherd ?? {};
  return {
    spawn_gate: {
      load5: setting(shepherd.spawn_gate?.load5, "shepherd"),
      build_load5: setting(shepherd.spawn_gate?.build_load5, "shepherd"),
    },
    review: { max_concurrent: setting(shepherd.review?.max_concurrent, "shepherd") },
  };
}
