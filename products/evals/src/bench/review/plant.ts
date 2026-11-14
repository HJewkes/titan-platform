import type { BundleGit } from "../../review-pr/bundle.js";
import { CONTROL_KINDS, plantDefect, type ControlKind } from "../../review-pr/controls.js";
import type { ReviewCaseBody } from "./cases.js";

const text = (buffer: Buffer): string => buffer.toString("utf8").trim();

/**
 * A planted case on a clean head: the first file the PR changed that can carry `kind`, read at the head. Only a clean
 * head is planted on, since a head with a real defect would give the case two gold answers and score only one.
 */
export async function plantOn(clean: ReviewCaseBody, kind: ControlKind, git: BundleGit): Promise<ReviewCaseBody | undefined> {
  if (clean.caseType !== "clean") throw new Error(`refusing to plant on ${clean.id}: it is a ${clean.caseType} case, not a clean head`);
  const changed = text(await git.git(["diff", "--name-only", "--diff-filter=d", clean.base, clean.head])).split("\n").filter(Boolean).sort();
  for (const path of changed) {
    const planted = plantDefect(kind, path, (await git.git(["show", `${clean.head}:${path}`])).toString("utf8"));
    if (!planted) continue;
    const plant = { kind, path: planted.path, line: planted.line, text: planted.text };
    return { ...clean, id: `${clean.id}-planted-${kind}`, caseType: "planted", gold: [{ path: planted.path, line: planted.line }], plant, plantedOn: clean.id };
  }
  return undefined;
}

/** Kinds rotate per control; each clean head carries at most one plant, taken in the pool's order. */
export async function plantControls(pool: readonly ReviewCaseBody[], count: number, gitFor: (repo: string) => BundleGit | undefined): Promise<ReviewCaseBody[]> {
  const used = new Set<string>();
  const planted: ReviewCaseBody[] = [];
  for (let n = 0; n < count; n++) {
    const kind = CONTROL_KINDS[n % CONTROL_KINDS.length] ?? CONTROL_KINDS[0];
    const control = await firstPlantable(pool, kind, used, gitFor);
    if (control === undefined) break;
    planted.push(control);
  }
  return planted;
}

async function firstPlantable(pool: readonly ReviewCaseBody[], kind: ControlKind, used: Set<string>, gitFor: (repo: string) => BundleGit | undefined): Promise<ReviewCaseBody | undefined> {
  for (const clean of pool) {
    const git = gitFor(clean.repo);
    if (used.has(clean.id) || git === undefined) continue;
    const control = await plantOn(clean, kind, git);
    if (control === undefined) continue;
    used.add(clean.id);
    return control;
  }
  return undefined;
}
