/** One import in a chain: `importer` imports `imported` on the given lines. */
export interface ImportLink {
  importer: string;
  imported: string;
  lines: number[];
}

/** One broken import chain, under the contract name and the sentence lint-imports prints above it. */
export interface BrokenChain {
  contract: string;
  summary: string;
  links: ImportLink[];
}

const LINK = /^(-)?\s+(\S+) -> (\S+) \(l\.([\d, ?]+)\)$/;
const SUMMARY = /^(\S.* is not allowed to import \S.*):$/;

function isUnderline(line: string | undefined, heading: string): boolean {
  return line !== undefined && /^-+$/.test(line) && line.length === heading.length;
}

function toLink(m: RegExpExecArray): ImportLink {
  const lines = m[4]!.split(",").map((n) => Number(n.trim())).filter((n) => Number.isInteger(n) && n > 0);
  return { importer: m[2]!, imported: m[3]!, lines };
}

/** Reads the "Broken contracts" section; a chain starts at a "-" line and continues on indented lines. */
export function parseBrokenChains(stdout: string): BrokenChain[] {
  const lines = stdout.split("\n");
  const start = lines.findIndex((l, i) => l === "Broken contracts" && isUnderline(lines[i + 1], l));
  if (start < 0) return [];
  const chains: BrokenChain[] = [];
  let contract = "";
  let summary = "";
  for (let i = start + 2; i < lines.length; i++) {
    const line = lines[i]!;
    const link = LINK.exec(line);
    if (isUnderline(lines[i + 1], line) && line.trim()) contract = line;
    else if (SUMMARY.test(line)) summary = SUMMARY.exec(line)![1]!;
    else if (link?.[1]) chains.push({ contract, summary, links: [toLink(link)] });
    else if (link && chains.length > 0) chains.at(-1)!.links.push(toLink(link));
  }
  return chains;
}
