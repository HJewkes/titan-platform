import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { IdeaSchema, type Idea, type RoundRecord } from "@titan-design/autoresearch";
import { afterEach, describe, expect, it } from "vitest";
import { evaluatorPorts } from "./evaluator.js";
import { execGit } from "./ratchet.js";

const IDENTITY = ["-c", "user.name=evaluator fixture", "-c", "user.email=fixture@example.invalid"];
const git = (cwd: string, ...args: string[]) => execGit([...IDENTITY, ...args], cwd);
const signal = new AbortController().signal;

const TARGET = {
  schema: "ar-target/v1",
  ratchetPrefix: "autoresearch/fixture",
  frozen: ["ar/**"],
  caseSets: { "t-alpha": "suite-a" },
  unitTests: ["sh", "-c", "test ! -e unit-fails"],
  testProof: ["sh", "ar/proof.sh", "{base}", "{head}"],
  microRung: { "accept-gate": "L1-replay" },
  rungs: {
    seed: { cmd: ["sh", "ar/eval.sh", "{caseSet}", "{case}", "{key}", "{runnerRoot}"], maxUsd: 1, timeoutMin: 1 },
    "L1-replay": { cmd: ["sh", "ar/micro.sh", "{runnerRoot}", "{baselineDir}", "{microSignal}"] },
  },
  metric: { primary: { name: "score", direction: "min" }, noise: {} },
  phases: [{ id: "p1", train: ["t-alpha"], stop: { ideasEvaluated: 1, roundsWithoutGain: 1 } }],
};

const BOUNDS = {
  schema: "ar-bounds/v1",
  classes: {
    "accept-gate": { paths: ["src/gate/*.py"], tests: ["tests/test_gate*.py"] },
    "config-param": { paths: ["src/config.json"], params: { hot_cc: [6, 15] }, integerParams: ["hot_cc"] },
  },
  test: { required: true, mustFailOnBase: true, exceptClasses: ["config-param"] },
  banned: { frozenTouch: true, literalsOutsideConfig: true, newFiles: true },
};

/** The fixture target's adapter: an eval that can rewrite and commit its own scorer, a micro that records its argv, a proof that leaves a marker. */
const ADAPTER = {
  "ar/eval.sh": [
    'mkdir -p "$4/.artifacts/$3"',
    'if [ -e "$4/drift" ]; then echo "# edited" >> ar/score.py; git -c user.name=x -c user.email=x@example.invalid commit -qam drift; fi',
    'printf \'{"schema":"ar-result/v2","case":"%s","repeat":"%s","metrics":{"score":1},"usd":0.5,"wall_s":0,"artifact_dir":"%s"}\\n\' "$2" "$3" "$4/.artifacts/$3"',
  ].join("\n"),
  "ar/micro.sh": ['mkdir -p "$1/.artifacts"', 'printf "%s\\n" "$@" > "$1/.artifacts/micro.argv"', 'printf \'{"schema":"ar-micro/v1","rung":"L1-replay","predicted_direction_met":true,"usd":0.1,"signal":"%s"}\\n\' "$3"'].join("\n"),
  "ar/proof.sh": ["mkdir -p .artifacts", 'echo "$1 $2" > .artifacts/proof-ran', "test ! -e proof-fails"].join("\n"),
  "ar/score.py": "def score(run):\n    return 0\n",
};

const SEED = {
  ".gitignore": ".artifacts/\n",
  "src/gate/gates.py": "def accept(task):\n    return True\n",
  "src/config.json": '{\n  "hot_cc": 10\n}\n',
  "tests/test_gate.py": "def test_accept():\n    assert True\n",
};

function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

