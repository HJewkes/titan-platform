import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, rename as renameFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { checkEditableValue } from "@titan-design/coordinator";
import type { OwnerOp } from "@titan-design/owner-queue";
import { parseConfig } from "../config.js";
import { LIVE_FIELDS, type ConfigRef } from "../config-ref.js";
import { refused, type Outcome } from "../console-action/outcome.js";
import type { OpRead } from "../console-action/record.js";
import type { LedgerLine, OwnerOpsLedger } from "./ledger.js";

type ConfigSet = Extract<OwnerOp, { kind: "factory-config-set" }>;
type LivePath = keyof typeof LIVE_FIELDS;

const CONFIG_REVISIONS ="config.revisions.jsonl";
const WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
const APPEND_FLAGS = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW;

/** The config file serve loaded, the ref that holds it, and serve's state dir, where the revision log lives. */
export interface FactoryConfigFile {
  ref: ConfigRef;
  path: string;
  stateDir: string;
  /** The step that publishes the new bytes; tests inject a throw to prove a failed write leaves the old file whole. */
  rename?: (from: string, to: string) => Promise<void>;
}

export interface ConfigSetDeps {
  /** Absent when serve was started without its config file wired; the op is then refused, never applied blind. */
  factoryConfig: FactoryConfigFile | undefined;
  ledger: OwnerOpsLedger;
}

/** The file as it is on disk now: its bytes (null when there is no file) and their JSON. */
interface OnDisk {
  bytes: Buffer | null;
  json: unknown;
}

/**
 * Applies one owner-approved edit to a live factory config row, and only while the file still holds the value the owner
 * saw (`expectFrom`), so a hand edit made after the console prepared the op is never overwritten. The whole result must
 * load before anything is written; the old bytes are kept beside the file, and each change is logged with both shas.
 */
export async function setFactoryConfig(actionId: string, { op, confirmEvent }: OpRead, deps: ConfigSetDeps): Promise<Outcome> {
  if (op.kind !== "factory-config-set") return refused("record", `factory-config-set cannot run a ${op.kind} op`);
  const file = deps.factoryConfig;
  if (file === undefined) return refused("config-unavailable", "serve has no factory config file wired");
  const editable = checkEditableValue("factory", op.path, op.value);
  if (!editable.ok) return refused(editable.reason === "not-editable" ? "class" : "payload", editable.message);
  if (editable.field.reload !== "live" || !isLivePath(op.path)) return refused("class", `factory:${op.path} does not reload live, so serve would not see the edit`);
  const path = op.path;
  if ((await deps.ledger.read(actionId)).some(setByThis)) return { outcome: "already", path, value: effectiveValue(file.ref, path) };
  const disk = await readOnDisk(file.path);
  if (disk === undefined) return refused("payload", `${file.path} is not JSON; fix it on the terminal`);
  const current = valueAt(disk.json, path.split("."));
  if (!isDeepStrictEqual(current, op.expectFrom)) return { outcome: "moved", currentValue: current ?? null };
  return writeChecked(actionId, { op, path, current, disk, tag: tagOf(confirmEvent) }, file);
}

interface Change {
  op: ConfigSet;
  path: LivePath;
  current: unknown;
  disk: OnDisk;
  tag: string;
}

async function writeChecked(actionId: string, change: Change, file: FactoryConfigFile): Promise<Outcome> {
  const next = withValue(change.disk.json, change.path.split("."), change.op.value);
  if (next === undefined) return refused("payload", `${file.path} has a non-object on the way to ${change.path}`);
  const text = `${JSON.stringify(next, null, 2)}\n`;
  try {
    parseConfig(file.path, text);
  } catch (error) {
    return refused("payload", error instanceof Error ? error.message : String(error));
  }
  if (change.disk.bytes !== null) await writeDurably(`${file.path}.bak-console-${change.tag}`, change.disk.bytes, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW);
  await replaceFile(file, text, change.tag);
  await appendRevision(file.stateDir, { actionId, path: change.path, from: change.current ?? null, to: change.op.value, fromSha: shaOf(change.disk.bytes), toSha: shaOf(Buffer.from(text)) });
  file.ref.reload();
  return { outcome: "config-set", path: change.path, value: effectiveValue(file.ref, change.path) };
}

const setByThis = (entry: LedgerLine): boolean => entry.phase === "done" && entry.result !== undefined && "outcome" in entry.result && entry.result.outcome === "config-set";

const isLivePath = (path: string): path is LivePath => Object.hasOwn(LIVE_FIELDS, path);

/** What serve reads now, through the same reader its live consumers use, so the answer is the value in force. */
const effectiveValue = (ref: ConfigRef, path: LivePath): unknown => LIVE_FIELDS[path](ref.get().shepherd ?? {}) ?? null;

/** The record's sha256 hex, without the `action:` prefix, so a backup names the owner tap that made it. */
const tagOf = (confirmEvent: string): string => confirmEvent.replace(/^action:/, "").slice(0, 8);

const shaOf = (bytes: Buffer | null): string | null => (bytes === null ? null : createHash("sha256").update(bytes).digest("hex"));

async function readOnDisk(path: string): Promise<OnDisk | undefined> {
  const bytes = await readFile(path, { flag: constants.O_RDONLY | constants.O_NOFOLLOW }).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  if (bytes === null) return { bytes, json: {} };
  try {
    return { bytes, json: JSON.parse(bytes.toString("utf8")) as unknown };
  } catch {
    return undefined;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function valueAt(root: unknown, segments: readonly string[]): unknown {
  let node = root;
  for (const segment of segments) {
    if (!isRecord(node) || !Object.hasOwn(node, segment)) return undefined;
    node = node[segment];
  }
  return node;
}

/** A copy of `root` with the value set; undefined when a segment on the way holds something other than an object. */
function withValue(root: unknown, [head, ...rest]: readonly string[], value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(root) || head === undefined) return undefined;
  if (rest.length === 0) return { ...root, [head]: value };
  const child = withValue(Object.hasOwn(root, head) ? root[head] : {}, rest, value);
  return child === undefined ? undefined : { ...root, [head]: child };
}

/** Temp file, fsync, rename: a reader, or a crash, sees the old file or the new one, never a torn one. */
async function replaceFile(file: FactoryConfigFile, text: string, tag: string): Promise<void> {
  const temp = `${file.path}.tmp-console-${tag}`;
  await rm(temp, { force: true });
  try {
    await writeDurably(temp, Buffer.from(text), WRITE_FLAGS, await modeOf(file.path));
    await (file.rename ?? renameFile)(temp, file.path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

const modeOf = (path: string): Promise<number> => stat(path).then((found) => found.mode & 0o777, () => 0o600);

async function writeDurably(path: string, bytes: Uint8Array, flags: number, mode = 0o600): Promise<void> {
  const handle = await open(path, flags, mode);
  try {
    await handle.write(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

interface Revision {
  actionId: string;
  path: string;
  from: unknown;
  to: unknown;
  fromSha: string | null;
  toSha: string | null;
}

const appendRevision = (stateDir: string, revision: Revision): Promise<void> => writeDurably(join(stateDir, CONFIG_REVISIONS), Buffer.from(`${JSON.stringify(revision)}\n`), APPEND_FLAGS);
