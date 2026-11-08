import type { GitHubPort, PullRequest, RepoFile, RepoSlug } from "@titan-design/github";
import type { FactoryHost } from "../host.js";
import { BUMP_BRANCH_PREFIX, bumpBranch, consumerDepNames, planConsumerBump, readConsumerTree, type ConsumerBumpPlan, type ConsumerTree, type LatestRegistry } from "./consumer-bump.js";
import { failureOf } from "./error-class.js";
import type { LockfileRegen, LockfileTree } from "./lockfile-regen.js";
import { BUMP_TITLE, bumpCommitMessage, isSweepOnlyBranch } from "./leftover-bump.js";
import { lookupSeat, type SeatBook } from "./seats.js";
import { headInRepo, registerConsumerBump } from "./self-register.js";
import type { ShepherdServices } from "./services.js";

/** One behind consumer: the tree read at its default branch, the edits that raise it, and the branch they go on. */
interface PlannedBump {
  repo: RepoSlug;
  tree: ConsumerTree;
  plan: ConsumerBumpPlan;
  branch: string;
}

/** A consumer with nothing to open: already on npm latest, or a read or lookup that failed. */
type ConsumerBumpNote = { repo: RepoSlug; current: true } | { repo: RepoSlug; error: string };

interface ConsumerBumpPlans {
  bumps: PlannedBump[];
  notes: ConsumerBumpNote[];
}

/** Reads only: each seat-book consumer at its default branch, planned against npm latest; one repo's failure is its note and never stops the others. */
export async function planConsumerBumps(services: Pick<ShepherdServices, "port" | "seats">, registry: LatestRegistry, repos = consumerRepos(services.seats())): Promise<ConsumerBumpPlans> {
  const latest = memoized(registry);
  const result: ConsumerBumpPlans = { bumps: [], notes: [] };
  for (const repo of repos) {
    try {
      const planned = await planOne(services, repo, latest);
      if (planned.plan.edits.length === 0) result.notes.push({ repo, current: true });
      else result.bumps.push(planned);
    } catch (error) {
      result.notes.push({ repo, error: failureOf(error) });
    }
  }
  return result;
}

/** Every remote some seat lists, minus the ones a deny or charter hard stop forbids, so a denied repo is never read. */
function consumerRepos(book: SeatBook): RepoSlug[] {
  const remotes = new Set(book.seats.flatMap((seat) => seat.remotes));
  return [...remotes].filter((remote) => lookupSeat(book, remote).kind === "seat").sort();
}

async function planOne(services: Pick<ShepherdServices, "port">, repo: RepoSlug, latest: LatestRegistry): Promise<PlannedBump> {
  const ref = await services.port.defaultBranch(repo);
  const tree = await readConsumerTree(services.port, repo, ref);
  const names = consumerDepNames(tree);
  const versions = new Map(await Promise.all(names.map(async (name) => [name, await latest(name)] as const)));
  const plan = planConsumerBump(tree, versions);
  return { repo, tree, plan, branch: bumpBranch(plan.edits) };
}

/** Consumers share most names, so one sweep asks npm once per name. */
function memoized(registry: LatestRegistry): LatestRegistry {
  const seen = new Map<string, Promise<string | null>>();
  return (name) => {
    let answer = seen.get(name);
    if (!answer) seen.set(name, (answer = registry(name)));
    return answer;
  };
}

/** What one consumer came to: a PR opened or found, or why none was. */
interface ConsumerBumpSweepNote {
  repo: RepoSlug;
  pr?: number;
  /** An open bump PR is registered if it is not yet and nothing new opens; a closed one on the same branch is a rejected set, never reopened. */
  skipped?: "open" | "closed";
  registered?: string;
  current?: true;
  error?: string;
  /** The leftover branch that blocked this repo: it holds a commit the sweep did not write, so a human deletes it or opens its PR. */
  branch?: string;
}

/** A bump branch with no open PR whose commits are not provably the sweep's own, so it is never built on. */
class LeftoverBumpBranchError extends Error {
  constructor(readonly branch: string) {
    super(`leftover bump branch ${branch} has no open PR`);
    this.name = "LeftoverBumpBranchError";
  }
}

