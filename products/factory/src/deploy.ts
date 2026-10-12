import { join } from "node:path";
import { cloneIfAbsent, serviceRunsFromCheckout } from "./deploy-bootstrap.js";
import { DIRTY_SUFFIX } from "./build-info.js";
import { closureDirs, FACTORY_PACKAGE, nativeBuildChanges, readWorkspace, touchedPaths, versionOnlyManifestChange } from "./deploy-closure.js";
import type { DeployIncident } from "./deploy-incident.js";
import { deployLockPath, releaseLock, takeLock, type LockPorts } from "./deploy-lock.js";
import { describePause, readDeployPause, writeDeployPause, type DeployPause } from "./deploy-pause.js";
import { buildShaOf, DEFAULT_WATCH_WINDOW, watchServe, type WatchWindow } from "./deploy-watch-window.js";
import { redactCredentials } from "./redact.js";
import { restartService, type CommandResult, type RestartDrain, type ServiceIo, type ServicePorts } from "./service-control.js";

/** Every effect the deployer has beyond the service verbs'; tests pass fakes, so none of them reaches git, pnpm or launchd. */
export interface DeployPorts extends ServicePorts, LockPorts {
  /** `/health` with a longer timeout than `health`'s, for reads that must not mistake a slow answer for none. */
  healthWithin: (port: number, timeoutMs: number) => Promise<Record<string, unknown> | null>;
  /** `git clone --branch main <remote> <dest>`, run from the parent of `dest`; only called when the checkout is absent. */
  clone: (remote: string, dest: string) => Promise<CommandResult>;
  /** Runs in the service checkout. */
  git: (args: readonly string[]) => Promise<CommandResult>;
  /** Runs in the service checkout under the worktree setup env, except that pnpm honors the checkout's packageManager pin and only install ignores scripts. */
  pnpm: (args: readonly string[]) => Promise<CommandResult>;
  listDirs: (dir: string) => readonly string[];
  copyTree: (from: string, to: string) => void;
  removeTree: (path: string) => void;
  /** Tells the hub seat and the owner queue about a rollback that paused deploys; absent means only stderr carries it. */
  incident?: (incident: DeployIncident) => Promise<void>;
}

export interface DeployOptions {
  /** The dedicated checkout the service runs from; it must be on main with no tracked changes, and is cloned from `remote` when absent. */
  checkout: string;
  /** Where an absent checkout is cloned from; never a copy of a working tree. */
  remote?: string | undefined;
  /** Holds deploy.lock, deploy.json and deploy-backup/. */
  stateDir: string;
  port: number;
  logDir: string;
  /** The sha to deploy; defaults to origin/main after the fetch. */
  expect?: string;
  drain: RestartDrain;
  /** How long a restarted build is watched after its sha checks out; absent keys keep `DEFAULT_WATCH_WINDOW`. */
  watch?: Partial<WatchWindow>;
}

/** A refusal is printed, never recorded, so it cannot overwrite a rolled-back hold. */
export type DeployOutcome = "deployed" | "skipped" | "rolled-back";

/** What `/health` shows as `lastDeploy`. */
export interface DeployRecord {
  outcome: DeployOutcome;
  target: string;
  /** The build sha `/health` reported before the deploy, or `unknown`. */
  from: string;
  at: string;
  why?: string;
  touched?: string[];
}

interface Deploy {
  ports: DeployPorts;
  io: ServiceIo;
  options: DeployOptions;
}

interface Go {
  target: string;
  /** The running build sha as `/health` reported it, dirty suffix included. */
  running: string | undefined;
  closure: string[];
  touched: string[];
  /** The installed unit does not start this checkout's bin yet, so deploy only builds it and leaves the service alone. */
  prepareOnly: boolean;
}

type Stop = { kind: "stop"; code: number; message: string; record?: DeployRecord };
type Plan = { kind: "go"; go: Go } | Stop;

const UNKNOWN = "unknown";
const MAIN = "main";
const ORIGIN_MAIN = "origin/main";
const OUTPUT_TAIL_LINES = 20;
const OUTPUT_TAIL_CHARS = 2_000;
const FAILURE = 1;
const SHA_POLLS = 10;
const SHA_POLL_MS = 1_000;
const SHA_PROBE_TIMEOUT_MS = 5_000;
const LOCKFILE = "pnpm-lock.yaml";

