import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hostIsExecutable, resolveCommand } from "./command-path.js";

const onPath = (...files: string[]) => (file: string) => files.includes(file);

describe("resolveCommand", () => {
  it("takes the first PATH entry that holds an executable of that name", () => {
    const pathVar = ["/opt/a/bin", "/opt/b/bin", "/opt/c/bin"].join(path.delimiter);

    expect(resolveCommand("tool", pathVar, onPath("/opt/b/bin/tool", "/opt/c/bin/tool"))).toBe("/opt/b/bin/tool");
  });

  it("finds nothing on an empty or unset PATH", () => {
    expect(resolveCommand("tool", undefined, () => true)).toBeNull();
    expect(resolveCommand("tool", "", () => true)).toBeNull();
  });

  it("skips relative PATH entries, which would resolve against the start directory", () => {
    const pathVar = ["bin", ".", "/opt/b/bin"].join(path.delimiter);

    expect(resolveCommand("tool", pathVar, (file) => file !== "/opt/b/bin/tool")).toBeNull();
  });

  it("returns a value with a separator unchanged, absolute or not", () => {
    expect(resolveCommand("/opt/a/bin/tool", "/opt/b/bin", () => false)).toBe("/opt/a/bin/tool");
    expect(resolveCommand("bin/tool", "/opt/b/bin", () => true)).toBe("bin/tool");
  });
});

describe("hostIsExecutable", () => {
  let dir = "";
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("accepts an executable file and refuses a plain file, a directory and a missing path", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "command-path-"));
    const tool = path.join(dir, "tool");
    const plain = path.join(dir, "plain");
    writeFileSync(tool, "#!/bin/sh\n");
    chmodSync(tool, 0o755);
    writeFileSync(plain, "");
    chmodSync(plain, 0o644);
    mkdirSync(path.join(dir, "sub"), { mode: 0o755 });

    expect([tool, plain, path.join(dir, "sub"), path.join(dir, "missing")].map(hostIsExecutable)).toEqual([true, false, false, false]);
  });
});
