import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { contentKey, type ParsedFact } from "@titan-design/memory";
import { claudeProjectSlug, type TranscriptRoot } from "@titan-design/session-read";

const CLAUDE_MD = "CLAUDE.md";
const GLOBAL_PROJECT = "global";
const SECTION_HEADING = /^## +(.+?) *$/;
const FENCE = /^ {0,3}(```|~~~)/;

interface InstructionSection {
  account: string;
  project: string;
  path: string;
  host?: string;
  heading: string;
  body: string;
}

function isMissing(error: unknown): boolean {
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

function isRealDir(dir: string): boolean {
  try {
    return lstatSync(dir).isDirectory();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

// A symlinked CLAUDE.md is skipped, as a symlinked memory dir is, so a planted link cannot widen the read.
function readRegularFile(file: string): string | undefined {
  try {
    return lstatSync(file).isFile() ? readFileSync(file, "utf8") : undefined;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

/** Splits at second-level headings outside code fences; text before the first one is not a section. */
function splitSections(text: string): { heading: string; body: string }[] {
  const sections: { heading: string; lines: string[] }[] = [];
  let fenced = false;
  for (const line of text.split("\n")) {
    if (FENCE.test(line)) fenced = !fenced;
    const heading = fenced ? null : SECTION_HEADING.exec(line)?.[1];
    if (heading) sections.push({ heading, lines: [] });
    else sections.at(-1)?.lines.push(line);
  }
  return sections.map(({ heading, lines }) => ({ heading, body: lines.join("\n").trim() }));
}

/**
 * A transcript folder name is the project path with every non-alphanumeric character turned
 * into `-` (`claudeProjectSlug`), so a name with dashes is ambiguous; the decode keeps whichever reading names a real directory.
 */
function decodeFrom(base: string, encoded: string): string | undefined {
  for (const entry of listDir(base)) {
    const name = claudeProjectSlug(entry);
    const child = path.join(base, entry);
    if (encoded === name && isRealDir(child)) return child;
    if (encoded.startsWith(`${name}-`) && isRealDir(child)) {
      const found = decodeFrom(child, encoded.slice(name.length + 1));
      if (found) return found;
    }
  }
  return undefined;
}

function decodeProjectDir(folder: string): string | undefined {
  if (!folder.startsWith("-")) return undefined;
  return decodeFrom(path.sep, folder.slice(1));
}

function sectionsOf(file: string, ref: Omit<InstructionSection, "heading" | "body">): InstructionSection[] {
  const text = readRegularFile(file);
  return text === undefined ? [] : splitSections(text).map((section) => ({ ...ref, path: file, ...section }));
}

function rootSections({ root, account, host }: TranscriptRoot): InstructionSection[] {
  const origin = { account, ...(host ? { host } : {}) };
  const global = sectionsOf(path.join(path.dirname(root), CLAUDE_MD), { ...origin, project: GLOBAL_PROJECT, path: "" });
  // A mirror's project folders name paths on another machine, so only a local root's can be decoded.
  const projects = host ? [] : listDir(root).flatMap((project) => {
    const dir = decodeProjectDir(project);
    return dir ? sectionsOf(path.join(dir, CLAUDE_MD), { ...origin, project, path: "" }) : [];
  });
  return [...global, ...projects];
}

/** Reads the global CLAUDE.md beside each root's `projects` dir and each project's own CLAUDE.md, split at `##` headings. */
export function scanInstructions(roots: readonly TranscriptRoot[]): InstructionSection[] {
  return roots.flatMap(rootSections);
}

/** Each section as a fact, typed `user` so a destination rule can never propose deleting a CLAUDE.md. */
export function instructionFacts(sections: readonly InstructionSection[]): ParsedFact[] {
  return sections.map(({ account, project, path: file, host, heading, body }) => ({
    ok: true,
    ref: { account, project, path: file, ...(host ? { host } : {}) },
    name: heading,
    description: heading,
    type: "user",
    body,
    contentHash: contentKey(`${heading}\n${body}`),
  }));
}
