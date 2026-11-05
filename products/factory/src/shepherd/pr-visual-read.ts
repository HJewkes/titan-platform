// TP-4761 S4: the pixel proof for the visual tier, measured by Shepherd from the `pr-visual-<head>` artifact a titan-design
// PR's own workflow uploads (TP-1697). The PR's code wrote those bytes, so every count here is Shepherd's own: the
// artifact supplies only images, each read under byte, entry, shot and pixel caps, and anything it cannot read reads as
// unmeasured, which visual-tier.ts turns into tier 2. Reasons never echo a name or a string from the artifact.
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
  /** The pull request the proof is for, and the base it targets: a run for any other pull request or base is refused. */
  pr: number;
  baseRef: string;
  head: string;
  /** The workflow file the artifact's run must come from, e.g. `.github/workflows/pr-visual.yml`. */
  workflow: string;
  pixelTolerance: number;
}

/** A raw pixel proof for `visualTier` to parse, or why there is none. */
type PixelRead = { unmeasured: string } | { head: string; baseSha: string; rendered: boolean; shots: unknown[] };

export type ReadPrVisual = (target: PrVisualTarget) => Promise<PixelRead>;

const MI = 1024 * 1024;
const PR_VISUAL_CAPS = { inflatedBytes: 128 * MI, entries: 256, shots: 100, imagePixels: 16 * MI, totalPixels: 256 * MI, candidates: 5 };

/** How long each `gh` call may take, and the most artifact bytes downloaded at all. */
interface ReadLimits {
  timeoutMs: number;
  zipBytes: number;
}

const DEFAULT_LIMITS: ReadLimits = { timeoutMs: 60_000, zipBytes: 64 * MI };
const run = promisify(execFile);

const ArtifactSchema = z.object({ id: z.number().int(), expired: z.boolean(), size_in_bytes: z.number(), workflow_run: z.object({ id: z.number().int(), head_sha: z.string() }).nullable() });
const RunSchema = z.object({
  path: z.string(),
  event: z.string(),
  pull_requests: z.array(z.object({ number: z.number().int(), base: z.object({ ref: z.string() }) })),
});
const RUN_FIELDS = "{path: .path, event: .event, pull_requests: [.pull_requests[] | {number: .number, base: {ref: .base.ref}}]}";

type Run = z.infer<typeof RunSchema>;

/**
 * The one test a run must pass before its artifact is read. A `pull_request` run takes its workflow from the merge
 * with its own pull request's base, so a run of the configured path for another pull request, or one listing more than
 * this pull request, may have run a workflow someone else wrote; only this pull request's own run at its base counts.
 */
function artifactProvenance(run: Run, target: PrVisualTarget): boolean {
  const [only, ...others] = run.pull_requests;
  const ownPr = only !== undefined && others.length === 0 && only.number === target.pr && only.base.ref === target.baseRef;
  return run.event === "pull_request" && run.path === target.workflow && ownPr;
}

type Artifact = z.infer<typeof ArtifactSchema>;

const unmeasured = (why: string): PixelRead => ({ unmeasured: why });

function execPrVisualGh(gh = "gh"): PrVisualGh {
  return {
    text: async (args, timeoutMs) => (await run(gh, [...args], { encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * MI })).stdout,
    bytes: async (args, timeoutMs, maxBytes) => (await run(gh, [...args], { encoding: "buffer", timeout: timeoutMs, maxBuffer: maxBytes })).stdout,
  };
}

/** Unexpired artifacts at the head only; the name filter alone is no head check, since any run can pick a name. */
async function headArtifacts(gh: PrVisualGh, { repo, head }: PrVisualTarget, ms: number): Promise<Artifact[]> {
  const lines = await bounded(gh.text(["api", "--paginate", "--jq", ".artifacts[]", `repos/${repo}/actions/artifacts?name=pr-visual-${head}&per_page=100`], ms), ms);
  const artifacts = lines.split("\n").filter((line) => line.trim() !== "").map((line) => ArtifactSchema.parse(JSON.parse(line)));
  return artifacts.filter((a) => !a.expired && a.workflow_run?.head_sha === head).slice(0, PR_VISUAL_CAPS.candidates);
}

/** The newest head artifact whose run passes `artifactProvenance`, so no other workflow or pull request can supply it. */
async function configuredArtifact(gh: PrVisualGh, target: PrVisualTarget, ms: number): Promise<Artifact | undefined> {
  for (const artifact of await headArtifacts(gh, target, ms)) {
    const runId = artifact.workflow_run?.id;
    const run = RunSchema.parse(JSON.parse(await bounded(gh.text(["api", "--jq", RUN_FIELDS, `repos/${target.repo}/actions/runs/${runId}`], ms), ms)));
    if (artifactProvenance(run, target)) return artifact;
  }
  return undefined;
}

