import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Exec } from "@titan-design/fix-proof";
import { filterPrivate, type ExclusionPolicy } from "../private/exclusion.js";
import { localCloneGit, type BundleGit } from "../review-pr/bundle.js";
import { buildCorrectedRef, fixTests, laterFixCandidates, type FixSource, type indexCorpus } from "./later-fix.js";
import { screenLaterFix } from "./later-fix-screen.js";
import type { screenCase } from "./screen.js";
import type { CorpusV3Row } from "./select.js";
import { implementCaseId, type ImplementTaskSource, type LaterFixAttachment } from "./write-case.js";

/** Which corpus links to follow: title-matched follow-ups, file-overlap fixes within 14 days, or both. */
export type LaterFixSource = FixSource | "both";

interface LaterFixContext {
  index: ReturnType<typeof indexCorpus>;
  fixSource: LaterFixSource;
  outDir: string;
  policy: ExclusionPolicy;
  /** The owner's clone of `owner/repo`; only cloned from, never written. */
  cloneFor(repo: string): string | undefined;
  exec: Exec;
  screen?: typeof screenCase;
  log(line: string): void;
}

interface KeptCase {
  source: ImplementTaskSource;
  row: CorpusV3Row;
}

type Link = { caseId: string; pr: number; fixSource: FixSource };

export interface LaterFixManifest {
  attached: (Link & { tests: string[] })[];
  rejected: (Link & { reason: string })[];
  counts: { attached: number; rejected: Record<string, number> };
}

type Outcome = { ok: true; attachment: LaterFixAttachment } | { ok: false; reason: string };

const CLONE_TIMEOUT_MS = 10 * 60_000;
const REPO_NAME = /^[\w-][\w.-]*\/[\w-][\w.-]*$/;

/** The same `.scratch/<owner>/<repo>` clone the primary screen made, so a corrected reference never lands in the owner's clone. */
async function scratchCloneOf(repo: string, ctx: LaterFixContext): Promise<string> {
  if (!REPO_NAME.test(repo)) throw new Error(`repo is not owner/name: ${JSON.stringify(repo)}`);
  const clone = join(ctx.outDir, ".scratch", repo);
  if (existsSync(clone)) return clone;
  const local = ctx.cloneFor(repo);
  if (local === undefined) throw new Error(`no local clone for ${repo}`);
  mkdirSync(dirname(clone), { recursive: true });
  const result = await ctx.exec("git", ["clone", "--quiet", "--shared", "--no-checkout", "--", local, clone], { cwd: dirname(clone), timeoutMs: CLONE_TIMEOUT_MS });
  if (result.status !== 0) throw new Error(`scratch clone of ${repo} failed (exit ${result.status ?? "signal"}): ${result.stderr.trim()}`);
  return clone;
}

// Ignoring a source empties its list, so a PR both lists name still counts under the source that was kept.
function linksOf(row: CorpusV3Row, fixSource: LaterFixSource): CorpusV3Row {
  return { ...row, follow_up_fixes: fixSource === "fix-touch" ? [] : row.follow_up_fixes, fix_touch_14d: fixSource === "follow-up" ? [] : row.fix_touch_14d };
}

const readAt = async (port: BundleGit, sha: string, paths: readonly string[]) => Promise.all(paths.map(async (path) => ({ path, bytes: await port.git(["show", `${sha}:${path}`]) })));

function privateReason(kept: KeptCase, fixRow: CorpusV3Row, paths: readonly string[], ctx: LaterFixContext): string | undefined {
  const subject = { id: `${kept.source.repo}#${fixRow.pr_number}`, repo: kept.source.repo, taskInitiative: fixRow.task?.initiative ?? null, body: paths };
  return Object.keys(filterPrivate([subject], ctx.policy).excluded)[0];
}

/** Cheapest rejection first: the corrected reference and the fix's tests come before any install or build. */
async function screenOne(kept: KeptCase, pr: number, fixSource: FixSource, fixRow: CorpusV3Row, ctx: LaterFixContext): Promise<Outcome> {
  const clone = await scratchCloneOf(kept.source.repo, ctx);
  const fix = { fixPr: pr, fixBase: fixRow.base_commit, fixMerge: fixRow.merge_commit };
  const corrected = await buildCorrectedRef({ clone, scratchDir: join(ctx.outDir, ".scratch", "later-fix"), merge: kept.source.mergeSha, ...fix, exec: ctx.exec });
  if (!corrected.ok) return corrected;
  const port = localCloneGit(clone);
  const planned = await fixTests(port, fix.fixBase, fix.fixMerge);
  if (!planned.ok) return planned;
  const hidden = privateReason(kept, fixRow, [...planned.tests, ...planned.carried], ctx);
  if (hidden !== undefined) return { ok: false, reason: hidden };
  const verdict = await screenLaterFix({ source: kept.source, fixPr: pr, correctedSha: corrected.sha, tests: planned.tests, clone, outDir: ctx.outDir, exec: ctx.exec, screen: ctx.screen });
  if (verdict !== "attach") return { ok: false, reason: verdict };
  const files = { tests: await readAt(port, corrected.sha, planned.tests), support: await readAt(port, corrected.sha, planned.carried) };
  return { ok: true, attachment: { pr, fixSource, sourceSha: fix.fixMerge, ...files } };
}

async function outcomeOf(kept: KeptCase, pr: number, fixSource: FixSource, fixRow: CorpusV3Row, ctx: LaterFixContext): Promise<Outcome> {
  try {
    return await screenOne(kept, pr, fixSource, fixRow, ctx);
  } catch (error) {
    return { ok: false, reason: `screen-error:${error instanceof Error ? error.message : String(error)}` };
  }
}

const reasonKey = (reason: string): string => reason.split(":", 1)[0] ?? reason;

function countsOf(manifest: Pick<LaterFixManifest, "attached" | "rejected">): LaterFixManifest["counts"] {
  const rejected: Record<string, number> = {};
  for (const { reason } of manifest.rejected) rejected[reasonKey(reason)] = (rejected[reasonKey(reason)] ?? 0) + 1;
  return { attached: manifest.attached.length, rejected };
}

/**
 * Screens each kept case's later fixes in PR order and returns the attachments by case id. Only a fix whose corrected
 * reference builds and whose screen attaches it is read; every other fix is recorded with its reason.
 */
export async function screenLaterFixes(kept: readonly KeptCase[], ctx: LaterFixContext) {
  const attachments = new Map<string, LaterFixAttachment[]>();
  const manifest: Pick<LaterFixManifest, "attached" | "rejected"> = { attached: [], rejected: [] };
  for (const entry of kept) {
    const caseId = implementCaseId(entry.source);
    const { candidates, rejected } = laterFixCandidates(linksOf(entry.row, ctx.fixSource), ctx.index);
    manifest.rejected.push(...rejected.map(({ pr, fixSource, reason }) => ({ caseId, pr, fixSource, reason })));
    for (const { pr, fixSource, row } of candidates) {
      const outcome = await outcomeOf(entry, pr, fixSource, row, ctx);
      ctx.log(`${caseId} later fix #${pr}: ${outcome.ok ? "attach" : outcome.reason}`);
      if (!outcome.ok) manifest.rejected.push({ caseId, pr, fixSource, reason: outcome.reason });
      else {
        attachments.set(caseId, [...(attachments.get(caseId) ?? []), outcome.attachment]);
        manifest.attached.push({ caseId, pr, fixSource, tests: outcome.attachment.tests.map((file) => file.path) });
      }
    }
  }
  return { attachments, manifest: { ...manifest, counts: countsOf(manifest) } satisfies LaterFixManifest };
}