export const deployRecordPath = (stateDir: string): string => join(stateDir, "deploy.json");
const backupRoot = (stateDir: string): string => join(stateDir, "deploy-backup");
/** Redacted before the cut, so a cut can never leave a token without the prefix that marks it. */
function tail(name: string, text: string): string[] {
  const kept = redactCredentials(text.trim()).split("\n").slice(-OUTPUT_TAIL_LINES).join("\n");
  return kept === "" ? [] : [`${name}:\n${kept.length <= OUTPUT_TAIL_CHARS ? kept : `…${kept.slice(-OUTPUT_TAIL_CHARS)}`}`];
}

/** Both streams, since pnpm prints a failing script's output on stdout and leaves stderr empty. */
const detail = (result: CommandResult): string => [`exit ${result.code}`, ...tail("stderr", result.stderr), ...tail("stdout", result.stdout)].join("\n");

export function parseDeployRecord(text: string | undefined): DeployRecord | undefined {
  if (text === undefined) return undefined;
  try {
    const value = JSON.parse(text) as Partial<DeployRecord> | null;
    return typeof value?.outcome === "string" && typeof value.target === "string" ? (value as DeployRecord) : undefined;
  } catch {
    return undefined;
  }
}

/** Fast-forward, build and restart the service checkout to `expect` or origin/main; never resets, so a rollback restores `dist` only. */
export async function deployService(ports: DeployPorts, io: ServiceIo, options: DeployOptions): Promise<number> {
  ports.mkdir(options.stateDir);
  const lock = deployLockPath(options.stateDir);
  const held = takeLock(ports, lock);
  if (held !== undefined) {
    io.stderr(`error: ${held}\n`);
    return FAILURE;
  }
  try {
    const deploy = { ports, io, options };
    const plan = pauseHold(deploy) ?? (await planDeploy(deploy));
    return plan.kind === "go" ? await execute(deploy, plan.go) : stop(deploy, plan);
  } finally {
    releaseLock(ports, lock);
  }
}

function stop({ ports, io, options }: Deploy, plan: Stop): number {
  if (plan.record) ports.writeFile(deployRecordPath(options.stateDir), `${JSON.stringify(plan.record, null, 2)}\n`);
  (plan.code === 0 ? io.stdout : io.stderr)(`${plan.code === 0 ? "" : "error: "}${plan.message}\n`);
  return plan.code;
}

function record(deploy: Deploy, fields: Omit<DeployRecord, "at">): DeployRecord {
  return { ...fields, at: new Date(deploy.ports.now()).toISOString() };
}

/** Read under the lock and before any sha is resolved, so no target, however new, gets past a pause. */
function pauseHold({ ports, options }: Deploy): Stop | undefined {
  const state = readDeployPause(ports, options.stateDir);
  return state.paused ? { kind: "stop", code: FAILURE, message: `deploy held: ${describePause(state)}; clear with titan-factory service pause --clear` } : undefined;
}

function refuse(why: string): Stop {
  return { kind: "stop", code: FAILURE, message: `deploy refused: ${why}` };
}

async function planDeploy(deploy: Deploy): Promise<Plan> {
  const { ports } = deploy;
  if (ports.which("pnpm") === undefined) return refuse("pnpm is not on PATH");
  const cloneRefusal = await ensureCheckout(deploy);
  if (cloneRefusal !== undefined) return cloneRefusal;
  const guard = await checkoutGuard(ports);
  if (guard !== undefined) return refuse(`checkout not clean main: ${guard}`);
  const fetched = await ports.git(["fetch", "origin", MAIN]);
  if (fetched.code !== 0) return refuse(`git fetch origin main failed: ${detail(fetched)}`);
  const target = await resolveTarget(ports, deploy.options.expect);
  if (typeof target !== "object") return refuse(target);
  return planFor(deploy, target.sha, !serviceRunsFromCheckout(ports, deploy.options.checkout));
}

async function ensureCheckout({ ports, options }: Deploy): Promise<Stop | undefined> {
  const cloned = await cloneIfAbsent(ports, options.checkout, options.remote);
  if (cloned === "no-remote") {
    return refuse(`${options.checkout} does not exist and no remote is known to clone it from; set service.deployRemote (or service.deployCheckout) in the factory config`);
  }
  return cloned === undefined || cloned.code === 0 ? undefined : refuse(`git clone failed: ${detail(cloned)}`);
}

/** The checkout is dedicated to the deployer, so anything but a clean main means someone has used it by hand. */
async function checkoutGuard(ports: DeployPorts): Promise<string | undefined> {
  const branch = await ports.git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branch.code !== 0 || branch.stdout.trim() !== MAIN) return `HEAD is ${branch.code === 0 ? branch.stdout.trim() : "detached"}, not ${MAIN}`;
  const status = await ports.git(["status", "--porcelain", "--untracked-files=no"]);
  if (status.code !== 0) return `git status failed: ${detail(status)}`;
  return status.stdout.trim() === "" ? undefined : `tracked changes:\n${status.stdout.trimEnd()}`;
}

