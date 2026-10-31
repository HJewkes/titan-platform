import { join } from "node:path";
import { isObjectLike } from "@titan-design/rpc-protocol/narrow";
import { cloneIfAbsent, serviceRunsFromCheckout } from "./deploy-bootstrap.js";
import { DIRTY_SUFFIX } from "./build-info.js";
import { closureDirs, FACTORY_PACKAGE, nativeBuildChanges, readWorkspace, touchedPaths } from "./deploy-closure.js";
import { changedPaths, runtimeTouched, showAt } from "./deploy-range.js";
import { announce, resolveAlarms, type NoticePorts } from "./deploy-notices.js";
import { deployLockPath, releaseLock, takeLock, type LockPorts } from "./deploy-lock.js";
import { deployHeld } from "./deploy-hold-gate.js";
import { writeDeployPause, type DeployPause } from "./deploy-pause.js";
import { buildLog, detail, writeBuildLog, writeUnreadableHold, writeWindowRecord } from "./deploy-output.js";
import { buildShaOf, DEFAULT_WATCH_WINDOW, answerOf, watchServe, type Probe, type WatchHeld, type WatchIntent, type WatchWindow } from "./deploy-watch-window.js";
import { restartService, type CommandResult, type RestartDrain, type ServiceIo, type ServicePorts } from "./service-control.js";

/** Every effect the deployer has beyond the service verbs'; tests pass fakes, so none of them reaches git, pnpm or launchd. */
export interface DeployPorts extends ServicePorts, LockPorts, NoticePorts {
  /** `/health` with a longer timeout than `health`'s, for reads that must not mistake a slow answer for none. */
  healthWithin: (port: number, timeoutMs: number) => Promise<Probe>;
  /** `git clone --branch main <remote> <dest>`, run from the parent of `dest`; only called when the checkout is absent. */
  clone: (remote: string, dest: string) => Promise<CommandResult>;
  /** Runs in the service checkout. */
  git: (args: readonly string[]) => Promise<CommandResult>;
  /** Runs in the service checkout under the worktree setup env, except that pnpm honors the checkout's packageManager pin and only install ignores scripts. */
  pnpm: (args: readonly string[]) => Promise<CommandResult>;
  listDirs: (dir: string) => readonly string[];
  copyTree: (from: string, to: string) => void;
  removeTree: (path: string) => void;
  /** The file names in `dir`; undefined when it is missing or cannot be read. */
  listFiles: (dir: string) => string[] | undefined;
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
  /** The seat queue files whose Morning `DEPLOY HOLD:` items set the manual hold before it is read; absent skips the sync. */
  morningQueuesDir?: string | undefined;
}

/** A refusal is printed, never recorded, so it cannot overwrite a rolled-back hold. */
export type DeployOutcome = "deployed" | "skipped" | "rolled-back" | "held";

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
const FAILURE = 1;
const SHA_POLLS = 10;
const SHA_POLL_MS = 1_000;
const SHA_PROBE_TIMEOUT_MS = 5_000;
const LOCKFILE = "pnpm-lock.yaml";

export const deployRecordPath = (stateDir: string): string => join(stateDir, "deploy.json");
const backupRoot = (stateDir: string): string => join(stateDir, "deploy-backup");

const isDeployRecord = (value: unknown): value is DeployRecord => isObjectLike(value) && typeof value.outcome === "string" && typeof value.target === "string";

