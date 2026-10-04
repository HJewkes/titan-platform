import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildHelper } from "./factory-build-helper.mjs";

const roots = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function checkout() {
  const root = mkdtempSync(join(tmpdir(), "factory-build-helper-"));
  roots.push(root);
  return root;
}

describe("factory-build-helper", () => {
  it("compiles the helper into native/build, outside the dist that tsup cleans", () => {
    const root = checkout();
    const calls = [];

    const result = buildHelper({ platform: "darwin", root, run: (file, args) => calls.push([file, args]) });

    const out = join(root, "products", "factory", "native", "build", "owner-presence");
    expect(result).toEqual({ status: "built", out });
    expect(calls).toEqual([["/usr/bin/swiftc", ["-O", join(root, "products", "factory", "native", "owner-presence.swift"), "-o", out]]]);
  });

  it("skips the build off macOS", () => {
    const calls = [];

    expect(buildHelper({ platform: "linux", root: checkout(), run: (...args) => calls.push(args) })).toEqual({ status: "skipped" });
    expect(calls).toEqual([]);
  });
});
