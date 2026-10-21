import path from "node:path";
import type { OwnerItemDeposit } from "@titan-design/owner-queue";
import { z } from "zod";
import { failureDeposit, type FailureStage } from "./alarm.js";
import { releaseLock, takeLock, type LockPorts } from "./lock.js";
import { BUILD_ARGS, CLOSURE_ARGS, closureDirs, touchedPaths } from "./plan.js";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Every effect the updater has; tests pass fakes, so none of them reaches git, pnpm, systemd or a port. */
export interface UpdatePorts extends LockPorts {
  git: (cwd: string, args: readonly string[]) => Promise<CommandResult>;
  pnpm: (cwd: string, args: readonly string[]) => Promise<CommandResult>;
  systemctl: (args: readonly string[]) => Promise<CommandResult>;
  /** The directory the symlink `link` resolves to; undefined when it is missing or not a symlink. */
  readLink: (link: string) => string | undefined;
  /** Points `link` at `target` by renaming a fresh symlink over it, so a reader never sees it absent. */
  swapLink: (link: string, target: string) => void;
  exists: (file: string) => boolean;
  listDirs: (dir: string) => string[];
  mkdir: (dir: string) => void;
  writeFile: (file: string, text: string) => void;
  /** Starts the release's bin on a spare port with a scratch state dir; undefined once its /health names `sha` and `/` answers 200, else why not. */
  smoke: (release: string, sha: string) => Promise<string | undefined>;
  /** The build sha the console on `port` reports, polled until it is `want` or the wait ends; null when it answered with no sha, undefined when it never answered. */
  servedSha: (port: number, want: string) => Promise<string | null | undefined>;
  alarm: (deposit: OwnerItemDeposit) => Promise<void>;
  log: (line: string) => void;
  now: () => number;
}

export interface UpdateOptions {
  /** Holds `checkout/` (the clone that fetches), `releases/<sha>/` (one worktree per build) and the `current` symlink the unit runs. */
  root: string;
  /** Holds the lock, the last outcome and the last build log. */
  stateDir: string;
  /** The served console's loopback port. */
  port: number;
  unit: string;
}

type UpdateOutcome = "updated" | "failed" | "rolled-back" | "rollback-failed";

/** The last attempt; a failed target is not retried until main moves past it. */
interface UpdateRecord {
  outcome: UpdateOutcome;
  target: string;
  served: string;
  at: string;
  stage?: FailureStage;
  why?: string;
  touched?: string[];
}

export const EXIT = { OK: 0, FAILED: 1, LOCKED: 75, CONFIG: 78 } as const;
const MAIN = "origin/main";
const DETAIL_LINES = 20;

export const recordPath = (stateDir: string): string => path.join(stateDir, "self-update.json");
export const lockPath = (stateDir: string): string => path.join(stateDir, "self-update.lock");
const buildLogPath = (stateDir: string): string => path.join(stateDir, "self-update-build.log");

interface Update {
  ports: UpdatePorts;
  options: UpdateOptions;
  link: string;
  checkout: string;
}

interface Go {
  current: string;
  served: string;
  target: string;
  touched: string[];
  release: string;
}

type Stop = { kind: "stop"; code: number; message: string };

const stopWith = (code: number, message: string): Stop => ({ kind: "stop", code, message });

/** One pass: fetch, decide, build, smoke, swap, restart, verify; any failure leaves the old build serving. */
export async function selfUpdate(ports: UpdatePorts, options: UpdateOptions): Promise<number> {
  ports.mkdir(options.stateDir);
  const lock = lockPath(options.stateDir);
  const held = takeLock(ports, lock);
  if (held !== undefined) {
    ports.log(`self-update refused: ${held}`);
    return EXIT.LOCKED;
  }
  try {
    const update = { ports, options, link: path.join(options.root, "current"), checkout: path.join(options.root, "checkout") };
    const plan = await planUpdate(update);
    if ("kind" in plan) {
      ports.log(plan.message);
      return plan.code;
    }
    return await apply(update, plan);
  } finally {
    releaseLock(ports, lock);
  }
}

