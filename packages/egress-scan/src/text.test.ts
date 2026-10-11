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

const SECRET_MARKERS = ["zqplanted", PLANTED_TERM];

function expectNoMatchedText(result: { out: string; err: string }, extra: string[] = []): void {
  for (const marker of [...SECRET_MARKERS, ...extra]) {
    expect(result.out).not.toContain(marker);
    expect(result.err).not.toContain(marker);
  }
}

describe("text", () => {
  it("exits 0 on a clean body", () => {
    const result = runText([], "Add a retry to the sync job\n\nNo leaks here.\n");

    expect(result.code).toBe(0);
    expect(result.out).toContain("egress-scan: 0 findings");
    expectNoMatchedText(result);
  });

  it("exits 0 on empty input", () => {
    const result = runText([], "");

    expect(result.code).toBe(0);
    expect(result.out).toContain("egress-scan: 0 findings");
  });

  it("reports a home path in LF text as line:col and rule id only", () => {
    const result = runText([], `title\nsee ${plantedHomePath()} for details\n`);

    expect(result.code).toBe(1);
    expect(result.out).toContain("2:5 home-path");
    expectNoMatchedText(result);
  });

  it("reports a hit on the last line when there is no final newline", () => {
    const result = runText([], `title\nsee ${plantedHomePath()}`);

    expect(result.code).toBe(1);
    expect(result.out).toContain("2:5 home-path");
    expectNoMatchedText(result);
  });

  it("reports a private term with its list line, never the term", () => {
    const result = runText([], `ok\nworking on ${PLANTED_TERM} now`, { TITAN_EGRESS_TERMS: termFile() });

    expect(result.code).toBe(1);
    expect(result.out).toContain("2:12 private-term #1");
    expectNoMatchedText(result);
  });

  it("reports a credential token by kind, never its value", () => {
    const token = "ghp_" + "A".repeat(36);
    const result = runText([], `title\n\nuse ${token} to push`);

    expect(result.code).toBe(1);
    expect(result.out).toContain("3:5 credential-token github");
    expectNoMatchedText(result, [token, "A".repeat(8)]);
  });

  it("counts CRLF as one line break", () => {
    const result = runText([], `first\r\nsecond\r\nsee ${plantedHomePath()}\r\n`);

    expect(result.code).toBe(1);
    expect(result.out).toContain("3:5 home-path");
    expectNoMatchedText(result);
  });

  it("gives the same findings from --file as from stdin", () => {
    const body = `a\r\nsee ${plantedHomePath()}\nuse ${PLANTED_TERM}`;
    const file = path.join(scratch(), "body.md");
    fs.writeFileSync(file, body);
    const env = { TITAN_EGRESS_TERMS: termFile() };

    const viaFile = runText(["--file", file], "clean stdin", env);
    const viaStdin = runText([], body, env);

    expect(viaFile.code).toBe(1);
    expect(viaFile.out).toContain("2:5 home-path");
    expect(viaFile.out).toContain("3:5 private-term #1");
    expect(viaFile.out).toBe(viaStdin.out);
    expectNoMatchedText(viaFile);
    expectNoMatchedText(viaStdin);
  });

  it("exits 2 on an unreadable file without naming it", () => {
    const missing = path.join(scratch(), "zq-missing-file");

    const result = runText(["--file", missing], "");

    expect(result.code).toBe(2);
    expectNoMatchedText(result, ["zq-missing-file"]);
  });

  it("exits 2 on input over the size limit without echoing it", () => {
    const result = runText([], `${plantedHomePath()} `.repeat(3), {}, 10);

    expect(result.code).toBe(2);
    expect(result.err).toContain("over the scan limit");
    expectNoMatchedText(result);
  });

  it("exits 2 on a stray argument without echoing it", () => {
    const result = runText(["zq-stray-arg"], "");

    expect(result.code).toBe(2);
    expectNoMatchedText(result, ["zq-stray-arg"]);
  });

  it("exits 2 on an unknown option without echoing it", () => {
    const result = runText(["--zq-arg-secret"], "");

    expect(result.code).toBe(2);
    expectNoMatchedText(result, ["zq-arg-secret"]);
  });

  it("exits 2 when --file is given twice rather than scanning only the last", () => {
    const result = runText(["--file", "zq-first", "--file", "zq-second"], "");

    expect(result.code).toBe(2);
    expect(result.err).toContain("only once");
    expectNoMatchedText(result, ["zq-first", "zq-second"]);
  });
});