function noteOfFailure(repo: RepoSlug, error: unknown): ConsumerBumpSweepNote {
  return error instanceof LeftoverBumpBranchError ? { repo, error: failureOf(error), branch: error.branch } : { repo, error: failureOf(error) };
}

export interface ConsumerBumpPorts {
  registry: LatestRegistry;
  regen: LockfileRegen;
}

/** Opens at most one bump PR per behind consumer and hands it to Shepherd; a failure is that repo's note and never stops the others. */
export async function bumpConsumers(host: FactoryHost, services: ShepherdServices, ports: ConsumerBumpPorts): Promise<ConsumerBumpSweepNote[]> {
  const { unbumped, notes: openNotes } = await registerOpenBumps(host, services);
  const { bumps, notes } = await planConsumerBumps(services, ports.registry, unbumped);
  const result: ConsumerBumpSweepNote[] = [...openNotes, ...notes];
  for (const bump of bumps) {
    result.push(await bumpOne(host, services, ports.regen, bump).catch((error: unknown) => noteOfFailure(bump.repo, error)));
  }
  return result.sort((a, b) => a.repo.localeCompare(b.repo));
}

/** Runs before any tree read, so an open bump PR is registered even when its repo now plans as current or cannot be read; such a repo is not planned. */
async function registerOpenBumps(host: FactoryHost, services: ShepherdServices): Promise<{ unbumped: RepoSlug[]; notes: ConsumerBumpSweepNote[] }> {
  const unbumped: RepoSlug[] = [];
  const notes: ConsumerBumpSweepNote[] = [];
  for (const repo of consumerRepos(services.seats())) {
    try {
      const open = await openBumpOf(services, repo);
      if (open) notes.push({ repo, pr: open.number, skipped: "open", ...(await registerOnce(host, services, repo, open.number)) });
      else unbumped.push(repo);
    } catch (error) {
      notes.push({ repo, error: failureOf(error) });
    }
  }
  return { unbumped, notes };
}

async function openBumpOf(services: Pick<ShepherdServices, "port">, repo: RepoSlug): Promise<PullRequest | undefined> {
  return (await services.port.listOpenPrs(repo, BUMP_BRANCH_PREFIX)).find((pr) => headInRepo(pr, repo));
}

/** A consumer the sweep would leave alone because its bump PR already exists. */
interface SkippedBump {
  repo: RepoSlug;
  pr: number;
  skipped: "open" | "closed";
}

/** Reads only: what `bumpConsumers` would open, with the open and closed bump PR checks it makes before it writes. */
export async function previewConsumerBumps(services: Pick<ShepherdServices, "port" | "seats">, registry: LatestRegistry): Promise<ConsumerBumpPlans & { skips: SkippedBump[] }> {
  const skips: SkippedBump[] = [];
  const unbumped: RepoSlug[] = [];
  const errors: ConsumerBumpNote[] = [];
  for (const repo of consumerRepos(services.seats())) {
    try {
      const open = await openBumpOf(services, repo);
      if (open) skips.push({ repo, pr: open.number, skipped: "open" });
      else unbumped.push(repo);
    } catch (error) {
      errors.push({ repo, error: failureOf(error) });
    }
  }
  const planned = await planConsumerBumps(services, registry, unbumped);
  const bumps: PlannedBump[] = [];
  const notes = [...errors, ...planned.notes];
  for (const bump of planned.bumps) {
    try {
      const closed = await services.port.findPr(bump.repo, bump.branch);
      if (closed && !headInRepo(closed, bump.repo)) throw new Error(`${bump.repo} PR #${closed.number} from a fork holds ${bump.branch}`);
      if (closed) skips.push({ repo: bump.repo, pr: closed.number, skipped: "closed" });
      else bumps.push(bump);
    } catch (error) {
      notes.push({ repo: bump.repo, error: failureOf(error) });
    }
  }
  return { bumps, notes, skips };
}

async function bumpOne(host: FactoryHost, services: ShepherdServices, regen: LockfileRegen, bump: PlannedBump): Promise<ConsumerBumpSweepNote> {
  const { repo } = bump;
  const closed = await services.port.findPr(repo, bump.branch);
  if (closed && !headInRepo(closed, repo)) throw new Error(`${repo} PR #${closed.number} from a fork holds ${bump.branch}`);
  if (closed) return { repo, pr: closed.number, skipped: "closed" };
  const changed = await regenerate(regen, bump);
  const pr = await openBump(services.port, bump, changed);
  return { repo, pr: pr.number, ...(await registerOnce(host, services, repo, pr.number)) };
}

