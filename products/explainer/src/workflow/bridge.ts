import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { loadProfiles, profileFor } from "../profile-load.js";

/**
 * The host file `<dataDir>/bridge.json` (or a profile's `bridges/<name>.json`): where the export stage links the
 * finished video. It once also held the argv of each stage still bridged to template scripts; every stage now runs
 * in TypeScript, and a file that still carries one of those blocks is refused with the fix.
 */
export const BridgeFileSchema = z.object({
  schema: z.literal("explainer-bridge/v1"),
  /** Where the export stage links the finished video: `<dir>/<stem><suffix>` per artifact name; a companion doc is always `<dir>/companion.md`. */
  theater: z.object({ dir: z.string(), stem: z.string(), files: z.record(z.string(), z.string()) }),
});
export type BridgeFile = z.infer<typeof BridgeFileSchema>;

/** The fix for a host file written while a stage that runs in TypeScript now was still bridged. */
const PORTED_STAGES: Readonly<Record<string, string>> = {
  tts: 'still has a "tts" block, but tts runs in TypeScript now; delete it, and drop any sample builder it ran: render draws the storyboard itself now',
  sheets: 'still has a "sheets" block, but sheets runs in TypeScript now (the sidecar, poster and fingerprint); delete it, and drop write_video_meta.py and sheets.sh from the host',
  qa: 'still has a "qa" block, but qa runs in TypeScript now (render-qa); delete it, and drop examples/qa.ts from the host',
  render:
    'still has a "render" block, but render runs in TypeScript now; delete it, and drop from the host build_sample.py (the template fill draws the storyboard from script and resolved), ' +
    "the spike page's vite build (the composition page, built once per source sha in the explainer cache) and render.ts (renderVideo: capture, mix, captions.vtt, render-manifest.json, its QA gate)",
};

const PortedStagesSchema = z.object({ stages: z.record(z.string(), z.unknown()) });

/** A bridge a profile names, kept once per host so a run in any data dir uses it without a per-run copy. */
export interface NamedBridge {
  /** The host's own explainer data dir, which holds `bridges/<name>.json`. */
  home: string;
  name: string;
}

export const bridgeFilePath = (dataDir: string, named?: NamedBridge): string =>
  named ? path.join(named.home, "bridges", `${named.name}.json`) : path.join(dataDir, "bridge.json");

export function readBridgeFile(dataDir: string, named?: NamedBridge): BridgeFile {
  const file = bridgeFilePath(dataDir, named);
  if (!existsSync(file)) throw new Error(`no bridge host file at ${file}; see the explainer README, "explainer run"`);
  const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
  const stages = PortedStagesSchema.safeParse(raw).data?.stages ?? {};
  const ported = Object.keys(PORTED_STAGES).find((stage) => stages[stage] !== undefined);
  if (ported) throw new Error(`${file} ${PORTED_STAGES[ported]}`);
  return BridgeFileSchema.parse(raw);
}

export interface RunBridgeChoice {
  /** Where a named bridge lives; the data dir by default. */
  home?: string | undefined;
  profile?: string | undefined;
  /** Replaces the bridge's `theater.dir`. */
  theater?: string | undefined;
}

/** A run's bridge: the one its profile names, else the data dir's, linking into the theater folder the run asked for. */
export function runBridgeFile(dataDir: string, choice: RunBridgeChoice): BridgeFile {
  const name = choice.profile === undefined ? undefined : profileFor(loadProfiles(), choice.profile).bridge;
  const file = readBridgeFile(dataDir, name === undefined ? undefined : { home: choice.home ?? dataDir, name });
  return choice.theater ? { ...file, theater: { ...file.theater, dir: choice.theater } } : file;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface ExecRequest {
  argv: readonly string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}

/** Runs one argv; tests pass a fake that writes the outputs a real template command would. */
export type BridgeExec = (request: ExecRequest) => Promise<ExecResult>;

export const spawnExec: BridgeExec = ({ argv, cwd, env, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }));
  });
