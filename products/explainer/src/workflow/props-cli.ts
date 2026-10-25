import { appDirs } from "@titan-design/app-paths";
import { WorkflowRunStore, type WorkflowRun } from "@titan-design/workflow";
import { Command, CommanderError, InvalidArgumentError, Option } from "commander";
import { ScriptSchema } from "../script-schema.js";
import { beatProps, saveBackOf, type BeatProps, type SaveBack } from "./beat-props.js";
import { editBase, runView, withStore } from "./edit-cli.js";
import { openState } from "./host.js";
import { stageRecords } from "./report.js";
import { dataDirOption } from "./run-cli.js";
import { videoRuns } from "./video-runs.js";

const EXIT = { OK: 0, USAGE: 2 } as const;
const SHA = /^[0-9a-f]{64}$/;

type PropsResult = { found: false } | { found: true; runId: string; videoId: string; saveBack: SaveBack; beats: BeatProps[] };

interface PropsCliDeps {
  out?: (text: string) => void;
  err?: (text: string) => void;
}

const exportedMp4 = (run: WorkflowRun): string | undefined => stageRecords(run).find((record) => record.stage === "export")?.outputs.mp4;

/** The newest run whose export linked this mp4 into the theater: a re-render of the same bytes is the same video state. */
function runOfMp4(dataDir: string, mp4Sha: string): string | undefined {
  const db = openState(dataDir);
  try {
    const exported = videoRuns(new WorkflowRunStore(db)).filter((run) => exportedMp4(run) === mp4Sha);
    return exported.sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]?.id;
  } finally {
    db.close();
  }
}

/** What the props panel edits on the render with this sha; `found: false` when no explainer run exported it. */
function readProps(dataDir: string, mp4Sha: string): PropsResult {
  const runId = runOfMp4(dataDir, mp4Sha);
  if (runId === undefined) return { found: false };
  const view = runView(dataDir, runId);
  const words = view.artifacts.words;
  if (words === undefined) throw new Error(`run ${runId} has no words artifact`);
  const base = editBase(dataDir, view);
  const beats = beatProps({
    script: ScriptSchema.parse(base.script),
    resolved: base.resolved,
    words: withStore(dataDir, (store) => JSON.parse(store.readText(words))),
    ...(base.generated ? { generated: base.generated } : {}),
  });
  return { found: true, runId, videoId: view.videoId, saveBack: saveBackOf(), beats };
}

const mp4Sha = (text: string): string => {
  if (!SHA.test(text)) throw new InvalidArgumentError(`--mp4-sha needs a full sha256, got "${text}"`);
  return text;
};

function summary(result: PropsResult): string {
  if (!result.found) return "not made by explainer run\n";
  const save = result.saveBack.enabled ? "save on" : `save off: ${result.saveBack.reason}`;
  const rows = result.beats.map((b) => `${b.id} ${b.spec} ${b.startS.toFixed(2)}-${b.endS.toFixed(2)} s${b.overridden.length ? ` (overrides ${b.overridden.join(", ")})` : ""}\n`);
  return `run ${result.runId}: ${result.beats.length} template beats; ${save}\n${rows.join("")}`;
}

/** `explainer props --mp4-sha <sha>`: exit 0 with the props or `found: false`, 2 on usage or an unreadable run. */
export async function runPropsCli(argv: readonly string[], deps: PropsCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((text: string) => process.stdout.write(text));
  const err = deps.err ?? ((text: string) => process.stderr.write(text));
  const props = new Command("props")
    .description("Each template beat of the run that exported a render: slot schema, current value, overrides, locked ids and timing")
    .addOption(new Option("--mp4-sha <sha>", "the sha256 of the theater mp4").argParser(mp4Sha).makeOptionMandatory())
    .addOption(dataDirOption())
    .option("--json", "print the props as JSON")
    .exitOverride()
    .action((flags: { mp4Sha: string; dataDir?: string; json?: boolean }) => {
      const result = readProps(flags.dataDir ?? appDirs("explainer").data, flags.mp4Sha);
      out(flags.json ? `${JSON.stringify(result, null, 2)}\n` : summary(result));
    });
  const program = new Command("explainer").exitOverride().configureOutput({ writeOut: out, writeErr: err }).addCommand(props);
  try {
    await program.parseAsync([...argv], { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode === 0 ? EXIT.OK : EXIT.USAGE;
    err(`props: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT.USAGE;
  }
  return EXIT.OK;
}
