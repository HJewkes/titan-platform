import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { resolveBeat } from "./registry.js";

describe("the composition page's known kinds", () => {
  test("an unknown kind throws and names the kinds it knows", () => {
    assert.throws(() => resolveBeat("hologram"), /^Error: unknown beat kind "hologram"; known kinds: hook, held, list, verdict-card, fact-flash, claim-card, button, outro, finding-card, stat, chart, compare, arch-map, metrics-panel, scorecard, catalogue$/);
  });
});
