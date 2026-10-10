import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { compileGlobs, expandBraces } from "@titan-design/fix-proof";
import { isRepo } from "@titan-design/github";
import { z } from "zod";

export { isRepo as isRepoKey } from "@titan-design/github";

export const MERGE_ON_GREEN_GRANT = "merge-on-green-approve";

/** Lets a run merge into a base other than the repo's default branch, as a stacked PR's is; only a seat can grant it. */
export const FEATURE_BASE_GRANT = "merge-into-feature-base";

/** Every repo reference is canonicalised here, so denies and lookups compare one form. */
const RemoteSchema = z
  .string()
  .refine(isRepo, "must be a bare owner/name")
  .transform((remote) => remote.toLowerCase());

/** A glob that cannot compile would match nothing, so it is refused rather than read as no visual path. */
const VisualPathsSchema = z
  .array(z.string().min(1))
  .min(1, "list at least one glob, or leave visual_paths out")
  .refine((globs) => {
    try {
      compileGlobs(globs);
      return true;
    } catch {
      return false;
    }
  }, "every glob must compile");

/** A path as written (slashes tidied, case kept, for spawn cwds) and its one comparison key. */
export interface RepoPath {
  written: string;
  key: string;
}

const PATH_PREFIXES = ["~/", "$HOME/", "${HOME}/", "/"] as const;
export const HOME_PREFIXES: readonly string[] = ["~/", "$HOME/", "${HOME}/"];
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
    repos: z.array(z.object({ path: path.optional(), remote: RemoteSchema.optional(), read_only: z.boolean().optional() })).default([]),
    deny_repos: z.array(path).default([]),
    grants_extra: z.array(z.string()).default([]),
    visual_paths: VisualPathsSchema.optional(),
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
  /** Repo-relative globs a PR must touch none of to merge without the owner; absent means the seat has not opted in. */
  visualPaths?: string[];
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
  checkVisualPathsRelative(files);
  const seats = files.map(({ data }) => toSeat(data));
  const denied = files.flatMap(({ file, data }) => data.deny_repos.map((path) => resolveDeny(path, file, index)));
  const stops = charterHardStops(sources.charterPath);
  for (const [stop, remotes] of Object.entries(sources.hardStopRepos ?? {})) {
    if (stops.includes(stop)) denied.push(...remotes.map((r) => r.toLowerCase()));
  }
  return { seats, denied };
}

/** A malformed key or a deny wins over any seat; a remote several seats list gets the grants they all share and the visual paths of all of them. */
export function lookupSeat(book: SeatBook, repo: string): SeatLookup {
  if (!isRepo(repo)) return { kind: "denied", reason: `${JSON.stringify(repo)} is not an owner/name repo` };
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
  const visualPaths = sharedVisualPaths(seats);
  return { name: seats.map((s) => s.name).join("+"), remotes: [...new Set(seats.flatMap((s) => s.remotes))], paths, grants, ...(visualPaths && { visualPaths }) };
}

/**
 * The union of every seat's visual paths, so a path any seat calls visual gates. A seat that neither opted in nor holds
 * the merge grant would merge nothing alone, so the shared seat gets no visual paths and stays at the owner gate.
 */
function sharedVisualPaths(seats: Seat[]): string[] | undefined {
  const autoCapable = seats.every((s) => s.visualPaths !== undefined || s.grants.includes(MERGE_ON_GREEN_GRANT));
  const lists = seats.flatMap((s) => s.visualPaths ?? []);
  return autoCapable && seats.some((s) => s.visualPaths !== undefined) ? [...new Set(lists)] : undefined;
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

/** Why a glob can match no changed path, which GitHub spells as plain `/`-joined segments; undefined when it can. */
function unmatchableReason(glob: string): string | undefined {
  if (glob.trim() !== glob) return "has leading or trailing whitespace";
  if (glob.includes("\\")) return "has a backslash";
  const segments = glob.split("/");
  if (segments.includes("")) return "has an empty segment (a leading, doubled or trailing /)";
  if (segments.some((segment) => segment === "." || segment === "..")) return "has a . or .. segment";
  return undefined;
}

const FORMAT_CHARACTER = /\p{Cf}/u;

function codePoint(char: string): string {
  return `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
}

/** Characters that look like path syntax or nothing at all, so the glob reads right but no changed path spells it. */
function lookAlikeReason(glob: string): string | undefined {
  if (glob.includes("\uFF0F")) return "has a fullwidth slash (U+FF0F)";
  const format = FORMAT_CHARACTER.exec(glob)?.[0];
  return format === undefined ? undefined : `has a format character (${codePoint(format)})`;
}

/** Matching expands braces first, so each alternative must be matchable on its own; the seat book already refused a glob that cannot expand. */
function globReason(glob: string): string | undefined {
  const lookAlike = lookAlikeReason(glob);
  if (lookAlike !== undefined) return lookAlike;
  for (const alternative of expandBraces(glob)) {
    const reason = unmatchableReason(alternative);
    if (reason !== undefined) return alternative === glob ? reason : `has the alternative ${JSON.stringify(alternative)}, which ${reason}`;
  }
  return undefined;
}

/**
 * Changed files are repo-relative paths in one spelling, so a glob outside it matches none of them and its visual paths
 * would never gate. It is refused rather than normalised, so the seat owner sees what they wrote did nothing.
 */
function checkVisualPathsRelative(files: NamedSeatFile[]): void {
  for (const { file, data } of files) {
    for (const glob of data.visual_paths ?? []) {
      const reason = globReason(glob);
      if (reason !== undefined) throw new SeatBookInvalid(`seat ${data.name} visual_paths glob ${JSON.stringify(glob)} ${reason}, so it matches no repo-relative path (${file})`);
    }
  }
}

/** A deny resolves through the global index; unbound, its basename must itself be a repo name or the seat book is invalid. */
function resolveDeny(path: RepoPath, file: string, index: Map<string, string>): string {
  const remote = index.get(path.key);
  if (remote !== undefined) return remote;
  const name = path.key.split("/").pop()!;
  if (!isRepo(`owner/${name}`)) throw new SeatBookInvalid(`deny path ${JSON.stringify(path.written)} in ${file} matches no seat repo and ${JSON.stringify(name)} is not a repo name`);
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

/** Only an explicit `read_only: true` makes an entry a listing; absent or false keeps it owned; a non-boolean is refused. */
function toSeat(data: SeatFile): Seat {
  const owned = data.repos.filter((r) => r.read_only !== true);
  const remotes = owned.flatMap((r) => (r.remote ? [r.remote] : []));
  const paths = Object.fromEntries(owned.flatMap((r) => (r.remote && r.path ? [[r.remote, r.path.written]] : [])));
  return { name: data.name, remotes, paths, grants: data.grants_extra, ...(data.visual_paths && { visualPaths: data.visual_paths }) };
}

/** No configured charter means no hard stops; a configured one must exist and parse. */
function charterHardStops(path: string | undefined): string[] {
  if (!path) return [];
  return parseFrontmatter(path, "charter", CharterSchema).hard_stops;
}
