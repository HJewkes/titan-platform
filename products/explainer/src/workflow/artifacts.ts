import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Db, Migration } from "@titan-design/store-sqlite";
import { z } from "zod";

export const sha256 = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** Who wrote an artifact first; a later run that produces the same bytes adds no row. */
export interface Provenance {
  runId: string;
  stage: string;
}

/** A directory stored as the sorted list of its files' shas, hashed like ev's `tree` fixture. */
const TreeSchema = z.object({ schema: z.literal("artifact-tree/v1"), entries: z.array(z.object({ path: z.string(), sha: z.string() })) });
type Tree = z.infer<typeof TreeSchema>;
const KindRowSchema = z.object({ kind: z.string() });

export const artifactMigration = (version: number): Migration => ({
  version,
  name: "explainer-artifacts",
  up: (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS explainer_artifacts (
      sha TEXT PRIMARY KEY, kind TEXT NOT NULL, bytes INTEGER NOT NULL, run_id TEXT NOT NULL, stage TEXT NOT NULL, created_at TEXT NOT NULL
    )`);
  },
});

function filesUnder(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? filesUnder(path.join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]))
    .sort();
}

/**
 * `<dataDir>/artifacts/<sha256>`, written once and made read-only, so a hard link from the theater can never be
 * changed under the store. Files are copied in, never linked: a bridged tool that rewrites its output in place would
 * otherwise rewrite the stored bytes.
 */
export class ArtifactStore {
  private readonly root: string;

  constructor(dataDir: string, private readonly db: Db) {
    this.root = path.join(dataDir, "artifacts");
  }

  path(sha: string): string {
    const file = path.join(this.root, sha);
    if (!existsSync(file)) throw new Error(`artifact ${sha.slice(0, 12)} is not in the store`);
    return file;
  }

  putText(text: string, kind: string, from: Provenance): string {
    return this.putBytes(Buffer.from(text), kind, from);
  }

  putFile(file: string, kind: string, from: Provenance): string {
    if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`expected output file ${file} was not written`);
    return this.putBytes(readFileSync(file), kind, from);
  }

  putTree(dir: string, kind: string, from: Provenance): string {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`expected output directory ${dir} was not written`);
    const entries = filesUnder(dir).map((rel) => ({ path: rel, sha: this.putFile(path.join(dir, rel), `${kind}/file`, from) }));
    const tree: Tree = { schema: "artifact-tree/v1", entries };
    return this.putText(`${JSON.stringify(tree)}\n`, `${kind}/tree`, from);
  }

  readText(sha: string): string {
    const bytes = readFileSync(this.path(sha));
    if (sha256(bytes) !== sha) throw new Error(`artifact ${sha.slice(0, 12)} no longer matches its hash`);
    return bytes.toString("utf8");
  }

  /** Writes an artifact to `dest`: a file is copied, a tree is written file by file. Files already holding the bytes are left alone. */
  materialise(sha: string, dest: string): void {
    const tree = this.tree(sha);
    if (!tree) return this.copyOut(sha, dest);
    for (const entry of tree.entries) this.copyOut(entry.sha, path.join(dest, entry.path));
  }

  private tree(sha: string): Tree | undefined {
    const row = KindRowSchema.optional().parse(this.db.prepare("SELECT kind FROM explainer_artifacts WHERE sha = ?").get(sha));
    return row?.kind.endsWith("/tree") ? TreeSchema.parse(JSON.parse(this.readText(sha))) : undefined;
  }

  private copyOut(sha: string, dest: string): void {
    if (existsSync(dest) && sha256(readFileSync(dest)) === sha) return;
    mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.explainer-tmp`;
    copyFileSync(this.path(sha), tmp);
    chmodSync(tmp, 0o644);
    renameSync(tmp, dest);
  }

  private putBytes(bytes: Buffer, kind: string, from: Provenance): string {
    const sha = sha256(bytes);
    const file = path.join(this.root, sha);
    if (!existsSync(file)) {
      mkdirSync(this.root, { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, bytes);
      chmodSync(tmp, 0o444);
      renameSync(tmp, file);
    }
    this.db.prepare("INSERT OR IGNORE INTO explainer_artifacts (sha, kind, bytes, run_id, stage, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(sha, kind, bytes.length, from.runId, from.stage, new Date().toISOString());
    return sha;
  }
}
