import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Who is asking is resolved once, in `caller.ts`, and which initiatives an agent sees is applied once, in
 * `needs/merged.ts`, from active-work's verdict (TP-5556). #3690 failed review rounds because each entry point
 * decided both for itself, so these checks keep every other file from doing either. Each exemption says why it
 * decides nothing about which needs items an agent sees.
 */

const SRC = dirname(fileURLToPath(import.meta.url));
const OWNER_QUEUE_SRC = join(SRC, "..", "..", "..", "packages", "owner-queue", "src");

const AGENT_ENV = /\b(AGENT_CHAT_NAME|AGENT_CHAT_AGENT_ID|CLAUDECODE)\b/;
const OWNER_ONLY = /\bownerOnly\b/;
const VERDICT_BUILDERS = /\b(isAgentVisible|agentAccess|hiddenSlugs\w*|ownerOnlySlugs|withheldSlugs)\b/;
const WIRE_FIELD = /\b(withheld_from_agents|agent_visible)\b/;
const CALLER_FORGE = /\bcaller\s*[:=]\s*["'`]owner["'`]|\bfactoryContext\([^;]*?["'`]owner["'`]/;
const CALLER_COMPARE = /\bcaller\s*[!=]==/;

const AGENT_ENV_READERS: Record<string, string> = {
  "caller.ts": "resolves the needs caller",
  "cli-agent-env.ts": "refuses owner-terminal verbs in an agent shell: a write gate",
  "cli-options.ts": "names who registered a run: provenance",
  "cli-shepherd.ts": "names who registered a run: provenance",
  "gate-resolve.ts": "decides who may resolve a gate, against owner-signed presence: a write gate",
};

const OWNER_ONLY_NAMERS: Record<string, string> = {
  "shepherd/task-key-report.ts": "counts proposed task keys reserved for the owner; filters no needs item",
};

const WIRE_READERS: Record<string, string> = {
  "eligibility/shadow/tick.test-helpers.ts": "a fake active-work daemon that serves the field to tests; reads no verdict",
  "needs/agent-allow-list.ts": "reads withheld_from_agents, the one verdict the needs filter applies",
  "shepherd/task-ref.ts": "resolves a registration's task key from task-keys; returns no needs item",
};

const CALLER_DECIDERS: Record<string, string> = {
  "needs/merged.ts": "the one needs filter",
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "test-support" ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

// Prose may name what it must not do, so comments are dropped before matching.
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function sourcesUnder(root: string): { file: string; source: string }[] {
  return sourceFiles(root).map((file) => ({ file: relative(root, file).split(sep).join("/"), source: withoutComments(readFileSync(file, "utf8")) }));
}

const FACTORY = sourcesUnder(SRC);
const OWNER_QUEUE = sourcesUnder(OWNER_QUEUE_SRC);

const matching = (sources: readonly { file: string; source: string }[], pattern: RegExp): string[] =>
  sources.filter(({ source }) => pattern.test(source)).map(({ file }) => file).sort();

describe("the needs caller boundary in the factory", () => {
  it("reads the agent env markers only in caller.ts and the named gates", () => {
    expect(matching(FACTORY, AGENT_ENV)).toEqual(Object.keys(AGENT_ENV_READERS).sort());
  });

  it("never sets the owner caller outside the surface and shell resolvers", () => {
    expect(matching(FACTORY, CALLER_FORGE).filter((file) => file !== "serve.ts" && file !== "caller.ts")).toEqual([]);
  });

  it("decides on the caller only in the needs filter", () => {
    expect(matching(FACTORY, CALLER_COMPARE)).toEqual(Object.keys(CALLER_DECIDERS).sort());
  });

  it("builds no visibility verdict of its own", () => {
    expect(matching(FACTORY, VERDICT_BUILDERS)).toEqual([]);
  });

  it("reads the wire visibility fields only where the reason is named", () => {
    expect(matching(FACTORY, WIRE_FIELD)).toEqual(Object.keys(WIRE_READERS).sort());
  });

  it("carries no ownerOnly flag on needs items", () => {
    expect(matching(FACTORY, OWNER_ONLY)).toEqual(Object.keys(OWNER_ONLY_NAMERS).sort());
    expect(matching(OWNER_QUEUE, OWNER_ONLY)).toEqual([]);
  });
});
