import { createHash } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import {
  ArMicroSchema,
  BoundsSchema,
  TargetSchema,
  changedParams,
  frozenOverlap,
  median,
  parseUnifiedDiff,
  postCheck,
  renderCommand,
  resultSchemaFor,
  type ArPorts,
  type ArResult,
  type Bounds,
  type DiffFile,
  type Idea,
  type LookAggregate,
  type LookRequest,
  type Pinned,
  type RegistryRow,
  type RoundRecord,
  type RunPin,
  type Target,
} from "@titan-design/autoresearch";
import { execDatedGit, mergeOnto } from "./integrate.js";
import { execGit, ratchetFastForward, remoteDefaultBranch, seedRatchet } from "./ratchet.js";
import { lastLine, runCommand } from "./run-command.js";

export interface EvaluatorOptions {
  /** A clone of the target repo; its `origin` holds the ratchet branch. */
  clone: string;
  /** One evaluator and one integration checkout per run go here. */
  workRoot: string;
  archiveDir: string;
  /** Where `target.json` and `bounds.json` sit in the target repo. */
  adapterDir: string;
  /** Names L0 refuses in an added line; a host reads them from its own config, never from the target repo. */
  caseNames?: readonly string[];
  /** Held-out cases for milestone looks, from host config; absent or empty, a look is refused. */
  validatorCases?: readonly ValidatorCase[];
  /** The phase registry, one JSON line per finished phase; absent, the registry step records no path. */
  registryPath?: string;
  now?: () => number;
}

export interface ValidatorCase {
  case: string;
  /** The `{caseSet}` argument; absent, the target's own `caseSets` entry for the case, if any. */
  caseSet?: string;
}

type EvaluatorPorts = Pick<ArPorts, "pin" | "evalCase" | "micro" | "staticCheck" | "ratchet" | "integrate" | "archive" | "validate" | "registry">;

type Session = Pick<Pinned, "pin" | "target" | "bounds"> & { evaluatorTree: string; frozenHash: string; defaultBranch: string };
type Row = { name: string; ok: boolean; code?: string; ms?: number };

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const nul = (text: string) => text.split("\0").filter(Boolean);

/**
 * The frozen files as they are on disk, tracked or not, so an edit the evaluator commits still shows. Frozen
 * entries are git `:(glob)` pathspecs: `**`, `*` and `?`, no braces.
 */
