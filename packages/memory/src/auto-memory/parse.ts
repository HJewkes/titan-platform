import { parse as parseYaml } from "yaml";
import { contentKey } from "../text.js";
import { MEMORY_FACT_TYPES, type MemoryFactType, type MemoryIndexPointer, type MemorySourceRef, type ParseFailure, type ParsedFact } from "./types.js";

const OPEN = "---";
const CLOSE = "\n---";
const POINTER = /^\s*[-*]\s+\[([^\]]*)\]\(([^)\s]+)\)/;

type Fields = Record<string, unknown>;

function isFields(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function splitFrontmatter(raw: string): { yaml: string; body: string } | string {
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!text.startsWith(OPEN)) return "no frontmatter";
  const rest = text.slice(OPEN.length);
  const close = rest.indexOf(CLOSE);
  if (close === -1) return "frontmatter has no closing ---";
  return { yaml: rest.slice(0, close), body: rest.slice(close + CLOSE.length).replace(/^[^\n]*\n?/, "") };
}

function readYaml(yaml: string): Fields | string {
  try {
    const data: unknown = parseYaml(yaml);
    return isFields(data) ? data : "frontmatter is not a mapping";
  } catch (error) {
    return `invalid frontmatter YAML: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`;
  }
}

function text(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  return typeof value === "number" ? String(value) : undefined;
}

// Three shapes are in use: top-level `type`, `metadata.type`, and a `metadata` block with no type at all.
function factType(fields: Fields, metadata: Fields): MemoryFactType {
  const value = text(fields.type) ?? text(metadata.type);
  return MEMORY_FACT_TYPES.find((type) => type === value) ?? "unknown";
}

function fileStem(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.md$/, "");
}

/** Parses one auto-memory fact file. Never throws: a file it cannot read comes back as a `ParseFailure`. */
export function parseMemoryFile(raw: string, ref: MemorySourceRef): ParsedFact | ParseFailure {
  const split = splitFrontmatter(raw);
  if (typeof split === "string") return { ok: false, ref, error: `${ref.path}: ${split}` };
  const fields = readYaml(split.yaml);
  if (typeof fields === "string") return { ok: false, ref, error: `${ref.path}: ${fields}` };
  const metadata = isFields(fields.metadata) ? fields.metadata : {};
  const description = text(fields.description) ?? "";
  const body = split.body.trim();
  const modified = text(fields.modified) ?? text(metadata.modified);
  return {
    ok: true,
    ref,
    name: text(fields.name) ?? fileStem(ref.path),
    description,
    type: factType(fields, metadata),
    body,
    ...(modified === undefined ? {} : { modified }),
    contentHash: contentKey(`${description}\n${body}`),
  };
}

/** Reads the pointer lines of a `MEMORY.md` index; prose lines are skipped. */
export function parseMemoryIndex(raw: string): MemoryIndexPointer[] {
  const pointers: MemoryIndexPointer[] = [];
  raw.split(/\r?\n/).forEach((lineText, index) => {
    const match = POINTER.exec(lineText);
    if (match) pointers.push({ title: match[1] ?? "", file: match[2] ?? "", line: index + 1 });
  });
  return pointers;
}
