#!/usr/bin/env node
// A stand-in `explainer` for console tests and screenshots: canned synthetic props, and an `edit check` that applies
// a draft to them and reports length, row-count and locked-id problems the way the real CLI words them.
// EXPLAINER_FAKE_PROPS=unknown answers found:false; =fail exits 2. EXPLAINER_FAKE_LOG appends each argv, stdin and
// the TITAN_CONSOLE_* names that reached it, which must be none.
import { appendFileSync, readFileSync } from "node:fs";

const props = JSON.parse(readFileSync(new URL("./props.json", import.meta.url), "utf8"));
const argv = process.argv.slice(2);
const stdin = argv.includes("-") ? readFileSync(0, "utf8") : "";
if (process.env.EXPLAINER_FAKE_LOG) appendFileSync(process.env.EXPLAINER_FAKE_LOG, `${JSON.stringify({ argv, stdin, consoleEnv: Object.keys(process.env).filter((name) => name.startsWith("TITAN_CONSOLE_")), dataHome: process.env.XDG_DATA_HOME })}\n`);

const print = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

function fieldProblems(where, schema, value) {
  if (schema.type === "string" && typeof value === "string" && value.length > schema.maxLength) return [`${where}: Too big: expected string to have <=${schema.maxLength} characters`];
  if (schema.type === "string" && typeof value === "string" && value.length < (schema.minLength ?? 0)) return [`${where}: Too small: expected string to have >=${schema.minLength} characters`];
  if (schema.type !== "array" || !Array.isArray(value)) return [];
  if (value.length > schema.maxItems) return [`${where}: Too big: expected array to have <=${schema.maxItems} items`];
  return value.flatMap((row, i) => Object.entries(row).flatMap(([key, cell]) => fieldProblems(`${where}.${i}.${key}`, schema.items.properties[key] ?? {}, cell)));
}

function strandedIds(where, beat, value) {
  const ids = new Set(Array.isArray(value) ? value.map((row) => row.id) : []);
  const before = Array.isArray(beat.value[where]) ? beat.value[where].map((row) => row.id) : [];
  return beat.locked.filter((id) => before.includes(id) && !ids.has(id)).map((id) => `beats.${beat.id}.visual.slots.${where}: drops element ${id}, which cue 0 (enter at "synthetic") targets; keep its id or retarget the cue`);
}

function check(edit) {
  const problems = [];
  const diff = [];
  for (const [id, change] of Object.entries(edit.beats)) {
    const beat = props.beats.find((each) => each.id === id);
    if (!beat) {
      problems.push(`beats.${id}: the base script has no beat ${id}`);
      continue;
    }
    for (const [field, after] of Object.entries(change.slots ?? {})) {
      const where = `beats.${id}.visual.slots.${field}`;
      problems.push(...fieldProblems(where, beat.schema.properties[field] ?? {}, after), ...strandedIds(field, beat, after));
      if (JSON.stringify(beat.value[field]) !== JSON.stringify(after)) diff.push({ beat: id, path: `visual.slots.${field}`, before: beat.value[field], after });
    }
  }
  return { ok: problems.length === 0, problems, diff };
}

if (argv[0] === "props") {
  if (process.env.EXPLAINER_FAKE_PROPS === "fail") {
    process.stderr.write("props: run run-synthetic-0001 has no words artifact\n");
    process.exit(2);
  }
  print(process.env.EXPLAINER_FAKE_PROPS === "unknown" ? { found: false } : props);
} else if (argv[0] === "edit" && argv[1] === "check") {
  const verdict = check(JSON.parse(stdin));
  print(verdict);
  process.exitCode = verdict.ok ? 0 : 1;
} else {
  process.stderr.write(`fake explainer: no ${argv.join(" ")}\n`);
  process.exit(2);
}
