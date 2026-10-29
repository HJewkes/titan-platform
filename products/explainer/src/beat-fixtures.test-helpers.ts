import type { BeatSpec } from "./beat-schema.js";

// Invented specs over the invented doctrine vocabulary (hook, code-walk); none is a shipped spec.

/** A sound spec for `type` over the `code-walk` slots; overrides replace whole top-level fields. */
export const beatSpec = (type: string, overrides: Partial<BeatSpec> = {}): BeatSpec => ({
  schema: "beat-spec/v1",
  type,
  summary: `${type} summary.`,
  role: "explain",
  component: { name: "CodeWalkBeat", maturity: "spike" },
  slots: "code-walk",
  speech: { band: "code" },
  durationS: [5, 10, 20],
  preset: false,
  emphasis: { targets: ["lines"], treatments: ["highlight", "pointer"] },
  recipe: "Walk the lines.",
  ...overrides,
});

export const BEATS: ReadonlyMap<string, BeatSpec> = new Map([
  ["hook", beatSpec("hook", { role: "open", slots: "hook", speech: { band: "story" }, emphasis: { targets: ["cards"], treatments: ["scale"] } })],
  ["code-walk", beatSpec("code-walk")],
]);

/** Slots the `code-walk` schema accepts: two lines with distinct ids. */
export const codeWalkSlots = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  path: "src/sample.ts",
  language: "ts",
  mode: "plain",
  simplified: false,
  lines: [
    { id: "open", text: "const total = 0;" },
    { id: "close", text: "return total;" },
  ],
  ...overrides,
});
