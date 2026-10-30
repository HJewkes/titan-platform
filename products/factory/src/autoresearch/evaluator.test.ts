import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { IdeaSchema, OutcomeSchema, type Idea, type RoundRecord } from "@titan-design/autoresearch";
import { partialFake } from "@titan-design/test-kit";
import { seedRepoWithOrigin } from "@titan-design/test-kit/git";
import { afterEach, describe, expect, it } from "vitest";
import { evaluatorPorts, type EvaluatorOptions } from "./evaluator.js";
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
    slow: { cmd: ["sh", "-c", 'echo $$ > "$0/slow.pid"; exec sleep 600', "{runnerRoot}"], timeoutMin: 0.005 },
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
    'git -C "$4" rev-parse HEAD > "$4/.artifacts/$3/head"',
    'if [ -e "$4/drift" ]; then echo "# edited" >> ar/score.py; git -c user.name=x -c user.email=x@example.invalid commit -qam drift; fi',
    'printf \'{"schema":"ar-result/v2","case":"%s","repeat":"%s","metrics":{"score":1},"usd":0.5,"wall_s":0,"artifact_dir":"%s"}\\n\' "$2" "$3" "$4/.artifacts/$3"',
  ].join("\n"),
  "ar/micro.sh": ['mkdir -p "$1/.artifacts"', 'printf "%s\\n" "$@" > "$1/.artifacts/micro.argv"', 'printf \'{"schema":"ar-micro/v1","rung":"L1-replay","predicted_direction_met":true,"usd":0.1,"signal":"%s"}\\n\' "$3"'].join("\n"),
  "ar/proof.sh": ["mkdir -p .artifacts", 'echo "$1 $2" > .artifacts/proof-ran', 'if [ -e move-head ]; then git checkout --quiet --detach "$1"; fi', "test ! -e proof-fails"].join("\n"),
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

/** A bare `origin`, a checkout of it for the evaluator, and the adapter at the pin. */
async function fixture(bounds: object = BOUNDS, host: Partial<EvaluatorOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), "ar-evaluator-"));
  roots.push(root);
  const [bare, clone] = [join(root, "origin.git"), join(root, "clone")];
  seedRepoWithOrigin(clone, bare, { ...SEED, ...ADAPTER, "ar/target.json": JSON.stringify(TARGET), "ar/bounds.json": JSON.stringify(bounds) });
  const options = { clone, workRoot: join(root, "work"), archiveDir: join(root, "archive"), adapterDir: "ar", caseNames: ["t-alpha"], ...host };
  const pin = await git(clone, "rev-parse", "HEAD");
  /** A second host over the same clone and work root, as the factory is after a restart. */
  const restarted = () => evaluatorPorts(options);
  return { root, bare, clone, ports: evaluatorPorts(options), restarted, pin, run: { runId: "run-1", pin } };
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

  it("refuses a pin that is not on the remote's main, before any checkout or ratchet exists", async () => {
    const repo = await fixture();
    await git(repo.clone, "switch", "--quiet", "-c", "side");
    await git(repo.clone, "commit", "--quiet", "--allow-empty", "-m", "side");
    await git(repo.clone, "push", "--quiet", "origin", "side");

    await expect(repo.ports.pin({ runId: "run-1", pin: "side" }, signal)).rejects.toThrow("[pin-not-on-main]");
    expect(existsSync(join(repo.root, "work", "eval-run-1"))).toBe(false);
    expect(await git(repo.bare, "for-each-ref", "refs/heads/autoresearch")).toBe("");
  });

  it("pins again after a restart without moving the ratchet it seeded", async () => {
    const repo = await fixture();
    await repo.ports.pin({ runId: "run-1", pin: "main" }, signal);

    const pinned = await repo.restarted().pin({ runId: "run-1", pin: "main" }, signal);

    expect(await git(repo.bare, "rev-parse", pinned.ratchetRef)).toBe(repo.pin);
  });
});

