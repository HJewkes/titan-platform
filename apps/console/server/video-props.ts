/**
 * The props panel's reads (TP-4021 C1): what `explainer props` says each template beat of a render holds, and what
 * `explainer edit check` says of a draft. The console never imports explainer; it runs the installed CLI with a fixed
 * argv and no shell, and renders whatever JSON Schema that CLI emits. A missing CLI, a render explainer did not make
 * or a CLI failure is a gap line on the result, never an error, so the theater plays on without the panel.
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { z } from "zod";
import { EXIT } from "@titan-design/registry";
import { failure } from "./active-work.js";
import { readCommand } from "./owner-guard.js";
import { renderSha256 } from "./video-notes.js";
import { locateVideo, videoCatalog, type VideoCatalog } from "./videos.js";

export const EXPLAINER_NOT_FOUND = "explainer is not on PATH, so beat props are not shown; set TITAN_CONSOLE_EXPLAINER_BIN to its absolute path";
export const NOT_FROM_EXPLAINER = "not made by explainer run, so it has no beat props";
const NO_SCRIPT_SHA = "this explainer does not report the run's script sha, so drafts are not checked (TP-4263)";
const NOT_FOUND = "Video not found";
/** A props read is the same until the render's bytes change, which changes its sha; the TTL only bounds an upgraded CLI's lag. */
const PROPS_TTL_MS = 10 * 60_000;
const MAX_CACHED_PROPS = 64;
/** What the CLI needs to find its data dir and run node; the daemon's own settings, tokens included, stay behind. */
const CHILD_ENV = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TMPDIR", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"];
const CLI_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
export const MAX_EDIT_BYTES = 64 * 1024;

const Sha = z.string().regex(/^[0-9a-f]{64}$/);
const TuneValue = z.union([z.number(), z.string(), z.boolean()]);

const beatProps = z.object({
  id: z.string(),
  chapter: z.string(),
  spec: z.string(),
  slots: z.string(),
  schema: z.record(z.string(), z.unknown()),
  value: z.record(z.string(), z.unknown()),
  overridden: z.array(z.string()),
  locked: z.array(z.string()),
  startS: z.number(),
  endS: z.number(),
  stillS: z.number(),
});
const saveBack = z.object({ enabled: z.boolean(), reason: z.string().optional() });
const propsOut = z.discriminatedUnion("found", [
  z.object({ found: z.literal(false) }),
  z.object({ found: z.literal(true), runId: z.string().min(1), scriptSha: Sha.optional(), saveBack, beats: z.array(beatProps) }),
]);
const props = z.object({ runId: z.string(), scriptSha: Sha.optional(), saveBack, beats: z.array(beatProps) });

const fieldChange = z.object({ beat: z.string(), path: z.string(), before: z.unknown(), after: z.unknown() });
const verdict = z.object({ ok: z.boolean(), problems: z.array(z.string()), diff: z.array(fieldChange) });

const beatEdit = z.strictObject({ slots: z.record(z.string(), z.unknown()).optional(), tune: z.record(z.string(), TuneValue.nullable()).optional() });
const editCheckArgs = z.strictObject({ videoId: z.string(), runId: z.string().min(1), scriptSha: Sha, beats: z.record(z.string().min(1), beatEdit) });

type CliRun = { ran: true; code: number; stdout: string; stderr: string } | { ran: false; gap: string };

function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name, value]) => value !== undefined && (CHILD_ENV.includes(name) || name.startsWith("EXPLAINER_"))));
}

/** No bin, or a relative one that would run against the daemon's cwd: either way the reads answer a gap, not a spawn. */
function usableBin(bin: string | undefined): { bin: string } | { gap: string } {
  if (bin === undefined) return { gap: EXPLAINER_NOT_FOUND };
  return path.isAbsolute(bin) ? { bin } : { gap: `TITAN_CONSOLE_EXPLAINER_BIN must be an absolute path, got "${bin}"` };
}

const firstLine = (text: string): string => text.trim().split("\n")[0] ?? "";

