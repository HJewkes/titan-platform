import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect } from "vitest";
import type { Feed } from "../test-support/a17/feed.js";
import { a17Event } from "../test-support/a17/register.js";
import { getBlob, type BlobStore } from "./blob-store.js";
import { currentMarker, readMarkerValues, writeMarker } from "./marker-store.js";

const AT = "2026-11-01T12:00:00.000Z";
const ITEM = "o/r#7";
const FIRST_HEAD = "a".repeat(40);
const SECOND_HEAD = "b".repeat(40);
const OUTPUT_COPIES = 8192;

const digestOf = (bytes: Buffer): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function blobStore(): BlobStore {
  const root = mkdtempSync(join(tmpdir(), "marker-drop-"));
  dirs.push(root);
  return { blobDir: join(root, "marker-blobs"), capabilities: { refuse: () => undefined } };
}

/** A pure step body: its output depends only on the head value it is handed. Large enough that its blob is a file. */
const checkStep = (head: string): Buffer => Buffer.from(`verdict:${head}\n`.repeat(OUTPUT_COPIES));

const liveHead = (feed: Feed): string => {
  const head = feed.head("o/r", 7);
  if (head === undefined) throw new Error("the feed shows no head for o/r#7");
  return head;
};

async function push(feed: Feed, head: string, action: "opened" | "synchronize"): Promise<void> {
  await feed.fact({ type: "pr", repo: "o/r", pr: 7, head, base: "main", action });
}

a17Event("a dropped marker replays from its recorded read values", async (feed) => {
  const store = blobStore();
  await push(feed, FIRST_HEAD, "opened");
  const head = liveHead(feed);
  const output = checkStep(head);
  const { id } = writeMarker(feed.db, store, {
    item: ITEM,
    fact: "check",
    pinClass: "tree",
    pin: head,
    step: "check-head",
    callSite: "land:1",
    version: "v1",
    inputDigests: {},
    reads: [{ name: "head", bytes: Buffer.from(head) }],
    output,
    writtenAt: AT,
  });
  const recorded = currentMarker(feed.db, { item: ITEM, fact: "check", pinClass: "tree", pin: head })!;
  readdirSync(store.blobDir)
    .filter((name) => name === recorded.outputDigest?.slice("sha256:".length))
    .forEach((name) => unlinkSync(join(store.blobDir, name)));
  expect(readMarkerValues(feed.db, store, id)).toEqual({ missing: ["output"] });

  await push(feed, SECOND_HEAD, "synchronize");
  const readsBefore = feed.reads();
  const recordedHead = getBlob(feed.db, store, recorded.reads[0]!.digest);
  const replayed = recordedHead && checkStep(recordedHead.toString());

  expect(liveHead(feed)).toBe(SECOND_HEAD);
  expect(replayed && digestOf(replayed)).toBe(recorded.outputDigest);
  expect(feed.reads()).toBe(readsBefore);
});
