/**
 * The before and after pairs a CI `pr-visual` job leaves for a UI PR. `pairVisuals` reads a manifest already on disk; it
 * never fetches one, and it never offers an after-only set: a change shown without its before cannot be judged.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const Shot = z.object({ story: z.string().min(1), width: z.string().min(1), before: z.string().min(1).optional(), after: z.string().min(1).optional() });

const PrVisualManifestSchema = z.object({
  v: z.literal(1),
  repo: z.string(),
  pr: z.number().int(),
  baseSha: z.string().min(1),
  headSha: z.string().min(1),
  rendered: z.boolean(),
  reason: z.string().optional(),
  /** `before` and `after` are paths relative to the manifest's own directory. */
  shots: z.array(Shot),
});

type PrVisualManifest = z.infer<typeof PrVisualManifestSchema>;

interface VisualPair {
  story: string;
  width: string;
  before: string;
  after: string;
}

type PairedVisuals = { pairs: VisualPair[]; base: string } | { none: string };

function paired(manifest: PrVisualManifest, dir: string): PairedVisuals {
  const pairs = manifest.shots.flatMap(({ story, width, before, after }) => (before && after ? [{ story, width, before: join(dir, before), after: join(dir, after) }] : []));
  if (pairs.length < manifest.shots.length) return { none: `The visuals manifest has ${manifest.shots.length - pairs.length} shot(s) missing a before or an after, so none are shown.` };
  if (pairs.length === 0) return { none: "The visuals manifest lists no shots." };
  return { pairs, base: manifest.baseSha };
}

/** Reads `<dir>/pr-<n>/manifest.json`; anything but a complete set rendered at `headSha` is a stated reason, never a partial set. */
export async function pairVisuals(dir: string, prNumber: number, headSha: string): Promise<PairedVisuals> {
  const folder = join(dir, `pr-${prNumber}`);
  let raw: string;
  try {
    raw = await readFile(join(folder, "manifest.json"), "utf8");
  } catch {
    return { none: `No visuals manifest at ${join(folder, "manifest.json")}.` };
  }
  let parsed: ReturnType<typeof PrVisualManifestSchema.safeParse>;
  try {
    parsed = PrVisualManifestSchema.safeParse(JSON.parse(raw));
  } catch {
    return { none: "The visuals manifest is not valid JSON." };
  }
  if (!parsed.success) return { none: `The visuals manifest does not match its schema: ${parsed.error.issues[0]?.message ?? "invalid"}.` };
  const manifest = parsed.data;
  if (manifest.pr !== prNumber) return { none: `The visuals manifest is for PR ${manifest.pr}, not ${prNumber}.` };
  if (manifest.headSha !== headSha) return { none: `The visuals were captured at ${manifest.headSha.slice(0, 7)}, not the PR head ${headSha.slice(0, 7)}.` };
  if (!manifest.rendered) return { none: `Nothing was rendered${manifest.reason ? `: ${manifest.reason}` : "."}` };
  return paired(manifest, folder);
}
