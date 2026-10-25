import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import { appDirs } from "@titan-design/app-paths";
import { WorkflowRunStore } from "@titan-design/workflow";
import { Command, CommanderError, InvalidArgumentError, Option } from "commander";
import { z } from "zod";
import { loadBeatSpecs } from "../beat-load.js";
import { ResolvedSchema } from "../resolve-stage.js";
import { applyEdit, SlotEditSchema, type EditBase, type FieldChange, type SlotEdit } from "../slot-edit.js";
import { slotOverrideProblems } from "../slot-overrides.js";
import { ScriptSchema, type ScriptV1 } from "../script-schema.js";
import { ArtifactStore } from "./artifacts.js";
import { EditLedgerSchema, editIdOf, editLogFile, ledgerFile, listLedgers, writeLedger, type EditLedger } from "./edit-ledger.js";
import { dataDirOption } from "./run-cli.js";
import { openState, runView, type RunView } from "./host.js";
import { readJson } from "./run-dir.js";

const EXIT = { OK: 0, REFUSED: 1, USAGE: 2 } as const;
/** A runaway backstop only: resolve is deterministic and every tts take is cached, so an edit run spends nothing. */
export const EDIT_BUDGET_USD = 0.25;
const MAX_EDIT_BYTES = 256 * 1024;

type Resolved = z.infer<typeof ResolvedSchema>;
/** Launches `explainer <argv>` detached, its output appended to `logFile`; tests pass a fake. */
export type DetachedSpawn = (argv: readonly string[], logFile: string) => void;
/**
 * The template fill's verdict on the edited script: each problem the filled slots would raise (the whole parse and the
 * emphasis gate). TP-4134's `fillScript` plugs in here; until then `edit check` runs without it.
 */
export type FillCheck = (script: ScriptV1, resolved: Resolved) => string[];

export interface EditCliDeps {
  out?: (text: string) => void;
  err?: (text: string) => void;
  readStdin?: () => string;
  spawn?: DetachedSpawn;
  fill?: FillCheck;
}

type Io = Required<Pick<EditCliDeps, "out" | "err">>;

export interface EditVerdict {
  ok: boolean;
  editId?: string;
  problems: string[];
  diff: FieldChange[];
}

// The running bin is `explainer` itself, so the detached run is the same build that stored the edit.
const spawnDetached: DetachedSpawn = (argv, logFile) => {
  mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = openSync(logFile, "a");
  try {
    spawn(process.execPath, [process.argv[1]!, ...argv], { detached: true, stdio: ["ignore", fd, fd] }).unref();
  } finally {
    closeSync(fd);
  }
};

const dataDirOf = (flags: { dataDir?: string }): string => flags.dataDir ?? appDirs("explainer").data;
const issues = (error: z.ZodError, prefix = ""): string[] => error.issues.map((issue) => `${[prefix, ...issue.path.map(String)].filter(Boolean).join(".")}: ${issue.message}`);

function readEdit(file: string, deps: EditCliDeps): { edit?: SlotEdit; problems: string[] } {
  const text = file === "-" ? (deps.readStdin ?? (() => readFileSync(0, "utf8")))() : readFileSync(file, "utf8");
  if (Buffer.byteLength(text) > MAX_EDIT_BYTES) return { problems: [`edit: larger than ${MAX_EDIT_BYTES} bytes`] };
  const parsed = SlotEditSchema.safeParse(JSON.parse(text));
  return parsed.success ? { edit: parsed.data, problems: [] } : { problems: issues(parsed.error) };
}

function withStore<T>(dataDir: string, use: (store: ArtifactStore) => T): T {
  const db = openState(dataDir);
  try {
    return use(new ArtifactStore(dataDir, db));
  } finally {
    db.close();
  }
}

/** The base run's script, resolved beats and, when the run holds them, the fill's generated slots. */
function editBase(dataDir: string, view: RunView): EditBase & { resolved: Resolved } {
  const { script, resolved, slots } = view.artifacts;
  if (script === undefined || resolved === undefined) throw new Error(`run ${view.runId} has no resolved script; an edit needs a run that finished resolve`);
  return withStore(dataDir, (store) => {
    const beats = ResolvedSchema.parse(JSON.parse(store.readText(resolved)));
    const generated = slots === undefined ? {} : { generated: z.record(z.string(), z.unknown()).parse(JSON.parse(store.readText(slots))) };
    return { runId: view.runId, scriptSha: script, script: JSON.parse(store.readText(script)), layers: new Map(beats.beats.map((b) => [b.id, b.layer])), resolved: beats, ...generated };
  });
}

