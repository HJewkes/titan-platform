import { describe, expect, it } from "vitest";

import { harnessRefusal, parseProfile } from "./index.js";

/** CC-1516: `harness` defaults to claude-code, and a codex profile refuses every launch until CC-1517. */

const base = { model: "gpt-5-codex", allowedTools: ["Read"], isolation: "none", surface: "headless" };

describe("profile harness field (CC-1516)", () => {
  it("leaves a profile without the field unchanged and launchable", () => {
    const profile = parseProfile("plain", { ...base, model: "sonnet" });

    expect(profile).not.toHaveProperty("harness");
    expect(harnessRefusal(profile as never)).toBeUndefined();
  });

  it("keeps an explicit claude-code harness and launches it", () => {
    const profile = parseProfile("explicit", { ...base, model: "opus", harness: "claude-code" });

    expect(profile).toMatchObject({ harness: "claude-code" });
    expect(harnessRefusal(profile as never)).toBeUndefined();
  });

  it("refuses an unknown harness at load, naming the allowed values", () => {
    const profile = parseProfile("odd", { ...base, harness: "gemini" });

    expect(profile).toEqual({ error: 'odd: "harness" must be one of claude-code, codex' });
  });

  it.each(["opus", "sonnet", "haiku", "fable", "opus[1m]", "claude-sonnet-5-5", "Claude-Opus-5-5"])(
    "refuses the Claude model %s on a codex profile",
    (model) => {
      const profile = parseProfile("mixed", { ...base, harness: "codex", model });

      expect(profile).toEqual({ error: expect.stringContaining("is a Claude model") });
    },
  );

  it("loads a codex profile but names the capability it waits on", () => {
    const profile = parseProfile("codex-worker", { ...base, harness: "codex" });

    expect(profile).toMatchObject({ harness: "codex", model: "gpt-5-codex" });
    expect(harnessRefusal(profile as never)).toBe(
      'harness_unsupported: profile "codex-worker" uses harness "codex", unsupported until the Codex launch plan (CC-1517)',
    );
  });
});