/** The edited manifests plus the lockfile pnpm or npm rewrote, each with the blob it replaces. */
async function regenerate(regen: LockfileRegen, bump: PlannedBump): Promise<FileWrite[]> {
  const lockfile = bump.tree.lockfile;
  if (!lockfile) throw new Error(`${bump.repo} has no lockfile to regenerate`);
  const edited = new Map(bump.plan.files.map((file) => [file.path, file]));
  const readFiles = [...bump.tree.manifests, lockfile.file, bump.tree.workspaceYaml, bump.tree.npmrc].filter((file): file is RepoFile => file !== null);
  const tree: LockfileTree = { kind: lockfile.kind, files: Object.fromEntries(readFiles.map((file) => [file.path, edited.get(file.path)?.content ?? file.content])) };
  const regenerated = await regen(tree);
  const blobs = new Map(readFiles.map((file) => [file.path, file.blobSha]));
  const writes = new Map<string, FileWrite>(bump.plan.files.map((file) => [file.path, file]));
  for (const [path, content] of Object.entries(regenerated)) writes.set(path, { path, content, expectedBlobSha: blobs.get(path) ?? null });
  return [...writes.values()];
}

interface FileWrite {
  path: string;
  content: string;
  expectedBlobSha: string | null;
}

/**
 * Builds the branch through the contents API, as the toolchain sweep does; each write's expected blob makes a moved file fail instead of being overwritten.
 * A branch that already exists with no PR is built on only while every commit on it is the sweep's own write of one of these files, checked before
 * and after the writes, since any other commit would ride into the PR the sweep registers. It is never force-pushed or deleted.
 */
async function openBump(port: GitHubPort, bump: PlannedBump, files: FileWrite[]): Promise<PullRequest> {
  const { repo, branch, tree } = bump;
  const baseSha = await port.getHeadSha(repo, tree.ref);
  if (baseSha === null) throw new Error(`${repo} has no ${tree.ref} branch`);
  const created = await port.ensureBranch(repo, branch, baseSha);
  const paths = new Set(files.map((file) => file.path));
  const sweepOnly = async (): Promise<void> => {
    if (!created.done && !(await isSweepOnlyBranch(port, repo, tree.ref, branch, paths))) throw new LeftoverBumpBranchError(branch);
  };
  await sweepOnly();
  for (const file of files) {
    const expectedBlobSha = created.done ? file.expectedBlobSha : ((await port.getFile(repo, file.path, branch))?.blobSha ?? null);
    await port.putFile(repo, { path: file.path, branch, content: file.content, message: bumpCommitMessage(file.path), expectedBlobSha });
  }
  await sweepOnly();
  const opened = await port.openPr(repo, { head: branch, base: tree.ref, title: BUMP_TITLE, body: bumpBody(bump.plan) });
  if (!opened.done || !headInRepo(opened.pr, repo)) throw new Error(`${repo} PR #${opened.pr.number} on ${branch} was not opened by this sweep`);
  return opened.pr;
}

function bumpBody(plan: ConsumerBumpPlan): string {
  const raised = plan.edits.map((edit) => `- \`${edit.name}\`: ${edit.from} → ${edit.to} (\`${edit.path}\`)`);
  const left = plan.leftAlone.map((found) => `- \`${found.name}\`: ${found.spec} (\`${found.path}\`, ${found.reason})`);
  const leftSection = left.length > 0 ? ["", "Left alone:", ...left] : [];
  return ["Factory's consumer bump sweep opened this PR: it raises these specifiers to npm latest and regenerates the lockfile.", "", ...raised, ...leftSection].join("\n");
}

/** A live registration is left alone; a missing or failed one is (re)registered by `register` itself. */
async function registerOnce(host: FactoryHost, services: ShepherdServices, repo: RepoSlug, pr: number): Promise<{ registered?: string }> {
  const known = services.store.get().byPr(repo, pr);
  if (known && host.runtime.status(known.runId)?.status !== "failed") return {};
  return { registered: (await registerConsumerBump({ warnings: [], format: "json", host, shepherd: services }, repo, pr)).runId };
}
