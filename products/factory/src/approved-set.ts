import { createHash } from "node:crypto";
import { isCarryFencedPath } from "@titan-design/authority";
import { z } from "zod";
import { isSkillPath } from "./shepherd/skill-paths.js";

/** More images than this is no set an owner reviewed one by one, so it is refused rather than carried. */
export const MAX_SET_FILES = 256;

const hex = (length: number) => z.string().regex(new RegExp(`^[0-9a-f]{${length}}$`));
const SetFile = z.strictObject({ path: z.string(), key: z.string(), sha256: hex(64), blob: hex(40) });

/** The regenerated baselines the owner accepted at a red head: a later head must commit exactly these blobs and nothing else. */
export const ApprovedSetSchema = z.strictObject({
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

/** td's `CI_SOURCES` prefixes, mirrored: a set path outside its layer's baselines is never one CI regenerated. */
const LAYER_PREFIX = new Map([
  ["component", "packages/ui/specimen/baseline/"],
  ["story", "packages/ui/tests/visual/reference/stories.spec.ts-snapshots/"],
]);
/** No space, newline or control character, so a path cannot add a line to the fixer's note. */
const SAFE_PATH = /^[A-Za-z0-9._/-]+\.png$/;

/** Each path is a plain relative PNG under its layer's baselines, and no path or key repeats, so the set names only baselines. */
function pathProblem(images: SetPacket["images"]): string | undefined {
  const paths = new Set<string>();
  const keys = new Set<string>();
  for (const { key, layer, path } of images) {
    if (!SAFE_PATH.test(path) || path.split("/").some((part) => part === "" || part === "." || part === "..")) return `image ${key} has an unsafe path`;
    if (!path.startsWith(LAYER_PREFIX.get(layer) ?? "\0")) return `image ${key}'s path is not under the ${layer} baselines`;
    if (paths.has(path) || keys.has(key)) return `image ${key} repeats a path or key`;
    paths.add(path);
    keys.add(key);
  }
  return undefined;
}

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
  const problem = pathProblem(packet.images);
  if (problem) return { reason: "packet", detail: problem };
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

type SetMatchRefusal = "extra-path" | "unchanged" | "missing" | "blob-mismatch" | "removed-present" | "skill-or-fenced";
type SetMatch = { carries: true } | { carries: false; reason: SetMatchRefusal; paths: string[] };

/** `changed` is every path of `diff H1..H2`; `atHead` maps each set path present at H2 to its blob there. */
type SetHead = { changed: readonly string[]; atHead: ReadonlyMap<string, string> };

/**
 * Does a later head commit exactly the accepted set: every changed path in it, every file changed and at its accepted blob,
 * every removed path gone (a removed name that is a directory of a set file counts as present, since ls-tree lists inside it), and no changed path a skill or carry-fenced? A path match alone is not enough, since the blob is what the owner saw.
 */
export function setMatch(set: ApprovedSet, { changed, atHead }: SetHead): SetMatch {
  const named = new Set([...set.files.map((file) => file.path), ...set.removed]);
  const diff = new Set(changed);
  const checks: [SetMatchRefusal, string[]][] = [
    ["skill-or-fenced", changed.filter((path) => isSkillPath(path) || isCarryFencedPath(path))],
    ["extra-path", changed.filter((path) => !named.has(path))],
    ["unchanged", set.files.filter((file) => !diff.has(file.path)).map((file) => file.path)],
    ["missing", set.files.filter((file) => !atHead.has(file.path)).map((file) => file.path)],
    ["blob-mismatch", set.files.filter((file) => atHead.has(file.path) && atHead.get(file.path) !== file.blob).map((file) => file.path)],
    ["removed-present", set.removed.filter((path) => atHead.has(path) || [...named].some((other) => other.startsWith(`${path}/`)))],
  ];
  const failed = checks.find(([, paths]) => paths.length > 0);
  return failed ? { carries: false, reason: failed[0], paths: failed[1] } : { carries: true };
}

/**
 * The fixer's instruction, fixed so the owner's words can add to it but never change which files are committed. A set whose
 * instruction does not fit in `maxChars` is refused, since a cut note would silently drop files from the list.
 */
export function acceptSetNote({ set, layers }: BuiltSet, runId: string, maxChars: number): string | SetRefusal {
  const head = `Shepherd run ${runId}: commit exactly the ${layers.join(" and ") || "visual"} baselines CI run ${set.ciRunId} regenerated at ${set.fromHead}, byte for byte from its artifact, and change nothing else.`;
  const note = [head, ...set.files.map((file) => `- write ${file.path} (blob ${file.blob})`), ...set.removed.map((path) => `- delete ${path}`)].join("\n");
  const length = [...note].length;
  return length <= maxChars ? note : { reason: "set-too-large", detail: `the fixer's note for this set is ${length} characters, over ${maxChars}` };
}