async function frozenHash(tree: string, frozen: readonly string[]): Promise<string> {
  if (frozen.length === 0) return sha256("");
  const listed = await execGit(["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ...frozen.map((glob) => `:(glob)${glob}`)], tree);
  const paths = [...new Set(nul(listed))].sort();
  return sha256(paths.map((path) => `${path} ${existsSync(join(tree, path)) ? sha256(readFileSync(join(tree, path))) : "missing"}`).join("\n"));
}

/** A restarted pin replaces its own checkout rather than failing on the leftover. */
async function checkout(clone: string, tree: string, rev: string): Promise<void> {
  if (existsSync(tree)) await execGit(["worktree", "remove", "--force", tree], clone);
  await execGit(["worktree", "add", "--quiet", "--detach", tree, rev], clone);
}

async function readAdapter(clone: string, pin: string, adapterDir: string) {
  const at = (name: string) => `${pin}:${adapterDir}/${name}`;
  const target = TargetSchema.parse(JSON.parse(await execGit(["show", at("target.json")], clone)));
  const bounds = BoundsSchema.parse(JSON.parse(await execGit(["show", at("bounds.json")], clone)));
  return { target, bounds, targetSha: await execGit(["rev-parse", at("target.json")], clone), boundsSha: await execGit(["rev-parse", at("bounds.json")], clone) };
}

/** Glob classes are tested file by file against the pin's tree, which the recipe's literal-only check cannot do. */
async function refuseFrozenClasses(clone: string, pin: string, bounds: Bounds, frozen: readonly string[]): Promise<void> {
  const files = nul(await execGit(["ls-tree", "-r", "--name-only", "-z", pin], clone));
  const overlap = frozenOverlap(bounds, frozen, files);
  if (overlap.length > 0) throw new Error(`[bounds-frozen] ${overlap.join(", ")}`);
}

const evaluatorTreeOf = (workRoot: string, runId: string) => join(workRoot, `eval-${runId}`);

/** A run is judged against the default branch, so a pin from a side branch would ratchet work main never had. */
async function refuseOffMain(clone: string, pin: string, defaultBranch: string): Promise<void> {
  await execGit(["fetch", "--quiet", "origin"], clone).catch((error: unknown) => {
    throw new Error(`[pin-fetch] git fetch origin failed in ${clone}: ${error instanceof Error ? error.message : String(error)}`);
  });
  const onMain = await execGit(["merge-base", "--is-ancestor", pin, `origin/${defaultBranch}`], clone).then(
    () => true,
    (error: { code?: unknown }) => {
      if (error.code === 1) return false;
      throw error;
    },
  );
  if (!onMain) throw new Error(`[pin-not-on-main] ${pin} is not on origin/${defaultBranch}`);
}

async function pinRun(options: EvaluatorOptions, runId: string, rev: string): Promise<Pinned & Session> {
  const { clone, workRoot, adapterDir } = options;
  const pin = await execGit(["rev-parse", "--verify", `${rev}^{commit}`], clone);
  const defaultBranch = await remoteDefaultBranch(execGit, clone);
  await refuseOffMain(clone, pin, defaultBranch);
  const adapter = await readAdapter(clone, pin, adapterDir);
  await refuseFrozenClasses(clone, pin, adapter.bounds, adapter.target.frozen);
  const [evaluatorTree, integrationTree] = [evaluatorTreeOf(workRoot, runId), join(workRoot, `int-${runId}`)];
  await checkout(clone, evaluatorTree, pin);
  await checkout(clone, integrationTree, pin);
  const { ratchetPrefix } = adapter.target;
  const ratchetRef = `refs/heads/${ratchetPrefix}/${runId}`;
  await seedRatchet(execGit, { tree: integrationTree, ratchetRef, ratchetPrefix, defaultBranch, pin });
  const hash = await frozenHash(evaluatorTree, adapter.target.frozen);
  return { pin, ratchetRef, ratchetHead: pin, integrationTree, evaluatorTree, frozenHash: hash, defaultBranch, ...adapter };
}

async function assertIntact(session: Session): Promise<void> {
  const { evaluatorTree, target } = session;
  if (await execGit(["status", "--porcelain"], evaluatorTree)) throw new Error(`[evaluator-dirty] ${evaluatorTree} has uncommitted changes`);
  if ((await frozenHash(evaluatorTree, target.frozen)) !== session.frozenHash) throw new Error(`[frozen-drift] frozen files in ${evaluatorTree} no longer match the pin`);
}

/**
 * A host that restarted after `ar-pin` rebuilds the run's evaluator from the pin the engine recorded: the adapter is
 * re-read at the pin and the checkout must still hash to the recorded value, so a scorer edited while the host was
 * down is refused, not adopted.
 */
async function resumeRun(options: EvaluatorOptions, { runId, pin, frozenHash: recorded }: RunPin): Promise<Session> {
  const evaluatorTree = evaluatorTreeOf(options.workRoot, runId);
  if (recorded === undefined) throw new Error(`[no-pin] run ${runId} recorded no frozen hash, so its evaluator cannot be checked`);
  if (!existsSync(evaluatorTree)) throw new Error(`[no-pin] run ${runId} has no evaluator checkout at ${evaluatorTree}`);
  const { target, bounds } = await readAdapter(options.clone, pin, options.adapterDir);
  const session = { pin, target, bounds, evaluatorTree, frozenHash: recorded, defaultBranch: await remoteDefaultBranch(execGit, options.clone) };
  await assertIntact(session);
  return session;
}

/** Both sides of every evaluator run: a scorer that edits itself mid-run is caught after, not only before. */
async function guarded<T>(session: Session, run: () => Promise<T>): Promise<T> {
  await assertIntact(session);
  const result = await run();
  await assertIntact(session);
  return result;
}

const defined = (vars: Record<string, string | undefined>): Record<string, string> =>
  Object.fromEntries(Object.entries(vars).filter((entry): entry is [string, string] => entry[1] !== undefined));

function rungOf(target: Target, name: string) {
  const rung = target.rungs[name];
  if (!rung) throw new Error(`[rung] ${name} is not in target.rungs`);
  return rung;
}

/** Eval and micro scripts are frozen, so they run from the evaluator checkout; `{runnerRoot}` points them at the idea's code. */
async function runRung(session: Session, name: string, vars: Record<string, string | undefined>, signal: AbortSignal): Promise<unknown> {
  const rung = rungOf(session.target, name);
  const argv = renderCommand(rung.cmd, defined({ ...vars, maxUsd: rung.maxUsd?.toString() }));
  const timeoutMs = rung.timeoutMin === undefined ? undefined : rung.timeoutMin * 60_000;
  return guarded(session, async () => lastLine(await runCommand(argv, { cwd: session.evaluatorTree, signal, timeoutMs }), argv));
}

async function paramsOf(bounds: Bounds, idea: Idea, diff: readonly DiffFile[], tree: string, revs: [string, string]) {
  const spec = bounds.classes[idea.class];
  const file = spec?.params ? diff.find((changed) => spec.paths.includes(changed.path)) : undefined;
  if (!file) return undefined;
  const show = (rev: string) => execGit(["show", `${rev}:${file.path}`], tree).catch(() => "{}");
  return changedParams(await show(revs[0]), await show(revs[1]));
}

async function timedRow(name: string, argv: readonly string[], cwd: string, signal: AbortSignal): Promise<Row> {
  const started = Date.now();
  const run = await runCommand(argv, { cwd, signal });
  const ms = Date.now() - started;
  return run.ok ? { name, ok: true, ms } : { name, ok: false, code: name, ms };
}

/** The proof script is frozen, so its path is read from the evaluator checkout while it runs in the idea's tree. */
const resolveIn = (root: string, argv: readonly string[]) =>
  argv.map((arg, index) => (index > 0 && arg.includes("/") && !isAbsolute(arg) && existsSync(join(root, arg)) ? join(root, arg) : arg));

const provesTest = (session: Session, idea: Idea) =>
  session.target.testProof.length > 0 && session.bounds.test.mustFailOnBase && !session.bounds.test.exceptClasses.includes(idea.class);

async function suiteRows(session: Session, idea: Idea, tree: string, revs: [string, string], signal: AbortSignal): Promise<Row[]> {
  const rows: Row[] = [];
  if (session.target.unitTests.length > 0) rows.push(await timedRow("unit-suite", session.target.unitTests, tree, signal));
  if (provesTest(session, idea)) {
    const proof = resolveIn(session.evaluatorTree, renderCommand(session.target.testProof, { base: revs[0], head: revs[1] }));
    rows.push(await timedRow("test-proof", proof, tree, signal));
  }
  return rows;
}

/** L0 in the idea's tree. The bounds rows come from one pure pass and share its time; every row runs, and the first failure is the code. */
async function staticCheck(session: Session, caseNames: readonly string[], input: { idea: Idea; tree: string; base: string; head: string }, signal: AbortSignal) {
  const { idea, tree, base, head } = input;
  const started = Date.now();
  const diff = parseUnifiedDiff(await execGit(["diff", "--no-color", "--unified=0", "-M", base, head], tree));
  const paramValues = await paramsOf(session.bounds, idea, diff, tree, [base, head]);
  const post = postCheck({ idea, diff, bounds: session.bounds, frozen: session.target.frozen, caseNames, paramValues });
  const ms = Date.now() - started;
  const rows = [...post.checks.map((row) => ({ ...row, ms })), ...(await suiteRows(session, idea, tree, [base, head], signal))];
  const code = rows.find((row) => !row.ok)?.code;
  return { ok: code === undefined, code, checks: rows, diff: post.size };
}

const artifactDirs = (record: RoundRecord) =>
  [...new Set(record.outcomes.flatMap((outcome) => outcome.runs.flatMap((run) => (run.artifact_dir ? [run.artifact_dir] : []))))].filter((dir) => existsSync(dir));

/** A repeated round replaces its own line, so the file holds one sum per archive. */
function writeSum(dir: string, name: string, sum: string): void {
  const file = join(dir, "SHA256SUMS");
  const kept = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((line) => line && !line.endsWith(`  ${name}`)) : [];
  writeFileSync(file, [...kept, `${sum}  ${name}`].join("\n") + "\n");
}

async function archiveRound(archiveDir: string, input: { runId: string; round: number; record: RoundRecord }) {
  const dir = join(archiveDir, input.runId);
  const [name, stage] = [`round-${input.round}.tgz`, join(dir, `.stage-${input.round}`)];
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(join(stage, "artifacts"), { recursive: true });
  writeFileSync(join(stage, "record.json"), JSON.stringify(input.record, null, 2));
  artifactDirs(input.record).forEach((source, index) => cpSync(source, join(stage, "artifacts", `${index}-${basename(source)}`), { recursive: true }));
  const path = join(dir, name);
  const tar = await runCommand(["tar", "-czf", path, "-C", stage, "."], { cwd: dir });
  rmSync(stage, { recursive: true, force: true });
  if (!tar.ok) throw new Error(`[archive] tar failed: ${tar.stderr.trim()}`);
  const sum = sha256(readFileSync(path));
  writeSum(dir, name, sum);
  return { path, sha256: sum };
}

const LOOK_PROVENANCE = "frozen evaluator gates on held-out cases; not an LLM judge; search not changed";

/** Medians per metric and pass counts per gate over every run, so no case's own result leaves the port. */
function aggregateOf(runs: readonly ArResult[]): LookAggregate["aggregate"] {
  const names = (pick: (run: ArResult) => object) => [...new Set(runs.flatMap((run) => Object.keys(pick(run))))].sort();
  const metrics = names((run) => run.metrics).map((name) => [name, median(runs.flatMap((run) => run.metrics[name] ?? []))]);
  const gates = names((run) => run.gates).map((name) => [name, runs.filter((run) => run.gates[name] === true).length]);
  return { metrics: Object.fromEntries(metrics), gates: Object.fromEntries(gates) };
}

/** Unique per look, case and repeat like a search run's key, and naming the case only by its index. */
const lookKey = (input: LookRequest, index: number, repeat: number) => `${input.runId}-val${input.look}-${index}-${repeat}`.replace(/[^A-Za-z0-9._-]/g, "_");

async function seedRuns(session: Session, cases: readonly ValidatorCase[], input: LookRequest, tree: string, signal: AbortSignal): Promise<ArResult[]> {
  const { target } = session;
  const runs: ArResult[] = [];
  for (const [index, held] of cases.entries()) {
    for (let repeat = 1; repeat <= target.validator.runs; repeat++) {
      const vars = { caseSet: held.caseSet ?? target.caseSets[held.case], case: held.case, key: lookKey(input, index, repeat), runnerRoot: join(tree, target.runnerRoot) };
      runs.push(resultSchemaFor(target.metric).parse(await runRung(session, "seed", vars, signal)));
    }
  }
  return runs;
}

/**
 * G17: one look runs the frozen seed rung on the held-out cases against the head, in a tree of its own. A parent whose
 * evaluator checkout is gone gets it back at the pin, and the session's frozen-hash check still decides whether it is trusted.
 */
async function validateLook(options: EvaluatorOptions, session: ReturnType<typeof sessions>, input: LookRequest, signal: AbortSignal): Promise<LookAggregate> {
  const cases = options.validatorCases ?? [];
  if (cases.length === 0) throw new Error("[no-validator-cases] no held-out cases are configured for this target");
  const evaluatorTree = evaluatorTreeOf(options.workRoot, input.runId);
  if (!existsSync(evaluatorTree)) await checkout(options.clone, evaluatorTree, input.pin);
  const pinned = await session.of(input);
  const tree = join(options.workRoot, `val-${input.runId}-${input.look}`);
  await checkout(options.clone, tree, input.head);
  try {
    const runs = await seedRuns(pinned, cases, input, tree, signal);
    const at = new Date((options.now ?? Date.now)()).toISOString();
    return { look: input.look, at, sha: input.head, aggregate: aggregateOf(runs), provenance: LOOK_PROVENANCE, usd: runs.reduce((sum, run) => sum + run.usd, 0) };
  } finally {
    await execGit(["worktree", "remove", "--force", tree], options.clone);
  }
}

function appendRegistryRow(registryPath: string | undefined, row: RegistryRow): { path?: string } {
  if (registryPath === undefined) return {};
  mkdirSync(dirname(registryPath), { recursive: true });
  appendFileSync(registryPath, `${JSON.stringify(row)}\n`);
  return { path: registryPath };
}

/** Sessions by run: the one this process pinned, or one rebuilt from a step's recorded pin after a restart. */
function sessions(options: EvaluatorOptions) {
  const byRun = new Map<string, Promise<Session>>();
  const remember = <S extends Session>(runId: string, session: Promise<S>): Promise<S> => {
    byRun.set(runId, session);
    session.catch(() => byRun.get(runId) === session && byRun.delete(runId));
    return session;
  };
  return {
    pin: (runId: string, rev: string) => remember(runId, pinRun(options, runId, rev)),
    of: (input: RunPin) => byRun.get(input.runId) ?? remember(input.runId, resumeRun(options, input)),
  };
}

/**
 * The real evaluator side of a run: pin, L0, micro, eval, ratchet and archive. Every evaluator step names its run's
 * recorded pin, so a process restarted after `ar-pin` rebuilds the session instead of refusing the step.
 */
export function evaluatorPorts(options: EvaluatorOptions): EvaluatorPorts {
  const session = sessions(options);
  return {
    pin: ({ runId, pin }) => session.pin(runId, pin),
    evalCase: async (input, signal) => {
      const pinned = await session.of(input);
      const { target } = pinned;
      const vars = { caseSet: target.caseSets[input.case], case: input.case, key: input.key, runnerRoot: join(input.tree, target.runnerRoot) };
      return resultSchemaFor(target.metric).parse(await runRung(pinned, input.rung, vars, signal));
    },
    micro: async (input, signal) => {
      const pinned = await session.of(input);
      const { baselineDir, microSignal, key, case: name } = input;
      const vars = { ...input.microArgs, runnerRoot: join(input.tree, pinned.target.runnerRoot), baselineDir, microSignal, caseSet: pinned.target.caseSets[name], case: name, key };
      return ArMicroSchema.parse(await runRung(pinned, input.rung, vars, signal));
    },
    staticCheck: async (input, signal) => staticCheck(await session.of(input), options.caseNames ?? [], input, signal),
    ratchet: async (input) => {
      const { tree, ratchetRef, from, to } = input;
      const { target, defaultBranch } = await session.of(input);
      return ratchetFastForward(execGit, { tree, ratchetRef, ratchetPrefix: target.ratchetPrefix, defaultBranch, from, to });
    },
    integrate: ({ tree, base, head, message, at }) => mergeOnto(execDatedGit, { tree, base, head, message, at }),
    archive: (input) => archiveRound(options.archiveDir, input),
    validate: (input, signal) => validateLook(options, session, input, signal),
    registry: async ({ row }) => appendRegistryRow(options.registryPath, row),
  };
}