export function parseDeployRecord(text: string | undefined): DeployRecord | undefined {
  if (text === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return isDeployRecord(value) ? value : undefined;
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
    const held = deployHeld(ports, io.stderr, { ...options, now: ports.now() });
    const plan: Plan = held === undefined ? await planDeploy(deploy) : { kind: "stop", code: FAILURE, message: held };
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
  return buildShaOf(answerOf(await ports.healthWithin(port, SHA_PROBE_TIMEOUT_MS)));
}

/** A slow or missing answer under load is not a wrong sha, so poll; undefined means no answer with a sha in the whole poll. */
async function answeredHealth(ports: DeployPorts, port: number): Promise<Record<string, unknown> | undefined> {
  for (let poll = 0; poll < SHA_POLLS; poll++) {
    const health = answerOf(await ports.healthWithin(port, SHA_PROBE_TIMEOUT_MS));
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
  if (head !== target && (await isAncestor(ports, target, head))) return pastTarget(ports, head, target);
  const closure = closureDirs(readWorkspace({ readFile: (path) => ports.readFile(join(options.checkout, path)), listDirs: (dir) => ports.listDirs(join(options.checkout, dir)) }));
  const changed = from === undefined ? undefined : await changedPaths(ports.git, from, target);
  const go = { target, running, closure, touched: await runtimeTouched(ports.git, touchedPaths(changed, closure), from, target), prepareOnly };
  const native = go.touched.length === 0 ? undefined : await nativeBuildRefusal(ports, head, target);
  return native === undefined ? { kind: "go", go } : refuse(native);
}

/** Only the asked sha deploys, since the pacer checked its CI and no other sha's (TP-4279); deploy-health reads this refusal as superseded. */
async function pastTarget(ports: DeployPorts, head: string, target: string): Promise<Plan> {
  const past = `the checkout's main is at ${head}, already past ${target}`;
  if (!(await isAncestor(ports, head, ORIGIN_MAIN))) return refuse(`${past} with commits that are not on ${ORIGIN_MAIN}; push or remove them from the checkout's main, then rerun`);
  return refuse(`${past}; deploy that commit instead with titan-factory service deploy --expect ${head}`);
}

/** setupEnv pins ignore_scripts, so a changed native addon would install uncompiled and a dist rollback could not undo it. */
async function nativeBuildRefusal(ports: DeployPorts, head: string, target: string): Promise<string | undefined> {
  const changes = nativeBuildChanges(await showAt(ports.git, head, LOCKFILE), await showAt(ports.git, target, LOCKFILE));
  if (changes.length === 0) return undefined;
  const steps = `git merge --ff-only ${target}, pnpm install --frozen-lockfile, pnpm --filter "${FACTORY_PACKAGE}..." build, then titan-factory service restart`;
  return `${LOCKFILE} changes a package with a native build (${changes.join("; ")}), and the deployer installs with ignore_scripts, which skips that build. Deploy it by hand in the checkout: ${steps}`;
}

async function execute(deploy: Deploy, go: Go): Promise<number> {
  const merged = await fastForward(deploy.ports, go.target);
  if (merged !== undefined) return stop(deploy, refuse(merged));
  if (go.prepareOnly) return prepare(deploy, go);
  if (go.touched.length === 0) return finish(deploy, go, "skipped", "no changed path reaches the factory build");
  deploy.io.stdout(`deploying ${go.target} over build ${go.running ?? UNKNOWN}; ${go.touched.length} changed path(s) reach the factory build\n`);
  const backup = snapshot(deploy, go);
  const built = await installAndBuild(deploy, go.target);
  if (built !== undefined) return rollBackBuild(deploy, go, backup, built);
  const why = await restartAndConfirm(deploy, go.target);
  if (typeof why === "object") return finish(deploy, go, "held", why.held, writeUnreadableHold(deploy.ports, deploy.options.stateDir, go.target, why.held));
  if (why !== undefined) return rollBackRestart(deploy, go, backup, why);
  await resolveAlarms(deploy.ports, deploy.io);
  return finish(deploy, go, "deployed");
}


/** No service runs from this checkout yet, so there is no backup to restore and no restart to confirm: build, then `service install` points the service at it. */
async function prepare(deploy: Deploy, go: Go): Promise<number> {
  const built = await installAndBuild(deploy, go.target);
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

function finish(deploy: Deploy, go: Go, outcome: DeployOutcome, why?: string, alarm?: string): number {
  if (alarm !== undefined) deploy.io.stderr(alarm);
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

async function installAndBuild(deploy: Deploy, target: string): Promise<string | undefined> {
  for (const args of [["install", "--frozen-lockfile"], ["--filter", `${FACTORY_PACKAGE}...`, "build"]]) {
    const result = await deploy.ports.pnpm(args);
    if (result.code === 0) continue;
    const command = `pnpm ${args.join(" ")}`;
    return `${command} failed: ${detail(result)}\n${writeBuildLog(deploy.ports, deploy.options.stateDir, buildLog(command, target, new Date(deploy.ports.now()).toISOString(), result))}`;
  }
  return undefined;
}

/**
 * restartService confirms launchd's pid and github ok; the sha check proves the new build is the one answering, and the watch that it stays up without new step errors.
 * The drain's last answer goes to the watch, so runs the restart interrupted are told from runs that broke after it.
 */
async function restartAndConfirm({ ports, io, options }: Deploy, target: string): Promise<string | WatchHeld | undefined> {
  let atRestart: Record<string, unknown> | null = null;
  if ((await restartService(ports, io, options.port, options.logDir, options.drain, (drained) => (atRestart = drained))) !== 0) return "the restarted service did not come up healthy";
  const health = await answeredHealth(ports, options.port);
  const sha = buildShaOf(health);
  if (health === undefined || sha === undefined) return `/health answered no build sha in ${SHA_POLLS} tries`;
  if (sha !== target) return `/health reports build ${sha}, not ${target}`;
  const record = (intent: WatchIntent): void => {
    const warning = writeWindowRecord(ports, options.stateDir, intent);
    if (warning !== undefined) io.stderr(warning);
  };
  const watch = { probe: (timeoutMs: number) => ports.healthWithin(options.port, timeoutMs), sleep: ports.sleep, now: ports.now, alive: ports.isAlive, record, report: io.stdout };
  return watchServe(watch, { confirmed: health, atRestart }, target, { ...DEFAULT_WATCH_WINDOW, ...options.watch });
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
  await announce(deploy.ports, deploy.io, { kind, target: go.target, from: go.running ?? UNKNOWN, why: told, at: new Date(deploy.ports.now()).toISOString() });
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


/** After a failed build the old process has its code loaded already, so it should still answer as the running build. */
async function stillServing({ ports, options }: Deploy, go: Go): Promise<boolean> {
  return go.running === undefined || (await answeredBuild(ports, options.port)) === go.running;
}
