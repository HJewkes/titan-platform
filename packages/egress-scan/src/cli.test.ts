import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli, type CliIo } from "./cli.js";
import { makeTestRepo, plantedHomePath, tempDir, ZERO_SHA, type TestRepo } from "./test-repo.js";

const dirs: string[] = [];
const PLANTED_TERM = "zq-planted-" + "term";

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function newRepo(): TestRepo {
  const repo = makeTestRepo();
  dirs.push(repo.dir);
  return repo;
}

/** A home with no term file, so no test reads the machine's real one. */
function emptyHome(): string {
  const home = tempDir("egress-home-");
  dirs.push(home);
  return home;
}

function termFile(contents: string, mode = 0o600): string {
  const file = path.join(emptyHome(), "terms");
  fs.writeFileSync(file, contents, { mode });
  fs.chmodSync(file, mode);
  return file;
}

interface Run {
  code: number;
  out: string;
  err: string;
}

function run(repo: TestRepo, argv: string[], env: Record<string, string> = {}, stdin = ""): Run {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    cwd: repo.dir,
    env: { HOME: emptyHome(), ...env },
    readStdin: () => stdin,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  const code = runCli(argv, io);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

function commitFile(repo: TestRepo, file: string, contents: string): string {
  repo.write(file, contents);
  return repo.commit(`add ${file}`);
}

describe("range", () => {
  it("fails a planted path with file:line and the rule, never echoing it, and passes a clean commit", () => {
    const repo = newRepo();
    const base = repo.commit("base");
    const leak = commitFile(repo, "notes.md", `path ${plantedHomePath()}\n`);
    const clean = commitFile(repo, "clean.md", "nothing to see\n");

    const failing = run(repo, ["range", base, leak]);
    const passing = run(repo, ["range", leak, clean]);

    expect((failing.out + failing.err).includes(plantedHomePath())).toBe(false);
    expect(failing.code).toBe(1);
    expect(failing.out).toContain(`commit ${leak.slice(0, 7)} notes.md:1 home-path`);
    expect(passing.code).toBe(0);
  });

  it("exits 2 on a malformed .egress-allow instead of treating it as empty", () => {
    const repo = newRepo();
    const base = repo.commit("base");
    const leak = commitFile(repo, "notes.md", `path ${plantedHomePath()}\n`);
    repo.write(".egress-allow", "notes.md home-path no task id here\n");

    const result = run(repo, ["range", base, leak]);

    expect(result.code).toBe(2);
    expect(result.err).toContain(".egress-allow line 1");
  });

  it("honours a valid .egress-allow entry and counts it", () => {
    const repo = newRepo();
    const base = repo.commit("base");
    const leak = commitFile(repo, "docs/notes.md", `path ${plantedHomePath()}\n`);
    repo.write(".egress-allow", "docs/notes.md home-path fixture, TP-405\n");

    const result = run(repo, ["range", base, leak]);

    expect(result.code).toBe(0);
    expect(result.out).toContain("allowed: home-path 1");
  });
});

describe("private term list", () => {
  it("is never read in CI, even when TITAN_EGRESS_TERMS points at one", () => {
    const repo = newRepo();
    const base = repo.commit("base");
    const head = commitFile(repo, "a.md", `mentions ${PLANTED_TERM}\n`);

    const result = run(repo, ["range", base, head], { CI: "true", TITAN_EGRESS_TERMS: termFile(PLANTED_TERM) });

    expect(result.code).toBe(0);
    expect(result.out).toContain("private term list: not loaded");
  });

  it("prints a notice and continues when absent, and exits 2 when TITAN_EGRESS_REQUIRE_TERMS=1", () => {
    const repo = newRepo();
    const base = repo.commit("base");
    const head = commitFile(repo, "a.md", "clean\n");

    const lenient = run(repo, ["range", base, head]);
    const strict = run(repo, ["range", base, head], { TITAN_EGRESS_REQUIRE_TERMS: "1" });

    expect(lenient.code).toBe(0);
    expect(lenient.err).toContain("private term list not found; generic rules only");
    expect(strict.code).toBe(2);
  });

  it("loads the list under CI when TITAN_EGRESS_REQUIRE_TERMS=1, so a planted term fails the scan", () => {
    const repo = newRepo();
    const base = repo.commit("base");
    const head = commitFile(repo, "a.md", `mentions ${PLANTED_TERM}\n`);

    const result = run(repo, ["range", base, head], {
      CI: "true",
      TITAN_EGRESS_REQUIRE_TERMS: "1",
      TITAN_EGRESS_TERMS: termFile(PLANTED_TERM),
    });

    expect(result.code).toBe(1);
  });

  it("exits 2 naming the switch under CI when REQUIRE_TERMS=1 and no list exists", () => {
    const repo = newRepo();
    const base = repo.commit("base");
    const head = commitFile(repo, "a.md", "clean\n");

    const result = run(repo, ["range", base, head], { CI: "true", TITAN_EGRESS_REQUIRE_TERMS: "1" });

    expect(result.code).toBe(2);
    expect(result.err).toContain("TITAN_EGRESS_REQUIRE_TERMS");
  });

  it.each([["zero bytes", ""], ["only comments and blanks", "# nothing here\n\n   \n"]])(
    "exits 2 when REQUIRE_TERMS=1 and the list holds no terms (%s)",
    (_name, contents) => {
      const repo = newRepo();
      const base = repo.commit("base");
      const head = commitFile(repo, "a.md", "clean\n");

      const strict = run(repo, ["range", base, head], {
        TITAN_EGRESS_REQUIRE_TERMS: "1",
        TITAN_EGRESS_TERMS: termFile(contents),
      });
      const lenient = run(repo, ["range", base, head], { TITAN_EGRESS_TERMS: termFile(contents) });

      expect(strict.code).toBe(2);
      expect(strict.err).toContain("TITAN_EGRESS_REQUIRE_TERMS");
      expect(lenient.code).toBe(0);
    },
  );

  it("exits 2 when REQUIRE_TERMS=1 and the list cannot be read", () => {
    const repo = newRepo();
    const base = repo.commit("base");
    const head = commitFile(repo, "a.md", "clean\n");
    const unreadable = path.join(emptyHome(), "terms-dir");
    fs.mkdirSync(unreadable);

    const result = run(repo, ["range", base, head], {
      TITAN_EGRESS_REQUIRE_TERMS: "1",
      TITAN_EGRESS_TERMS: unreadable,
    });

    expect(result.code).toBe(2);
    expect(result.err).toContain("TITAN_EGRESS_REQUIRE_TERMS");
  });

  it.each(["1", "true", "TRUE", "yes", "on", " 1", "1 "])(
    "treats REQUIRE_TERMS=%j as on: exits 2 under CI with no list",
    (value) => {
      const repo = newRepo();
      const base = repo.commit("base");
      const head = commitFile(repo, "a.md", "clean\n");

      const result = run(repo, ["range", base, head], { CI: "true", TITAN_EGRESS_REQUIRE_TERMS: value });

      expect(result.code).toBe(2);
    },
  );

  it.each(["", "0", "false", "no", "off", "OFF"])("treats REQUIRE_TERMS=%j as off", (value) => {
    const repo = newRepo();
    const base = repo.commit("base");
    const head = commitFile(repo, "a.md", "clean\n");

    const result = run(repo, ["range", base, head], { CI: "true", TITAN_EGRESS_REQUIRE_TERMS: value });

    expect(result.code).toBe(0);
  });

  it.each(["2", "tru", "enabled", "y", "1;"])(
    "exits 2 on the unrecognised REQUIRE_TERMS value %j instead of reading it as off",
    (value) => {
      const repo = newRepo();
      const base = repo.commit("base");
      const head = commitFile(repo, "a.md", "clean\n");

      const result = run(repo, ["range", base, head], { CI: "true", TITAN_EGRESS_REQUIRE_TERMS: value });

      expect(result.code).toBe(2);
      expect(result.err).toContain("TITAN_EGRESS_REQUIRE_TERMS");
    },
  );

  it("flags a planted term by its line number without naming it", () => {
    const repo = newRepo();
    const base = repo.commit("base");
    const head = commitFile(repo, "a.md", `mentions ${PLANTED_TERM}\n`);

    const result = run(repo, ["range", base, head], { TITAN_EGRESS_TERMS: termFile(`# mine\n${PLANTED_TERM}\n`) });

    expect((result.out + result.err).includes(PLANTED_TERM)).toBe(false);
    expect(result.code).toBe(1);
    expect(result.out).toContain(`commit ${head.slice(0, 7)} a.md:1 private-term #2`);
  });

  it("is found under XDG_CONFIG_HOME when TITAN_EGRESS_TERMS is unset", () => {
    const repo = newRepo();
    const base = repo.commit("base");
    const head = commitFile(repo, "a.md", `mentions ${PLANTED_TERM}\n`);
    const configHome = emptyHome();
    fs.mkdirSync(path.join(configHome, "titan-egress"));
    fs.writeFileSync(path.join(configHome, "titan-egress", "private-terms"), PLANTED_TERM, { mode: 0o600 });

    const result = run(repo, ["range", base, head], { XDG_CONFIG_HOME: configHome });

    expect(result.out).toContain("private-term #1");
  });

  it.skipIf(process.platform === "win32")("warns but still loads a list readable by other users", () => {
    const repo = newRepo();
    const base = repo.commit("base");
    const head = commitFile(repo, "a.md", `mentions ${PLANTED_TERM}\n`);

    const result = run(repo, ["range", base, head], { TITAN_EGRESS_TERMS: termFile(PLANTED_TERM, 0o644) });

    expect(result.err).toContain("readable by other users");
    expect(result.code).toBe(1);
  });

  it("exits 2 on an invalid regex term, naming its line only", () => {
    const repo = newRepo();
    const head = repo.commit("base");

    const result = run(repo, ["range", ZERO_SHA, head], { TITAN_EGRESS_TERMS: termFile("re:zq[unclosed") });

    expect(result.code).toBe(2);
    expect(result.err).toContain("line 1");
    expect(result.err.includes("unclosed")).toBe(false);
  });
});

describe("pre-push and tree", () => {
  it("scans the commits named on git's pre-push stdin", () => {
    const repo = newRepo();
    const base = repo.commit("base");
    const leak = commitFile(repo, "notes.md", `path ${plantedHomePath()}\n`);
    const stdin = `refs/heads/main ${leak} refs/heads/main ${base}\n`;

    const result = run(repo, ["pre-push", "origin", "git@example.com:o/r.git"], {}, stdin);

    expect(result.code).toBe(1);
    expect(result.out).toContain(`commit ${leak.slice(0, 7)} notes.md:1 home-path`);
  });

  it("scans every tracked file at HEAD", () => {
    const repo = newRepo();
    commitFile(repo, "deep/notes.md", `one\npath ${plantedHomePath()}\n`);

    const result = run(repo, ["tree"]);

    expect(result.code).toBe(1);
    expect(result.out).toContain("deep/notes.md:2 home-path");
  });
});

describe("argument validation", () => {
  function outputTarget(): string {
    return path.join(emptyHome(), "leaked-output");
  }

  it("exits 2 and writes no file when a pre-push stdin sha begins with a dash", () => {
    const repo = newRepo();
    const base = repo.commit("base");
    const target = outputTarget();

    const result = run(repo, ["pre-push", "origin"], {}, `refs/heads/main --output=${target} refs/heads/main ${base}\n`);

    expect(result.code).toBe(2);
    expect(result.err).toContain("line 1: field 2 is not a full sha");
    expect(result.err.includes(target)).toBe(false);
    expect(fs.existsSync(target)).toBe(false);
  });

  it("exits 2 and writes no file when the range base is an --output option", () => {
    const repo = newRepo();
    const head = repo.commit("base");
    const target = outputTarget();

    const result = run(repo, ["range", `--output=${target}`, head]);

    expect(result.code).toBe(2);
    expect(result.err.includes(target)).toBe(false);
    expect(fs.existsSync(target)).toBe(false);
  });

  it("exits 2 naming the position when a range head begins with a dash after --", () => {
    const repo = newRepo();
    const base = repo.commit("base");

    const result = run(repo, ["range", "--", base, "-p"]);

    expect(result.code).toBe(2);
    expect(result.err).toContain("range: argument 2 is not a sha or ref name");
  });

  it("exits 2 when the pre-push remote name begins with a dash", () => {
    const repo = newRepo();
    const base = repo.commit("base");

    const result = run(repo, ["pre-push", "--", "--upload-pack=x"], {}, `refs/heads/main ${base} refs/heads/main ${ZERO_SHA}\n`);

    expect(result.code).toBe(2);
    expect(result.err).toContain("pre-push: argument 1 is not a remote name");
  });
});

describe("usage", () => {
  it.each([[[]], [["bogus"]], [["range", "only-one"]], [["tree", "extra"]], [["--nope"]]])(
    "exits 2 for %j",
    (argv) => {
      expect(run(newRepo(), argv).code).toBe(2);
    },
  );

  it.each([[["--help"]], [["-h", "range"]]])("prints usage and exits 0 for %j", (argv) => {
    const result = run(newRepo(), argv);

    expect(result.code).toBe(0);
    expect(result.out).toContain("usage: titan-egress-scan");
  });

  it("exits 2 instead of skipping the scan when a help flag follows the command", () => {
    const repo = newRepo();
    const head = repo.commit("base");

    const result = run(repo, ["range", "-h", head, head]);

    expect(result.code).toBe(2);
    expect(result.out).not.toContain("usage: titan-egress-scan");
  });
});