describe("evaluator eval and micro", () => {
  it("runs the seed rung from the evaluator checkout with the idea's tree as the runner root", async () => {
    const repo = await fixture();
    await repo.ports.pin({ runId: "run-1", pin: "main" }, signal);
    const { tree } = await ideaTree(repo, "plain", GATE_EDIT);

    const result = await repo.ports.evalCase({ ...repo.run, tree, case: "t-alpha", key: "run-1-a-r1", rung: "seed" }, signal);

    expect(result).toMatchObject({ case: "t-alpha", repeat: "run-1-a-r1", usd: 0.5, artifact_dir: join(tree, ".artifacts", "run-1-a-r1") });
  });

  // The rung sleeps far past the suite's timeout, so an evaluator that waited would never answer; no clock is read (TP-4262).
  it("stops a rung that runs past its timeoutMin instead of waiting for it", async () => {
    const repo = await fixture();
    await repo.ports.pin({ runId: "run-1", pin: "main" }, signal);
    const { tree } = await ideaTree(repo, "slow", GATE_EDIT);

    await expect(repo.ports.evalCase({ ...repo.run, tree, case: "t-alpha", key: "k-slow", rung: "slow" }, signal)).rejects.toThrow("[command]");
    const pid = Number(readFileSync(join(tree, "slow.pid"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  });

  it("fails an eval whose run rewrites and commits a frozen file", async () => {
    const repo = await fixture();
    await repo.ports.pin({ runId: "run-1", pin: "main" }, signal);
    const { tree } = await ideaTree(repo, "drifts", GATE_EDIT);
    writeFileSync(join(tree, "drift"), "");

    await expect(repo.ports.evalCase({ ...repo.run, tree, case: "t-alpha", key: "k1", rung: "seed" }, signal)).rejects.toThrow("[frozen-drift]");
  });

  it("refuses to run an eval in a dirty evaluator checkout", async () => {
    const repo = await fixture();
    const pinned = await repo.ports.pin({ runId: "run-1", pin: "main" }, signal);
    const { tree } = await ideaTree(repo, "dirty", GATE_EDIT);
    writeFileSync(join(pinned.evaluatorTree!, "stray.txt"), "left by someone\n");

    await expect(repo.ports.evalCase({ ...repo.run, tree, case: "t-alpha", key: "k1", rung: "seed" }, signal)).rejects.toThrow("[evaluator-dirty]");
    expect(existsSync(join(tree, ".artifacts", "k1"))).toBe(false);
  });

  it("hands the micro rung the best's baseline dir and the signal in the template's argv order", async () => {
    const repo = await fixture();
    await repo.ports.pin({ runId: "run-1", pin: "main" }, signal);
    const { tree } = await ideaTree(repo, "micro", GATE_EDIT);

    const micro = await repo.ports.micro({ ...repo.run, idea: idea("accept-gate"), tree, rung: "L1-replay", case: "t-alpha", baselineDir: "/runs/best", microSignal: "accepts:down", microArgs: {}, key: "k-m1" }, signal);

    expect(micro).toMatchObject({ rung: "L1-replay", signal: "accepts:down" });
    expect(readFileSync(join(tree, ".artifacts", "micro.argv"), "utf8").split("\n").slice(0, 3)).toEqual([tree, "/runs/best", "accepts:down"]);
  });
});

describe("evaluator after a restart", () => {
  it("serves an eval for a run another instance pinned, from the recorded pin", async () => {
    const repo = await fixture();
    const { frozenHash } = await repo.ports.pin({ runId: "run-1", pin: "main" }, signal);
    const { tree } = await ideaTree(repo, "after-restart", GATE_EDIT);

    const result = await repo.restarted().evalCase({ ...repo.run, frozenHash, tree, case: "t-alpha", key: "k-restart", rung: "seed" }, signal);

    expect(result).toMatchObject({ case: "t-alpha", repeat: "k-restart" });
  });

  it("refuses an eval and an L0 when a frozen file was committed in the evaluator checkout while the host was down", async () => {
    const repo = await fixture();
    const pinned = await repo.ports.pin({ runId: "run-1", pin: "main" }, signal);
    const gate = await ideaTree(repo, "drifted", GATE_EDIT);
    writeFileSync(join(pinned.evaluatorTree!, "ar", "score.py"), "def score(run):\n    return 1\n");
    await git(pinned.evaluatorTree!, "commit", "--quiet", "-am", "edit the scorer");
    const restarted = repo.restarted();
    const run = { ...repo.run, frozenHash: pinned.frozenHash };

    await expect(restarted.evalCase({ ...run, tree: gate.tree, case: "t-alpha", key: "k1", rung: "seed" }, signal)).rejects.toThrow("[frozen-drift]");
    await expect(restarted.staticCheck({ ...run, idea: idea("accept-gate"), ...gate }, signal)).rejects.toThrow("[frozen-drift]");
  });

  it("rebuilds again on the next step once a refused drift is undone, without another restart", async () => {
    const repo = await fixture();
    const pinned = await repo.ports.pin({ runId: "run-1", pin: "main" }, signal);
    const { tree } = await ideaTree(repo, "restored", GATE_EDIT);
    const scorer = join(pinned.evaluatorTree!, "ar", "score.py");
    const original = readFileSync(scorer, "utf8");
    writeFileSync(scorer, "def score(run):\n    return 1\n");
    await git(pinned.evaluatorTree!, "commit", "--quiet", "-am", "edit the scorer");
    const restarted = repo.restarted();
    const evalAt = (key: string) => restarted.evalCase({ ...repo.run, frozenHash: pinned.frozenHash, tree, case: "t-alpha", key, rung: "seed" }, signal);
    await expect(evalAt("k1")).rejects.toThrow("[frozen-drift]");

    writeFileSync(scorer, original);
    await git(pinned.evaluatorTree!, "commit", "--quiet", "-am", "restore the scorer");

    expect(await evalAt("k2")).toMatchObject({ repeat: "k2" });
  });

  it("refuses a step whose run recorded no frozen hash or was never pinned here", async () => {
    const repo = await fixture();
    await repo.ports.pin({ runId: "run-1", pin: "main" }, signal);
    const { tree } = await ideaTree(repo, "unpinned", GATE_EDIT);
    const evalIn = (runId: string, frozenHash?: string) => repo.restarted().evalCase({ runId, pin: repo.pin, frozenHash, tree, case: "t-alpha", key: "k1", rung: "seed" }, signal);

    await expect(evalIn("run-1")).rejects.toThrow("[no-pin] run run-1 recorded no frozen hash");
    await expect(evalIn("run-2", "0".repeat(64))).rejects.toThrow("[no-pin] run run-2 has no evaluator checkout");
  });
});

describe("evaluator L0", () => {
  it("runs the test proof for a class that needs a test and skips it for an excepted class", async () => {
    const repo = await fixture();
    await repo.ports.pin({ runId: "run-1", pin: "main" }, signal);
    const gate = await ideaTree(repo, "gate", GATE_EDIT);
    const config = await ideaTree(repo, "config", { "src/config.json": '{\n  "hot_cc": 12\n}\n' });

    const gateL0 = await repo.ports.staticCheck({ ...repo.run, idea: idea("accept-gate"), ...gate }, signal);
    const configL0 = await repo.ports.staticCheck({ ...repo.run, idea: idea("config-param"), ...config }, signal);

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

    const l0 = await repo.ports.staticCheck({ ...repo.run, idea: idea("accept-gate"), ...gate }, signal);

    expect(l0).toMatchObject({ ok: false, code: "unit-suite" });
    expect(l0.checks!.filter((row) => !row.ok).map((row) => row.name)).toEqual(["unit-suite", "test-proof"]);
    expect(l0.checks!.every((row) => typeof row.ms === "number" && row.ms >= 0)).toBe(true);
  });

  it("puts the tree back at the head it checked when the test proof checked out the base, so the next eval measures that head", async () => {
    const repo = await fixture();
    await repo.ports.pin({ runId: "run-1", pin: "main" }, signal);
    const gate = await ideaTree(repo, "moves-head", GATE_EDIT);
    writeFiles(gate.tree, { "move-head": "" });

    await repo.ports.staticCheck({ ...repo.run, idea: idea("accept-gate"), ...gate }, signal);
    await repo.ports.evalCase({ ...repo.run, tree: gate.tree, case: "t-alpha", key: "k-head", rung: "seed" }, signal);

    expect(readFileSync(join(gate.tree, ".artifacts", "proof-ran"), "utf8").trim()).toBe(`${gate.base} ${gate.head}`);
    expect(readFileSync(join(gate.tree, ".artifacts", "k-head", "head"), "utf8").trim()).toBe(gate.head);
  });

  it("reads the params file at base and head and refuses an out-of-range value", async () => {
    const repo = await fixture();
    await repo.ports.pin({ runId: "run-1", pin: "main" }, signal);
    const config = await ideaTree(repo, "config-high", { "src/config.json": '{\n  "hot_cc": 20\n}\n' });

    const l0 = await repo.ports.staticCheck({ ...repo.run, idea: idea("config-param"), ...config }, signal);

    expect(l0).toMatchObject({ ok: false, code: "param-out-of-range", diff: { files: 1 } });
  });
});

describe("evaluator ratchet and archive", () => {
  it("refuses main as a ratchet ref and leaves the remote alone", async () => {
    const repo = await fixture();
    const pinned = await repo.ports.pin({ runId: "run-1", pin: "main" }, signal);
    const winner = await ideaTree(repo, "winner", GATE_EDIT);
    const move = { tree: pinned.integrationTree, ratchetRef: "refs/heads/main", ratchetPrefix: "autoresearch/fixture", from: repo.pin, to: winner.head };
    const record = { round: 1, ideaId: "i-1", kind: "ff" as const, keepRung: "L3", delta: 1, sigma: 0.1, runDigests: [], pin: repo.pin };

    await expect(repo.ports.ratchet({ ...repo.run, ...move, ...record }, signal)).rejects.toThrow("[ratchet-main]");
    expect(await git(repo.bare, "rev-parse", "refs/heads/main")).toBe(repo.pin);
  });

  it("judges the ref by the pinned target's prefix, not a prefix the request names", async () => {
    const repo = await fixture();
    const pinned = await repo.ports.pin({ runId: "run-1", pin: "main" }, signal);
    const winner = await ideaTree(repo, "winner", GATE_EDIT);
    await git(pinned.integrationTree, "push", "--quiet", "origin", `${repo.pin}:refs/heads/other/run-1`);
    const move = { tree: pinned.integrationTree, ratchetRef: "refs/heads/other/run-1", ratchetPrefix: "other", from: repo.pin, to: winner.head };
    const record = { round: 1, ideaId: "i-1", kind: "ff" as const, keepRung: "L3", delta: 1, sigma: 0.1, runDigests: [], pin: repo.pin };

    await expect(repo.ports.ratchet({ ...repo.run, ...move, ...record }, signal)).rejects.toThrow("[ratchet-ref]");
    expect(await git(repo.bare, "rev-parse", "refs/heads/other/run-1")).toBe(repo.pin);
  });

  it("writes the round's tgz with its record and artifacts, and a SHA256SUMS line that verifies", async () => {
    const repo = await fixture();
    const artifacts = join(repo.root, "artifacts", "run-1-a-r1");
    writeFiles(artifacts, { "lanes.json": "[]\n" });
    const run = { schema: "ar-result/v2", case: "t-alpha", repeat: "r1", metrics: {}, usd: 0, wall_s: 0, artifact_dir: artifacts };
    const outcome = OutcomeSchema.parse({ ideaId: "i-1", lineage: "l", cell: "c", verdict: "kept", reason: "ok", rungReached: "L3", runs: [run] });
    const record = partialFake<RoundRecord>({ outcomes: [outcome] });

    const archived = await repo.ports.archive!({ runId: "run-1", round: 2, record }, signal);

    const sum = createHash("sha256").update(readFileSync(archived.path!)).digest("hex");
    expect(archived.sha256).toBe(sum);
    expect(readFileSync(join(repo.root, "archive", "run-1", "SHA256SUMS"), "utf8")).toBe(`${sum}  round-2.tgz\n`);
    const listed = execFileSync("tar", ["-tzf", archived.path!], { encoding: "utf8" });
    expect(listed).toContain("./record.json");
    expect(listed).toContain("./artifacts/0-run-1-a-r1/lanes.json");
  });
});

const HELD_OUT = ["val-1", "val-2", "val-3"].map((name) => ({ case: name, caseSet: "held" }));

/** Every object key and string value in `value`, so a case name anywhere in a look's answer is found. */
const wordsOf = (value: unknown): string[] =>
  typeof value === "string" ? [value] : value && typeof value === "object" ? Object.entries(value).flatMap(([key, inner]) => [key, ...wordsOf(inner)]) : [];

describe("milestone looks and the phase registry", () => {
  it("answers only aggregates over the held-out cases, naming none of them", async () => {
    const repo = await fixture(BOUNDS, { validatorCases: HELD_OUT, now: () => Date.parse("2026-10-22T00:00:00Z") });
    const pinned = await repo.ports.pin(repo.run, signal);
    const { head } = await ideaTree(repo, "best", { "src/gate/gates.py": "def accept(task):\n    return task\n" });

    const look = await repo.ports.validate!({ ...repo.run, frozenHash: pinned.frozenHash, look: 1, head }, signal);

    expect(look).toEqual({ look: 1, at: "2026-10-22T00:00:00.000Z", sha: head, aggregate: { metrics: { score: 1 }, gates: {} }, provenance: expect.stringContaining("not an LLM judge"), usd: 1.5 });
    expect(wordsOf(look).filter((word) => HELD_OUT.some((held) => word.includes(held.case)))).toEqual([]);
    expect(existsSync(join(repo.root, "work", "val-run-1-1"))).toBe(false);
  });

  it("re-creates a parked evaluator checkout at the pin and still refuses a frozen-file drift", async () => {
    const repo = await fixture(BOUNDS, { validatorCases: HELD_OUT });
    const pinned = await repo.ports.pin(repo.run, signal);
    const evaluator = join(repo.root, "work", "eval-run-1");
    await execGit(["worktree", "remove", "--force", evaluator], repo.clone);
    const request = { ...repo.run, frozenHash: pinned.frozenHash, look: 1, head: repo.pin };

    await expect(repo.restarted().validate!(request, signal)).resolves.toMatchObject({ sha: repo.pin });
    await expect(repo.restarted().validate!({ ...request, frozenHash: "0".repeat(64) }, signal)).rejects.toThrow("[frozen-drift]");
  });

  it("refuses a look when no held-out cases are configured", async () => {
    const repo = await fixture();

    await expect(repo.ports.validate!({ ...repo.run, look: 1, head: repo.pin }, signal)).rejects.toThrow("[no-validator-cases]");
  });

  it("appends one registry line per phase", async () => {
    const registryPath = join(tmpdir(), `ar-registry-${process.pid}`, "phases.jsonl");
    roots.push(dirname(registryPath));
    const repo = await fixture(BOUNDS, { registryPath });
    const row = { phase: "p1", pin: repo.pin, trainCases: ["t-alpha"], ideasByRung: {}, sigma: 0, pairs: 0, locked: false, spend: { agentUsd: 0, modelUsd: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, archives: [], stopReason: "rounds-exhausted" as const, provenance: "fixture" };

    await repo.ports.registry!({ runId: "run-1", row }, signal);
    const answer = await repo.ports.registry!({ runId: "run-2", row }, signal);

    expect(answer).toEqual({ path: registryPath });
    expect(readFileSync(registryPath, "utf8").trim().split("\n").map((line) => JSON.parse(line))).toEqual([row, row]);
  });
});
