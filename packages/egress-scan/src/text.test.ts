import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli, type CliIo } from "./cli.js";
import { plantedHomePath, tempDir } from "./test-repo.js";

const dirs: string[] = [];
const PLANTED_TERM = "zq-planted-" + "term";

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = tempDir("egress-text-");
  dirs.push(dir);
  return dir;
}

function termFile(): string {
  const file = path.join(scratch(), "terms");
  fs.writeFileSync(file, PLANTED_TERM + "\n", { mode: 0o600 });
  return file;
}

function runText(argv: string[], stdin: string, env: Record<string, string> = {}, maxPatchBytes?: number) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    cwd: scratch(),
    env: { HOME: scratch(), ...env },
    readStdin: () => stdin,
    readFile: (file) => fs.readFileSync(file, "utf-8"),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    maxPatchBytes,
  };
  const code = runCli(["text", ...argv], io);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("text", () => {
  it("exits 0 on a clean body", () => {
    const result = runText([], "Add a retry to the sync job\n\nNo leaks here.\n");

    expect(result.code).toBe(0);
    expect(result.out).toContain("egress-scan: 0 findings");
  });

  it("reports a home path as line:col and rule id without the matched text", () => {
    const result = runText([], `title\nsee ${plantedHomePath()} for details\n`);

    expect(result.code).toBe(1);
    expect(result.out).toContain("2:5 home-path");
    expect(result.out).not.toContain("zqplanted");
    expect(result.err).not.toContain("zqplanted");
  });

  it("reports a private term with its list line, never the term", () => {
    const result = runText([], `ok\nworking on ${PLANTED_TERM} now`, { TITAN_EGRESS_TERMS: termFile() });

    expect(result.code).toBe(1);
    expect(result.out).toContain("2:12 private-term #1");
    expect(result.out).not.toContain(PLANTED_TERM);
  });

  it("counts CRLF as one line break", () => {
    const result = runText([], `first\r\nsecond\r\nsee ${plantedHomePath()}\r\n`);

    expect(result.out).toContain("3:5 home-path");
  });

  it("reads --file instead of stdin", () => {
    const file = path.join(scratch(), "body.md");
    fs.writeFileSync(file, `${plantedHomePath()}\n`);

    const result = runText(["--file", file], "clean stdin");

    expect(result.code).toBe(1);
    expect(result.out).toContain("1:1 home-path");
  });

  it("exits 2 on an unreadable file without naming it", () => {
    const missing = path.join(scratch(), "zq-missing-file");

    const result = runText(["--file", missing], "");

    expect(result.code).toBe(2);
    expect(result.err).not.toContain("zq-missing-file");
  });

  it("exits 2 on input over the size limit", () => {
    const result = runText([], "a".repeat(11), {}, 10);

    expect(result.code).toBe(2);
    expect(result.err).toContain("over the scan limit");
  });

  it("exits 2 on a stray argument", () => {
    expect(runText(["body"], "").code).toBe(2);
  });
});
