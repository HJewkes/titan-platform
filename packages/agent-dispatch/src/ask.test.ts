import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { askHuman, dismissAsk, readAnswers } from "./ask.js";
import { BrokerUnavailableError, DispatchError } from "./dispatch.js";
import { installExecutable } from "./test-support.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-dispatch-ask-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A fake `agent-chat` that records its argv NUL-separated and its stdin, then runs `script`. */
function fakeAgentChat(script: string): string {
  const path = join(dir, "agent-chat");
  installExecutable(
    path,
    `#!/bin/sh\n` +
      `: >"${dir}/argv"\n` +
      `for a in "$@"; do printf '%s\\0' "$a" >>"${dir}/argv"; done\n` +
      `cat >"${dir}/stdin"\n` +
      script,
  );
  return path;
}

const recordedArgv = (): string[] =>
  readFileSync(join(dir, "argv"), "utf8").split("\0").slice(0, -1);

function printing(body: string, exit = 0): string {
  const file = join(dir, "out");
  writeFileSync(file, body);
  return fakeAgentChat(`cat "${file}"\nexit ${exit}\n`);
}

const QUESTION = "Merge run1? The diff touches the release workflow.";

describe("askHuman", () => {
  it("sends the question on stdin, never argv, and returns the msgId", async () => {
    const bin = printing(JSON.stringify({ msgId: "m-41" }));

    const msgId = await askHuman(
      bin,
      { as: "titan-factory", text: QUESTION, task: "gate:run1/merge", options: ["merge", "hold"], recommended: "merge" },
      5_000,
    );

    expect(msgId).toBe("m-41");
    expect(readFileSync(join(dir, "stdin"), "utf8")).toBe(QUESTION);
    expect(recordedArgv()).toEqual([
      "ask", "--as", "titan-factory", "--text-stdin", "--json",
      "--task", "gate:run1/merge", "--option", "merge", "--option", "hold", "--recommended", "merge",
    ]);
    expect(recordedArgv().join(" ")).not.toContain("release workflow");
  });

  it("reports a broker refusal with its reason", async () => {
    const bin = fakeAgentChat(`echo "titan-factory already has 20 open questions" >&2\nexit 1\n`);

    const asking = askHuman(bin, { as: "titan-factory", text: QUESTION }, 5_000);

    await expect(asking).rejects.toThrow(/already has 20 open questions/);
    await expect(asking).rejects.not.toBeInstanceOf(BrokerUnavailableError);
  });

  it("marks a down or too-old broker apart from a refusal, so the caller retries", async () => {
    const bin = fakeAgentChat(`echo "broker too old: it did not answer service_ask" >&2\nexit 69\n`);

    await expect(askHuman(bin, { as: "titan-factory", text: QUESTION }, 5_000)).rejects.toBeInstanceOf(
      BrokerUnavailableError,
    );
  });

  it("names a usage error as one", async () => {
    const bin = fakeAgentChat(`echo "the question is empty" >&2\nexit 2\n`);

    await expect(askHuman(bin, { as: "titan-factory", text: " " }, 5_000)).rejects.toThrow(/usage error/);
  });

  it("refuses a label the broker would reject without calling agent-chat", async () => {
    const bin = printing(JSON.stringify({ msgId: "m-41" }));

    await expect(askHuman(bin, { as: "Not A Label", text: QUESTION }, 5_000)).rejects.toBeInstanceOf(DispatchError);
    expect(() => recordedArgv()).toThrow();
  });
});

describe("readAnswers", () => {
  const answered = {
    msgId: "m-50", questionId: "m-41", outcome: "answered", text: "merge", by: "human", channel: "telegram", at: 1,
  };
  const dismissed = { msgId: "m-51", questionId: "m-42", outcome: "dismissed", text: "", by: "human", at: 2 };

  it("passes the cursor and parses answered and dismissed rows with next", async () => {
    const bin = printing(JSON.stringify({ answers: [answered, dismissed], next: "m-51" }));

    const page = await readAnswers(bin, "titan-factory", "m-41", 5_000);

    expect(recordedArgv()).toEqual(["answers", "titan-factory", "--since", "m-41", "--json"]);
    expect(page).toEqual({ answers: [answered, dismissed], next: "m-51" });
  });

  it("reads from the start when no cursor is given", async () => {
    const bin = printing(JSON.stringify({ answers: [] }));

    const page = await readAnswers(bin, "titan-factory", undefined, 5_000);

    expect(recordedArgv()).toEqual(["answers", "titan-factory", "--json"]);
    expect(page).toEqual({ answers: [] });
  });

  it("throws on malformed JSON rather than returning an empty page", async () => {
    const bin = printing("answered m-41 m-50: merge\n");

    await expect(readAnswers(bin, "titan-factory", undefined, 5_000)).rejects.toThrow(/invalid JSON/);
  });

  it("throws on a row of the wrong shape rather than dropping it", async () => {
    const bin = printing(JSON.stringify({ answers: [{ ...answered, outcome: "maybe" }] }));

    await expect(readAnswers(bin, "titan-factory", undefined, 5_000)).rejects.toBeInstanceOf(DispatchError);
  });

  it("reports an unknown cursor as a refusal", async () => {
    const bin = fakeAgentChat(`echo "unknown msg_id: no-such-id" >&2\nexit 1\n`);

    await expect(readAnswers(bin, "titan-factory", "no-such-id", 5_000)).rejects.toThrow(/unknown msg_id/);
  });
});

describe("dismissAsk", () => {
  it("dismisses the ask by msg_id", async () => {
    const bin = printing("Dismissed m-41.\n");

    await dismissAsk(bin, "m-41", 5_000);

    expect(recordedArgv()).toEqual(["dismiss", "m-41"]);
  });

  it("reports a refusal for an ask that is already closed", async () => {
    const bin = fakeAgentChat(`echo "m-41 is not open" >&2\nexit 1\n`);

    await expect(dismissAsk(bin, "m-41", 5_000)).rejects.toThrow(/not open/);
  });

  it("refuses a msg_id that would read as a flag", async () => {
    const bin = printing("");

    await expect(dismissAsk(bin, "--all", 5_000)).rejects.toBeInstanceOf(DispatchError);
  });
});