/** A bare `origin`, a clone of it for the evaluator, and the adapter at the pin. */
async function fixture(bounds: object = BOUNDS) {
  const root = mkdtempSync(join(tmpdir(), "ar-evaluator-"));
  roots.push(root);
  const [seed, bare, clone] = [join(root, "seed"), join(root, "origin.git"), join(root, "clone")];
  mkdirSync(seed);
  await git(seed, "init", "--quiet", "-b", "main");
  writeFiles(seed, { ...SEED, ...ADAPTER, "ar/target.json": JSON.stringify(TARGET), "ar/bounds.json": JSON.stringify(bounds) });
  await git(seed, "add", "--all");
  await git(seed, "commit", "--quiet", "-m", "fixture");
  await git(root, "clone", "--quiet", "--bare", seed, bare);
  await git(root, "clone", "--quiet", bare, clone);
  const ports = evaluatorPorts({ clone, workRoot: join(root, "work"), archiveDir: join(root, "archive"), adapterDir: "ar", caseNames: ["t-alpha"] });
  return { root, bare, clone, ports, pin: await git(clone, "rev-parse", "HEAD") };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** An idea's tree at the pin with `files` committed on top. */
async function ideaTree(repo: Fixture, name: string, files: Record<string, string>) {
  const tree = join(repo.root, "trees", name);
  await git(repo.clone, "worktree", "add", "--quiet", "--detach", tree, repo.pin);
  writeFiles(tree, files);
  await git(tree, "add", "--all");
  await git(tree, "commit", "--quiet", "-m", name);
  return { tree, base: repo.pin, head: await git(tree, "rev-parse", "HEAD") };
}

const idea = (cls: string): Idea =>
  IdeaSchema.parse({
    id: `i-${cls}`, lineage: "l-1", cell: `${cls}:fixture`, round: 1, hypothesis: "h", mechanism: "m", class: cls, direction: "d",
    targets: [], expectedEffect: { metric: "score", direction: "down", microSignal: "accepts" }, testPlan: "t", bold: false,
  });

const GATE_EDIT = { "src/gate/gates.py": "def accept(task):\n    return False\n", "tests/test_gate.py": "def test_accept():\n    assert False\n" };

describe("evaluator pin", () => {
  it("checks out the evaluator at the pin, hashes its frozen files and points the ratchet ref at the pin", async () => {
    const repo = await fixture();

    const pinned = await repo.ports.pin({ runId: "run-1", pin: "main" }, signal);

    expect(pinned).toMatchObject({ pin: repo.pin, ratchetHead: repo.pin, ratchetRef: "refs/heads/autoresearch/fixture/run-1" });
    expect(pinned.frozenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(pinned.targetSha).toBe(await git(repo.clone, "rev-parse", `${repo.pin}:ar/target.json`));
    expect(await git(repo.bare, "rev-parse", pinned.ratchetRef)).toBe(repo.pin);
  });

  it("refuses a glob class that reaches a frozen file, found only by listing the pin's files", async () => {
    const repo = await fixture({ ...BOUNDS, classes: { ...BOUNDS.classes, scorer: { paths: ["ar/*.py"], tests: [] } } });

    await expect(repo.ports.pin({ runId: "run-1", pin: "main" }, signal)).rejects.toThrow("[bounds-frozen] ar/*.py");
  });
});

describe("evaluator eval and micro", () => {
  it("runs the seed rung from the evaluator checkout with the idea's tree as the runner root", async () => {
    const repo = await fixture();
    await repo.ports.pin({ runId: "run-1", pin: "main" }, signal);
    const { tree } = await ideaTree(repo, "plain", GATE_EDIT);

    const result = await repo.ports.evalCase({ tree, case: "t-alpha", key: "run-1-a-r1", rung: "seed" }, signal);

    expect(result).toMatchObject({ case: "t-alpha", repeat: "run-1-a-r1", usd: 0.5, artifact_dir: join(tree, ".artifacts", "run-1-a-r1") });
  });

  it("fails an eval whose run rewrites and commits a frozen file", async () => {
    const repo = await fixture();
    await repo.ports.pin({ runId: "run-1", pin: "main" }, signal);
    const { tree } = await ideaTree(repo, "drifts", GATE_EDIT);
    writeFileSync(join(tree, "drift"), "");

    await expect(repo.ports.evalCase({ tree, case: "t-alpha", key: "k1", rung: "seed" }, signal)).rejects.toThrow("[frozen-drift]");
  });

  it("refuses to run an eval in a dirty evaluator checkout", async () => {
    const repo = await fixture();
    const pinned = await repo.ports.pin({ runId: "run-1", pin: "main" }, signal);
    const { tree } = await ideaTree(repo, "dirty", GATE_EDIT);
    writeFileSync(join(pinned.evaluatorTree!, "stray.txt"), "left by someone\n");

    await expect(repo.ports.evalCase({ tree, case: "t-alpha", key: "k1", rung: "seed" }, signal)).rejects.toThrow("[evaluator-dirty]");
    expect(existsSync(join(tree, ".artifacts", "k1"))).toBe(false);
  });

  it("hands the micro rung the best's baseline dir and the signal in the template's argv order", async () => {
    const repo = await fixture();
    await repo.ports.pin({ runId: "run-1", pin: "main" }, signal);
    const { tree } = await ideaTree(repo, "micro", GATE_EDIT);

    const micro = await repo.ports.micro({ idea: idea("accept-gate"), tree, rung: "L1-replay", case: "t-alpha", baselineDir: "/runs/best", microSignal: "accepts:down", microArgs: {}, key: "k-m1" }, signal);

    expect(micro).toMatchObject({ rung: "L1-replay", signal: "accepts:down" });
    expect(readFileSync(join(tree, ".artifacts", "micro.argv"), "utf8").split("\n").slice(0, 3)).toEqual([tree, "/runs/best", "accepts:down"]);
  });
});

describe("evaluator L0", () => {
  it("runs the test proof for a class that needs a test and skips it for an excepted class", async () => {
    const repo = await fixture();
    await repo.ports.pin({ runId: "run-1", pin: "main" }, signal);
    const gate = await ideaTree(repo, "gate", GATE_EDIT);
    const config = await ideaTree(repo, "config", { "src/config.json": '{\n  "hot_cc": 12\n}\n' });

    const gateL0 = await repo.ports.staticCheck({ idea: idea("accept-gate"), ...gate }, signal);
    const configL0 = await repo.ports.staticCheck({ idea: idea("config-param"), ...config }, signal);

    expect(gateL0.ok).toBe(true);
    expect(readFileSync(join(gate.tree, ".artifacts", "proof-ran"), "utf8").trim()).toBe(`${gate.base} ${gate.head}`);
    expect(configL0.ok).toBe(true);
    expect(configL0.checks!.map((row) => row.name)).not.toContain("test-proof");
    expect(existsSync(join(config.tree, ".artifacts", "proof-ran"))).toBe(false);
  });

  it("times every row and names the first failure when the unit suite and the proof both fail", async () => {
    const repo = await fixture();
    await repo.ports.pin({ runId: "run-1", pin: "main" }, signal);
    const gate = await ideaTree(repo, "failing", GATE_EDIT);
    writeFiles(gate.tree, { "unit-fails": "", "proof-fails": "" });

    const l0 = await repo.ports.staticCheck({ idea: idea("accept-gate"), ...gate }, signal);

    expect(l0).toMatchObject({ ok: false, code: "unit-suite" });
    expect(l0.checks!.filter((row) => !row.ok).map((row) => row.name)).toEqual(["unit-suite", "test-proof"]);
    expect(l0.checks!.every((row) => typeof row.ms === "number" && row.ms >= 0)).toBe(true);
  });

  it("reads the params file at base and head and refuses an out-of-range value", async () => {
    const repo = await fixture();
    await repo.ports.pin({ runId: "run-1", pin: "main" }, signal);
    const config = await ideaTree(repo, "config-high", { "src/config.json": '{\n  "hot_cc": 20\n}\n' });

    const l0 = await repo.ports.staticCheck({ idea: idea("config-param"), ...config }, signal);

    expect(l0).toMatchObject({ ok: false, code: "param-out-of-range", diff: { files: 1 } });
  });
});

describe("evaluator ratchet and archive", () => {
  it("refuses a ratchet ref outside the target's prefix and leaves the remote alone", async () => {
    const repo = await fixture();
    const pinned = await repo.ports.pin({ runId: "run-1", pin: "main" }, signal);
    const winner = await ideaTree(repo, "winner", GATE_EDIT);
    const move = { tree: pinned.integrationTree, ratchetRef: "refs/heads/main", ratchetPrefix: "autoresearch/fixture", from: repo.pin, to: winner.head };
    const record = { round: 1, ideaId: "i-1", kind: "ff" as const, keepRung: "L3", delta: 1, sigma: 0.1, runDigests: [], pin: repo.pin };

    await expect(repo.ports.ratchet({ ...move, ...record }, signal)).rejects.toThrow("[ratchet-ref]");
    expect(await git(repo.bare, "rev-parse", "refs/heads/main")).toBe(repo.pin);
  });

  it("judges the ref by the pinned target's prefix, not a prefix the request names", async () => {
    const repo = await fixture();
    const pinned = await repo.ports.pin({ runId: "run-1", pin: "main" }, signal);
    const winner = await ideaTree(repo, "winner", GATE_EDIT);
    await git(pinned.integrationTree, "push", "--quiet", "origin", `${repo.pin}:refs/heads/other/run-1`);
    const move = { tree: pinned.integrationTree, ratchetRef: "refs/heads/other/run-1", ratchetPrefix: "other", from: repo.pin, to: winner.head };
    const record = { round: 1, ideaId: "i-1", kind: "ff" as const, keepRung: "L3", delta: 1, sigma: 0.1, runDigests: [], pin: repo.pin };

    await expect(repo.ports.ratchet({ ...move, ...record }, signal)).rejects.toThrow("[ratchet-ref]");
    expect(await git(repo.bare, "rev-parse", "refs/heads/other/run-1")).toBe(repo.pin);
  });

  it("writes the round's tgz with its record and artifacts, and a SHA256SUMS line that verifies", async () => {
    const repo = await fixture();
    const artifacts = join(repo.root, "artifacts", "run-1-a-r1");
    writeFiles(artifacts, { "lanes.json": "[]\n" });
    const run = { schema: "ar-result/v2", case: "t-alpha", repeat: "r1", metrics: {}, gates: {}, violations: {}, usd: 0, wall_s: 0, artifact_dir: artifacts } as const;
    const outcome = { ideaId: "i-1", lineage: "l", cell: "c", verdict: "kept", reason: "ok", rungReached: "L3", runs: [run] } as const;
    const record = { outcomes: [outcome], digest: {}, ops: {}, draws: [], registries: {}, evidence: [] } as unknown as RoundRecord;

    const archived = await repo.ports.archive!({ runId: "run-1", round: 2, record }, signal);

    const sum = createHash("sha256").update(readFileSync(archived.path!)).digest("hex");
    expect(archived.sha256).toBe(sum);
    expect(readFileSync(join(repo.root, "archive", "run-1", "SHA256SUMS"), "utf8")).toBe(`${sum}  round-2.tgz\n`);
    const listed = execFileSync("tar", ["-tzf", archived.path!], { encoding: "utf8" });
    expect(listed).toContain("./record.json");
    expect(listed).toContain("./artifacts/0-run-1-a-r1/lanes.json");
  });
});
