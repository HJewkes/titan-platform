/**
 * The shadow import (TP-3579 M3): reads an autonomy tree's `charter.md` and seat files into one
 * titan-coordinator/v1 document. Front matter is YAML, and JSON front matter is YAML too. Every
 * comment in it becomes a note for rev 0, because those comments are the tree's only change
 * history today.
 *
 * Seat files are `seats/*.md` when that directory exists, else the tree's other top-level `*.md`
 * files; a file whose front matter is not `autonomy-seat/v1` is not a seat. An import that
 * `renderSeatBook` cannot turn back into the same seat files is refused, so nothing a seat file
 * says is dropped silently. Errors name files relative to the tree, never an absolute path,
 * because they reach a LAN caller.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { isNode, isPair, isScalar, parseDocument, visit, type Document } from "yaml";
import {
  checkCoordinatorConfig,
  coordinatorConfigSchema,
  diffDocuments,
  importAutonomyTree,
  parseCharterPolicy,
  renderSeatBook,
  seatConfigSchema,
  type CharterPolicy,
  type CoordinatorConfig,
  type SeatConfig,
} from "@titan-design/coordinator";

export const CHARTER_FILE = "charter.md";
const SEATS_DIR = "seats";
const SEAT_SCHEMA = "autonomy-seat/v1";
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export const limitsSchema = coordinatorConfigSchema.shape.limits;
export type Limits = CoordinatorConfig["limits"];
export type TreeError = { file: string; path: string; message: string };
export type TreeImport =
  | { ok: true; document: CoordinatorConfig; seats: SeatConfig[]; notes: string[]; limitsFrom: "charter" | "given" }
  | { ok: false; errors: TreeError[] };

interface FrontMatter {
  file: string;
  data: unknown;
  notes: string[];
}

export interface ImportOptions {
  /** Used only when the charter has no `pools` block, which the limits are built from otherwise. */
  limits?: Limits;
}

class TreeRefusal extends Error {
  constructor(readonly errors: TreeError[]) {
    super(errors.map((error) => `${error.file}: ${error.path}: ${error.message}`).join("\n"));
  }
}

const refuse = (file: string, fieldPath: string, message: string): never => {
  throw new TreeRefusal([{ file, path: fieldPath, message }]);
};

function keyPath(ancestors: readonly unknown[], index: unknown): string {
  const keys = ancestors.filter(isPair).map((pair) => (isScalar(pair.key) ? String(pair.key.value) : "?"));
  if (typeof index === "number") keys.push(String(index));
  return keys.join(".") || "(top)";
}

/** Each comment line as `<file>: <key path>: <text>`, in document order. */
function commentNotes(file: string, doc: Document): string[] {
  const notes: string[] = [];
  const add = (where: string, comment: string | null | undefined): void => {
    for (const line of (comment ?? "").split("\n")) if (line.trim() !== "") notes.push(`${file}: ${where}: ${line.trim()}`);
  };
  add("(top)", doc.commentBefore);
  visit(doc, (index, node, ancestors) => {
    if (!isNode(node)) return;
    add(keyPath(ancestors, index), node.commentBefore);
    add(keyPath(ancestors, index), node.comment);
  });
  add("(end)", doc.comment);
  return notes;
}

/** Null when the file has no front matter. */
async function readFrontMatter(tree: string, file: string): Promise<FrontMatter | null> {
  const text = await readFile(path.join(tree, file), "utf8").catch(() => refuse(file, "", "the file is unreadable"));
  const match = FRONT_MATTER.exec(text);
  if (!match) return null;
  const doc = parseDocument(match[1] ?? "");
  const [first] = doc.errors;
  if (first) refuse(file, "", `the front matter is not YAML: ${first.message.split("\n")[0]}`);
  return { file, data: doc.toJS(), notes: commentNotes(file, doc) };
}

async function isDirectory(dir: string): Promise<boolean> {
  return (await stat(dir).catch(() => null))?.isDirectory() ?? false;
}

async function seatFileNames(tree: string): Promise<string[]> {
  const inSeats = await isDirectory(path.join(tree, SEATS_DIR));
  const dir = inSeats ? path.join(tree, SEATS_DIR) : tree;
  const names = await readdir(dir).catch(() => refuse(inSeats ? SEATS_DIR : ".", "", "the directory is unreadable"));
  return names
    .filter((name) => name.endsWith(".md") && (inSeats || name !== CHARTER_FILE))
    .sort()
    .map((name) => (inSeats ? path.join(SEATS_DIR, name) : name));
}

