/**
 * The compare-tree diff (TP-3579 2.2 step 1): the revision log head's document against a fresh
 * import of the autonomy tree, plus whether the materialized file still holds the head. During the
 * shadow phase this stays empty, or it names the drift. Read-only: it never writes the log, the
 * materialized file or the tree.
 */
import { z } from "zod";
import { diffDocuments, documentSha, revisionSha, type ConfigRevision } from "@titan-design/coordinator";
import { readCommand } from "../owner-guard.js";
import { importTree } from "./import.js";
import { readRevisionLog, revisionLogPath } from "./log.js";
import { readMaterialized } from "./materialize.js";

/** Where the store lives; `autonomyTree` is null until the owner points the console at a tree. */
export interface ConfigStorePaths {
  autonomyTree: string | null;
  coordinatorFile: string;
}
export type ConfigStoreSource = ConfigStorePaths & { stateDir: string };

const headSchema = z.object({ rev: z.number(), at: z.string(), sha: z.string(), documentSha: z.string() });
const changeSchema = z.object({ path: z.string(), kind: z.enum(["added", "removed", "changed"]), before: z.unknown().optional(), after: z.unknown().optional() });
const treeErrorSchema = z.object({ file: z.string(), path: z.string(), message: z.string() });

export const compareTreeResult = z.discriminatedUnion("state", [
  z.object({ state: z.literal("not-configured") }),
  z.object({ state: z.literal("no-revisions") }),
  z.object({ state: z.literal("log-invalid"), errors: z.array(z.string()) }),
  z.object({ state: z.literal("tree-invalid"), head: headSchema, errors: z.array(treeErrorSchema) }),
  z.object({
    state: z.literal("compared"),
    head: headSchema,
    materialized: z.enum(["current", "stale", "missing", "unreadable"]),
    limitsFrom: z.enum(["charter", "given"]),
    changes: z.array(changeSchema),
  }),
]);
export type CompareTreeResult = z.infer<typeof compareTreeResult>;

function headOf(revisions: readonly unknown[], head: ConfigRevision): z.infer<typeof headSchema> {
  return { rev: head.rev, at: head.at, sha: revisionSha(revisions.at(-1)), documentSha: documentSha(head.document) };
}

/** A tree with no pools block is compared with the head's limits, so only its seats and policy can drift. */
export async function compareTree(source: ConfigStoreSource | undefined): Promise<CompareTreeResult> {
  if (source?.autonomyTree == null) return { state: "not-configured" };
  const log = await readRevisionLog(revisionLogPath(source.stateDir));
  if (log.state === "empty") return { state: "no-revisions" };
  if (log.state === "invalid") return { state: "log-invalid", errors: log.errors.map((error) => `rev ${error.rev} ${error.code}: ${error.message}`) };
  const head = headOf(log.revisions, log.head);
  const tree = await importTree(source.autonomyTree, { limits: log.head.document.limits });
  if (!tree.ok) return { state: "tree-invalid", head, errors: tree.errors };
  const materialized = await readMaterialized(source.coordinatorFile, head.documentSha);
  return { state: "compared", head, materialized, limitsFrom: tree.limitsFrom, changes: diffDocuments(log.head.document, tree.document) };
}

export function configStoreCommands(source: ConfigStoreSource | undefined) {
  return {
    "config.compareTree": readCommand({
      name: "config.compareTree",
      description: "The coordinator revision log head against a fresh import of the autonomy tree, and whether the materialized document is current",
      args: z.object({}),
      result: compareTreeResult,
      run: () => compareTree(source),
    }),
  };
}
