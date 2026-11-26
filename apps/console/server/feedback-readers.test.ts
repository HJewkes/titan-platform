/**
 * The census of feedback.json readers (TP-6773). feedback@1 has no answerer field, and the by-rec sweep is a second,
 * non-owner writer, so every module that reads a round's feedback must say how it treats who answered. Each file that
 * names the file or its schema is listed here with one label, and a file the table does not list fails, so a new reader
 * cannot assume the owner unnoticed.
 *
 * - `answerer-aware`: takes the answerer from the feedback through owner-queue's `feedbackAnswerer`.
 * - `owner-only-refuses`: acts as the owner and refuses an answer `isOwnerAnswer` rejects.
 * - `no-attribution`: reads or writes answers without naming who gave them.
 *
 * A file that gets its answerer or its refusal from another listed file names that call in `via`; the other file must
 * carry the same label and the call must appear in this file's code.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

type Label = "answerer-aware" | "owner-only-refuses" | "no-attribution";

interface Via {
  call: string;
  file: string;
}

interface Reader {
  label: Label;
  why: string;
  via?: Via;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ROOTS = ["apps/console/server", "packages/owner-queue/src", "products/factory/src", "products/explainer/src"];
const READS_FEEDBACK = /FEEDBACK_FILE|feedback\.json|FeedbackSchema|RoundFeedbackSchema|feedback@1/;
const REQUIRED: Record<Exclude<Label, "no-attribution">, string> = { "answerer-aware": "feedbackAnswerer", "owner-only-refuses": "isOwnerAnswer" };

const ROUND_ITEMS = "packages/owner-queue/src/round-items.ts";
const ROUND_MERGE = "products/factory/src/shepherd/round-merge.ts";

const aware = (why: string, via?: Via): Reader => ({ label: "answerer-aware", why, ...(via && { via }) });
const refuses = (why: string, via?: Via): Reader => ({ label: "owner-only-refuses", why, ...(via && { via }) });
const none = (why: string): Reader => ({ label: "no-attribution", why });

const READERS: Record<string, Reader> = {
  "apps/console/server/approval-items.ts": aware("queue items credit the answerer owner-queue reads", { call: "answeredFromFeedback", file: ROUND_ITEMS }),
  "apps/console/server/by-rec-rounds.ts": none("only checks that no feedback.json exists yet"),
  "apps/console/server/config.ts": none("names feedback.json in a setting's doc"),
  "apps/console/server/listeners.ts": refuses("relays Ship and Send back to the gate as owner-remote"),
  "apps/console/server/perf/disk.fixture.ts": none("writes synthetic perf fixtures"),
  "apps/console/server/round-asker.ts": aware("the asker's notice names who answered"),
  "apps/console/server/round-decisions.ts": aware("decision-log items carry the submit's answerer", { call: "answerer", file: "apps/console/server/rounds-submit.ts" }),
  "apps/console/server/round-feedback.ts": none("builds the document; the submit pipeline sets general"),
  "apps/console/server/round-fixtures.ts": none("test fixtures"),
  "apps/console/server/round-follow-ups.ts": none("files follow-up sidecars keyed on round and question"),
  "apps/console/server/round-import.ts": none("validates and copies the file; readers take the answerer from it"),
  "apps/console/server/round-notes.ts": none("shows the sent text and ticks as written"),
  "apps/console/server/round-nudge.ts": none("only checks that no feedback.json exists yet"),
  "apps/console/server/round-plan-approval.test-helpers.ts": none("test fixtures"),
  "apps/console/server/round-plan-approval.ts": refuses("posts a plan-approval record as owner-remote"),
  "apps/console/server/round-rec-answer.ts": none("hands the owner's one tap to the submit pipeline"),
  "apps/console/server/round-reveal.ts": none("writes revealed.json; names the schema in its doc"),
  "apps/console/server/round-rules.ts": none("names feedback.json in its doc"),
  "apps/console/server/round-schema.ts": none("the schema itself"),
  "apps/console/server/round-summary.ts": none("a sent round's text as written"),
  "apps/console/server/round-withdraw.ts": none("only checks that a feedback.json exists"),
  "apps/console/server/round2-adapter.ts": none("the posted-answer schema"),
  "apps/console/server/rounds-submit.ts": aware("the one writer; reads the answerer it hands every listener"),
  "apps/console/server/rounds.ts": none("parses the file and lists the round as sent"),
  "apps/console/server/storybook-gc.ts": none("reads the file's mtime only"),
  "packages/owner-queue/src/by-rec-answerer.ts": aware("defines feedbackAnswerer"),
  "packages/owner-queue/src/consolidate.ts": refuses("only the owner's answers block or lift a Ship"),
  [ROUND_ITEMS]: aware("answeredFromFeedback credits feedbackAnswerer"),
  "products/explainer/src/calibration-agreement.ts": refuses("feedback picks are the owner's judge labels"),
  "products/explainer/src/eval-calibrate-judges-cli.ts": refuses("reads labels only through labelsFromFeedback", { call: "labelsFromFeedback", file: "products/explainer/src/calibration-agreement.ts" }),
  "products/factory/src/gate-answer-check.ts": refuses("resolves the merge gate on the owner's Ship or Send back"),
  "products/factory/src/gate-answer-rpc.ts": refuses("hands the files to checkAnswer", { call: "checkAnswer", file: "products/factory/src/gate-answer-check.ts" }),
  "products/factory/src/note-limits.ts": none("names feedback.json in its doc"),
  "products/factory/src/planner/window-ports.ts": aware("planner owner contact counts owner answers only"),
  [ROUND_MERGE]: refuses("boundAnswerRefusal, the check every Ship reader shares"),
  "products/factory/src/shepherd/round-ship-sweep.ts": refuses("merges only through roundMergeDecisions", { call: "roundMergeDecisions", file: ROUND_MERGE }),
  "products/factory/src/shepherd/visual-feedback-notes.ts": refuses("counts an answer only through boundAnswerRefusal", { call: "boundAnswerRefusal", file: ROUND_MERGE }),
};

const codeOf = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function sourceFiles(root: string): string[] {
  return ROOTS.flatMap((dir) => {
    const entries = readdirSync(path.join(root, dir), { recursive: true, encoding: "utf8" });
    return entries.filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".d.ts")).map((entry) => path.posix.join(dir, entry.split(path.sep).join("/")));
  });
}

function labelProblems(file: string, reader: Reader, code: (file: string) => string, table: Record<string, Reader>): string[] {
  if (reader.label === "no-attribution") return [];
  const required = REQUIRED[reader.label];
  if (reader.via === undefined) return code(file).includes(required) ? [] : [`${file} is ${reader.label} but its code never calls ${required}`];
  const { call, file: target } = reader.via;
  const problems = code(file).includes(call) ? [] : [`${file} is ${reader.label} via ${call}, which its code never calls`];
  return table[target]?.label === reader.label ? problems : [...problems, `${file} is ${reader.label} via ${target}, which the census does not label ${reader.label}`];
}

function censusProblems(root: string, table: Record<string, Reader>): string[] {
  const code = (file: string): string => codeOf(readFileSync(path.join(root, file), "utf8"));
  const readers = sourceFiles(root).filter((file) => READS_FEEDBACK.test(readFileSync(path.join(root, file), "utf8")));
  const unlisted = readers.filter((file) => table[file] === undefined).map((file) => `${file} reads feedback.json and is not in the census`);
  const stale = Object.keys(table).filter((file) => !readers.includes(file)).map((file) => `${file} is in the census but no longer reads feedback.json`);
  const mislabelled = readers.flatMap((file) => (table[file] === undefined ? [] : labelProblems(file, table[file], code, table)));
  return [...unlisted, ...stale, ...mislabelled];
}

describe("the feedback.json reader census", () => {
  const scratch: string[] = [];
  afterEach(() => scratch.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  it("every feedback.json reader is classified", () => {
    expect(censusProblems(REPO_ROOT, READERS)).toEqual([]);
  });

  it("an unclassified reader fails the census", () => {
    const root = mkdtempSync(path.join(tmpdir(), "feedback-census-"));
    scratch.push(root);
    for (const dir of ROOTS) mkdirSync(path.join(root, dir), { recursive: true });
    writeFileSync(path.join(root, "apps/console/server/new-reader.ts"), 'export const FILE = "feedback.json";\n');
    writeFileSync(path.join(root, "products/factory/src/claims-owner.ts"), "// isOwnerAnswer is only named here\nexport const read = (FeedbackSchema: unknown) => FeedbackSchema;\n");

    const problems = censusProblems(root, { "products/factory/src/claims-owner.ts": refuses("a synthetic reader") });

    expect(problems).toEqual([
      "apps/console/server/new-reader.ts reads feedback.json and is not in the census",
      "products/factory/src/claims-owner.ts is owner-only-refuses but its code never calls isOwnerAnswer",
    ]);
  });
});
