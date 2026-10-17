import { createHash } from "node:crypto";
import { z } from "zod";

/** More images than this is no set an owner reviewed one by one, so it is refused rather than carried. */
export const MAX_SET_FILES = 256;

const hex = (length: number) => z.string().regex(new RegExp(`^[0-9a-f]{${length}}$`));
const SetFile = z.strictObject({ path: z.string(), key: z.string(), sha256: hex(64), blob: hex(40) });

/** The regenerated baselines the owner accepted at a red head: a later head must commit exactly these blobs and nothing else. */
const ApprovedSetSchema = z.strictObject({
  packetSha: hex(64),
  packetId: z.string(),
  ciRunId: z.string(),
  fromHead: hex(40),
  files: z.array(SetFile).max(MAX_SET_FILES),
  removed: z.array(z.string()),
  sidePaths: z.array(z.string()).max(0),
});
export type ApprovedSet = z.infer<typeof ApprovedSetSchema>;

/** Only the fields the set is built from; the key rule is td's, so a key can never name a path outside `after/`. */
const SetImage = z.looseObject({
  key: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
  layer: z.string(),
  path: z.string(),
  change: z.enum(["changed", "new", "removed"]),
  after: z.looseObject({ sha256: hex(64) }).optional(),
});
const SetPacket = z.looseObject({ packetId: z.string(), headSha: hex(40), ci: z.looseObject({ runId: z.string() }), images: z.array(SetImage) });
type SetPacket = z.infer<typeof SetPacket>;

/** What the caller read of one `after/<key>.png`: digests only, so no image bytes are held past the read. */
export type AfterDigest = { sha256: string; blob: string };

type SetRefusal = { reason: "packet" | "set-too-large"; detail: string };
/** `layers` only names what the fixer commits in the note; the set itself carries no layer. */
type BuiltSet = { set: ApprovedSet; layers: string[] };

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** The id git gives `bytes` as a blob, as td's `gitBlobId`: sha1 of `blob <length>\0` and the bytes. */
export function gitBlobId(bytes: Uint8Array): string {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

export const afterDigest = (bytes: Uint8Array): AfterDigest => ({ sha256: sha256(bytes), blob: gitBlobId(bytes) });

/** The factory's own packet.json, read loosely; undefined when it is no packet a set can be built from. */
export function setPacketOf(bytes: Uint8Array): SetPacket | undefined {
  try {
    return SetPacket.safeParse(JSON.parse(Buffer.from(bytes).toString("utf8"))).data;
  } catch {
    return undefined;
  }
}

/** The images whose after bytes the set carries, which are the only `after/<key>.png` files the caller reads. */
export const keptImages = (packet: Pick<SetPacket, "images">) => packet.images.filter((image) => image.change !== "removed");

/** `packet` is packet.json's bytes from the factory's own packet dir, never the console's copy. */
type SetInputs = { packet: Uint8Array; packetSha: string; fromHead: string; after: ReadonlyMap<string, AfterDigest> };

/**
 * The set the owner accepted, built from the factory's lint-passed packet for the gate's head: each changed or new image's
 * after bytes must hash to the packet's `after.sha256`, so the blob id is of the bytes the owner was shown. Sorted by path,
 * so a replay builds the same payload.
 */
export function approvedSetOf({ packet: bytes, packetSha, fromHead, after }: SetInputs): BuiltSet | SetRefusal {
  if (sha256(bytes) !== packetSha) return { reason: "packet", detail: "the factory's packet.json does not hash to the request's packetSha" };
  const packet = setPacketOf(bytes);
  if (!packet || packet.headSha !== fromHead) return { reason: "packet", detail: `the factory has no packet for head ${fromHead}` };
  const kept = keptImages(packet);
  if (kept.length > MAX_SET_FILES) return { reason: "set-too-large", detail: `${kept.length} images, over ${MAX_SET_FILES}` };
  const files: ApprovedSet["files"] = [];
  for (const image of kept) {
    const read = after.get(image.key);
    if (!image.after || read?.sha256 !== image.after.sha256) return { reason: "packet", detail: `after/${image.key}.png does not hash to the packet's after.sha256` };
    files.push({ path: image.path, key: image.key, sha256: read.sha256, blob: read.blob });
  }
  const removed = packet.images.filter((image) => image.change === "removed").map((image) => image.path);
  files.sort((a, b) => byPath(a.path, b.path));
  const set = ApprovedSetSchema.parse({ packetSha, packetId: packet.packetId, ciRunId: packet.ci.runId, fromHead, files, removed: removed.sort(byPath), sidePaths: [] });
  return { set, layers: [...new Set(packet.images.map((image) => image.layer))].sort() };
}

const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The fixer's instruction, fixed so the owner's words can add to it but never change which files are committed. */
export function acceptSetNote({ set, layers }: BuiltSet, runId: string): string {
  const head = `Shepherd run ${runId}: commit exactly the ${layers.join(" and ") || "visual"} baselines CI run ${set.ciRunId} regenerated at ${set.fromHead}, byte for byte from its artifact, and change nothing else.`;
  return [head, ...set.files.map((file) => `- write ${file.path} (blob ${file.blob})`), ...set.removed.map((path) => `- delete ${path}`)].join("\n");
}
