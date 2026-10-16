import { describe, expect, it, vi } from "vitest";
import { ESPEAK_TIMEOUT_MS, espeakCliG2p, espeakVersion, type EspeakRunner } from "./espeak-g2p.js";

describe("espeakCliG2p", () => {
  it("runs the argv the audiobook backend runs, with the default voice", () => {
    const run = vi.fn<EspeakRunner>(() => "hɛlˈoʊ");
    const out = espeakCliG2p({ run })("hello there", "en-us");
    expect(out).toBe("hɛlˈoʊ");
    expect(run.mock.calls[0]?.[0]).toEqual(["espeak-ng", "-q", "--ipa=3", "-v", "en-us", "hello there"]);
    expect(run.mock.calls[0]?.[1]).toEqual({ timeoutMs: ESPEAK_TIMEOUT_MS });
  });

  it("uses the 10 second timeout", () => {
    expect(ESPEAK_TIMEOUT_MS).toBe(10_000);
  });

  it("sends the voice the caller names and the configured binary", () => {
    const run = vi.fn<EspeakRunner>(() => "");
    espeakCliG2p({ run, bin: "/opt/bin/espeak-ng", voice: "en-gb" })("tea", "en-gb");
    espeakCliG2p({ run })("tea", "en-gb-x-rp");
    expect(run.mock.calls[0]?.[0]).toEqual(["/opt/bin/espeak-ng", "-q", "--ipa=3", "-v", "en-gb", "tea"]);
    expect(run.mock.calls[1]?.[0].slice(3, 5)).toEqual(["-v", "en-gb-x-rp"]);
  });

  it("returns an empty string and reports once when the runner throws", () => {
    const failure = new Error("spawn espeak-ng ENOENT");
    const onError = vi.fn();
    const g2p = espeakCliG2p({
      run: () => {
        throw failure;
      },
      onError,
    });
    expect(g2p("hello", "en-us")).toBe("");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it("returns an empty string and reports once when the run times out", () => {
    const onError = vi.fn();
    const g2p = espeakCliG2p({
      run: (_argv, { timeoutMs }) => {
        throw Object.assign(new Error(`timed out after ${timeoutMs} ms`), { code: "ETIMEDOUT" });
      },
      onError,
    });
    expect(g2p("hello", "en-us")).toBe("");
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("fails quietly with no onError", () => {
    const g2p = espeakCliG2p({
      run: () => {
        throw new Error("boom");
      },
    });
    expect(g2p("hello", "en-us")).toBe("");
  });
});

describe("espeakVersion", () => {
  it("reads the version from the --version banner", () => {
    const run = vi.fn<EspeakRunner>(() => "eSpeak NG text-to-speech: 1.52.0  Data at: /usr/lib/espeak-ng-data\n");
    expect(espeakVersion({ run })).toBe("1.52.0");
    expect(run.mock.calls[0]?.[0]).toEqual(["espeak-ng", "--version"]);
  });

  it("is null when the binary cannot run or prints no version", () => {
    expect(
      espeakVersion({
        run: () => {
          throw new Error("ENOENT");
        },
      }),
    ).toBeNull();
    expect(espeakVersion({ run: () => "usage: ..." })).toBeNull();
  });
});
