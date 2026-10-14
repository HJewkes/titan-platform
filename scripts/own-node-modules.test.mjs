import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { strayDependency } from "./own-node-modules.mjs";

function writePackage(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), '{"name":"fake"}');
}

describe("a checkout's own node_modules", () => {
  let parent;
  let child;
  beforeEach(() => {
    parent = realpathSync(mkdtempSync(path.join(tmpdir(), "own-node-modules-")));
    child = path.join(parent, "child");
    writePackage(child);
  });
  afterEach(() => {
    rmSync(parent, { recursive: true, force: true });
  });

  it("flags a package that only an ancestor checkout has installed", () => {
    writePackage(path.join(parent, "node_modules", "fake"));

    const message = strayDependency(child, "fake");

    expect(message).toContain(path.join(parent, "node_modules", "fake"));
    expect(message).toContain("pnpm install --frozen-lockfile");
  });

  it("accepts a package installed in the checkout itself", () => {
    writePackage(path.join(parent, "node_modules", "fake"));
    writePackage(path.join(child, "node_modules", "fake"));

    expect(strayDependency(child, "fake")).toBeNull();
  });

  it("accepts pnpm's symlink into the checkout's own .pnpm store", () => {
    const stored = path.join(child, "node_modules", ".pnpm", "fake@1.0.0", "node_modules", "fake");
    writePackage(stored);
    symlinkSync(stored, path.join(child, "node_modules", "fake"), "dir");

    expect(strayDependency(child, "fake")).toBeNull();
  });

  it("flags a checkout whose package is a link into an ancestor's node_modules", () => {
    const ancestors = path.join(parent, "node_modules", "fake");
    writePackage(ancestors);
    mkdirSync(path.join(child, "node_modules"));
    symlinkSync(ancestors, path.join(child, "node_modules", "fake"), "dir");

    expect(strayDependency(child, "fake")).toContain(ancestors);
  });

  it("reports a package nothing has installed", () => {
    expect(strayDependency(child, "fake-not-anywhere-tp-2781")).toContain("is not installed");
  });
});
