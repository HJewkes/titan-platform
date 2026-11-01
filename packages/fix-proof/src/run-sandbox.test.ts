import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { removeTemplates, templateDirectory } from "@titan-design/test-kit/git";
import { afterEach, describe, expect, it } from "vitest";
import type { Exec } from "./exec.js";
import { FIXED, makeRepo, REAL_TEST, removeRepos } from "./repo.test-helpers.js";
import { run } from "./run.js";
import { isSandboxed, sudoStub } from "./sandbox.test-helpers.js";

afterEach(removeRepos);

const ok = (file: string, args: string[]) => spawnSync(file, args, { stdio: "ignore" }).status === 0;
// sandboxCommand passes the user as setpriv's --regid too, so the user needs a same-named group: Debian's nobody has only nogroup.
const SYSTEM_USER = ["nobody", "daemon"].find((user) => ok("id", ["-u", user]) && ok("getent", ["group", user]));
const REAL_SANDBOX =
  process.platform === "linux" && SYSTEM_USER !== undefined && ok("sudo", ["-n", "true"]) && ok("sh", ["-c", "command -v unshare setpriv timeout"]);

// The dirs under tmp holding a judge.git: run()'s one snapshot dir while it runs.
function snapshotDirs(tmp: string): string[] {
  return fs.readdirSync(tmp).map((name) => path.join(tmp, name)).filter((dir) => fs.existsSync(path.join(dir, "judge.git")));
}

// Head-side code: tries to read and write judge.git in every snapshot dir it can name, then writes an empty vitest report.
function probe(tmp: string, leak: string): string {
  return `side=$(basename "$(pwd)")
id -u > "${leak}/$side-uid"
for d in "${tmp}"/fix-proof-reports-*; do
  echo "$d" >> "${leak}/$side-names"
  err=$(cat "$d/judge.git/HEAD" 2>&1 >/dev/null); echo "read $? $err" >> "${leak}/$side-tries"
  err=$(touch "$d/judge.git/x" 2>&1); echo "write $? $err" >> "${leak}/$side-tries"
done
while [ $# -gt 0 ] && [ "$1" != --outputFile ]; do shift; done
printf '{"testResults":[]}' > "$2"
`;
}

describe("run() with a sandbox user keeps head code away from judge.git", { timeout: 120_000 }, () => {
  let scratch = "";
  let tmp = "";
  const savedTmpdir = process.env.TMPDIR;

  function enterScratch(parent: string): void {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(parent, "fix-proof-sandbox-")));
    tmp = path.join(scratch, "tmp");
    fs.mkdirSync(tmp);
    process.env.TMPDIR = tmp;
  }

  afterEach(() => {
    if (savedTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmpdir;
    if (templateDirectory()?.startsWith(scratch)) removeTemplates();
    if (scratch !== "") fs.rmSync(scratch, { recursive: true, force: true });
    scratch = "";
  });

  it("run() sandboxes both sides, and judge.git's dir is runner-owned 0700 and never chowned", async () => {
    enterScratch(os.tmpdir());
    const repo = makeRepo({}, scratch);
    const head = repo.commit({ "src/math.ts": FIXED, "src/math.test.ts": REAL_TEST });
    const stub = sudoStub();
    const sandboxedIn = new Set<string>();
    let seen: { dir: string; stat: fs.Stats }[] = [];
    const exec: Exec = (file, args, options) => {
      if (isSandboxed({ file, args })) sandboxedIn.add(path.basename(options.cwd));
      if (seen.length === 0 && sandboxedIn.has("head")) seen = snapshotDirs(tmp).map((dir) => ({ dir, stat: fs.lstatSync(dir) }));
      return stub.exec(file, args, options);
    };

    await run({ repo: repo.dir, base: repo.base, head, exec, sandboxUser: "fix-proof-sandbox" });

    expect([...sandboxedIn].sort()).toEqual(["base", "head"]);
    expect(seen).toHaveLength(1);
    const [{ dir, stat }] = seen as [{ dir: string; stat: fs.Stats }];
    expect(stat.mode & 0o077).toBe(0);
    expect(stat.uid).toBe(process.getuid?.());
    const sudoArgs = stub.calls.filter((call) => call.file === "sudo").flatMap((call) => call.args);
    expect(sudoArgs.filter((arg) => arg.includes(dir))).toEqual([]);
  });

  describe.skipIf(!REAL_SANDBOX)("as a real second uid", () => {
    it(`head-side code running as ${SYSTEM_USER} cannot read or write judge.git`, async () => {
      // The sandbox user must traverse down to the trees, and this run's temp root may sit under a private home.
      enterScratch("/tmp");
      fs.chmodSync(scratch, 0o711);
      const leak = path.join(scratch, "leak");
      fs.mkdirSync(leak);
      fs.chmodSync(leak, 0o1777);
      const repo = makeRepo({ command: "sh probe.sh", build: "true" }, scratch, { "probe.sh": probe(tmp, leak) });
      const head = repo.commit({ "src/math.ts": FIXED, "src/math.test.ts": REAL_TEST });

      await run({ repo: repo.dir, base: repo.base, head, sandboxUser: SYSTEM_USER });

      const read = (name: string) => fs.readFileSync(path.join(leak, name), "utf-8").trim();
      expect(read("head-uid")).not.toBe(String(process.getuid?.()));
      expect(read("head-names")).toMatch(/fix-proof-reports-/);
      const tries = read("head-tries").split("\n");
      expect(tries).toEqual([expect.stringMatching(/^read [1-9]\d* .*Permission denied/), expect.stringMatching(/^write [1-9]\d* .*Permission denied/)]);
    });
  });
});
