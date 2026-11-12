// `titan-factory shepherd visual-feedback-notes` (TP-5410): the sweep over the console's answered feedback rounds, with the
// real ports: rounds read from the console rounds dir, tasks added with the active-work CLI, a JSON ledger in the state dir.
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EXIT, defineCommand } from "@titan-design/registry";
import { z } from "zod";
import { configPath, factoryStateDir, loadConfig } from "../config.js";
import type { FactoryContext } from "../context.js";
import { coded } from "./register-args.js";
import { systemDeliveryExec, type DeliveryExec } from "./visual-delivery.js";
import { sweepFeedbackNotes, type NoteTask, type NotesPorts, type NotesResult } from "./visual-feedback-notes.js";

const Args = z.object({ initiative: z.string().min(1) });
const LEDGER = "visual-feedback-notes.json";
const ENOENT = "ENOENT";

const readOrUndefined = (file: string): Promise<string | undefined> =>
  readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === ENOENT) return undefined;
    throw error;
  });

async function readLedger(file: string): Promise<string[]> {
  const parsed = z.array(z.string()).safeParse(JSON.parse((await readOrUndefined(file)) ?? "[]"));
  if (!parsed.success) throw new Error(`${file} is not a list of keys`);
  return parsed.data;
}

async function writeLedger(file: string, keys: readonly string[]): Promise<void> {
  await mkdir(join(file, ".."), { recursive: true, mode: 0o700 });
  await writeFile(`${file}.tmp`, `${JSON.stringify([...keys].sort(), null, 2)}\n`, { mode: 0o600 });
  await rename(`${file}.tmp`, file);
}

async function addTask(exec: DeliveryExec, task: NoteTask): Promise<void> {
  const argv = ["active-work", "task", "add", task.initiative, "--title", task.title, "--done-when", task.doneWhen, "--tags", "visual-feedback", "--notes", task.notes, "--quiet"];
  const result = await exec(argv, AbortSignal.timeout(60_000));
  if (result.status !== 0) throw new Error(`active-work task add exit ${result.status}: ${result.detail}`);
}

function portsOf(roundsDir: string, ledger: string, exec: DeliveryExec): NotesPorts {
  return {
    roundIds: async () => (await readdir(roundsDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(),
    read: (id, file) => readOrUndefined(join(roundsDir, id, file)),
    filed: async () => new Set(await readLedger(ledger)),
    file: async (task) => {
      await addTask(exec, task);
      await writeLedger(ledger, [...(await readLedger(ledger)), task.key]);
    },
  };
}

export const visualFeedbackNotesCommand = defineCommand<z.infer<typeof Args>, NotesResult, FactoryContext>({
  name: "shepherd.visual-feedback-notes",
  description: "File one active-work task per non-blank note of every answered feedback round in the console rounds dir; initiative is the fallback for a PR with no task. A re-run files nothing already filed",
  args: Args,
  result: z.custom<NotesResult>(),
  run: async ({ initiative }) => {
    const delivery = loadConfig(configPath(process.env)).shepherd?.visualDelivery;
    if (delivery?.roundsDir === undefined) throw coded("visual-feedback-notes needs shepherd.visualDelivery.roundsDir", EXIT.UNAVAILABLE);
    const ledger = join(factoryStateDir(process.env), LEDGER);
    return sweepFeedbackNotes(portsOf(delivery.roundsDir, ledger, systemDeliveryExec(delivery.roundsDir)), initiative);
  },
});