/** Only a commit already on origin/main deploys, so a stray branch sha never reaches the service. */
async function resolveTarget(ports: DeployPorts, expect: string | undefined): Promise<{ sha: string } | string> {
  const name = expect ?? ORIGIN_MAIN;
  const parsed = await ports.git(["rev-parse", "--verify", "--quiet", `${name}^{commit}`]);
  if (parsed.code !== 0) return `${name} is not a commit in the checkout after git fetch`;
  const sha = parsed.stdout.trim();
  return (await isAncestor(ports, sha, ORIGIN_MAIN)) ? { sha } : `${sha} is not on ${ORIGIN_MAIN}`;
}

async function isAncestor(ports: DeployPorts, ancestor: string, of: string): Promise<boolean> {
  return (await ports.git(["merge-base", "--is-ancestor", ancestor, of])).code === 0;
}

async function runningBuild(ports: DeployPorts, port: number): Promise<string | undefined> {
  return buildShaOf(await ports.healthWithin(port, SHA_PROBE_TIMEOUT_MS));
}

/** A slow or missing answer under load is not a wrong sha, so poll; undefined means no answer with a sha in the whole poll. */
async function answeredHealth(ports: DeployPorts, port: number): Promise<Record<string, unknown> | undefined> {
  for (let poll = 0; poll < SHA_POLLS; poll++) {
    const health = await ports.healthWithin(port, SHA_PROBE_TIMEOUT_MS);
    if (buildShaOf(health) !== undefined) return health ?? undefined;
    await ports.sleep(SHA_POLL_MS);
  }
  return undefined;
}

const answeredBuild = async (ports: DeployPorts, port: number): Promise<string | undefined> => buildShaOf(await answeredHealth(ports, port));

/** A dirty or unknown build has no commit to diff from, so it neither no-ops nor skips. */
const cleanSha = (sha: string | undefined): string | undefined => (sha === undefined || sha === UNKNOWN || sha.endsWith(DIRTY_SUFFIX) ? undefined : sha);

async function planFor(deploy: Deploy, target: string, prepareOnly: boolean): Promise<Plan> {
  const { ports, options } = deploy;
  const last = parseDeployRecord(ports.readFile(deployRecordPath(options.stateDir)));
  if (!prepareOnly && last?.outcome === "rolled-back" && last.target === target) {
    return { kind: "stop", code: FAILURE, message: `deploy held: ${target} rolled back at ${last.at} (${last.why ?? "no reason recorded"}); a newer main sha deploys` };
  }
  const running = await runningBuild(ports, options.port);
  const from = cleanSha(running);
  if (!prepareOnly && from !== undefined && (await isAncestor(ports, target, from))) return { kind: "stop", code: 0, message: `already deployed: build ${from} contains ${target}` };
  const head = (await ports.git(["rev-parse", "HEAD"])).stdout.trim();
  if (head !== target && (await isAncestor(ports, target, head))) return refuse(await pastTarget(ports, head, target));
  const closure = closureDirs(readWorkspace({ readFile: (path) => ports.readFile(join(options.checkout, path)), listDirs: (dir) => ports.listDirs(join(options.checkout, dir)) }));
  const changed = from === undefined ? undefined : await changedPaths(ports, from, target);
  const go = { target, running, closure, touched: await runtimeTouched(ports, touchedPaths(changed, closure), from, target), prepareOnly };
  const native = go.touched.length === 0 ? undefined : await nativeBuildRefusal(ports, head, target);
  return native === undefined ? { kind: "go", go } : refuse(native);
}

async function pastTarget(ports: DeployPorts, head: string, target: string): Promise<string> {
  const past = `the checkout's main is at ${head}, already past ${target}`;
  if (await isAncestor(ports, head, ORIGIN_MAIN)) return `${past}; deploy that commit instead with titan-factory service deploy --expect ${head}`;
  return `${past} with commits that are not on ${ORIGIN_MAIN}; push or remove them from the checkout's main, then rerun`;
}

/** setupEnv pins ignore_scripts, so a changed native addon would install uncompiled and a dist rollback could not undo it. */
async function nativeBuildRefusal(ports: DeployPorts, head: string, target: string): Promise<string | undefined> {
  const read = async (sha: string): Promise<string | undefined> => {
    const shown = await ports.git(["show", `${sha}:${LOCKFILE}`]);
    return shown.code === 0 ? shown.stdout : undefined;
  };
  const changes = nativeBuildChanges(await read(head), await read(target));
  if (changes.length === 0) return undefined;
  const steps = `git merge --ff-only ${target}, pnpm install --frozen-lockfile, pnpm --filter "${FACTORY_PACKAGE}..." build, then titan-factory service restart`;
  return `${LOCKFILE} changes a package with a native build (${changes.join("; ")}), and the deployer installs with ignore_scripts, which skips that build. Deploy it by hand in the checkout: ${steps}`;
}

