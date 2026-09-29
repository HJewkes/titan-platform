import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

const SeatRepoSchema = z.object({ path: z.string().optional(), remote: z.string().optional() });

/** The autonomy-seat/v1 frontmatter fields Shepherd reads; every other seat field is ignored. */
const SeatFileSchema = z.object({
  schema: z.literal("autonomy-seat/v1"),
  name: z.string().min(1),
  repos: z.array(SeatRepoSchema).default([]),
  deny_repos: z.array(z.string()).default([]),
  grants_extra: z.array(z.string()).default([]),
});

const CharterSchema = z.object({ hard_stops: z.array(z.string()).default([]) });

export interface Seat {
  name: string;
  /** `owner/name` remotes this seat owns. */
  remotes: string[];
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
}

/** The charter's `dotfiles-merge` hard stop names this one repo. */
export const DOTFILES_REMOTE = "HJewkes/dotfiles";

export function frontmatter(text: string): unknown {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  return match ? parse(match[1]!) : undefined;
}

/** Reads every seat file, in filename order, plus the charter; a missing directory or charter reads as empty. */
export function loadSeatBook(sources: SeatSources): SeatBook {
  const files = readSeatFiles(sources.seatsDir);
  const seats = files.map(({ data }) => toSeat(data));
  const denied = files.flatMap(({ data }) => deniedRemotes(data));
  if (charterHardStops(sources.charterPath).includes("dotfiles-merge")) denied.push(DOTFILES_REMOTE.toLowerCase());
  return { seats, denied };
}

/** A deny wins over any seat; otherwise the first seat listing the remote owns it. */
export function lookupSeat(book: SeatBook, repo: string): SeatLookup {
  const remote = repo.toLowerCase();
  const name = remote.split("/").pop() ?? remote;
  if (book.denied.includes(remote) || book.denied.includes(name)) return { kind: "denied", reason: `${repo} is on a seat deny list or a charter hard stop` };
  const seat = book.seats.find((s) => s.remotes.some((r) => r.toLowerCase() === remote));
  return seat ? { kind: "seat", seat } : { kind: "none" };
}

type SeatFile = z.infer<typeof SeatFileSchema>;

function readSeatFiles(dir: string | undefined): { data: SeatFile }[] {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .flatMap((f) => {
      const parsed = SeatFileSchema.safeParse(frontmatter(readFileSync(join(dir, f), "utf8")));
      return parsed.success ? [{ data: parsed.data }] : [];
    });
}

function toSeat(data: SeatFile): Seat {
  const remotes = data.repos.flatMap((r) => (r.remote ? [r.remote] : []));
  return { name: data.name, remotes, grants: data.grants_extra };
}

/** A deny entry is a path: the same seat's `repos[]` maps it to a remote, else its basename stands for the repo name. */
function deniedRemotes(data: SeatFile): string[] {
  return data.deny_repos.map((path) => {
    const remote = data.repos.find((r) => r.path === path)?.remote;
    return (remote ?? basename(path)).toLowerCase();
  });
}

function charterHardStops(path: string | undefined): string[] {
  if (!path || !existsSync(path)) return [];
  const parsed = CharterSchema.safeParse(frontmatter(readFileSync(path, "utf8")));
  return parsed.success ? parsed.data.hard_stops : [];
}