function decodeShot(zip: ZipReader, file: string, budget: { pixels: number }): Decoded | string {
  const bytes = zip.read(file);
  if ("refused" in bytes) return bytes.refused;
  const limit = Math.min(PR_VISUAL_CAPS.imagePixels, budget.pixels);
  const decoded = decodePngBounded(bytes, { maxPixels: limit });
  if ("refused" in decoded) return decoded.refused === overPixels(limit) ? "over the pixel cap" : decoded.refused;
  budget.pixels -= decoded.width * decoded.height;
  return decoded;
}

type Shot = { story: string; width: string; before?: string | undefined; after?: string | undefined };

/** One shot's proof entry: changed pixels counted here, or png-delta's `sizesDiffer`, which the proof schema refuses. */
function measureShot(zip: ZipReader, shot: Shot, index: number, ctx: { budget: { pixels: number }; pixelTolerance: number }): unknown {
  if (shot.before === undefined || shot.after === undefined) return `shot ${index} is not paired`;
  if (shot.before === shot.after) return `shot ${index} names one file for before and after`;
  const before = decodeShot(zip, shot.before, ctx.budget);
  if (typeof before === "string") return `shot ${index} before: ${before}`;
  const after = decodeShot(zip, shot.after, ctx.budget);
  if (typeof after === "string") return `shot ${index} after: ${after}`;
  const delta = pixelDelta(before, after, { pixelTolerance: ctx.pixelTolerance });
  const id = `${shot.story}@${shot.width}`;
  return delta.sizesDiffer ? { id, paired: true, sizesDiffer: true } : { id, paired: true, changedPixels: delta.changedPixels };
}

/** `rendered: false`, or a dropped one-sided shot, means some story went unmeasured, so neither is ever a proof. */
function measureArchive(zip: ZipReader, pixelTolerance: number): PixelRead {
  const manifestBytes = zip.read("manifest.json");
  if ("refused" in manifestBytes) return unmeasured(`manifest: ${manifestBytes.refused}`);
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(manifestBytes).toString("utf8"));
  } catch {
    return unmeasured("manifest is not JSON");
  }
  const parsed = PrVisualManifestSchema.safeParse(json);
  if (!parsed.success) return unmeasured("manifest does not match its schema");
  const manifest = parsed.data;
  if (!manifest.rendered) return unmeasured("the pr-visual run rendered nothing, but the head changes a rendered path");
  if (manifest.reason !== undefined) return unmeasured("the pr-visual run dropped a one-sided shot");
  if (manifest.shots.length > PR_VISUAL_CAPS.shots) return unmeasured(`over ${PR_VISUAL_CAPS.shots} shots`);
  const ctx = { budget: { pixels: PR_VISUAL_CAPS.totalPixels }, pixelTolerance };
  const shots: unknown[] = [];
  for (const [index, shot] of manifest.shots.entries()) {
    const measured = measureShot(zip, shot, index, ctx);
    if (typeof measured === "string") return unmeasured(measured);
    shots.push(measured);
  }
  return { head: manifest.headSha, baseSha: manifest.baseSha, rendered: true, shots };
}

async function readOnce(gh: PrVisualGh, target: PrVisualTarget, { timeoutMs: ms, zipBytes }: ReadLimits): Promise<PixelRead> {
  const overCap = (size: number) => size > zipBytes;
  const capped = unmeasured(`artifact over the ${zipBytes}-byte cap`);
  const artifact = await configuredArtifact(gh, target, ms);
  if (artifact === undefined) return unmeasured("no pr-visual artifact from this pull request's own run of the configured workflow at the head");
  if (overCap(artifact.size_in_bytes)) return capped;
  const bytes = await bounded(gh.bytes(["api", `repos/${target.repo}/actions/artifacts/${artifact.id}/zip`], ms, zipBytes), ms);
  if (overCap(bytes.length)) return capped;
  const zip = openZip(bytes, { maxEntries: PR_VISUAL_CAPS.entries, maxInflatedBytes: PR_VISUAL_CAPS.inflatedBytes });
  return "refused" in zip ? unmeasured(`artifact zip: ${zip.refused}`) : measureArchive(zip, target.pixelTolerance);
}

/** Reads and measures the head's pr-visual artifact; a failed read is unmeasured, never a throw. */
export function ghPrVisual(gh: PrVisualGh = execPrVisualGh(), limits: Partial<ReadLimits> = {}): ReadPrVisual {
  return async (target) => {
    try {
      return await readOnce(gh, target, { ...DEFAULT_LIMITS, ...limits });
    } catch (error) {
      return unmeasured(`pr-visual read failed: ${errorClass(error)}`);
    }
  };
}
