import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export interface SyntheticFile {
  relPath: string;
  title?: string;
  published?: string;
  body: string;
}

/** Invented series and prose in the archive shape; nothing here is real corpus text. */
export function writeCorpus(files: SyntheticFile[]): { root: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "corpus-query-"));
  for (const f of files) writeFile(root, f);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export function writeFile(root: string, f: SyntheticFile): void {
  const header = [
    f.title === undefined ? undefined : `TITLE: ${f.title}`,
    f.published === undefined ? undefined : `PUBLISHED: ${f.published}`,
    f.title === undefined ? undefined : "POST_ID: 1001",
  ].filter((l) => l !== undefined);
  const head = header.length > 0 ? `${header.join("\n")}\n\n` : "";
  const full = path.join(root, f.relPath);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, head + f.body);
}
