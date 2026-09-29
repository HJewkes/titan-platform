import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

const SeatRepoSchema = z.object({ path: z.string().min(1).optional(), remote: z.string().optional() });

/** The autonomy-seat/v1 frontmatter fields Shepherd reads; every other seat field is ignored. */
const SeatFileSchema = z.object({
  schema: z.literal("autonomy-seat/v1"),
  name: z.string().min(1),
  repos: z.array(SeatRepoSchema).default([]),
  deny_repos: z.array(z.string()).default([]),
  grants_extra: z.array(z.string()).default([]),
});

const CharterSchema = z.object({ hard_stops: z.array(z.string()).default([]) });

/** A GitHub `owner/name` with no URL, `.git` suffix, extra path segment or whitespace. */
export function isRepoKey(repo: string): boolean {
  return /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo) && !/\.git$/i.test(repo);
}

export interface Seat {
  name: string;
  /** `owner/name` remotes this seat owns. */
  remotes: string[];
  /** Lowercased remote to the seat's local checkout path, as written (`~` unexpanded); the cwd for spawns. */
  paths: Record<string, string>;
  grants: string[];
}

export interface SeatBook {
  seats: Seat[];
  /** Remotes (lowercased) or bare repo names (lowercased) no registration may target. */
  denied: string[];
}

export type SeatLookup = { kind: "seat"; seat: Seat } | { kind: "none" } | { kind: "denied"; reason: string };

export interface SeatSources {
  seatsDir?: string;
  charterPath?: string;
  /** Charter hard-stop id to the `owner/name` remotes it forbids, e.g. `dotfiles-merge`. */
  hardStopRepos?: Record<string, string[]>;
}

export class SeatBookInvalid extends Error {
  override readonly name = "SeatBookInvalid";
}

export function frontmatter(text: string): unknown {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  return match ? parse(match[1]!) : undefined;
}

/** Reads every seat file plus the charter; a missing seats directory is an empty book, any invalid file throws. */
export function loadSeatBook(sources: SeatSources): SeatBook {
  const files = readSeatFiles(sources.seatsDir);
  const seats = files.map(toSeat);
  const denied = files.flatMap(deniedRemotes);
  const stops = charterHardStops(sources.charterPath);
  for (const [stop, remotes] of Object.entries(sources.hardStopRepos ?? {})) {
    if (stops.includes(stop)) denied.push(...remotes.map((r) => r.toLowerCase()));
  }
  return { seats, denied };
}

/** A malformed key or a deny wins over any seat; a remote several seats list gets the grants they all share. */
export function lookupSeat(book: SeatBook, repo: string): SeatLookup {
  if (!isRepoKey(repo)) return { kind: "denied", reason: `${JSON.stringify(repo)} is not an owner/name repo` };
  const remote = repo.toLowerCase();
  const name = remote.split("/")[1]!;
  if (book.denied.includes(remote) || book.denied.includes(name)) return { kind: "denied", reason: `${repo} is on a seat deny list or a charter hard stop` };
  const seats = book.seats.filter((s) => s.remotes.some((r) => r.toLowerCase() === remote));
  return seats.length > 0 ? { kind: "seat", seat: narrowest(seats) } : { kind: "none" };
}

function narrowest(seats: Seat[]): Seat {
  if (seats.length === 1) return seats[0]!;
  const grants = seats[0]!.grants.filter((g) => seats.every((s) => s.grants.includes(g)));
  const paths = Object.assign({}, ...seats.map((s) => s.paths)) as Record<string, string>;
  return { name: seats.map((s) => s.name).join("+"), remotes: [...new Set(seats.flatMap((s) => s.remotes))], paths, grants };
}

type SeatFile = z.infer<typeof SeatFileSchema>;

function readSeatFiles(dir: string | undefined): SeatFile[] {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => parseFrontmatter(join(dir, f), "seat file", SeatFileSchema));
}

function parseFrontmatter<T>(path: string, kind: string, schema: z.ZodType<T>): T {
  let parsed: z.ZodSafeParseResult<T>;
  try {
    parsed = schema.safeParse(frontmatter(readFileSync(path, "utf8")));
  } catch (error) {
    throw new SeatBookInvalid(`unreadable ${kind} ${path}: ${(error as Error).message}`);
  }
  if (!parsed.success) throw new SeatBookInvalid(`invalid ${kind} ${path}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "$"}: ${i.message}`).join("; ")}`);
  return parsed.data;
}

function toSeat(data: SeatFile): Seat {
  const remotes = data.repos.flatMap((r) => (r.remote ? [r.remote] : []));
  const paths = Object.fromEntries(data.repos.flatMap((r) => (r.remote && r.path ? [[r.remote.toLowerCase(), r.path]] : [])));
  return { name: data.name, remotes, paths, grants: data.grants_extra };
}

/** A deny entry is a path: the same seat's `repos[]` maps it to a remote, else its basename stands for the repo name. */
function deniedRemotes(data: SeatFile): string[] {
  return data.deny_repos.map((path) => {
    const remote = data.repos.find((r) => r.path === path)?.remote;
    return (remote ?? basename(path)).toLowerCase();
  });
}

/** No configured charter means no hard stops; a configured one must exist and parse. */
function charterHardStops(path: string | undefined): string[] {
  if (!path) return [];
  return parseFrontmatter(path, "charter", CharterSchema).hard_stops;
}
