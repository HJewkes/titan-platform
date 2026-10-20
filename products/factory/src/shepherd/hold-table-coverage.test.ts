import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fakeGitHub, fakeSha, githubPort } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import { g10HoldAt } from "./registration-hold.js";

const SHEPHERD_DIR = fileURLToPath(new URL(".", import.meta.url));
/** A module that reads the G10 hold, the sign-off rule or the hold table can lift a hold by changing what it reads. */
const POLICY_IMPORT = /["']\.\/(?:g10-release|signoffs|registration-hold)\.js["']/;

const policyImporters = (): string[] =>
  readdirSync(SHEPHERD_DIR)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .filter((name) => POLICY_IMPORT.test(readFileSync(`${SHEPHERD_DIR}${name}`, "utf8")));

async function holdFor(path: string): Promise<string | undefined> {
  const fake = fakeGitHub({ repo: "octo/demo" });
  const { number: pr } = fake.addPr({ headSha: fakeSha("head-1") });
  fake.prFiles.set(pr, [{ path, status: "modified", additions: 1, deletions: 1 }]);
  return g10HoldAt(githubPort(fake.wire), { repo: "octo/demo", pr });
}

describe("the G10 hold table", () => {
  it("finds the modules that import Shepherd's hold policy", () => {
    expect(policyImporters()).toEqual(expect.arrayContaining(["registration-hold.ts", "spawn-facts.ts", "review.ts"]));
  });

  it("holds every Shepherd module that imports g10-release, signoffs or registration-hold", async () => {
    const unheld: string[] = [];
    for (const name of policyImporters()) {
      const reason = await holdFor(`products/factory/src/shepherd/${name}`);
      if (!reason?.startsWith("g10-adversary:")) unheld.push(name);
    }

    expect(unheld).toEqual([]);
  });
});