/** Exit codes are the CLI's answer, so a non-zero exit still returns its output; only a spawn failure or timeout is a gap. */
function runExplainer(bin: string, args: readonly string[], stdin?: string): Promise<CliRun> {
  return new Promise((resolve) => {
    const child = execFile(bin, args, { timeout: CLI_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, encoding: "utf8", env: childEnv() }, (error, stdout, stderr) => {
      if (error === null) return resolve({ ran: true, code: 0, stdout, stderr });
      if (typeof error.code === "number" && !error.killed) return resolve({ ran: true, code: error.code, stdout, stderr });
      resolve({ ran: false, gap: error.killed ? `explainer ${args[0]} took over ${CLI_TIMEOUT_MS / 1000} s and was stopped` : `explainer could not be run: ${error.message}` });
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(stdin ?? "");
  });
}

function parseJson<T>(schema: z.ZodType<T>, text: string): T | null {
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const exitGap = (verb: string, run: { code: number; stderr: string }): string => `explainer ${verb} exited ${run.code}${firstLine(run.stderr) ? `: ${firstLine(run.stderr)}` : ""}`;

async function locate(catalog: VideoCatalog, id: string): Promise<string> {
  const file = await locateVideo(catalog, id);
  if (file === null) throw failure(NOT_FOUND, EXIT.NOINPUT);
  return file;
}

type PropsRead = { mp4Sha: string; props: z.infer<typeof props> | null; gaps: string[] };

async function readProps(bin: string | undefined, mp4Sha: string): Promise<PropsRead> {
  const none = (gap: string): PropsRead => ({ mp4Sha, props: null, gaps: [gap] });
  const usable = usableBin(bin);
  if ("gap" in usable) return none(usable.gap);
  const run = await runExplainer(usable.bin, ["props", "--mp4-sha", mp4Sha, "--json"]);
  if (!run.ran) return none(run.gap);
  if (run.code !== 0) return none(exitGap("props", run));
  const out = parseJson(propsOut, run.stdout);
  if (out === null) return none("explainer props answered an unexpected shape");
  if (!out.found) return none(NOT_FROM_EXPLAINER);
  const found = props.parse(out);
  return { mp4Sha, props: found, gaps: found.scriptSha === undefined ? [NO_SCRIPT_SHA] : [] };
}

type CheckRead = { verdict: z.infer<typeof verdict> | null; gaps: string[] };

/** `edit check` exits 1 on a refused edit and still prints its verdict; only 2 (usage, a missing run) is a gap. */
async function checkEdit(bin: string | undefined, edit: Record<string, unknown>): Promise<CheckRead> {
  const usable = usableBin(bin);
  if ("gap" in usable) return { verdict: null, gaps: [usable.gap] };
  const text = JSON.stringify(edit);
  if (Buffer.byteLength(text) > MAX_EDIT_BYTES) throw failure(`the draft is over ${MAX_EDIT_BYTES} bytes`, EXIT.DATAERR);
  const run = await runExplainer(usable.bin, ["edit", "check", "-"], text);
  if (!run.ran) return { verdict: null, gaps: [run.gap] };
  if (run.code !== 0 && run.code !== 1) return { verdict: null, gaps: [exitGap("edit check", run)] };
  const parsed = parseJson(verdict, run.stdout);
  return parsed === null ? { verdict: null, gaps: ["explainer edit check answered an unexpected shape"] } : { verdict: parsed, gaps: [] };
}

/** Answers kept are the CLI's own: props, or not made by explainer. A failure is asked again on the next open. */
function propsCache(bin: string | undefined, nowMs: () => number): (mp4Sha: string) => Promise<PropsRead> {
  const kept = new Map<string, { at: number; read: PropsRead }>();
  return async (mp4Sha) => {
    const hit = kept.get(mp4Sha);
    if (hit !== undefined && nowMs() - hit.at < PROPS_TTL_MS) return hit.read;
    const read = await readProps(bin, mp4Sha);
    if (read.props === null && read.gaps[0] !== NOT_FROM_EXPLAINER) return read;
    if (kept.size >= MAX_CACHED_PROPS) kept.delete(kept.keys().next().value!);
    kept.set(mp4Sha, { at: nowMs(), read });
    return read;
  };
}

/** `explainerBin` absent means no CLI was found at start; each read then answers one gap naming the setting. */
export function videoPropsCommands(catalog: VideoCatalog = videoCatalog({ roots: [] }), explainerBin?: string, now: () => Date = () => new Date()) {
  const cachedProps = propsCache(explainerBin, () => now().getTime());
  return {
    "videos.props": readCommand({
      name: "videos.props",
      description: "Each template beat of the explainer run that rendered this video: slot JSON Schema, current value, overrides, locked ids, span and still time, and whether a save can render",
      args: z.object({ videoId: z.string() }),
      result: z.object({ mp4Sha: z.string(), props: props.nullable(), gaps: z.array(z.string()) }),
      run: async ({ videoId }) => cachedProps(await renderSha256(await locate(catalog, videoId))),
    }),
    "videos.edit-check": readCommand({
      name: "videos.edit-check",
      description: "Dry-run a draft of slot and tune edits through `explainer edit check`: per-field problems and the before/after diff; writes nothing",
      args: editCheckArgs,
      result: z.object({ verdict: verdict.nullable(), gaps: z.array(z.string()) }),
      run: async ({ videoId, runId, scriptSha, beats }) => {
        const mp4Sha = await renderSha256(await locate(catalog, videoId));
        const edit = { schema: "explainer.slot-edit/v1", base: { runId, scriptSha, mp4Sha }, beats, createdAt: now().toISOString() };
        return checkEdit(explainerBin, edit);
      },
    }),
  };
}
