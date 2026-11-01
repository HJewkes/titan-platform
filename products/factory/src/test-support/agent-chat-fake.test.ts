import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFakeRoster } from "./agent-chat-fake.js";

// Reads the roster the way the fake's `agent ls` does, and prints how many reads were not whole JSON.
const READER = `
const fs = require("fs"), file = process.argv[1], until = Date.now() + Number(process.argv[2]);
let torn = 0, reads = 0;
while (Date.now() < until) {
  try { JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { if (e.code !== "ENOENT") torn++; }
  reads++;
}
console.log(JSON.stringify({ torn, reads }));
`;

describe("the agent-chat fake roster", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ar-fake-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("is never half-written to a reader that polls while it is rewritten", async () => {
    const rows = [{ name: "a", filler: "x".repeat(1_000_000) }];
    writeFakeRoster(dir, rows);
    const reader = spawn(process.execPath, ["-e", READER, join(dir, "roster.json"), "1000"], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    reader.stdout.on("data", (chunk) => (out += chunk));
    const done = new Promise((resolve) => reader.on("close", resolve));

    const until = Date.now() + 1000;
    while (Date.now() < until) writeFakeRoster(dir, rows);
    await done;

    expect(JSON.parse(out)).toMatchObject({ torn: 0 });
  }, 20_000);
});
