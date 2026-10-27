/**
 * `fileRound`, the core of `titan-console decisions file`: a seat hands it one round@2 round.json that asks
 * questions only, and it lands in the console's own rounds dir as `<unit>-r<round>/` with an `asker.json` naming
 * the seat and initiative that asked (`round-asker.ts`). Nothing is written anywhere else.
 *
 * A round with variants or a merge-bound Ship question is refused: those carry frames or a packet, which only a
 * review-harness dir has, so they go through `rounds import`. The round is filed through `importRound` from a
 * private temp dir, so it passes the same checks and the same staged rename, and the temp dir is removed after.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EXIT } from "@titan-design/registry";
import { failure } from "./active-work.js";
import { ASKER_FILE, ASKER_SCHEMA_ID, SEAT_NAME, readAsker, writeJsonOnce, type AskerRecord } from "./round-asker.js";
import { importRound } from "./round-import.js";
import type { Manifest } from "./round-schema.js";
import { MAX_ROUND_BYTES, ROUND_FILE, parseManifest } from "./rounds.js";

interface Asker {
  seat: string;
  initiative: string | null;
}

export interface FileResult extends Asker {
  id: string;
  /** False when the same round.json was already filed; its first asker is kept. */
  created: boolean;
}

interface FileArgs {
  body: string;
  roundsDir: string;
  asker: Asker;
  now?: Date;
}

const refuse = (message: string, code: number = EXIT.DATAERR): never => {
  throw failure(`decision round refused: ${message}`, code);
};

function checkAsker({ seat, initiative }: Asker): void {
  if (!SEAT_NAME.test(seat)) refuse(`seat "${seat}" is not an agent-chat name (lowercase letters, digits and dashes)`, EXIT.USAGE);
  if (initiative !== null && !SEAT_NAME.test(initiative)) refuse(`initiative "${initiative}" is not a slug`, EXIT.USAGE);
}

function checkQuestionsOnly(manifest: Manifest): void {
  const rounds = "import a round with frames or a Ship question with `titan-console rounds import <round-dir>`";
  if (manifest.variants.length > 0) refuse(`a decision round asks questions only, and this one has ${manifest.variants.length} variants; ${rounds}`);
  const ship = manifest.questions.find((question) => question.kind === "pick-one" && question.merge !== undefined);
  if (ship) refuse(`a decision round asks questions only, and question ${ship.id} is a merge-bound Ship; ${rounds}`);
}

function readRound(body: string): Buffer {
  const bytes = Buffer.from(body, "utf8");
  if (bytes.length > MAX_ROUND_BYTES) refuse(`the round is over ${MAX_ROUND_BYTES} bytes`);
  const parsed = parseManifest(bytes);
  if (!parsed.ok) return refuse(`${ROUND_FILE}: ${parsed.reason}`);
  checkQuestionsOnly(parsed.manifest);
  return bytes;
}

async function importFromTemp(bytes: Buffer, roundsDir: string): Promise<{ id: string; created: boolean }> {
  const source = await mkdtemp(path.join(tmpdir(), "titan-console-decision-"));
  try {
    await writeFile(path.join(source, ROUND_FILE), bytes, { mode: 0o600 });
    return await importRound({ source, roundsDir });
  } finally {
    await rm(source, { recursive: true, force: true });
  }
}

export async function fileRound({ body, roundsDir, asker, now = new Date() }: FileArgs): Promise<FileResult> {
  checkAsker(asker);
  const { id, created } = await importFromTemp(readRound(body), roundsDir);
  const dir = path.join(path.resolve(roundsDir), id);
  const record: AskerRecord = { schema: ASKER_SCHEMA_ID, ...asker, filedAt: now.toISOString() };
  if (await writeJsonOnce(path.join(dir, ASKER_FILE), record)) return { id, created, ...asker };
  const first = (await readAsker(dir)) ?? refuse(`round ${id} holds an ${ASKER_FILE} that is not an asker@1 record`);
  return { id, created, seat: first.seat, initiative: first.initiative };
}
