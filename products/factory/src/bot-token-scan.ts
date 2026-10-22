import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { openDatabase, type Db } from "@titan-design/store-sqlite";
import { z } from "zod";
import { readFingerprint } from "./bot-token-fingerprint.js";

const SCAN_PLACES = ["env", "briefs", "logs", "transcripts", "store"] as const;
export type ScanPlace = (typeof SCAN_PLACES)[number];

/** Every place the scan reads, injectable so tests run on fixture dirs and never on the real /proc or home. */
export interface ScanSources {
  procRoot: string;
  /** Only this uid's processes are read: the scan runs as the agents' uid, and what an agent can reach is the question. */
  uid: number;
  briefs: readonly string[];
  logs: readonly string[];
  transcripts: readonly string[];
  /** The factory database, dumped row by row through a read-only connection. */
  store: string | undefined;
}

/** A hit names its place and where in it, never the matched string. */
interface ScanHit {
  place: ScanPlace;
  where: string;
}

export type ScanReport = { state: "no-fingerprint" } | { state: "scanned"; hits: ScanHit[]; scanned: Record<ScanPlace, number>; missing: { place: ScanPlace; root: string }[] };

// Unbounded on the right: a token run straight into more token characters is found by trying each token-length prefix.
const CLASSIC_RUN = /ghp_[A-Za-z0-9]{36,}/g;
const CLASSIC_LENGTH = 40;
const FINE_GRAINED_RUN = /github_pat_[A-Za-z0-9_]{22,}/g;
const FINE_GRAINED_LENGTHS = { min: 33, max: 266 };
const CHUNK_BYTES = 1024 * 1024;
const CARRY_CHARS = FINE_GRAINED_LENGTHS.max + 1;
const LOG_FILE = /\.log(\.\d+)?$/;

type Matcher = (text: string) => boolean;

function prefixesMatch(run: string, lengths: number[], fingerprint: string): boolean {
  return lengths.some((length) => length <= run.length && createHash("sha256").update(run.slice(0, length)).digest("hex") === fingerprint);
}

function matcherFor(fingerprint: string): Matcher {
  const fineLengths = Array.from({ length: FINE_GRAINED_LENGTHS.max - FINE_GRAINED_LENGTHS.min + 1 }, (_, i) => FINE_GRAINED_LENGTHS.min + i);
  return (text) =>
    [...text.matchAll(CLASSIC_RUN)].some(([run]) => prefixesMatch(run, [CLASSIC_LENGTH], fingerprint)) ||
    [...text.matchAll(FINE_GRAINED_RUN)].some(([run]) => prefixesMatch(run, fineLengths, fingerprint));
}

/** Reads in chunks with a carry longer than any token, so a large transcript never sits in memory whole and no token is cut. */
function fileHolds(file: string, matches: Matcher): boolean {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(CHUNK_BYTES);
    let carry = "";
    for (let read = readSync(fd, buffer); read > 0; read = readSync(fd, buffer)) {
      const text = carry + buffer.toString("latin1", 0, read);
      if (matches(text)) return true;
      carry = text.slice(-CARRY_CHARS);
    }
    return false;
  } finally {
    closeSync(fd);
  }
}

/** Symlinks are not followed, so a link loop or a link out of the place cannot widen or hang the walk. */
function filesUnder(dir: string): string[] {
  if (readable(() => statSync(dir).isFile())) return [dir];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    return entry.isFile() ? [path] : [];
  });
}

/** A file that vanishes or is unreadable mid-walk is skipped: the scan reports what it could read. */
function readable(read: () => boolean): boolean {
  try {
    return read();
  } catch {
    return false;
  }
}

interface PlaceScan {
  hits: string[];
  scanned: number;
}

function scanFiles(roots: readonly string[], matches: Matcher, keep: (name: string) => boolean = () => true): PlaceScan {
  const files = roots.filter((root) => existsSync(root)).flatMap((root) => filesUnder(root).filter((file) => keep(file)));
  return { hits: files.filter((file) => readable(() => fileHolds(file, matches))), scanned: files.length };
}

function scanEnv(procRoot: string, uid: number, matches: Matcher): PlaceScan {
  if (!existsSync(procRoot)) return { hits: [], scanned: 0 };
  const pids = readdirSync(procRoot).filter((name) => /^\d+$/.test(name) && readable(() => statSync(join(procRoot, name)).uid === uid));
  const hits = pids.filter((pid) => readable(() => fileHolds(join(procRoot, pid, "environ"), matches)));
  return { hits: hits.map((pid) => `pid ${pid}`), scanned: pids.length };
}

function cellHolds(cell: unknown, matches: Matcher): boolean {
  if (typeof cell === "string") return matches(cell);
  return Buffer.isBuffer(cell) && matches(cell.toString("latin1"));
}

function tableHolds(db: Db, table: string, matches: Matcher): boolean {
  for (const row of db.prepare(`SELECT * FROM "${table.replaceAll('"', '""')}"`).raw().iterate()) {
    if (Array.isArray(row) && row.some((cell) => cellHolds(cell, matches))) return true;
  }
  return false;
}

function scanStore(file: string | undefined, matches: Matcher): PlaceScan {
  if (file === undefined || !existsSync(file)) return { hits: [], scanned: 0 };
  const db = openDatabase(file, { readonly: true, foreignKeys: false });
  try {
    const names = z.array(z.string()).parse(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all());
    const tables = names.filter((name) => !name.startsWith("sqlite_"));
    return { hits: tables.filter((table) => tableHolds(db, table, matches)).map((table) => `table ${table}`), scanned: tables.length };
  } finally {
    db.close();
  }
}

function missingRoots(sources: ScanSources): { place: ScanPlace; root: string }[] {
  const store = sources.store === undefined ? [] : [sources.store];
  const roots: [ScanPlace, readonly string[]][] = [["env", [sources.procRoot]], ["briefs", sources.briefs], ["logs", sources.logs], ["transcripts", sources.transcripts], ["store", store]];
  return roots.flatMap(([place, list]) => list.filter((root) => !existsSync(root)).map((root) => ({ place, root })));
}

/** A17: is the bot's token anywhere an agent can read? Matches token-shaped strings by SHA-256 against serve's fingerprint. */
export function scanForBotToken(fingerprintFile: string, sources: ScanSources): ScanReport {
  const fingerprint = readFingerprint(fingerprintFile);
  if (fingerprint === undefined) return { state: "no-fingerprint" };
  const matches = matcherFor(fingerprint);
  const places: Record<ScanPlace, PlaceScan> = {
    env: scanEnv(sources.procRoot, sources.uid, matches),
    briefs: scanFiles(sources.briefs, matches),
    logs: scanFiles(sources.logs, matches, (file) => LOG_FILE.test(file)),
    transcripts: scanFiles(sources.transcripts, matches),
    store: scanStore(sources.store, matches),
  };
  const { env, briefs, logs, transcripts, store } = places;
  return {
    state: "scanned",
    hits: SCAN_PLACES.flatMap((place) => places[place].hits.map((where) => ({ place, where }))),
    scanned: { env: env.scanned, briefs: briefs.scanned, logs: logs.scanned, transcripts: transcripts.scanned, store: store.scanned },
    missing: missingRoots(sources),
  };
}
