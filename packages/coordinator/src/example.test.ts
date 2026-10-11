import { readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTerms, scanText } from "@titan-design/egress-scan";
import { describe, expect, it } from "vitest";
import { checkCoordinatorConfig } from "./coordinator-config.js";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const examplePath = join(packageDir, "examples", "single-seat.json");
const exampleText = readFileSync(examplePath, "utf8");

// Owner data is supplied at runtime so no literal of it lives in the repo: the account and
// home-directory names of whoever runs the test, plus the owner's private term list
// (usernames, seat names) when $TITAN_EGRESS_TERMS or the default list exists.
function ownerDenylist(): string {
  const home = homedir();
  const lines = [userInfo().username, basename(home), home, "/Users/", "/home/"];
  const termFile = process.env.TITAN_EGRESS_TERMS ?? join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "titan-egress", "private-terms");
  try {
    lines.push(readFileSync(termFile, "utf8"));
  } catch {
    // No private list on this machine, such as CI: the runtime names above still apply.
  }
  return lines.filter((line) => line.trim() !== "").join("\n");
}

const terms = parseTerms(ownerDenylist());

describe("single-seat example", () => {
  it("passes checkCoordinatorConfig", () => {
    const result = checkCoordinatorConfig(JSON.parse(exampleText));

    expect(result).toMatchObject({ ok: true });
  });

  it("describes one attended operator seat, one repo and one pool", () => {
    const config = JSON.parse(exampleText);

    expect(Object.keys(config.seats)).toEqual(["operator"]);
    expect(Object.keys(config.repos)).toHaveLength(1);
    expect(Object.keys(config.limits.pools)).toHaveLength(1);
  });

  it("carries no owner data", () => {
    expect(scanText(exampleText, { terms })).toEqual([]);
  });

  it("is caught when it names a home directory", () => {
    const leaked = exampleText.replace("~/src/app", `${homedir()}/src/app`);

    expect(scanText(leaked, { terms }).length).toBeGreaterThan(0);
  });

  it("ships in the published files", () => {
    const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));

    expect(pkg.files).toContain("examples");
  });
});
