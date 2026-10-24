import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { indexPaths, openCodeGraph, type CodeGraphStore } from "@titan-design/code-graph";

const STRUCTURE_FIXTURE = fileURLToPath(new URL("../../../../fixtures/structure-ts", import.meta.url));
export const FIXTURE_PIN = "1111111111111111111111111111111111111111";
export const OTHER_PIN = "2222222222222222222222222222222222222222";

export const ENTRY = "packages/a/src/entry.ts";
export const SERVICE = "packages/b/src/service.ts";
export const STORE = "packages/c/src/store.ts";
export const REPORT = "packages/c/src/report.ts";

/** A throwaway copy of the fixture, so indexing never writes beside the checked-in files. */
export async function fixtureClone(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rx-structure-clone-"));
  await cp(STRUCTURE_FIXTURE, dir, { recursive: true });
  return dir;
}

export interface IndexedFixture {
  clone: string;
  store: CodeGraphStore;
  snapshotId: number;
  dispose(): Promise<void>;
}

/** The fixture indexed once at {@link FIXTURE_PIN} into a temp db. */
export async function indexedFixture(commitHash = FIXTURE_PIN): Promise<IndexedFixture> {
  const clone = await fixtureClone();
  const dbDir = await mkdtemp(join(tmpdir(), "rx-structure-db-"));
  const store = openCodeGraph(join(dbDir, "graph.db"));
  const { snapshotId } = await indexPaths(store, { paths: [clone], commitHash, computeMetrics: true, computeChurn: false });
  return {
    clone,
    store,
    snapshotId,
    async dispose() {
      store.close();
      await Promise.all([clone, dbDir].map((dir) => rm(dir, { recursive: true, force: true })));
    },
  };
}
