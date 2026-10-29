import { readFileSync } from "node:fs";
import { isMap, isNode, isScalar, LineCounter, parseDocument, type Document, type Node } from "yaml";
import type { z } from "zod";
import { WatchlistSchema, type Watchlist } from "./config.js";

/** One problem in the watch list, with the 1-based line it sits on when one is known. */
export interface ConfigProblem {
  line?: number;
  path: string;
  message: string;
}

export class WatchlistError extends Error {
  constructor(
    readonly file: string,
    readonly problems: ConfigProblem[],
  ) {
    super(problems.map((p) => formatProblem(file, p)).join("\n"));
    this.name = "WatchlistError";
  }
}

export function formatProblem(file: string, p: ConfigProblem): string {
  const where = p.line === undefined ? file : `${file}:${p.line}`;
  return p.path ? `${where}: ${p.path}: ${p.message}` : `${where}: ${p.message}`;
}

type PathKey = PropertyKey;

function nodeAt(doc: Document, path: readonly PathKey[]): Node | undefined {
  const node: unknown = doc.getIn([...path], true);
  return isNode(node) ? node : undefined;
}

// An unknown key is reported on the key's own line, not on its parent map's first line.
function keyNodeAt(doc: Document, path: readonly PathKey[], key: string): Node | undefined {
  const parent = path.length === 0 ? doc.contents : nodeAt(doc, path);
  if (!isMap(parent)) return undefined;
  const pair = parent.items.find((item) => isScalar(item.key) && item.key.value === key);
  return isNode(pair?.key) ? pair.key : undefined;
}

function lineOf(lines: LineCounter, node: Node | undefined): number | undefined {
  const offset = node?.range?.[0];
  return offset === undefined ? undefined : lines.linePos(offset).line;
}

function issueProblems(doc: Document, lines: LineCounter, issue: z.core.$ZodIssue): ConfigProblem[] {
  if (issue.code === "unrecognized_keys") {
    return issue.keys.map((key) => ({
      line: lineOf(lines, keyNodeAt(doc, issue.path, key)) ?? lineOf(lines, nodeAt(doc, issue.path)),
      path: [...issue.path, key].join("."),
      message: "unknown key",
    }));
  }
  let at = issue.path;
  while (at.length > 0 && !nodeAt(doc, at)) at = at.slice(0, -1);
  return [{ line: lineOf(lines, at.length > 0 ? nodeAt(doc, at) : undefined), path: issue.path.join("."), message: issue.message }];
}

/** Parse and validate watch-list text; throws `WatchlistError` naming each problem's line. */
export function parseWatchlist(text: string, file: string): Watchlist {
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, prettyErrors: true,uniqueKeys: true });
  if (doc.errors.length > 0) {
    throw new WatchlistError(
      file,
      doc.errors.map((e) => ({ line: e.linePos?.[0].line, path: "", message: e.message.split("\n")[0]! })),
    );
  }
  const parsed = WatchlistSchema.safeParse(doc.toJS());
  if (parsed.success) return parsed.data;
  throw new WatchlistError(
    file,
    parsed.error.issues.flatMap((issue) => issueProblems(doc, lines, issue)),
  );
}

export function loadWatchlist(file: string): Watchlist {
  return parseWatchlist(readFileSync(file, "utf8"), file);
}
