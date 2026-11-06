import { encodePng } from "@titan-design/png-delta";
import { ghPrVisualEvidence, type PrVisualEvidence, type PrVisualGh } from "./pr-visual-evidence.js";

export const HEAD = "a".repeat(40);
export const BASE = "b".repeat(40);
export const OTHER = "c".repeat(40);
const WORKFLOW = ".github/workflows/pr-visual.yml";

/** A synthetic 2x2 image: grey, with one pixel's red channel nudged by `nudge`. */
export function png(nudge = 0): Buffer {
  const rgba = new Uint8Array(16).fill(128);
  for (let alpha = 3; alpha < 16; alpha += 4) rgba[alpha] = 255;
  rgba[0] = 128 + nudge;
  return encodePng({ width: 2, height: 2, rgba });
}

/** A little-endian record of `size` bytes, with each `[offset, value, width]` written in. */
function record(size: number, fields: readonly (readonly [number, number, 2 | 4])[]): Buffer {
  const out = Buffer.alloc(size);
  for (const [at, value, width] of fields) out.writeUIntLE(value, at, width);
  return out;
}

/** A stored zip of `files`; `zip64` marks the first entry's size as a zip64 placeholder. */
function zipOf(files: Record<string, Buffer>, zip64 = false): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const size = zip64 && centrals.length === 0 ? 0xffffffff : data.length;
    locals.push(record(30, [[0, 0x04034b50, 4], [18, data.length, 4], [22, data.length, 4], [26, name.length, 2]]), Buffer.from(name), data);
    centrals.push(record(46, [[0, 0x02014b50, 4], [20, data.length, 4], [24, size, 4], [28, name.length, 2], [42, offset, 4]]), Buffer.from(name));
    offset += 30 + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const count = centrals.length / 2;
  return Buffer.concat([...locals, directory, record(22, [[0, 0x06054b50, 4], [8, count, 2], [10, count, 2], [12, directory.length, 4], [16, offset, 4]])]);
}

export const shotOf = (story: string, width: string) => ({ story, width, before: `before/${story}@${width}.png`, after: `after/${story}@${width}.png` });

interface Artifact {
  /** One `[before, after]` pair per shot, story `button--s<index>` at width 1280, in manifest order. */
  pairs: [Buffer, Buffer][];
  manifest?: Record<string, unknown>;
  runHead?: string;
  zip64?: boolean;
}

function artifactZip({ pairs, manifest, zip64 }: Artifact): Buffer {
  const shots = pairs.map((_, index) => shotOf(`button--s${index}`, "1280"));
  const files: Record<string, Buffer> = {};
  pairs.forEach(([before, after], index) => Object.assign(files, { [shots[index]!.before]: before, [shots[index]!.after]: after }));
  const body = { v: 1, repo: "octo/design", pr: 7, baseSha: BASE, headSha: HEAD, rendered: true, shots, ...manifest };
  return zipOf({ "manifest.json": Buffer.from(JSON.stringify(body)), ...files }, zip64);
}

export function fakeGh(artifact: Artifact): PrVisualGh {
  const zip = artifactZip(artifact);
  const listed = { id: 41, expired: false, size_in_bytes: zip.length, workflow_run: { id: 9, head_sha: artifact.runHead ?? HEAD } };
  return {
    text: async (args) => (args.includes("--paginate") ? `${JSON.stringify(listed)}\n` : `${WORKFLOW}\n`),
    bytes: async () => zip,
  };
}

export function evidenceOf(artifact: Artifact, limits: { zipBytes?: number } = {}): Promise<PrVisualEvidence> {
  return ghPrVisualEvidence(fakeGh(artifact), limits)({ repo: "octo/design", head: HEAD, workflow: WORKFLOW, pixelTolerance: 0.1 });
}
