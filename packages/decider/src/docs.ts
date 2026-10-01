import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertDomain, type Principle } from "./principles.js";
import { parsePriorDoc, renderDomainDoc, type DomainChanges, type DomainDoc, type RenderOptions } from "./render.js";

export interface WriteDocsInput {
  /** The principles directory; the caller resolves it, so tests and owners can point it anywhere. */
  dir: string;
  principles: ReadonlyMap<string, readonly Principle[]>;
  changes: ReadonlyMap<string, DomainChanges>;
  now: Date;
}

export interface WrittenDoc extends Omit<DomainDoc, "markdown"> {
  path: string;
}

const NO_CHANGES: DomainChanges = { added: [], promoted: [], demoted: [], retired: [], confirmed: [], contradicted: [] };

function readPrior(path: string) {
  return existsSync(path) ? parsePriorDoc(readFileSync(path, "utf8")) : null;
}

/** Write via a sibling temp file so a reader never sees half a doc. */
function writeAtomically(path: string, text: string): void {
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, text);
  renameSync(temp, path);
}

/** Write `<domain>.md` for every domain that has live principles or changed in this run. */
export function writePrincipleDocs(input: WriteDocsInput, options: RenderOptions = {}): WrittenDoc[] {
  mkdirSync(input.dir, { recursive: true });
  const domains = [...new Set([...input.principles.keys(), ...input.changes.keys()])].sort();
  return domains.map((domain) => {
    const path = join(input.dir, `${assertDomain(domain)}.md`);
    const doc = renderDomainDoc(
      { domain, principles: input.principles.get(domain) ?? [], changes: input.changes.get(domain) ?? NO_CHANGES, prior: readPrior(path), now: input.now },
      options,
    );
    writeAtomically(path, doc.markdown);
    return { domain: doc.domain, version: doc.version, bumped: doc.bumped, path };
  });
}
