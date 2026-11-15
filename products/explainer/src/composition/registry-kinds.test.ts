import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { registeredKinds, resolveBeat } from "./registry.js";

describe("the beat registry's kinds", () => {
  test("an unknown kind throws and names the kinds it knows", () => {
    assert.throws(() => resolveBeat("hologram"), /^Error: unknown beat kind "hologram"; known kinds: hook, held, list, verdict-card, fact-flash, claim-card, button, outro, stat, chart, compare, arch-map, proof, catalogue$/);
  });

  test("hook and catalogue draw on the whole page and every spec kind past them in the stage box", () => {
    const page = registeredKinds().filter((kind) => !resolveBeat(kind).stage);

    assert.deepEqual(page, ["hook", "catalogue"]);
  });
});
