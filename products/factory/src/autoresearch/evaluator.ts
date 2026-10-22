import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import {
  ArMicroSchema,
  BoundsSchema,
  TargetSchema,
  changedParams,
  frozenOverlap,
  parseUnifiedDiff,
  postCheck,
  renderCommand,
  resultSchemaFor,
  type ArPorts,
  type Bounds,
  type DiffFile,
  type Idea,
  type Pinned,
  type RoundRecord,
  type Target,
} from "@titan-design/autoresearch";
import { execGit, ratchetFastForward } from "./ratchet.js";
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
}

type EvaluatorPorts = Pick<ArPorts, "pin" | "evalCase" | "micro" | "staticCheck" | "ratchet" | "archive">;

type Session = Pinned & { evaluatorTree: string; frozenHash: string };
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

async function pinRun(options: EvaluatorOptions, runId: string, rev: string): Promise<Session> {
  const { clone, workRoot, adapterDir } = options;
  const pin = await execGit(["rev-parse", "--verify", `${rev}^{commit}`], clone);
  const adapter = await readAdapter(clone, pin, adapterDir);
  await refuseFrozenClasses(clone, pin, adapter.bounds, adapter.target.frozen);
  const [evaluatorTree, integrationTree] = [join(workRoot, `eval-${runId}`), join(workRoot, `int-${runId}`)];
  await checkout(clone, evaluatorTree, pin);
  await checkout(clone, integrationTree, pin);
  const ratchetRef = `refs/heads/${adapter.target.ratchetPrefix}/${runId}`;
  await execGit(["push", "--quiet", "origin", `${pin}:${ratchetRef}`], integrationTree);
  const hash = await frozenHash(evaluatorTree, adapter.target.frozen);
  return { pin, ratchetRef, ratchetHead: pin, integrationTree, evaluatorTree, frozenHash: hash, ...adapter };
}

async function assertIntact(session: Session): Promise<void> {
  const { evaluatorTree, target } = session;
  if (await execGit(["status", "--porcelain"], evaluatorTree)) throw new Error(`[evaluator-dirty] ${evaluatorTree} has uncommitted changes`);
  if ((await frozenHash(evaluatorTree, target.frozen)) !== session.frozenHash) throw new Error(`[frozen-drift] frozen files in ${evaluatorTree} no longer match the pin`);
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

/**
 * The real evaluator side of a run: pin, L0, micro, eval, ratchet and archive. The pin is held in memory, so a
 * process restart after `ar-pin` refuses the next evaluator step rather than run it unguarded.
 */
export function evaluatorPorts(options: EvaluatorOptions): EvaluatorPorts {
  let session: Session | undefined;
  const pinned = () => {
    if (!session) throw new Error("[no-pin] this process has not pinned an evaluator");
    return session;
  };
  return {
    pin: async ({ runId, pin }) => (session = await pinRun(options, runId, pin)),
    evalCase: async ({ tree, case: name, key, rung }, signal) => {
      const { target } = pinned();
      const vars = { caseSet: target.caseSets[name], case: name, key, runnerRoot: join(tree, target.runnerRoot) };
      return resultSchemaFor(target.metric).parse(await runRung(pinned(), rung, vars, signal));
    },
    micro: async (input, signal) => {
      const { target } = pinned();
      const { baselineDir, microSignal, key, case: name } = input;
      const vars = { ...input.microArgs, runnerRoot: join(input.tree, target.runnerRoot), baselineDir, microSignal, caseSet: target.caseSets[name], case: name, key };
      return ArMicroSchema.parse(await runRung(pinned(), input.rung, vars, signal));
    },
    staticCheck: (input, signal) => staticCheck(pinned(), options.caseNames ?? [], input, signal),
    ratchet: ({ tree, ratchetRef, from, to }) => ratchetFastForward(execGit, { tree, ratchetRef, ratchetPrefix: pinned().target.ratchetPrefix, from, to }),
    archive: (input) => archiveRound(options.archiveDir, input),
  };
}
