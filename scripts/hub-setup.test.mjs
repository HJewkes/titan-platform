import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const hubDir = new URL("../deploy/hub/", import.meta.url).pathname;
const roots = [];

function hubCopy({ stamp }) {
  const root = mkdtempSync(join(tmpdir(), "hub-setup-"));
  roots.push(root);
  cpSync(join(hubDir, "scripts"), join(root, "scripts"), { recursive: true });
  cpSync(join(hubDir, "config"), join(root, "config"), { recursive: true });
  cpSync(join(hubDir, "appservices"), join(root, "appservices"), { recursive: true });
  mkdirSync(join(root, "data/db"), { recursive: true });
  writeFileSync(join(root, "data/db/CURRENT"), "x");
  writeFileSync(join(root, ".env"), "SERVER_NAME=new.example\n");
  if (stamp) writeFileSync(join(root, "data/server_name"), stamp);
  return root;
}

const runSetup = (root) => spawnSync("bash", [join(root, "scripts/setup.sh")], { encoding: "utf8" });

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("hub setup.sh", () => {
  it("refuses a non-empty data/db that has no server_name stamp", () => {
    const root = hubCopy({});
    const result = runSetup(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("data/server_name is missing");
  });

  it("refuses a stamp that differs from SERVER_NAME", () => {
    const root = hubCopy({ stamp: "old.example" });
    const result = runSetup(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("created for old.example, not new.example");
  });
});
