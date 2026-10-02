import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

/** A GitHub `owner/name` with no URL, `.git` suffix, all-dot name, extra path segment or whitespace. */
export function isRepoKey(repo: string): boolean {
  return /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo) && !/\.git$/i.test(repo) && !/\/\.+$/.test(repo);
}

/** Every repo reference is canonicalised here, so denies and lookups compare one form. */
const RemoteSchema = z
  .string()
  .refine(isRepoKey, "must be a bare owner/name")
  .transform((remote) => remote.toLowerCase());

/** A path as written (slashes tidied, case kept, for spawn cwds) and its one comparison key. */
export interface RepoPath {
  written: string;
  key: string;
}

const PATH_PREFIXES = ["~/", "$HOME/", "${HOME}/", "/"] as const;
const HOME_PREFIXES: readonly string[] = ["~/", "$HOME/", "${HOME}/"];
const PATH_SEGMENT = /^[A-Za-z0-9._-]+(?: +[A-Za-z0-9._-]+)*$/;

/** An allowlist: a known prefix then plain segments (inner spaces alias nothing); any other spelling is refused, since it could only miss a deny. */
function pathSegments(path: string): { prefix: string; segments: string[] } | undefined {
  const prefix = PATH_PREFIXES.find((p) => path.startsWith(p));
  if (prefix === undefined) return undefined;
  const segments = path.slice(prefix.length).split("/").filter((segment) => segment !== "");
  const plain = segments.every((segment) => PATH_SEGMENT.test(segment) && segment !== "." && segment !== "..");
  return segments.length > 0 && plain ? { prefix, segments } : undefined;
}

/** Lowercased, slashes collapsed, trailing slash dropped, and `$HOME`, `${HOME}` or the home dir spelled `~`. */
function repoPathKey(prefix: string, segments: string[], home: string): string {
  const rest = segments.join("/").toLowerCase();
  if (HOME_PREFIXES.includes(prefix)) return `~/${rest}`;
  const homeKey = `${home.toLowerCase()}/`;
  const absolute = `/${rest}`;
  return absolute.startsWith(homeKey) ? `~/${absolute.slice(homeKey.length)}` : absolute;
}

function repoPathSchema(home: string) {
  return z.string().transform((path, ctx): RepoPath => {
    const parsed = pathSegments(path);
    if (!parsed) {
      ctx.addIssue({ code: "custom", message: `path ${JSON.stringify(path)} is not an allowed path: ~/, $HOME/, \${HOME}/ or / then segments of [A-Za-z0-9._-] with inner spaces` });
      return z.NEVER;
    }
    return { written: parsed.prefix + parsed.segments.join("/"), key: repoPathKey(parsed.prefix, parsed.segments, home) };
  });
}

/** The injected home must itself be an allowed absolute path, or home unification would silently match nothing. */
function checkedHome(home: string): string {
  const parsed = pathSegments(home);
  if (!parsed || parsed.prefix !== "/") throw new SeatBookInvalid(`home ${JSON.stringify(home)} must be an absolute directory other than /`);
  return `/${parsed.segments.join("/")}`;
}

/** The autonomy-seat/v1 frontmatter fields Shepherd reads; every other seat field is ignored. */
function seatFileSchema(home: string) {
  const path = repoPathSchema(home);
  return z.object({
    schema: z.literal("autonomy-seat/v1"),
    name: z.string().min(1),
    repos: z.array(z.object({ path: path.optional(), remote: RemoteSchema.optional(), read_only: z.unknown().optional() })).default([]),
    deny_repos: z.array(path).default([]),
    grants_extra: z.array(z.string()).default([]),
  });
}

const CharterSchema = z.object({ schema: z.literal("autonomy-charter/v1"), hard_stops: z.array(z.string()) });

export interface Seat {
  name: string;
  /** `owner/name` remotes this seat owns. */
  remotes: string[];
  /** Lowercased remote to the seat's checkout path as written, slashes tidied (`~` unexpanded); the cwd for spawns. */
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
  /** The home directory a seat path may spell literally; defaults to the OS home. */
  home?: string;
}

export class SeatBookInvalid extends Error {
  override readonly name = "SeatBookInvalid";
}

export function frontmatter(text: string): unknown {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  return match ? parse(match[1]!) : undefined;
}

