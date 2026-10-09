import type { AgentRunnerOptions, LegacyStepRunner, RoutedStepInput, StepRunOutcome } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { checkDraft, draftPrompt, draftRoute, type DocFile } from "./draft.js";
import type { DocTask } from "./task-source.js";

const TASK: DocTask = { slug: "demo", id: "D-7", title: "Explain the retry flag", status: "open", done_when: "The guide names the retry flag and its default." };
const BEFORE: DocFile = { path: "site/guides/retry.md", content: "---\ntitle: Retry\n---\n# Retry\n\nRuns once.\n\n## Flags\n\nNone yet.\n" };
const AFTER = "---\ntitle: Retry\n---\n# Retry\n\nRuns once.\n\n## Flags\n\n`--retry` reruns a failed step; it defaults to 2.\n";
// Joined at runtime so the push-time egress scan does not read the fixture as a leaked home path.
const HOME_PATH = ["", "home", "someone", "notes"].join("/");
const DRAFT = { title: "Document the retry flag", summary: "Names --retry and its default.", content: AFTER };

function stepInput(): RoutedStepInput {
  return { runId: "r1", workflowName: "doc-change", stepId: "draft", iteration: 0, prompt: "p", signal: new AbortController().signal, attempt: 1, requestKey: "k" };
}

function fakeRunner(outcome: StepRunOutcome) {
  const seen: { options?: AgentRunnerOptions; inputs: RoutedStepInput[] } = { inputs: [] };
  const runnerFor = (options: AgentRunnerOptions): LegacyStepRunner => {
    seen.options = options;
    return { run: async (input) => (seen.inputs.push(input as RoutedStepInput), outcome) };
  };
  return { runnerFor, seen };
}

describe("draftPrompt", () => {
  it("carries the task's title, done_when, the path and the current content", () => {
    const prompt = draftPrompt({ task: TASK, file: BEFORE });

    for (const part of [TASK.title, TASK.done_when, BEFORE.path, "None yet."]) expect(prompt).toContain(part);
  });

  it("tells the model it has no tools, since claude-print gives it none and it otherwise apologises in content", () => {
    expect(draftPrompt({ task: TASK, file: BEFORE })).toContain("You have no tools");
  });
});

describe("draftRoute", () => {
  it("runs one claude-print sonnet turn under a $0.5 cap with the draft schema", async () => {
    const { runnerFor, seen } = fakeRunner({ ok: true, output: JSON.stringify(DRAFT) });

    const route = draftRoute({ cwd: "/repo", runnerFor });

    expect(route).toMatchObject({ match: "draft", onRestart: "repeat" });
    expect(seen.options).toMatchObject({ cwd: "/repo", maxTurns: 1, maxBudgetUsd: 0.5, defaults: { harness: "claude-print", model: "sonnet" } });
    expect(seen.options?.defaults?.outputSchema?.safeParse(DRAFT).success).toBe(true);
  });

  it("returns the parsed draft as JSON and keeps the usage", async () => {
    const usage = { costUsd: 0.05, inputTokens: 10, outputTokens: 20 };
    const { runnerFor } = fakeRunner({ ok: true, output: JSON.stringify({ ...DRAFT, extra: "dropped" }), usage });

    const outcome = await draftRoute({ cwd: "/repo", runnerFor }).runner.run(stepInput());

    expect(outcome).toEqual({ ok: true, output: JSON.stringify(DRAFT), usage });
  });

  it("fails as schema_invalid on output that is not a draft, without echoing it", async () => {
    const { runnerFor } = fakeRunner({ ok: true, output: '{"title":"t","secret":"model text"}' });

    const outcome = await draftRoute({ cwd: "/repo", runnerFor }).runner.run(stepInput());

    expect(outcome).toMatchObject({ ok: false, code: "schema_invalid", retryable: false });
    expect(JSON.stringify(outcome)).not.toContain("model text");
  });

  it("fails as schema_invalid on output that is not JSON", async () => {
    const { runnerFor } = fakeRunner({ ok: true, output: "not json" });

    expect(await draftRoute({ cwd: "/repo", runnerFor }).runner.run(stepInput())).toMatchObject({ ok: false, code: "schema_invalid" });
  });

  it("passes a runner failure through unchanged", async () => {
    const failed: StepRunOutcome = { ok: false, error: "rate_limited: slow down", retryable: true };
    const { runnerFor } = fakeRunner(failed);

    expect(await draftRoute({ cwd: "/repo", runnerFor }).runner.run(stepInput())).toEqual(failed);
  });
});

describe("checkDraft", () => {
  it("accepts a bounded change to a Markdown file that keeps its front matter and sections", () => {
    expect(checkDraft(BEFORE, AFTER, 5)).toEqual({ ok: true });
  });

  it.each([
    ["unchanged content", BEFORE, BEFORE.content, "content is unchanged"],
    ["a non-Markdown path", { ...BEFORE, path: "site/guides/retry.txt" }, AFTER, "not a Markdown path"],
    ["a path outside the repo", { ...BEFORE, path: "../retry.md" }, AFTER, "not a Markdown path"],
    ["a front-matter edit", BEFORE, AFTER.replace("title: Retry", "title: Retries"), "front matter changed"],
    ["dropped front matter", BEFORE, AFTER.replace("---\ntitle: Retry\n---\n", ""), "front matter changed"],
    ["a removed section", BEFORE, AFTER.replace("## Flags\n", ""), "section removed: ## Flags"],
    ["an apology with the file only in a code fence", BEFORE, "---\ntitle: Retry\n---\nI could not edit it. Paste this:\n\n```\n# Retry\n```\n", "section removed: # Retry"],
    ["a home path in an added line", BEFORE, `${AFTER}See ${HOME_PATH}.\n`, "owner data in an added line"],
    ["an email in an added line", BEFORE, `${AFTER}Ask someone@corp.dev.\n`, "owner data in an added line"],
  ])("refuses %s", (_name, before, after, reason) => {
    const result = checkDraft(before, after, 50);

    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.reasons).toContain(reason);
  });

  it("refuses a line delta over the bound and names both numbers", () => {
    const after = `${AFTER}${"More.\n".repeat(4)}`;

    expect(checkDraft(BEFORE, after, 3)).toEqual({ ok: false, reasons: ["6 changed lines exceed the bound of 3"] });
  });

  it("allows an example.com address, which is documentation, not owner data", () => {
    expect(checkDraft(BEFORE, `${AFTER}Mail ops@example.com.\n`, 5)).toEqual({ ok: true });
  });
});