async function changedPaths(ports: DeployPorts, from: string, target: string): Promise<string[] | undefined> {
  const diff = await ports.git(["diff", "--name-only", "--no-renames", from, target]);
  return diff.code === 0 ? diff.stdout.split("\n").filter((line) => line !== "") : undefined;
}

/** A Version Packages merge bumps only package versions, which the build never reads, so those manifests are not build inputs. */
async function runtimeTouched(ports: DeployPorts, touched: string[], from: string | undefined, target: string): Promise<string[]> {
  if (from === undefined) return touched;
  const read = async (sha: string, path: string): Promise<string | undefined> => {
    const shown = await ports.git(["show", `${sha}:${path}`]);
    return shown.code === 0 ? shown.stdout : undefined;
  };
  const kept = await Promise.all(touched.map(async (path) => !path.endsWith("/package.json") || !versionOnlyManifestChange(await read(from, path), await read(target, path))));
  return touched.filter((_, index) => kept[index]);
}

async function execute(deploy: Deploy, go: Go): Promise<number> {
  const merged = await fastForward(deploy.ports, go.target);
  if (merged !== undefined) return stop(deploy, refuse(merged));
  if (go.prepareOnly) return prepare(deploy, go);
  if (go.touched.length === 0) return finish(deploy, go, "skipped", "no changed path reaches the factory build");
  deploy.io.stdout(`deploying ${go.target} over build ${go.running ?? UNKNOWN}; ${go.touched.length} changed path(s) reach the factory build\n`);
  const backup = snapshot(deploy, go);
  const built = await installAndBuild(deploy.ports);
  if (built !== undefined) return rollBackBuild(deploy, go, backup, built);
  const why = await restartAndConfirm(deploy, go.target);
  return why === undefined ? finish(deploy, go, "deployed") : rollBackRestart(deploy, go, backup, why);
}

/** No service runs from this checkout yet, so there is no backup to restore and no restart to confirm: build, then `service install` points the service at it. */
async function prepare(deploy: Deploy, go: Go): Promise<number> {
  const built = await installAndBuild(deploy.ports);
  if (built !== undefined) return stop(deploy, refuse(built));
  deploy.io.stdout(`prepared ${go.target} in ${deploy.options.checkout}; run titan-factory service install to point the service at it\n`);
  return 0;
}

async function fastForward(ports: DeployPorts, target: string): Promise<string | undefined> {
  const merge = await ports.git(["merge", "--ff-only", target]);
  if (merge.code !== 0) return `git merge --ff-only ${target} failed: ${detail(merge)}`;
  const head = (await ports.git(["rev-parse", "HEAD"])).stdout.trim();
  return head === target ? undefined : `the checkout is at ${head} after the fast-forward, not ${target}`;
}

function finish(deploy: Deploy, go: Go, outcome: DeployOutcome, why?: string): number {
  const fields = { outcome, target: go.target, from: go.running ?? UNKNOWN, ...(why === undefined ? {} : { why }), touched: go.touched };
  const ok = outcome === "deployed" || outcome === "skipped";
  return stop(deploy, { kind: "stop", code: ok ? 0 : FAILURE, message: `${outcome} ${go.target}${why === undefined ? "" : `: ${why}`}`, record: record(deploy, fields) });
}

/** One backup at a time: the dist of every closure package as the running build left it. */
function snapshot({ ports, options }: Deploy, go: Go): string {
  const root = backupRoot(options.stateDir);
  const backup = join(root, go.running ?? UNKNOWN);
  ports.removeTree(root);
  for (const dir of go.closure) {
    const dist = join(options.checkout, dir, "dist");
    if (ports.exists(dist)) ports.copyTree(dist, join(backup, dir, "dist"));
  }
  return backup;
}

function restore({ ports, options }: Deploy, go: Go, backup: string): void {
  for (const dir of go.closure) {
    const dist = join(options.checkout, dir, "dist");
    const saved = join(backup, dir, "dist");
    ports.removeTree(dist);
    if (ports.exists(saved)) ports.copyTree(saved, dist);
  }
}

