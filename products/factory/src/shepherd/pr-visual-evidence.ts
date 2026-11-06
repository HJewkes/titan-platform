// TP-4761 C1: what the `pr-visual-<head>` artifact a titan-design PR uploads says, read as evidence for the owner only.
// The PR's own code wrote those bytes, so nothing here may lower the visual tier: no merge guard, tier or policy module
// imports this file (pr-visual-evidence-isolation.test.ts pins it). Every count is Shepherd's own, each image is read
// under byte, entry, shot and pixel caps, and a reason never echoes a name or a string from the artifact.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { decodePngBounded, overPixels, pixelDelta, type Decoded } from "@titan-design/png-delta";
import { z } from "zod";
import { bounded } from "./codewatch-questions.js";
import { errorClass } from "./error-class.js";
import { openZip, type ZipReader } from "./pr-visual-zip.js";
import { PrVisualManifestSchema } from "./visuals-manifest.js";

/** The `gh` calls the read makes: JSON text for listings, and the artifact zip as bytes under `maxBytes`. */
export interface PrVisualGh {
  text(args: readonly string[], timeoutMs: number): Promise<string>;
  bytes(args: readonly string[], timeoutMs: number, maxBytes: number): Promise<Uint8Array>;
}

interface PrVisualTarget {
  repo: string;
  head: string;
  /** The workflow file the artifact's run must come from, e.g. `.github/workflows/pr-visual.yml`. */
  workflow: string;
  pixelTolerance: number;
}

type ShotEvidence = { story: string; width: string } & ({ changedPixels: number } | { sizesDiffer: true });

/** `missing`: selected stories with no before and after pair at some width the artifact shot (TP-4774 b). */
export type PrVisualEvidence = { measured: true; shots: ShotEvidence[]; missing: string[] } | { measured: false; reason: string };

type ReadPrVisualEvidence = (target: PrVisualTarget) => Promise<PrVisualEvidence>;

const MI = 1024 * 1024;
const CAPS = { inflatedBytes: 128 * MI, entries: 256, shots: 100, selected: 500, imagePixels: 16 * MI, totalPixels: 256 * MI, candidates: 5 };
const STORY_ID = /^[a-z0-9][a-z0-9-]{0,199}$/;
const WIDTH = /^[0-9]{1,5}$/;

type ReadLimits = { timeoutMs: number; zipBytes: number };

export const DEFAULT_LIMITS: ReadLimits = { timeoutMs: 60_000, zipBytes: 64 * MI };
const run = promisify(execFile);

const ArtifactSchema = z.object({ id: z.number().int(), expired: z.boolean(), size_in_bytes: z.number(), workflow_run: z.object({ id: z.number().int(), head_sha: z.string() }).nullable() });
type Artifact = z.infer<typeof ArtifactSchema>;

const unmeasured = (reason: string): PrVisualEvidence => ({ measured: false, reason });

export function execPrVisualGh(gh = "gh"): PrVisualGh {
  return {
    text: async (args, timeoutMs) => (await run(gh, [...args], { encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * MI })).stdout,
    bytes: async (args, timeoutMs, maxBytes) => (await run(gh, [...args], { encoding: "buffer", timeout: timeoutMs, maxBuffer: maxBytes })).stdout,
  };
}

/** The newest unexpired head artifact from the configured workflow; the name filter alone is no head check. */
async function headArtifact(gh: PrVisualGh, { repo, head, workflow }: PrVisualTarget, ms: number): Promise<Artifact | undefined> {
  const lines = await bounded(gh.text(["api", "--paginate", "--jq", ".artifacts[]", `repos/${repo}/actions/artifacts?name=pr-visual-${head}&per_page=100`], ms), ms);
  const listed = lines.split("\n").filter((line) => line.trim() !== "").map((line) => ArtifactSchema.parse(JSON.parse(line)));
  for (const artifact of listed.filter((a) => !a.expired && a.workflow_run?.head_sha === head).slice(0, CAPS.candidates)) {
    const path = await bounded(gh.text(["api", "--jq", ".path", `repos/${repo}/actions/runs/${artifact.workflow_run?.id}`], ms), ms);
    if (path.trim() === workflow) return artifact;
  }
  return undefined;
}

function decodeShot(zip: ZipReader, file: string, budget: { pixels: number }): Decoded | string {
  const bytes = zip.read(file);
  if ("refused" in bytes) return bytes.refused;
  const limit = Math.min(CAPS.imagePixels, budget.pixels);
  const decoded = decodePngBounded(bytes, { maxPixels: limit });
  if ("refused" in decoded) return decoded.refused === overPixels(limit) ? "over the pixel cap" : decoded.refused;
  budget.pixels -= decoded.width * decoded.height;
  return decoded;
}

type Pair = { story: string; width: string; before: string; after: string };

