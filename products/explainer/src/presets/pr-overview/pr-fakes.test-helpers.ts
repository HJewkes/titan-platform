import type { CallEdge } from "./call-edges.js";
import type { GhRun, PrView } from "./pr-read.js";

/** A synthetic PR on a synthetic repo; no real PR content. */
export const REPO = "acme/widgets";
export const PR = `${REPO}#7`;
export const HEAD = "a".repeat(40);

export const VIEW: PrView = {
  number: 7,
  title: "Cache widget lookups (DEMO-12)",
  body: "Adds a lookup cache in front of the widget store.",
  headRefName: "feat/widget-cache",
  headRefOid: HEAD,
  reviews: [
    { body: "Eviction never runs when the cache is full.\n\nVerdict: FIX_FIRST", state: "COMMENTED" },
    { body: "", state: "APPROVED" },
  ],
  comments: [{ body: "Benchmark: lookups drop from 40 ms to 3 ms." }],
};

export const PATCH = `diff --git a/src/api.ts b/src/api.ts
index 1111111..2222222 100644
--- a/src/api.ts
+++ b/src/api.ts
@@ -1,3 +1,5 @@
 import { save } from "./store.js";
+import { lookup } from "./cache.js";
 export function handle(id: string): string {
-  return save(id);
+  const hit = lookup(id);
+  return hit ?? save(id);
 }
diff --git a/src/cache.ts b/src/cache.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/cache.ts
@@ -0,0 +1,3 @@
+export function lookup(id: string): string | undefined {
+  return id === "" ? undefined : id;
+}
diff --git a/docs/old.md b/docs/old.md
deleted file mode 100644
index 4444444..0000000
--- a/docs/old.md
+++ /dev/null
@@ -1,2 +0,0 @@
-# Old
-notes
diff --git a/docs/a.md b/docs/b.md
similarity index 90%
rename from docs/a.md
rename to docs/b.md
index 5555555..6666666 100644
--- a/docs/a.md
+++ b/docs/b.md
@@ -1 +1 @@
-# A
+# B
`;

/** The repo's call graph: one call across two changed files, one into an unchanged file, one inside a file. */
export const EDGES: CallEdge[] = [
  { from: "src/api.ts#handle", to: "src/cache.ts#lookup", sites: 1 },
  { from: "src/api.ts#handle", to: "src/store.ts#save", sites: 1 },
  { from: "src/cache.ts#lookup", to: "src/cache.ts#lookup", sites: 1 },
];

export const fakeEdges = (edges: CallEdge[] = EDGES) => async (): Promise<CallEdge[]> => edges;

/** A fake `gh` that answers `pr view` and `pr diff` for one PR and records each call. */
export function fakeGh(view: PrView = VIEW, patch: string = PATCH): GhRun & { calls: string[][] } {
  const calls: string[][] = [];
  const gh = async (args: readonly string[]): Promise<string> => {
    calls.push([...args]);
    if (args[0] === "pr" && args[1] === "view") return JSON.stringify(view);
    if (args[0] === "pr" && args[1] === "diff") return patch;
    throw new Error(`fake gh: unexpected ${args.join(" ")}`);
  };
  return Object.assign(gh, { calls });
}

type Gate = { gateId: string; stepId: string; repo: string; pr: number | null; head: string | null; headIsCurrent: boolean | null; held: string | null };

export function gate(overrides: Partial<Gate> = {}): Gate {
  return { gateId: "run-1:approve-merge", stepId: "approve-merge", repo: REPO, pr: 7, head: HEAD, headIsCurrent: true, held: "visual-gate2: frames to sign off", ...overrides };
}
