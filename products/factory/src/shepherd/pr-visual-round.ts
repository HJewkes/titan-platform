// TP-4761 C3: the pr-visual artifact written into a round directory as before and after pairs, plus the one packet line
// the owner reads beside them. Like the evidence read it informs only: no tier or merge guard imports this file.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { errorClass } from "./error-class.js";
import { DEFAULT_LIMITS, execPrVisualGh, manifestOf, measureArchive, openHeadArtifact, type Manifest, type PrVisualEvidence, type PrVisualGh } from "./pr-visual-evidence.js";
import type { ZipReader } from "./pr-visual-zip.js";
import type { RoundVisuals } from "./visual-week.js";

const WORKFLOW = ".github/workflows/pr-visual.yml";
const PIXEL_TOLERANCE = 0.1;
const CAVEAT = "unattested producer output; not used for the tier";

/** One PR's pairs as written: `reason` says why none are, and `failed` marks a read that may succeed when tried again. */
export interface PrVisuals extends RoundVisuals {
  reason?: string;
  failed?: true;
}

const nothing = (reason: string): PrVisuals => ({ line: `pr-visual: no before and after shown, ${reason} (${CAVEAT})`, variantKeys: [], reason });

type Measured = Extract<PrVisualEvidence, { measured: true }>;

const isChanged = (shot: Measured["shots"][number]): boolean => "sizesDiffer" in shot || shot.changedPixels > 0;

function lineOf(evidence: Measured): string {
  const total = evidence.shots.length;
  const changed = evidence.shots.filter(isChanged).length;
  const missing = evidence.missing.length;
  if (total > 0 && changed === 0) return `pr-visual: ${total} shots, all shots were unchanged and none are shown, ${missing} missing (${CAVEAT})`;
  return `pr-visual: ${total} shots, ${changed} changed, ${total - changed} unchanged not shown, ${missing} missing (${CAVEAT})`;
}

type Target = { repo: string; pr: number; head: string };

/** Why the manifest's shots cannot be shown as a complete set at this PR and head, or undefined when they can. */
function incomplete(manifest: Manifest, { pr, head }: Target): string | undefined {
  if (manifest.pr !== pr || manifest.headSha !== head) return "the artifact was captured for another PR or head";
  const lacking = manifest.shots.filter((shot) => shot.before === undefined || shot.after === undefined).length;
  if (lacking > 0) return `${lacking} shot(s) lack a before or an after`;
  return manifest.shots.length === 0 ? "the artifact lists no shots" : undefined;
}

/** Copies each changed pair under names Shepherd chose, never the artifact's, and writes the manifest `pairVisuals` reads. */
async function writePairs(zip: ZipReader, manifest: Manifest, changed: readonly boolean[], folder: string): Promise<string[]> {
  await mkdir(folder, { recursive: true });
  const shots: { story: string; width: string; before: string; after: string }[] = [];
  for (const [index, shot] of manifest.shots.entries()) {
    if (!changed[index]) continue;
    const names = { before: `${index}-${shot.story}@${shot.width}-before.png`, after: `${index}-${shot.story}@${shot.width}-after.png` };
    for (const side of ["before", "after"] as const) {
      const bytes = zip.read(shot[side] ?? "");
      if ("refused" in bytes) throw new Error(`shot ${index} ${side}: ${bytes.refused}`);
      await writeFile(join(folder, names[side]), bytes);
    }
    shots.push({ story: shot.story, width: shot.width, ...names });
  }
  const body = { v: 1, repo: manifest.repo, pr: manifest.pr, baseSha: manifest.baseSha, headSha: manifest.headSha, rendered: true, shots };
  await writeFile(join(folder, "manifest.json"), JSON.stringify(body));
  return shots.flatMap((shot) => [join(folder, shot.before), join(folder, shot.after)]);
}

async function prVisualsOf(gh: PrVisualGh, target: Target, folder: string): Promise<PrVisuals> {
  const zip = await openHeadArtifact(gh, { repo: target.repo, head: target.head, workflow: WORKFLOW, pixelTolerance: PIXEL_TOLERANCE }, DEFAULT_LIMITS);
  if (typeof zip === "string") return nothing(zip);
  const evidence = measureArchive(zip, PIXEL_TOLERANCE);
  if (!evidence.measured) return nothing(evidence.reason);
  const manifest = manifestOf(zip);
  if (typeof manifest === "string") return nothing(manifest);
  const reason = incomplete(manifest, target);
  if (reason !== undefined) return nothing(reason);
  const changed = evidence.shots.map(isChanged);
  return { line: lineOf(evidence), variantKeys: await writePairs(zip, manifest, changed, folder) };
}

/** The PR's pr-visual pairs written into `folder` itself, or a stated reason none are shown; never an after-only set, never a throw. */
export async function writePrVisuals(target: Target, folder: string, gh: PrVisualGh = execPrVisualGh()): Promise<PrVisuals> {
  try {
    return await prVisualsOf(gh, target, folder);
  } catch (error) {
    return { ...nothing(`the read failed: ${errorClass(error)}`), failed: true };
  }
}

/** The PR's pr-visual pairs written under `<roundDir>/pr-<n>/`, or a stated reason none are shown. */
export async function writeRoundVisuals(target: Target, roundDir: string, gh?: PrVisualGh): Promise<RoundVisuals> {
  const { line, variantKeys } = await writePrVisuals(target, join(roundDir, `pr-${target.pr}`), gh);
  return { line, variantKeys };
}