function measurePair(zip: ZipReader, pair: Pair, index: number, ctx: { budget: { pixels: number }; pixelTolerance: number }): ShotEvidence | string {
  if (pair.before === pair.after) return `shot ${index} names one file for before and after`;
  const before = decodeShot(zip, pair.before, ctx.budget);
  if (typeof before === "string") return `shot ${index} before: ${before}`;
  const after = decodeShot(zip, pair.after, ctx.budget);
  if (typeof after === "string") return `shot ${index} after: ${after}`;
  const delta = pixelDelta(before, after, { pixelTolerance: ctx.pixelTolerance });
  const id = { story: pair.story, width: pair.width };
  return delta.sizesDiffer ? { ...id, sizesDiffer: true } : { ...id, changedPixels: delta.changedPixels };
}

export type Manifest = z.infer<typeof PrVisualManifestSchema>;

/** A selected story is missing unless it has a pair at every width the artifact shot any story at. */
function missingStories(manifest: Manifest, shots: readonly ShotEvidence[]): string[] {
  const widths = new Set(manifest.shots.map((shot) => shot.width));
  const paired = new Set(shots.map((shot) => `${shot.story}@${shot.width}`));
  const stories = new Set((manifest.selected ?? []).map((item) => item.story));
  return [...stories].filter((story) => widths.size === 0 || [...widths].some((width) => !paired.has(`${story}@${width}`)));
}

export function manifestOf(zip: ZipReader): Manifest | string {
  const bytes = zip.read("manifest.json");
  if ("refused" in bytes) return `manifest: ${bytes.refused}`;
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    return "manifest is not JSON";
  }
  const parsed = PrVisualManifestSchema.safeParse(json);
  if (!parsed.success) return "manifest does not match its schema";
  const { shots, selected = [] } = parsed.data;
  if (shots.length > CAPS.shots || selected.length > CAPS.selected) return "over the shot or selected-story cap";
  const ids = [...shots.map((shot) => shot.story), ...selected.map((item) => item.story)];
  if (!ids.every((id) => STORY_ID.test(id)) || !shots.every((shot) => WIDTH.test(shot.width))) return "a story id or width is not well formed";
  return parsed.data;
}

export function measureArchive(zip: ZipReader, pixelTolerance: number): PrVisualEvidence {
  const manifest = manifestOf(zip);
  if (typeof manifest === "string") return unmeasured(manifest);
  if (!manifest.rendered) return unmeasured("the pr-visual run rendered nothing");
  const ctx = { budget: { pixels: CAPS.totalPixels }, pixelTolerance };
  const shots: ShotEvidence[] = [];
  for (const [index, { story, width, before, after }] of manifest.shots.entries()) {
    if (before === undefined || after === undefined) continue;
    const measured = measurePair(zip, { story, width, before, after }, index, ctx);
    if (typeof measured === "string") return unmeasured(measured);
    shots.push(measured);
  }
  return { measured: true, shots, missing: missingStories(manifest, shots) };
}

/** The head's artifact opened as a zip, or the reason it could not be: no artifact, over a cap, or an unreadable zip. */
export async function openHeadArtifact(gh: PrVisualGh, target: PrVisualTarget, { timeoutMs: ms, zipBytes }: ReadLimits): Promise<ZipReader | string> {
  const overCap = (size: number) => size > zipBytes;
  const capped = `artifact over the ${zipBytes}-byte cap`;
  const artifact = await headArtifact(gh, target, ms);
  if (artifact === undefined) return "no pr-visual artifact from the configured workflow at the head";
  if (overCap(artifact.size_in_bytes)) return capped;
  const bytes = await bounded(gh.bytes(["api", `repos/${target.repo}/actions/artifacts/${artifact.id}/zip`], ms, zipBytes), ms);
  if (overCap(bytes.length)) return capped;
  const zip = openZip(bytes, { maxEntries: CAPS.entries, maxInflatedBytes: CAPS.inflatedBytes });
  return "refused" in zip ? `artifact zip: ${zip.refused}` : zip;
}

async function readOnce(gh: PrVisualGh, target: PrVisualTarget, limits: ReadLimits): Promise<PrVisualEvidence> {
  const zip = await openHeadArtifact(gh, target, limits);
  return typeof zip === "string" ? unmeasured(zip) : measureArchive(zip, target.pixelTolerance);
}

/** Reads the head's pr-visual artifact as evidence; a failed read is unmeasured, never a throw. */
export function ghPrVisualEvidence(gh: PrVisualGh = execPrVisualGh(), limits: Partial<ReadLimits> = {}): ReadPrVisualEvidence {
  return async (target) => {
    try {
      return await readOnce(gh, target, { ...DEFAULT_LIMITS, ...limits });
    } catch (error) {
      return unmeasured(`pr-visual read failed: ${errorClass(error)}`);
    }
  };
}
