import type { GitHubPort, PullRequest, RepoSlug } from "@titan-design/github";
import type { FactoryHost } from "../host.js";
import { TOOLCHAIN_CONSUMERS, adoptionPlan, readCanonical, readConsumer } from "../workflows/toolchain-fanout.js";
import { isSweepOnlyBranch } from "./leftover-bump.js";
import { headInRepo, registerToolchainAdoption } from "./self-register.js";
import type { ShepherdServices } from "./services.js";
import { failureOf } from "./error-class.js";

/** Drift, not an event, starts a fanout; an hourly read of a handful of files per consumer keeps the rate-limit cost small. */
export const TOOLCHAIN_SWEEP_MS = 3_600_000;
const CANONICAL_REPO: RepoSlug = "HJewkes/titan-platform";

type AdoptionPlan = NonNullable<ReturnType<typeof adoptionPlan>>;

export interface ToolchainPlans {
  plans: AdoptionPlan[];
  /** A repo whose toolchain could not be read; the canonical repo here means no consumer was read at all. */
  errors: { repo: RepoSlug; error: string }[];
}

export interface ToolchainSweepNote {
  repo: RepoSlug;
  pr?: number;
  /** The branch already has a PR; an open one is registered if it is not yet, a closed one is never reopened. */
  skipped?: "open" | "closed";
  registered?: string;
  error?: string;
}

/** Reads only: the canonical toolchain and every consumer's, and the adoption each drifted consumer needs. */
export async function planAdoptions(port: GitHubPort): Promise<ToolchainPlans> {
  let canonical;
  try {
    canonical = await readCanonical(port);
  } catch (error) {
    return { plans: [], errors: [{ repo: CANONICAL_REPO, error: failureOf(error) }] };
  }
  const result: ToolchainPlans = { plans: [], errors: [] };
  for (const consumer of TOOLCHAIN_CONSUMERS) {
    try {
      const plan = adoptionPlan(canonical, await readConsumer(port, consumer));
      if (plan) result.plans.push(plan);
    } catch (error) {
      result.errors.push({ repo: consumer.repo, error: failureOf(error) });
    }
  }
  return result;
}

/** Opens one adoption PR per drifted consumer and hands it to Shepherd; a failure is that repo's note and never stops the others. */
export async function sweepToolchain(host: FactoryHost, services: ShepherdServices): Promise<ToolchainSweepNote[]> {
  const { plans, errors } = await planAdoptions(services.port);
  const notes: ToolchainSweepNote[] = [...errors];
  for (const plan of plans) {
    notes.push(await adoptOne(host, services, plan).catch((error: unknown) => ({ repo: plan.repo, error: failureOf(error) })));
  }
  return notes;
}

async function adoptOne(host: FactoryHost, services: ShepherdServices, plan: AdoptionPlan): Promise<ToolchainSweepNote> {
  const existing = await services.port.findPr(plan.repo, plan.branch);
  if (existing?.state === "open") return { repo: plan.repo, pr: existing.number, skipped: "open", ...(await registerOnce(host, services, plan.repo, existing.number)) };
  if (existing) return { repo: plan.repo, pr: existing.number, skipped: "closed" };
  const pr = await openAdoption(services.port, plan);
  return { repo: plan.repo, pr: pr.number, ...(await registerOnce(host, services, plan.repo, pr.number)) };
}

/** The branch holds a commit that is not this sweep's own write of a plan file, so a person deletes it or opens its PR. */
class LeftoverAdoptionBranchError extends Error {
  constructor(repo: RepoSlug, branch: string) {
    super(`${repo}: leftover branch ${branch} already exists; refusing to adopt over it`);
    this.name = "LeftoverAdoptionBranchError";
  }
}

/**
 * Builds the branch through the contents API, so no checkout or push is involved. A branch that already exists with no PR is
 * resumed only while every commit on it is this sweep's own write of one of the plan's files, checked before and after the
 * writes; any other leftover is refused with nothing written. Each write carries the blob it expects, re-read on a resumed branch.
 */
export async function openAdoption(port: GitHubPort, plan: AdoptionPlan): Promise<PullRequest> {
  const baseSha = await port.getHeadSha(plan.repo, plan.baseBranch);
  if (baseSha === null) throw new Error(`${plan.repo} has no ${plan.baseBranch} branch`);
  const created = await port.ensureBranch(plan.repo, plan.branch, baseSha);
  const paths = new Set(plan.files.map((file) => file.path));
  const messageOf = (path: string): string => `${plan.title}: ${path}`;
  const sweepOnly = async (): Promise<void> => {
    if (!(await isSweepOnlyBranch(port, plan.repo, plan.baseBranch, plan.branch, paths, messageOf))) throw new LeftoverAdoptionBranchError(plan.repo, plan.branch);
  };
  if (!created.done) await sweepOnly();
  for (const file of plan.files) {
    const expectedBlobSha = created.done ? file.expectedBlobSha : ((await port.getFile(plan.repo, file.path, plan.branch))?.blobSha ?? null);
    await port.putFile(plan.repo, { path: file.path, branch: plan.branch, content: file.content, message: messageOf(file.path), expectedBlobSha });
  }
  await sweepOnly();
  const opened = await port.openPr(plan.repo, { head: plan.branch, base: plan.baseBranch, title: plan.title, body: adoptionBody(plan) });
  if (!opened.done || !headInRepo(opened.pr, plan.repo)) throw new Error(`${plan.repo} PR #${opened.pr.number} on ${plan.branch} was not opened by this sweep`);
  return opened.pr;
}

function adoptionBody(plan: AdoptionPlan): string {
  const files = plan.files.map((file) => `- \`${file.path}\``);
  const left = plan.leftAlone.map((found) => `- \`${found.path}:${found.line}\` (${found.reason})`);
  const leftSection = left.length > 0 ? ["", "Left alone, for a person to judge:", ...left] : [];
  return [`Factory's toolchain sweep opened this PR: it aligns the repo with ${CANONICAL_REPO}'s canonical toolchain.`, "", ...files, ...leftSection].join("\n");
}

/** A live registration is left alone; a missing or failed one is (re)registered by `register` itself. */
async function registerOnce(host: FactoryHost, services: ShepherdServices, repo: RepoSlug, pr: number): Promise<{ registered?: string }> {
  const known = services.store.get().byPr(repo, pr);
  if (known && host.runtime.status(known.runId)?.status !== "failed") return {};
  return { registered: (await registerToolchainAdoption({ warnings: [], format: "json", host, shepherd: services }, repo, pr)).runId };
}