const recordSchema = z.object({
  outcome: z.enum(["updated", "failed", "rolled-back", "rollback-failed"]),
  target: z.string(),
  served: z.string(),
  at: z.string(),
  stage: z.enum(["build", "smoke", "restart", "rollback"]).optional(),
  why: z.string().optional(),
  touched: z.array(z.string()).optional(),
});

export function readRecord(text: string | undefined): UpdateRecord | undefined {
  try {
    const parsed = recordSchema.safeParse(JSON.parse(text ?? ""));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

const detail = (result: CommandResult): string => {
  const lines = `${result.stderr}\n${result.stdout}`.trim().split("\n");
  return lines.slice(-DETAIL_LINES).join("\n") || `exit ${result.code}`;
};

async function revParse(update: Update, cwd: string, rev: string): Promise<string | undefined> {
  const parsed = await update.ports.git(cwd, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
  return parsed.code === 0 ? parsed.stdout.trim() : undefined;
}

async function planUpdate(update: Update): Promise<Go | Stop> {
  const { ports, options, link, checkout } = update;
  const current = ports.readLink(link);
  if (current === undefined) return stopWith(EXIT.CONFIG, `self-update refused: ${link} is not a symlink to the served checkout; run the owner step in apps/console/docs/self-update.md`);
  const fetched = await ports.git(checkout, ["fetch", "--quiet", "origin", "main"]);
  if (fetched.code !== 0) return stopWith(EXIT.FAILED, `self-update refused: git fetch origin main failed: ${detail(fetched)}`);
  const target = await revParse(update, checkout, MAIN);
  const served = await revParse(update, current, "HEAD");
  if (target === undefined || served === undefined) return stopWith(EXIT.FAILED, `self-update refused: could not resolve ${target === undefined ? MAIN : `HEAD in ${current}`}`);
  if (served === target) return stopWith(EXIT.OK, `up to date: serving ${target}`);
  const last = readRecord(ports.readFile(recordPath(options.stateDir)));
  if (last !== undefined && last.outcome !== "updated" && last.target === target) {
    return stopWith(EXIT.OK, `held: ${target} ${last.outcome} at ${last.at} (${last.why ?? "no reason recorded"}); a newer main sha updates`);
  }
  const touched = await consoleTouched(update, current, served, target);
  if (touched.length === 0) return stopWith(EXIT.OK, `no console change from ${served} to ${target}; still serving ${served}`);
  return { current, served, target, touched, release: path.join(options.root, "releases", target) };
}

/** Diffed in the fetching clone, against the closure pnpm reads from the served tree; a failed diff counts as a change. */
async function consoleTouched(update: Update, current: string, served: string, target: string): Promise<string[]> {
  const diff = await update.ports.git(update.checkout, ["diff", "--name-only", "--no-renames", served, target]);
  if (diff.code !== 0) return [`<git diff failed: ${detail(diff)}>`];
  const listed = await update.ports.pnpm(current, CLOSURE_ARGS);
  const closure = listed.code === 0 ? closureDirs(listed.stdout, current) : undefined;
  return touchedPaths(diff.stdout.split("\n").filter((line) => line !== ""), closure);
}

async function apply(update: Update, go: Go): Promise<number> {
  update.ports.log(`updating ${go.served} -> ${go.target}; ${go.touched.length} changed path(s) reach the console build`);
  const built = await buildRelease(update, go);
  if (built !== undefined) return failBeforeSwap(update, go, "build", built);
  const smoke = await update.ports.smoke(go.release, go.target);
  if (smoke !== undefined) return failBeforeSwap(update, go, "smoke", smoke);
  update.ports.swapLink(update.link, go.release);
  const restarted = await restartTo(update, go.target);
  if (restarted !== undefined) return rollBack(update, go, restarted);
  write(update, go, "updated");
  update.ports.log(`updated: serving ${go.target}`);
  await prune(update, [go.release, go.current]);
  return EXIT.OK;
}

/** A leftover worktree from an earlier failed attempt is replaced, so a rerun starts clean. */
async function buildRelease(update: Update, go: Go): Promise<string | undefined> {
  const { ports, checkout } = update;
  await removeRelease(update, go.release);
  ports.mkdir(path.dirname(go.release));
  const added = await ports.git(checkout, ["worktree", "add", "--detach", go.release, go.target]);
  if (added.code !== 0) return `git worktree add failed: ${detail(added)}`;
  for (const args of [["install", "--frozen-lockfile"], BUILD_ARGS]) {
    const result = await ports.pnpm(go.release, args);
    if (result.code === 0) continue;
    ports.writeFile(buildLogPath(update.options.stateDir), `pnpm ${args.join(" ")} at ${go.target}\n${result.stdout}\n${result.stderr}\n`);
    return `pnpm ${args.join(" ")} failed: ${detail(result)}`;
  }
  return undefined;
}

async function removeRelease(update: Update, release: string): Promise<void> {
  if (!update.ports.exists(release)) return;
  await update.ports.git(update.checkout, ["worktree", "remove", "--force", release]);
}

/**
 * Undefined when the restarted unit answers /health with the build it should be serving. A build from before
 * the stamp reports no sha, so on the way back `unstamped` accepts any answer from it.
 */
async function restartTo(update: Update, sha: string, unstamped = false): Promise<string | undefined> {
  const { ports, options } = update;
  const restarted = await ports.systemctl(["--user", "restart", options.unit]);
  if (restarted.code !== 0) return `systemctl --user restart ${options.unit} failed: ${detail(restarted)}`;
  const answered = await ports.servedSha(options.port, sha);
  if (answered === sha || (unstamped && answered === null)) return undefined;
  return `/health on port ${options.port} answered ${answered === undefined ? "nothing" : answered === null ? "with no build sha" : `build ${answered}`}, not ${sha}`;
}

async function failBeforeSwap(update: Update, go: Go, stage: FailureStage, why: string): Promise<number> {
  await removeRelease(update, go.release);
  return fail(update, go, { outcome: "failed", stage, why, serving: go.served });
}

/** One swap back and one restart; a rollback that does not verify is reported, never retried. */
async function rollBack(update: Update, go: Go, why: string): Promise<number> {
  update.ports.log(`error: ${why}; putting ${go.served} back`);
  update.ports.swapLink(update.link, go.current);
  const back = await restartTo(update, go.served, true);
  if (back === undefined) return fail(update, go, { outcome: "rolled-back", stage: "restart", why, serving: go.served });
  return fail(update, go, { outcome: "rollback-failed", stage: "rollback", why: `${why}; then ${back}`, serving: go.served });
}

interface Failure {
  outcome: Exclude<UpdateOutcome, "updated">;
  stage: FailureStage;
  why: string;
  serving: string;
}

async function fail(update: Update, go: Go, failure: Failure): Promise<number> {
  const { ports } = update;
  ports.log(`${failure.outcome === "rollback-failed" ? "ALERT" : "error"}: ${failure.stage} of ${go.target} failed: ${failure.why}`);
  write(update, go, failure.outcome, { stage: failure.stage, why: failure.why });
  try {
    await ports.alarm(failureDeposit({ stage: failure.stage, target: go.target, serving: failure.serving, why: failure.why }));
  } catch (error) {
    ports.log(`error: the owner-queue alarm failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return EXIT.FAILED;
}

function write(update: Update, go: Go, outcome: UpdateOutcome, extra: Pick<UpdateRecord, "stage" | "why"> = {}): void {
  const record: UpdateRecord = { outcome, target: go.target, served: go.served, at: new Date(update.ports.now()).toISOString(), ...extra, touched: go.touched };
  update.ports.writeFile(recordPath(update.options.stateDir), `${JSON.stringify(record, null, 2)}\n`);
}

/** Keeps the serving release and the one before it for a hand rollback; never touches `checkout/`, which sits outside releases/. */
async function prune(update: Update, keep: readonly string[]): Promise<void> {
  const releases = path.join(update.options.root, "releases");
  const kept = new Set(keep.map((dir) => path.basename(dir)));
  for (const name of update.ports.listDirs(releases)) {
    if (!kept.has(name)) await update.ports.git(update.checkout, ["worktree", "remove", "--force", path.join(releases, name)]);
  }
  await update.ports.git(update.checkout, ["worktree", "prune"]);
}