async function installAndBuild(ports: DeployPorts): Promise<string | undefined> {
  for (const args of [["install", "--frozen-lockfile"], ["--filter", `${FACTORY_PACKAGE}...`, "build"]]) {
    const result = await ports.pnpm(args);
    if (result.code !== 0) return `pnpm ${args.join(" ")} failed: ${detail(result)}`;
  }
  return undefined;
}

/** restartService confirms launchd's pid and github ok; the sha check proves the new build is the one answering, and the watch that it stays up without new step errors. */
async function restartAndConfirm({ ports, io, options }: Deploy, target: string): Promise<string | undefined> {
  if ((await restartService(ports, io, options.port, options.logDir, options.drain)) !== 0) return "the restarted service did not come up healthy";
  const health = await answeredHealth(ports, options.port);
  const sha = buildShaOf(health);
  if (health === undefined || sha === undefined) return `/health answered no build sha in ${SHA_POLLS} tries`;
  if (sha !== target) return `/health reports build ${sha}, not ${target}`;
  const probe = (timeoutMs: number) => ports.healthWithin(options.port, timeoutMs);
  return watchServe({ probe, sleep: ports.sleep, now: ports.now, alive: ports.isAlive }, health, target, { ...DEFAULT_WATCH_WINDOW, ...options.watch });
}

/** A failed build may have half-cleaned dist while the old process still runs, so restore before anything respawns it. */
async function rollBackBuild(deploy: Deploy, go: Go, backup: string, why: string): Promise<number> {
  deploy.io.stderr(`error: ${why}; restoring the factory build from ${backup}\n`);
  restore(deploy, go, backup);
  const back = await stillServing(deploy, go);
  return finish(deploy, go, "rolled-back", back ? why : `${why}; the restored build did not answer /health as ${go.running ?? "before"}`);
}

/**
 * The pause is written before anything is restored, so a deployer killed mid-rollback still holds every deploy.
 * One restore, one restart, one notice: a failed rollback is reported and left paused, never retried.
 */
async function rollBackRestart(deploy: Deploy, go: Go, backup: string, why: string): Promise<number> {
  const pauseFailure = pause(deploy, go, why, "pending");
  deploy.io.stderr(`error: ${why}; restoring the factory build from ${backup}\n`);
  const unverified = await restoreAndVerify(deploy, go, backup);
  const kind = unverified === undefined ? "rolled-back" : "rollback-failed";
  const lost = pause(deploy, go, why, unverified === undefined ? "verified" : "failed") ?? pauseFailure;
  const told = `${why}${unverified === undefined ? "" : `; ${unverified}`}${lost === undefined ? "" : `; the deploy pause could not be written: ${lost}`}`;
  if (unverified !== undefined || lost !== undefined) deploy.io.stderr(`ALERT: the rollback of ${go.target} needs a person: ${told}\n`);
  await announce(deploy, { kind, target: go.target, from: go.running ?? UNKNOWN, why: told, at: new Date(deploy.ports.now()).toISOString() });
  return finish(deploy, go, "rolled-back", told);
}

const pause = ({ ports, options }: Deploy, go: Go, why: string, rollback: DeployPause["rollback"]): string | undefined =>
  writeDeployPause(ports, options.stateDir, { pausedAt: new Date(ports.now()).toISOString(), target: go.target, from: go.running ?? UNKNOWN, why, rollback });

/** Undefined only when the restored build answers `/health` as the sha that ran before; an unknown old sha cannot be verified. */
async function restoreAndVerify(deploy: Deploy, go: Go, backup: string): Promise<string | undefined> {
  const { ports, io, options } = deploy;
  try {
    restore(deploy, go, backup);
    if ((await restartService(ports, io, options.port, options.logDir, { ...options.drain, wait: false })) !== 0) return "the restored build did not come up healthy";
  } catch (error) {
    return `restoring the old build threw: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (go.running === undefined || go.running === UNKNOWN) return "the build before the deploy is unknown, so the restored build cannot be verified";
  const sha = await answeredBuild(ports, options.port);
  return sha === go.running ? undefined : `the restored build answered /health as ${sha ?? "nothing"}, not ${go.running}`;
}

async function announce({ ports, io }: Deploy, incident: DeployIncident): Promise<void> {
  if (!ports.incident) return io.stderr("error: no incident notice is wired, so only this log carries the rollback\n");
  try {
    await ports.incident(incident);
  } catch (error) {
    io.stderr(`error: the incident notice failed: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

/** After a failed build the old process has its code loaded already, so it should still answer as the running build. */
async function stillServing({ ports, options }: Deploy, go: Go): Promise<boolean> {
  return go.running === undefined || (await answeredBuild(ports, options.port)) === go.running;
}