/** What resolve would refuse in the edited script: the schema, the slot-overrides gate, and the fill when it exists. */
function scriptProblems(script: unknown, resolved: Resolved, fill: FillCheck | undefined): string[] {
  const parsed = ScriptSchema.safeParse(script);
  if (!parsed.success) return issues(parsed.error, "script");
  return [...slotOverrideProblems(parsed.data.beats, resolved.beats, loadBeatSpecs()), ...(fill?.(parsed.data, resolved) ?? [])];
}

interface Checked extends EditVerdict {
  script?: Record<string, unknown>;
  view?: RunView;
}

function checkEdit(dataDir: string, edit: SlotEdit, fill: FillCheck | undefined): Checked {
  const view = runView(dataDir, edit.base.runId);
  const base = editBase(dataDir, view);
  const applied = applyEdit(base, edit);
  if (!applied.ok) return { ok: false, problems: applied.problems, diff: [] };
  const problems = scriptProblems(applied.script, base.resolved, fill);
  return { ok: problems.length === 0, editId: editIdOf(edit), problems, diff: applied.diff, script: applied.script, view };
}

function readAndCheck(file: string, dataDir: string, deps: EditCliDeps): { edit?: SlotEdit; checked: Checked } {
  const { edit, problems } = readEdit(file, deps);
  return edit ? { edit, checked: checkEdit(dataDir, edit, deps.fill) } : { checked: { ok: false, problems, diff: [] } };
}

const verdictOf = ({ ok, editId, problems, diff }: Checked): EditVerdict => ({ ok, ...(editId ? { editId } : {}), problems, diff });

export function editRunArgv(dataDir: string, view: RunView, editId: string, scriptSha: string): string[] {
  const where = [...(view.profile ? ["--profile", view.profile] : []), ...(view.theater ? ["--theater", view.theater] : [])];
  return [
    "run", "--from", "resolve", "--base", view.runId, "--pin", `script=${scriptSha}`, "--edit", editId,
    "--budget-usd", String(EDIT_BUDGET_USD), "--data-dir", dataDir, ...where,
  ];
}

interface Applied {
  editId: string;
  scriptSha: string;
  started: boolean;
}

function startedBefore(dataDir: string, editId: string): EditLedger | undefined {
  const ledger = readJson(ledgerFile(dataDir, editId), EditLedgerSchema);
  return ledger?.status === "started" ? ledger : undefined;
}

/** Stores the edited script and its ledger row; with `start`, launches the linked run from resolve, detached. */
function storeEdit(dataDir: string, edit: SlotEdit, checked: Checked & { script: Record<string, unknown>; view: RunView }, start: boolean, deps: EditCliDeps): Applied {
  const editId = editIdOf(edit);
  const earlier = start ? startedBefore(dataDir, editId) : undefined;
  if (earlier) throw new Error(`edit ${editId} already started run ${earlier.runId ?? "(starting)"}; one save makes one run`);
  const text = `${JSON.stringify(checked.script, null, 2)}\n`;
  const scriptSha = withStore(dataDir, (store) => store.putText(text, "script", { runId: "input", stage: "edit" }));
  writeLedger(dataDir, {
    schema: "explainer.edit-ledger/v1", editId, base: edit.base, videoId: checked.view.videoId, scriptSha, beats: edit.beats,
    ...(edit.fromNote ? { fromNote: edit.fromNote } : {}), createdAt: edit.createdAt, status: start ? "started" : "stored",
  });
  if (start) (deps.spawn ?? spawnDetached)(editRunArgv(dataDir, checked.view, editId, scriptSha), editLogFile(dataDir, editId));
  return { editId, scriptSha, started: start };
}

export interface EditRow extends EditLedger {
  /** The linked run's workflow status; `starting` while a launched run has not linked itself, `not started` without one. */
  runStatus: string;
}

