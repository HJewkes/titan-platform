/**
 * When the by-rec sweep first saw a round (TP-6773), so the owner's wait is measured from a time the asker cannot set.
 * round.json's mtime is the asker's to write (`utimes`, or `cp -p`, `rsync -a` and `tar -x` by accident), so the sweep
 * keeps its own first-seen file in the console's state dir, written `wx` once per round and manifest, and waits from the
 * later of that and the mtime. A rewritten round.json has a new sha, so it gets a fresh first-seen time too.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { readStateJson, writeJsonOnce } from "./state-file.js";

const BY_REC_SEEN_DIR = "auto-by-rec-seen";
const SEEN_SCHEMA = "titan-console/auto-by-rec-seen@1";
const seenSchema = z.object({ schema: z.literal(SEEN_SCHEMA), at: z.iso.datetime({ offset: true }) });

interface SeenRound {
  id: string;
  manifestSha256: string;
  updatedAt: string;
}

const seenFile = (stateDir: string, round: SeenRound): string =>
  path.join(stateDir, BY_REC_SEEN_DIR, `${encodeURIComponent(round.id)}@${round.manifestSha256}.json`);

const later = (a: string, b: string): string => (Date.parse(a) >= Date.parse(b) ? a : b);

/**
 * The time the round's wait starts. A first-seen file that is missing records `now`; one that will not parse counts as
 * seen `now` on every pass, so a damaged file keeps the round waiting and never shortens the wait.
 */
export async function byRecOpenedAt(stateDir: string, round: SeenRound, now: Date): Promise<string> {
  const file = seenFile(stateDir, round);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeJsonOnce(file, { schema: SEEN_SCHEMA, at: now.toISOString() });
  return byRecSeenAt(stateDir, round, now);
}

/** The same start, read only: a round no sweep has seen yet starts its wait `now`, as the sweep's first sighting would. */
export async function byRecSeenAt(stateDir: string, round: SeenRound, now: Date): Promise<string> {
  const seen = (await readStateJson(seenFile(stateDir, round), seenSchema))?.at ?? now.toISOString();
  return later(seen, round.updatedAt);
}
