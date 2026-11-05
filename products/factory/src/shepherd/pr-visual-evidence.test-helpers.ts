import zlib from "node:zlib";
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

function headers(name: string, data: Buffer, packed: Buffer, offset: number): [Buffer, Buffer] {
  const fields = Buffer.alloc(12);
  fields.writeUInt32LE(zlib.crc32(data), 0);
  fields.writeUInt32LE(packed.length, 4);
  fields.writeUInt32LE(data.length, 8);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  fields.copy(local, 14);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  fields.copy(central, 16);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(offset, 42);
  return [local, central];
}

/** A deflate zip of `files`; `zip64` marks the first entry's size as a zip64 placeholder. */
function zipOf(files: Record<string, Buffer>, zip64 = false): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const packed = zlib.deflateRawSync(data);
    const [local, central] = headers(name, data, packed, offset);
    if (zip64 && centrals.length === 0) central.writeUInt32LE(0xffffffff, 24);
    locals.push(local, Buffer.from(name), packed);
    centrals.push(central, Buffer.from(name));
    offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(centrals.length / 2, 8);
  eocd.writeUInt16LE(centrals.length / 2, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
}

export const shotOf = (story: string, width: string) => ({ story, width, before: `before/${story}@${width}.png`, after: `after/${story}@${width}.png` });

export interface Artifact {
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

function fakeGh(artifact: Artifact): PrVisualGh {
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