function listRows(dataDir: string, filter: { mp4Sha?: string; video?: string }): EditRow[] {
  const rows = listLedgers(dataDir).filter((ledger) => (filter.mp4Sha ? ledger.base.mp4Sha === filter.mp4Sha : ledger.videoId === filter.video));
  const db = openState(dataDir);
  try {
    const runs = new WorkflowRunStore(db);
    const statusOf = (ledger: EditLedger): string => {
      if (ledger.runId) return runs.get(ledger.runId)?.status ?? "unknown";
      return ledger.status === "started" ? "starting" : "not started";
    };
    return rows.map((ledger) => ({ ...ledger, runStatus: statusOf(ledger) }));
  } finally {
    db.close();
  }
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

function checkCommand(deps: EditCliDeps, io: Io, onResult: (code: number) => void): Command {
  return new Command("check")
    .description("Apply an explainer.slot-edit/v1 to its base run's script and print the verdict per beat and field as JSON; writes nothing")
    .argument("<edit>", "the edit JSON file, or - for stdin")
    .addOption(dataDirOption())
    .exitOverride()
    .action((file: string, flags: { dataDir?: string }) => {
      const { checked } = readAndCheck(file, dataDirOf(flags), deps);
      io.out(json(verdictOf(checked)));
      onResult(checked.ok ? EXIT.OK : EXIT.REFUSED);
    });
}

function applyCommand(deps: EditCliDeps, io: Io, onResult: (code: number) => void): Command {
  return new Command("apply")
    .description("Store the edited script as an artifact and write the edit's ledger row; with --start, launch the linked run from resolve, detached")
    .argument("<edit>", "the edit JSON file, or - for stdin")
    .addOption(dataDirOption())
    .option("--start", `launch \`explainer run --from resolve\` over the base with the new script pinned, capped at $${EDIT_BUDGET_USD}`)
    .option("--json", "print { editId, scriptSha, started } as JSON")
    .exitOverride()
    .action((file: string, flags: { dataDir?: string; start?: boolean; json?: boolean }) => {
      const dataDir = dataDirOf(flags);
      const { edit, checked } = readAndCheck(file, dataDir, deps);
      if (!edit || !checked.ok || !checked.script || !checked.view) {
        io.out(json(verdictOf(checked)));
        return onResult(EXIT.REFUSED);
      }
      const applied = storeEdit(dataDir, edit, { ...checked, script: checked.script, view: checked.view }, flags.start === true, deps);
      io.out(flags.json ? json(applied) : `edit ${applied.editId}: script ${applied.scriptSha}${applied.started ? "; linked run launched" : ""}\n`);
      onResult(EXIT.OK);
    });
}

const SHA = /^[0-9a-f]{64}$/;
const mp4Sha = (text: string): string => {
  if (!SHA.test(text)) throw new InvalidArgumentError(`--mp4-sha needs a full sha256, got "${text}"`);
  return text;
};

function listCommand(io: Io, onResult: (code: number) => void): Command {
  return new Command("list")
    .description("List the saved edits of a video, each with its linked run's status")
    .addOption(dataDirOption())
    .addOption(new Option("--mp4-sha <sha>", "the edits drafted over the render with this sha").argParser(mp4Sha).conflicts("video"))
    .option("--video <id>", "the edits of this video")
    .option("--json", "print the rows as JSON")
    .exitOverride()
    .action((flags: { dataDir?: string; mp4Sha?: string; video?: string; json?: boolean }) => {
      if (!flags.mp4Sha && !flags.video) throw new InvalidArgumentError("edit list needs --mp4-sha <sha> or --video <id>");
      const rows = listRows(dataDirOf(flags), flags);
      const line = (r: EditRow) => `${r.editId} over run ${r.base.runId}: ${Object.keys(r.beats).length} beats, run ${r.runId ?? "—"} ${r.runStatus}\n`;
      io.out(flags.json ? json(rows) : rows.map(line).join("") || "no edits\n");
      onResult(EXIT.OK);
    });
}

/** `explainer edit check|apply|list`: exit 0 on an accepted edit or a listing, 1 on a refused edit, 2 on usage or a missing run. */
export async function runEditCli(argv: readonly string[], deps: EditCliDeps = {}): Promise<number> {
  const io: Io = { out: deps.out ?? ((text) => process.stdout.write(text)), err: deps.err ?? ((text) => process.stderr.write(text)) };
  let code: number = EXIT.OK;
  const onResult = (next: number): void => {
    code = next;
  };
  const edit = new Command("edit").description("Owner slot and tune edits on a finished run")
    .addCommand(checkCommand(deps, io, onResult)).addCommand(applyCommand(deps, io, onResult)).addCommand(listCommand(io, onResult));
  const program = new Command("explainer").exitOverride().configureOutput({ writeOut: io.out, writeErr: io.err }).addCommand(edit);
  try {
    await program.parseAsync([...argv], { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode === 0 ? EXIT.OK : EXIT.USAGE;
    io.err(`edit: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT.USAGE;
  }
  return code;
}