function schemaErrors(file: string, issues: readonly { path: PropertyKey[]; message: string }[]): never {
  throw new TreeRefusal(issues.map((issue) => ({ file, path: issue.path.map(String).join("."), message: issue.message })));
}

async function readCharter(tree: string): Promise<FrontMatter & { policy: CharterPolicy }> {
  const front = (await readFrontMatter(tree, CHARTER_FILE)) ?? refuse(CHARTER_FILE, "", "the charter has no front matter");
  const parsed = parseCharterPolicy(front.data);
  if (!parsed.ok) schemaErrors(CHARTER_FILE, parsed.errors.map((error) => ({ path: error.path.split("."), message: error.message })));
  return { ...front, policy: parsed.policy };
}

const isSeatFrontMatter = (front: FrontMatter | null): front is FrontMatter =>
  front !== null && typeof front.data === "object" && front.data !== null && (front.data as { schema?: unknown }).schema === SEAT_SCHEMA;

async function readSeats(tree: string): Promise<(FrontMatter & { seat: SeatConfig })[]> {
  const fronts = await Promise.all((await seatFileNames(tree)).map((file) => readFrontMatter(tree, file)));
  return fronts.filter(isSeatFrontMatter).map((front) => {
    const parsed = seatConfigSchema.safeParse(front.data);
    if (!parsed.success) schemaErrors(front.file, parsed.error.issues);
    return { ...front, seat: parsed.data };
  });
}

/** The charter's pools and funds pass through its schema untyped, so they are checked here. */
function charterLimits({ pools, funds }: CharterPolicy): Limits {
  const parsed = limitsSchema.safeParse({ version: 1, pools, ...(funds === undefined ? {} : { funds }) });
  if (!parsed.success) schemaErrors(CHARTER_FILE, parsed.error.issues);
  return parsed.data;
}

function limitsFor(charter: CharterPolicy, given: Limits | undefined): { limits: Limits; from: "charter" | "given" } {
  if (charter.pools !== undefined) return { limits: charterLimits(charter), from: "charter" };
  if (given !== undefined) return { limits: given, from: "given" };
  return refuse(CHARTER_FILE, "pools", "the charter has no pools block, and no limits were given");
}

function checkedDocument(document: CoordinatorConfig): CoordinatorConfig {
  const checked = checkCoordinatorConfig(document);
  if (checked.ok) return checked.config;
  throw new TreeRefusal(checked.errors.map((error) => ({ file: "(document)", path: error.path, message: error.message })));
}

/** Refuses an import that would lose or change a seat-file field when rendered back. */
function assertRoundTrip(document: CoordinatorConfig, seats: readonly (FrontMatter & { seat: SeatConfig })[]): void {
  const rendered = new Map(renderSeatBook(document).map((seat) => [seat.name, seat]));
  const errors = seats.flatMap(({ file, seat }) =>
    diffDocuments(seat, rendered.get(seat.name)).map((change) => ({ file, path: change.path, message: `${change.kind} when the document is rendered back to seat files` })),
  );
  if (errors.length > 0) throw new TreeRefusal(errors);
}

async function readTree(tree: string, options: ImportOptions): Promise<TreeImport> {
  const charter = await readCharter(tree);
  const seats = await readSeats(tree);
  const { limits, from } = limitsFor(charter.policy, options.limits);
  const document = checkedDocument(importAutonomyTree(charter.policy, seats.map(({ seat }) => seat), limits));
  assertRoundTrip(document, seats);
  const notes = [charter, ...seats].flatMap((front) => front.notes);
  return { ok: true, document, seats: seats.map(({ seat }) => seat), notes, limitsFrom: from };
}

/** Never throws for a bad tree: every refusal is an error naming the file and field. */
export async function importTree(tree: string, options: ImportOptions = {}): Promise<TreeImport> {
  try {
    return await readTree(tree, options);
  } catch (error) {
    if (error instanceof TreeRefusal) return { ok: false, errors: error.errors };
    throw error;
  }
}