/** Any invalid seat file or charter throws; a deny path unknown to every seat denies its basename under any owner. */
export function loadSeatBook(sources: SeatSources): SeatBook {
  const files = readSeatFiles(sources.seatsDir, checkedHome(sources.home ?? homedir()));
  const index = pathIndex(files);
  checkRemotePaths(files);
  const seats = files.map(({ data }) => toSeat(data));
  const denied = files.flatMap(({ file, data }) => data.deny_repos.map((path) => resolveDeny(path, file, index)));
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
  const seats = book.seats.filter((s) => s.remotes.includes(remote));
  return seats.length > 0 ? { kind: "seat", seat: narrowest(seats) } : { kind: "none" };
}

function narrowest(seats: Seat[]): Seat {
  if (seats.length === 1) return seats[0]!;
  const grants = seats[0]!.grants.filter((g) => seats.every((s) => s.grants.includes(g)));
  const paths = Object.assign({}, ...seats.map((s) => s.paths)) as Record<string, string>;
  return { name: seats.map((s) => s.name).join("+"), remotes: [...new Set(seats.flatMap((s) => s.remotes))], paths, grants };
}

type SeatFile = z.infer<ReturnType<typeof seatFileSchema>>;

interface NamedSeatFile {
  file: string;
  data: SeatFile;
}

function readSeatFiles(dir: string | undefined, home: string): NamedSeatFile[] {
  if (!dir || !existsSync(dir)) return [];
  const schema = seatFileSchema(home);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => ({ file: join(dir, f), data: parseFrontmatter(join(dir, f), "seat file", schema) }));
}

/** One path-to-remote map across all seats; a path two seats bind to different remotes is a conflict. */
function pathIndex(files: NamedSeatFile[]): Map<string, string> {
  const owners = new Map<string, { remote: string; file: string }>();
  for (const { file, data } of files) {
    for (const { path, remote } of data.repos) {
      if (!path || !remote) continue;
      const seen = owners.get(path.key);
      if (seen && seen.remote !== remote) throw new SeatBookInvalid(`path ${path.key} maps to ${seen.remote} in ${seen.file} and to ${remote} in ${file}`);
      owners.set(path.key, { remote, file });
    }
  }
  return new Map([...owners].map(([path, { remote }]) => [path, remote]));
}

/** A remote bound to two checkout paths would let the later seat file silently pick the spawn cwd. */
function checkRemotePaths(files: NamedSeatFile[]): void {
  const seen = new Map<string, { path: RepoPath; file: string }>();
  for (const { file, data } of files) {
    for (const { path, remote } of data.repos) {
      if (!path || !remote) continue;
      const prior = seen.get(remote);
      if (prior && prior.path.key !== path.key) throw new SeatBookInvalid(`remote ${remote} is bound to ${prior.path.written} in ${prior.file} and to ${path.written} in ${file}`);
      if (!prior) seen.set(remote, { path, file });
    }
  }
}

/** A deny resolves through the global index; unbound, its basename must itself be a repo name or the seat book is invalid. */
function resolveDeny(path: RepoPath, file: string, index: Map<string, string>): string {
  const remote = index.get(path.key);
  if (remote !== undefined) return remote;
  const name = path.key.split("/").pop()!;
  if (!isRepoKey(`owner/${name}`)) throw new SeatBookInvalid(`deny path ${JSON.stringify(path.written)} in ${file} matches no seat repo and ${JSON.stringify(name)} is not a repo name`);
  return name;
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

/** Only an explicit `read_only: true` makes an entry a listing; absent or any other value keeps it owned. */
function toSeat(data: SeatFile): Seat {
  const owned = data.repos.filter((r) => r.read_only !== true);
  const remotes = owned.flatMap((r) => (r.remote ? [r.remote] : []));
  const paths = Object.fromEntries(owned.flatMap((r) => (r.remote && r.path ? [[r.remote, r.path.written]] : [])));
  return { name: data.name, remotes, paths, grants: data.grants_extra };
}

/** No configured charter means no hard stops; a configured one must exist and parse. */
function charterHardStops(path: string | undefined): string[] {
  if (!path) return [];
  return parseFrontmatter(path, "charter", CharterSchema).hard_stops;
}
