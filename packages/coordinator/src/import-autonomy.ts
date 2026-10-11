import type { Limits } from "@titan-design/agent-dispatch/limits";
import type { CharterPolicy } from "./charter-policy.js";
import type { CoordinatorConfig, CoordinatorSeat } from "./coordinator-config.js";
import type { SeatConfig, SeatRepo } from "./seat-config.js";

type RepoTable = Record<string, SeatRepo>;

function baseId(repo: SeatRepo): string {
  return repo.path.split("/").filter(Boolean).pop() ?? repo.path;
}

// Seats may list the same checkout with different detail, so a repo is shared only when
// the objects are identical; a variant gets its own id rather than losing a seat's keys.
function repoIdFor(repos: RepoTable, repo: SeatRepo): string {
  const base = baseId(repo);
  for (let n = 1; ; n++) {
    const id = n === 1 ? base : `${base}-${n}`;
    const known = repos[id];
    if (known === undefined) {
      repos[id] = repo;
      return id;
    }
    if (JSON.stringify(known) === JSON.stringify(repo)) return id;
  }
}

// The loose seat types carry index signatures, which defeat Omit, so the result is cast back.
function without<T extends object>(value: T, keys: readonly string[]): T {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key))) as T;
}

function toCoordinatorSeat(repos: RepoTable, seat: SeatConfig): CoordinatorSeat {
  const { repos: inline, ...rest } = without(seat, ["schema", "name", "config_dir"]);
  return inline === undefined ? rest : { ...rest, repos: inline.map((repo) => repoIdFor(repos, repo)) };
}

function withSharing(repos: RepoTable, seats: Record<string, CoordinatorSeat>): RepoTable {
  return Object.fromEntries(
    Object.entries(repos).map(([id, repo]) => {
      const users = Object.entries(seats)
        .filter(([, seat]) => seat.repos?.includes(id))
        .map(([name]) => name);
      const listed = repo.shared_with ?? [];
      const missing = users.filter((user) => !listed.includes(user));
      return [id, users.length > 1 && missing.length > 0 ? { ...repo, shared_with: [...listed, ...missing] } : repo];
    }),
  );
}

/**
 * Builds a titan-coordinator/v1 document from parsed charter and seat front matter and a
 * limits block. Pure: the caller reads and parses the files, then runs checkCoordinatorConfig.
 */
export function importAutonomyTree(
  charter: CharterPolicy,
  seatFiles: readonly SeatConfig[],
  limits: Limits,
): CoordinatorConfig {
  const repos: RepoTable = {};
  const seats = Object.fromEntries(seatFiles.map((seat) => [seat.name, toCoordinatorSeat(repos, seat)]));
  const { hard_stops, defaults, human_only_initiatives } = charter;
  return {
    $schema: "titan-coordinator/v1",
    owner: { seat: charter.owner_seat ?? charter.hub },
    repos: withSharing(repos, seats),
    seats,
    limits,
    policy: {
      hard_stops,
      defaults,
      ...(human_only_initiatives === undefined ? {} : { human_only_initiatives }),
    },
  };
}

function toSeatFile(config: CoordinatorConfig, name: string, seat: CoordinatorSeat): SeatConfig {
  const { repos, ...rest } = without(seat, ["dispatch"]);
  const inline = repos?.map((id) => config.repos[id] as SeatRepo);
  const pool = config.limits.pools[seat.pool];
  return {
    schema: "autonomy-seat/v1",
    name,
    ...rest,
    config_dir: (pool as { config_dir: string }).config_dir,
    ...(inline === undefined ? {} : { repos: inline }),
  };
}

/** Renders a document's seats as the seat files they came from, taking config_dir from each seat's pool. */
export function renderSeatBook(config: CoordinatorConfig): SeatConfig[] {
  return Object.entries(config.seats).map(([name, seat]) => toSeatFile(config, name, seat));
}
