import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RewritePins,
  RewritePinsSchema,
  UnpinnedRewriteError,
  applyPins,
  pinKey,
  splitSentences,
  type RewritePinsFile,
  type RewritePinsOptions,
  type SentencePiece,
} from "./rewrite-pins.js";

const FIXED = new Date("2026-01-02T03:04:05.000Z");
const options: RewritePinsOptions = { now: () => FIXED };
const pinsAt = () => new RewritePins(undefined, options);

describe("pinKey", () => {
  it("is a sha256 hex digest that ignores whitespace layout", () => {
    expect(pinKey("the flomber  sync\n is live.")).toBe(pinKey("  the flomber sync is live. "));
    expect(pinKey("the flomber sync is live.")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs for different sentences", () => {
    expect(pinKey("the flomber sync is live.")).not.toBe(pinKey("the flomber sync is live now."));
  });
});

describe("RewritePins lookup", () => {
  it("returns the stored rewrite, also after the source is reflowed", () => {
    const pins = pinsAt();
    pins.put("the flomber sync is live.", "the flomber sync is on air.", "rules:test");

    expect(pins.get("the flomber sync is live.")).toBe("the flomber sync is on air.");
    expect(pins.get("the flomber   sync\nis live.")).toBe("the flomber sync is on air.");
  });

  it("misses a sentence that only extends a pinned one", () => {
    const pins = pinsAt();
    pins.put("the flomber sync is live.", "the flomber sync is on air.", "rules:test");

    expect(pins.get("the flomber sync is live now.")).toBeUndefined();
  });

  it("records the rewriter id and the injected clock in the entry", () => {
    const pins = pinsAt();
    pins.put("the flomber sync is live.", "the flomber sync is on air.", "rules:test");

    expect(pins.toJson().pins[pinKey("the flomber sync is live.")]).toEqual({
      source: "the flomber sync is live.",
      rewrite: "the flomber sync is on air.",
      rewriter: "rules:test",
      createdAt: "2026-01-02T03:04:05.000Z",
    });
  });

  it("recognises a stored rewrite but not its source", () => {
    const pins = pinsAt();
    pins.put("the flomber sync is live.", "the flomber sync is on air.", "rules:test");

    expect(pins.isPinnedRewrite("the flomber sync is on air.")).toBe(true);
    expect(pins.isPinnedRewrite("the flomber  sync is on air.")).toBe(true);
    expect(pins.isPinnedRewrite("the flomber sync is live.")).toBe(false);
  });
});

describe("RewritePins.prune", () => {
  it("drops pins whose source is not in use and returns how many", () => {
    const pins = pinsAt();
    pins.put("the first flomber is live.", "the first flomber is on air.", "a");
    pins.put("the second flomber is live.", "the second flomber is on air.", "a");

    const removed = pins.prune(new Set(["the first flomber is live."]));

    expect(removed).toBe(1);
    expect(pins.get("the first flomber is live.")).toBe("the first flomber is on air.");
    expect(pins.get("the second flomber is live.")).toBeUndefined();
  });
});

describe("RewritePins files", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rewrite-pins-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips through save and load and leaves no tmp file", async () => {
    const pins = pinsAt();
    pins.put("the flomber sync is live.", "the flomber sync is on air.", "rules:test");
    const path = join(dir, "nested", "rewrites.json");

    await pins.save(path);
    const loaded = await RewritePins.load(path);

    const file: RewritePinsFile = RewritePinsSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    expect(file).toEqual(pins.toJson());
    expect(loaded.toJson()).toEqual(pins.toJson());
    expect(readdirSync(join(dir, "nested"))).toEqual(["rewrites.json"]);
  });

  it("loads a missing file as an empty store", async () => {
    const loaded = await RewritePins.load(join(dir, "absent.json"));

    expect(loaded.toJson()).toEqual({ version: 1, pins: {} });
  });

  it("rejects a file with an unknown version, naming the field", async () => {
    const path = join(dir, "rewrites.json");
    writeFileSync(path, JSON.stringify({ version: 2, pins: {} }));

    await expect(RewritePins.load(path)).rejects.toThrow(/version/);
  });

  it("rejects a file that is not JSON instead of returning an empty store", async () => {
    const path = join(dir, "rewrites.json");
    writeFileSync(path, "{not json");

    await expect(RewritePins.load(path)).rejects.toThrow();
  });
});

describe("splitSentences", () => {
  it("keeps every separator so the pieces join back to the input", () => {
    const line = "  the show is live.  it runs?\nyes! done";

    const pieces: SentencePiece[] = splitSentences(line);

    expect(pieces.map((p) => p.text + p.gap).join("")).toBe(line);
    expect(pieces.map((p) => p.text.trim())).toEqual(["the show is live.", "it runs?", "yes!", "done"]);
  });

  it("does not split inside link markup that holds a period and a space", () => {
    const line = "the [flomber](/flˈOmbɚ. x/) is live. it runs.";

    const pieces = splitSentences(line);

    expect(pieces.map((p) => p.text)).toEqual(["the [flomber](/flˈOmbɚ. x/) is live.", "it runs."]);
  });

  it("splits at a boundary that sits next to a link", () => {
    const line = "it is [live](=adj). [zorptrix](/zˈɔɹptɹɪks/) runs.";

    expect(splitSentences(line).map((p) => p.text)).toEqual(["it is [live](=adj).", "[zorptrix](/zˈɔɹptɹɪks/) runs."]);
  });
});

describe("applyPins", () => {
  const line = "the show is live. it runs.";

  it("throws naming the flagged sentence that has no pin", () => {
    const error = catchError(() => applyPins(line, pinsAt(), ["live"]));

    expect(error).toBeInstanceOf(UnpinnedRewriteError);
    expect(error).toMatchObject({ sentences: ["the show is live."] });
  });

  it("replaces the pinned sentence and leaves the others byte-identical", () => {
    const pins = pinsAt();
    pins.put("the show is live.", "the show is on air.", "rules:test");

    expect(applyPins(line, pins, ["live"])).toBe("the show is on air. it runs.");
  });

  it("substitutes a pinned sentence even when no span is flagged", () => {
    const pins = pinsAt();
    pins.put("the show is live.", "the show is on air.", "rules:test");

    expect(applyPins(line, pins)).toBe("the show is on air. it runs.");
  });

  it("returns the line untouched when nothing is pinned or flagged", () => {
    expect(applyPins(line, pinsAt())).toBe(line);
  });

  it("matches the flagged span as a whole word in the plain text only", () => {
    const text = "the olive grove is [live](=adj). it runs.";

    expect(() => applyPins("the alive show. it runs.", pinsAt(), ["live"])).not.toThrow();
    expect(() => applyPins(text, pinsAt(), ["live"])).toThrow(UnpinnedRewriteError);
  });

  it("accepts a sentence that already is a pinned rewrite", () => {
    const pins = pinsAt();
    pins.put("the show is live.", "the show is live on air.", "rules:test");

    expect(applyPins("the show is live on air. it runs.", pins, ["live"])).toBe("the show is live on air. it runs.");
  });

  it("keeps the surrounding whitespace of a replaced sentence", () => {
    const pins = pinsAt();
    pins.put("the show is live.", "the show is on air.", "rules:test");

    expect(applyPins("  the show is live.\n\nit runs.", pins)).toBe("  the show is on air.\n\nit runs.");
  });
});

function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}
