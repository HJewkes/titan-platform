/*!
 * The question bounds and `questionsIssue` are adapted from openrig,
 * https://github.com/mvschwarz/openrig, packages/daemon/src/domain/human-questions.ts
 * (parseHumanQuestions). Copyright 2026 Mike Schwarz, licensed under the Apache License 2.0,
 * http://www.apache.org/licenses/LICENSE-2.0.
 * Changed here: the checks report through GateBriefInvalid instead of a result union, and
 * `recommended` keeps only `true`.
 * @license Apache-2.0
 */
import { isAnchorForm, verifyAnchorText, type AnchorPins, type RevisionSource } from "@titan-design/evidence";
import { GateBriefInvalid, type GateQuestion, type GateQuestionOption } from "./types.js";

const MAX_SUMMARY = 280;
const MAX_EVIDENCE_REF = 500;
const MAX_QUESTIONS = 4;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;
/** Slack's button text limit, so every option fits on a button. */
const MAX_OPTION_LABEL = 75;
const MAX_QUESTION_TEXT = 500;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;
const ID_RULE = 'id must be 1-40 letters, digits, "-" or "_"';
// eslint-disable-next-line no-control-regex -- a control character is exactly what a one-line field refuses
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;

export interface GateBriefSnapshot {
  summary: string | undefined;
  evidenceRef: string | undefined;
  questions: GateQuestion[] | undefined;
}

/** The pinned commits and their file text, against which an anchor-form evidenceRef is checked. */
interface BriefAnchorCheck {
  pins: AnchorPins;
  source: RevisionSource;
}

/**
 * Checks the brief fields and returns a copy holding only the declared ones, so a caller
 * cannot change the stored questions after `create`. `required` makes `summary` and `evidenceRef` mandatory; without it they are still checked when present.
 * With `anchors`, an evidenceRef written as an anchor (`head/<path>#L10-L20`) must hold at its pinned commit; free text stays legal.
 */
export function snapshotBrief(gateId: string, raw: unknown, required: boolean, anchors?: BriefAnchorCheck): Readonly<GateBriefSnapshot> {
  const { summary, evidenceRef, questions } = asRecord(raw);
  const issues = [
    ...lineIssues("summary", summary, MAX_SUMMARY, required),
    ...lineIssues("evidenceRef", evidenceRef, MAX_EVIDENCE_REF, required),
  ];
  if (anchors) issues.push(...anchorIssues(evidenceRef, anchors));
  const questionIssue = questions === undefined ? undefined : questionsIssue(questions);
  if (questionIssue) issues.push(questionIssue);
  if (issues.length > 0) throw new GateBriefInvalid(gateId, issues);
  return Object.freeze({
    summary: typeof summary === "string" ? summary : undefined,
    evidenceRef: typeof evidenceRef === "string" ? evidenceRef : undefined,
    questions: Array.isArray(questions) ? copyQuestions(questions) : undefined,
  });
}

function lineIssues(field: string, value: unknown, max: number, required: boolean): string[] {
  if (value === undefined) return required ? [`${field} is required`] : [];
  if (typeof value !== "string") return [`${field} must be a string`];
  if (value.trim() === "") return [`${field} is blank`];
  if (value.length > max) return [`${field} is over ${max} characters`];
  if (CONTROL_CHAR.test(value)) return [`${field} must be one line with no control characters`];
  return [];
}

function anchorIssues(evidenceRef: unknown, { pins, source }: BriefAnchorCheck): string[] {
  if (typeof evidenceRef !== "string" || !isAnchorForm(evidenceRef)) return [];
  const check = verifyAnchorText(evidenceRef, pins, source);
  return check.ok ? [] : [`evidenceRef ${check.detail}`];
}

function questionsIssue(value: unknown): string | undefined {
  if (!Array.isArray(value)) return "questions must be an array";
  if (value.length < 1 || value.length > MAX_QUESTIONS) return `ask 1 to ${MAX_QUESTIONS} questions (got ${value.length})`;
  const ids = new Set<string>();
  for (const [index, raw] of value.entries()) {
    const question = asRecord(raw);
    const where = `question ${index + 1}`;
    if (typeof question.id !== "string" || !ID_PATTERN.test(question.id)) return `${where}: ${ID_RULE}`;
    if (ids.has(question.id)) return `${where}: duplicate question id "${question.id}"`;
    ids.add(question.id);
    const issue = questionTextIssue(question.question) ?? optionsIssue(question.options);
    if (issue) return `${where}: ${issue}`;
  }
  return undefined;
}

function questionTextIssue(text: unknown): string | undefined {
  if (typeof text !== "string" || text.trim() === "") return "question text is required";
  if (text.length > MAX_QUESTION_TEXT) return `question text is over ${MAX_QUESTION_TEXT} characters`;
  return undefined;
}

function optionsIssue(options: unknown): string | undefined {
  if (!Array.isArray(options) || options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
    return `give ${MIN_OPTIONS} to ${MAX_OPTIONS} options`;
  }
  const ids = new Set<string>();
  let recommended = 0;
  for (const [index, raw] of options.entries()) {
    const option = asRecord(raw);
    const issue = optionIssue(option, ids);
    if (issue) return `option ${index + 1}: ${issue}`;
    if (typeof option.id === "string") ids.add(option.id);
    if (option.recommended === true) recommended++;
  }
  return recommended > 1 ? "mark at most one option as recommended" : undefined;
}

function optionIssue(option: Record<string, unknown>, seen: ReadonlySet<string>): string | undefined {
  if (typeof option.id !== "string" || !ID_PATTERN.test(option.id)) return ID_RULE;
  if (seen.has(option.id)) return `duplicate option id "${option.id}"`;
  if (typeof option.label !== "string" || option.label.trim() === "") return "label is required";
  if (option.label.length > MAX_OPTION_LABEL) return `label is over ${MAX_OPTION_LABEL} characters`;
  if (option.recommended !== undefined && typeof option.recommended !== "boolean") return "recommended must be true or false";
  return undefined;
}

/** Keeps only the declared fields, so nothing a caller attached rides along into the row. Runs after `questionsIssue` has accepted the shape. */
function copyQuestions(questions: readonly unknown[]): GateQuestion[] {
  return questions.map((raw) => {
    const question = asRecord(raw);
    const options: readonly unknown[] = Array.isArray(question.options) ? question.options : [];
    return { id: text(question.id), question: text(question.question), options: options.map(copyOption) };
  });
}

function copyOption(raw: unknown): GateQuestionOption {
  const option = asRecord(raw);
  const base = { id: text(option.id), label: text(option.label) };
  return option.recommended === true ? { ...base, recommended: true } : base;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
