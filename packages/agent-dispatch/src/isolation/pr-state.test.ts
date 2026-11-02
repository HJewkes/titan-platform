import { describe, expect, it, vi } from "vitest";
import {
  parsePrState,
  prStateReader,
  prTarget,
  reportPr,
  type PrStateDeps,
} from "./index.js";

/** CC-1678: one PR's state, read on the host's budget. */

const view = (state: string) =>
  JSON.stringify({ state, headRefOid: "a".repeat(40) });

function deps(over: Partial<PrStateDeps> = {}): PrStateDeps {
  return {
    refusal: async () => undefined,
    gh: async () => ({ exitCode: 0, stdout: view("MERGED") }),
    after: async () => undefined,
    ...over,
  };
}

describe("prTarget and reportPr", () => {
  it("reads owner/repo#n and a pull URL, and nothing else", () => {
    expect(prTarget("example/repo#7")).toEqual({ repo: "example/repo", pr: 7 });
    expect(prTarget("https://github.com/example/repo/pull/7/files")).toEqual({
      repo: "example/repo",
      pr: 7,
    });
    expect(prTarget("repo#7")).toBeUndefined();
    expect(prTarget(undefined)).toBeUndefined();
  });

  it("takes the PR line of a report in either form, with markdown trimmed", () => {
    expect(reportPr("Status: DONE\nPR: example/repo#7")).toBe("example/repo#7");
    expect(reportPr("**PR:** https://github.com/example/repo/pull/7.")).toBe(
      "example/repo#7"
    );
    expect(reportPr("Status: DONE\nPR: none")).toBeNull();
  });
});

describe("parsePrState", () => {
  it("returns the state and the head", () => {
    expect(parsePrState(view("OPEN"), 7)).toEqual({
      state: "OPEN",
      head: { number: 7, headSha: "a".repeat(40) },
    });
  });

  it("rejects an unknown state or a missing head", () => {
    expect(() => parsePrState(view("DRAFT"), 7)).toThrow(
      "without a known state"
    );
    expect(() => parsePrState(JSON.stringify({ state: "OPEN" }), 7)).toThrow(
      "without a known state"
    );
  });
});

describe("prStateReader", () => {
  it("asks gh for the PR's state and head, then reports the call", async () => {
    const gh = vi.fn(deps().gh);
    const after = vi.fn(async () => undefined);

    const state = await prStateReader(deps({ gh, after }))("example/repo#7");

    expect(state.state).toBe("MERGED");
    expect(gh).toHaveBeenCalledWith([
      "pr",
      "view",
      "7",
      "--repo",
      "example/repo",
      "--json",
      "state,headRefOid",
    ]);
    expect(after).toHaveBeenCalledOnce();
  });

  it("does not reach gh when the budget refuses", async () => {
    const gh = vi.fn(deps().gh);

    await expect(
      prStateReader(
        deps({ gh, refusal: async () => "gh graphql lane is cooling" })
      )("example/repo#7")
    ).rejects.toThrow("cooling");
    expect(gh).not.toHaveBeenCalled();
  });

  it("reports a failed call before it rejects", async () => {
    const after = vi.fn(async () => undefined);

    await expect(
      prStateReader(
        deps({ after, gh: async () => ({ exitCode: 1, stdout: "" }) })
      )("example/repo#7")
    ).rejects.toThrow("exited 1");
    expect(after).toHaveBeenCalledOnce();
  });

  it("rejects a reference that is not a PR", async () => {
    await expect(prStateReader(deps())("nonsense")).rejects.toThrow(
      "not a PR reference"
    );
  });
});
