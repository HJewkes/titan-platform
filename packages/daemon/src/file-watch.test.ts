import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { watchTree, type TreeWatcher } from "./file-watch.js";

const DEBOUNCE_MS = 20;

let root: string;
let watcher: TreeWatcher | null = null;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "titan-watch-"));
});

afterEach(async () => {
  watcher?.close();
  watcher = null;
  await rm(root, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Write into `dir` until the watcher reports a change.
 *
 * macOS drops the very first `fs.watch` event a few percent of the time when the watcher
 * attaches right after the directory was created (measured directly, not a `watchTree`
 * bug). Retrying keeps the assertion about our debounce rather than about OS delivery.
 */
async function writeUntilChanged(dir: string, counter: { count: number }): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (let attempt = 0; counter.count === 0 && Date.now() < deadline; attempt++) {
    await writeFile(path.join(dir, `note-${attempt}.md`), "hello");
    const window = Date.now() + 300;
    while (counter.count === 0 && Date.now() < window) await sleep(5);
  }
  if (counter.count === 0) throw new Error(`no change fired for ${dir}`);
}

describe("watchTree", () => {
  it("fires one debounced callback for a write inside a nested subdirectory", { timeout: 15_000 }, async () => {
    const nested = path.join(root, "a", "b");
    await mkdir(nested, { recursive: true });
    const counter = { count: 0 };
    watcher = watchTree(root, () => counter.count++, { debounceMs: DEBOUNCE_MS });
    expect(await watcher.whenWatching(nested)).toBe(true);

    await writeUntilChanged(nested, counter);

    expect(counter.count).toBe(1);
  });

  it("stops firing after close", async () => {
    const counter = { count: 0 };
    watcher = watchTree(root, () => counter.count++, { debounceMs: DEBOUNCE_MS });

    watcher.close();
    await writeFile(path.join(root, "after-close.md"), "hello");
    await sleep(DEBOUNCE_MS * 5);

    expect(counter.count).toBe(0);
    expect(watcher.isWatching(root)).toBe(false);
  });

  it("covers a deep tree and still tears down promptly (TP-37)", async () => {
    // 60 nested directories. Watching per directory cost one FSEvents handle each,
    // and each close is a serialized semaphore round-trip — the shape that made a
    // real daemon spend 12.6s in its SIGTERM handler across 1,593 directories.
    let deep = root;
    for (let i = 0; i < 60; i++) {
      deep = path.join(deep, `d${i}`);
      await mkdir(deep);
    }
    watcher = watchTree(root, () => undefined, { debounceMs: DEBOUNCE_MS });
    expect(await watcher.whenWatching(deep)).toBe(true);

    const started = Date.now();
    watcher.close();
    const elapsed = Date.now() - started;
    watcher = null;

    // 60 handles at the measured ~8ms each would be ~480ms; one handle is ~8ms.
    expect(elapsed).toBeLessThan(400);
  });

  it("reports errors instead of throwing when the root is missing", () => {
    const errors: unknown[] = [];

    const missing = watchTree(path.join(root, "absent"), () => undefined, { onError: (err) => errors.push(err) });
    missing.close();

    expect(errors.length).toBeGreaterThan(0);
  });
});
