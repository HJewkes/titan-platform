// The synthetic review rounds in `fixtures/rounds`, for tests and the owner's browser check. Nothing there is copied from a real round;
// the PNGs under `ship-tile-r1` and `beacon-states-r1` are solid blocks with a stripe (and a dot), generated once by a throwaway script.
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RoundsSource } from "./rounds.js";

export const FIXTURE_ROUNDS: RoundsSource = { dir: path.join(import.meta.dirname, "..", "fixtures", "rounds") };

export interface StagedRound {
  source: RoundsSource;
  /** The round's feedback.json, parsed; rejects until a submit has written it. */
  feedback: () => Promise<unknown>;
  remove: () => Promise<void>;
}

/** A temp rounds dir with fixture round `from` copied in as `id` under a test's own round.json, so a test can submit to it. */
export async function stagedRound(from: string, id: string, roundJson: unknown): Promise<StagedRound> {
  const root = await mkdtemp(path.join(tmpdir(), "staged-round-"));
  await cp(path.join(FIXTURE_ROUNDS.dir, from), path.join(root, id), { recursive: true });
  await writeFile(path.join(root, id, "round.json"), JSON.stringify(roundJson));
  return {
    source: { dir: root },
    feedback: async () => JSON.parse(await readFile(path.join(root, id, "feedback.json"), "utf8")) as unknown,
    remove: () => rm(root, { recursive: true, force: true }),
  };
}
