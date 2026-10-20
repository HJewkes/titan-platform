import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Parse-only (R28, TP-3100 J7): the ingress may verify, project and append, and nothing else. Each module outside this
 * directory is pinned to the names it may bring in, so a hub, port or runtime type cannot ride in on an allowed specifier.
 */
const ALLOWED: Record<string, readonly string[]> = {
  "node:crypto": ["createHmac", "timingSafeEqual"],
  "node:http": ["createServer", "IncomingMessage", "Server", "ServerResponse"],
  "node:path": ["dirname", "join"],
  "../config.js": ["configPath"],
  "../event-log/ci-keys.js": ["ciEvent", "fromCheckRunDelivery", "fromStatusDelivery", "CiObservation"],
  "../event-log/event-log.js": ["appendEvent", "IdentityEvent", "TransitionEvent"],
  "../event-log/repo-keys.js": ["fromPullRequestDelivery", "fromPushDelivery", "fromReviewDelivery", "fromRulesetDelivery", "repoEvent", "RepoObservation"],
  "../github-sources/mode.js": ["SourcesReader"],
  "@titan-design/daemon": ["Logger", "TokenFileError", "parseBase64Secret", "trackSecretFile"],
  "@titan-design/store-sqlite": ["Db"],
};

const NAMED = /^\s*(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s*from\s*"([^"]+)";/gm;
const ANY_FROM = /\bfrom\s*["']/g;
const OTHER_FORMS = /\bimport\s*\(|\brequire\s*\(|^\s*import\s+["']/m;

/** Pure: every import in one source that the allowlist does not name, as `specifier: name`. */
function violations(source: string): string[] {
  const named = [...source.matchAll(NAMED)];
  const found = named.flatMap(([, names = "", specifier = ""]) => {
    if (specifier.startsWith("./")) return [];
    const allowed = ALLOWED[specifier] ?? [];
    return names
      .split(",")
      .map((name) => name.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0] ?? "")
      .filter((name) => name !== "" && !allowed.includes(name))
      .map((name) => `${specifier}: ${name}`);
  });
  const unparsed = (source.match(ANY_FROM)?.length ?? 0) !== named.length || OTHER_FORMS.test(source);
  return unparsed ? [...found, "an import form other than named braces"] : found;
}

const DIR = fileURLToPath(new URL(".", import.meta.url));
const sources = readdirSync(DIR).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));

describe("ingress parse-only imports", () => {
  it("imports only the pinned names from outside its own directory", () => {
    const found = sources.flatMap((name) => violations(readFileSync(join(DIR, name), "utf8")).map((line) => `${name} ${line}`));

    expect(found).toEqual([]);
  });

  it("scans the ingress core itself", () => {
    expect(sources).toEqual(expect.arrayContaining(["answer.ts", "listen.ts", "paths.ts", "secret.ts", "signature.ts"]));
  });

  // Mutation killed: a hub type imported from an allowed package so the ingress can broadcast.
  it("refuses a hub type from the daemon package, a namespace import and a dynamic import", () => {
    expect(violations('import type { EventHub } from "@titan-design/daemon";\nhub.broadcast("x");')).toEqual(["@titan-design/daemon: EventHub"]);
    expect(violations('import * as daemon from "@titan-design/daemon";')).toEqual(["an import form other than named braces"]);
    expect(violations('const m = await import("../workflows.js");')).toEqual(["an import form other than named braces"]);
    expect(violations('import { TokenFileError } from "@titan-design/daemon";\nimport { x } from "./paths.js";')).toEqual([]);
  });
});
