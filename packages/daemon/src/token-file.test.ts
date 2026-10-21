import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SecretRejection, TokenFileError, trackSecretFile } from "./token-file.js";

const FIXTURE = `ghp_${"a1B2".repeat(9)}`;
const parseFixture = (raw: string): string => {
  const text = raw.replace(/\n$/, "");
  if (!/^ghp_[A-Za-z0-9]{36}$/.test(text)) throw new Error(`bad ${text}`);
  return text;
};

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(tmpdir(), "secret-file-"));
  file = path.join(dir, "bot.secret");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function write(content: string, mode = 0o600): void {
  fs.writeFileSync(file, content, { mode });
  fs.chmodSync(file, mode);
}

function refusal(fn: () => unknown): TokenFileError {
  try {
    fn();
  } catch (err) {
    if (err instanceof TokenFileError) return err;
    throw err;
  }
  throw new Error("expected a refusal");
}

describe("trackSecretFile", () => {
  it("returns a secret the caller's parser accepts", () => {
    write(`${FIXTURE}\n`);
    expect(trackSecretFile(file, parseFixture)()).toBe(FIXTURE);
  });

  it("re-reads and re-parses after the file is replaced", () => {
    write(FIXTURE);
    const read = trackSecretFile(file, parseFixture);
    const next = `ghp_${"z9Y8".repeat(9)}`;
    fs.rmSync(file);
    write(next);
    expect(read()).toBe(next);
  });

  it("refuses a symlink", () => {
    write(FIXTURE);
    const link = path.join(dir, "link");
    fs.symlinkSync(file, link);
    expect(refusal(() => trackSecretFile(link, parseFixture)).problem).toBe("symlink");
  });

  it("refuses a directory as not regular", () => {
    expect(refusal(() => trackSecretFile(dir, parseFixture)).problem).toBe("not-regular");
  });

  it("refuses a file owned by another uid", () => {
    write(FIXTURE);
    const real = process.getuid;
    Object.defineProperty(process, "getuid", { value: () => (real?.() ?? 0) + 1, configurable: true });
    try {
      expect(refusal(() => trackSecretFile(file, parseFixture)).problem).toBe("owner");
    } finally {
      Object.defineProperty(process, "getuid", { value: real, configurable: true });
    }
  });

  it.each([0o640, 0o604, 0o644])("refuses mode %o", (mode) => {
    write(FIXTURE, mode);
    expect(refusal(() => trackSecretFile(file, parseFixture)).problem).toBe("mode");
  });

  it("maps a parser throw to malformed without echoing the text", () => {
    write(`${FIXTURE}x`);
    const err = refusal(() => trackSecretFile(file, parseFixture));
    expect(err.problem).toBe("malformed");
    expect(err.message).not.toContain(FIXTURE);
  });

  it("honours the problem a SecretRejection names", () => {
    write(FIXTURE);
    const parse = (): string => {
      throw new SecretRejection("short", "too short");
    };
    expect(refusal(() => trackSecretFile(file, parse)).problem).toBe("short");
  });
});
