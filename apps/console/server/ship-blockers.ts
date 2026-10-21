/**
 * What keeps a Ship round from shipping (TP-3741): earlier feedback on the same unit that the owner has not
 * ticked as addressed, and any change request in the answer being sent (owner item 166: free text, or a
 * pick that differs from the implemented choice). The page disables Ship for these reasons and
 * `rounds.submit` refuses a Ship pick for the same ones, so this module imports types only and runs in both.
 * An answer the owner marks follow-up (TP-3346) is filed for later instead, so it never blocks. A frame's comment,
 * pin or Rejected verdict asks for a change as a comment does (TP-3773 S6b); Chosen or Maybe alone does not.
 */
import type { Feedback, Manifest, Question } from "./round-schema.js";

/** One earlier round's feedback, verbatim: its non-Ship pick, comments and round note. */
export interface PriorFeedback {
  round: number;
  submittedAt: string;
  pick?: string;
  revisionRequested?: true;
  comment?: string;
  general?: string;
  /** One line per frame that round left feedback on. */
  frames?: string[];
  /** In a round with several Ship questions (TP-3329), the `repo#pr` this entry's feedback was on; it blocks only that PR. */
  pr?: string;
}

export interface DraftAnswer {
  questionId: string;
  pick?: string;
  revisionRequested?: true;
  picks?: string[];
  comment?: string;
}

/** A frame's verdict, comment and pins, as drafted or as sent in feedback `variants`. */
interface DraftFrame {
  key: string;
  verdict?: "chosen" | "rejected" | "maybe" | null;
  comment?: string;
  annotations?: readonly { note: string }[];
}

/** The answer about to be sent: every answer with its comment, the round note, the rounds ticked Addressed and the follow-ups. */
interface ShipDraft {
  answers: readonly DraftAnswer[];
  general: string;
  addressed: readonly number[];
  /** The side questions marked follow-up; absent is none. */
  followUps?: readonly string[];
  /** The frames' feedback; absent is none. */
  variants?: readonly DraftFrame[];
}

interface EarlierRound {
  manifest: Manifest;
  feedback: Feedback | null;
  /** The questions that round filed as follow-ups, whose comments are not this PR's to address. */
  followUps?: readonly string[];
}

type PickOne = Extract<Question, { kind: "pick-one" }>;
type MergeQuestion = PickOne & { merge: NonNullable<PickOne["merge"]> };

const isMerge = (question: Question): question is MergeQuestion => question.kind === "pick-one" && question.merge !== undefined;
const blank = (text: string | undefined): boolean => (text ?? "").trim() === "";
const pageOf = (question: MergeQuestion): string => `${question.merge.repo}#${question.merge.pr}`;

/** The merge question's comment first, as it is the one a Send back carries. */
function commentsOf(answers: readonly Feedback["answers"][number][], mergeId: string | undefined): string[] {
  const ordered = [...answers].sort((left, right) => Number(right.questionId === mergeId) - Number(left.questionId === mergeId));
  return ordered.flatMap((answer) => (blank(answer.comment) ? [] : [answer.comment ?? ""]));
}

/** Words the fixer gets: a frame's comment or a pin. */
const hasWords = (frame: DraftFrame): boolean => !blank(frame.comment) || (frame.annotations ?? []).length > 0;
const asksChange = (frame: DraftFrame): boolean => hasWords(frame) || frame.verdict === "rejected";
const labelOf = (manifest: Manifest, key: string): string => manifest.variants.find((variant) => variant.key === key)?.label ?? key;

function frameLine(manifest: Manifest, frame: DraftFrame): string {
  const head = frame.verdict ? `${labelOf(manifest, frame.key)} (${frame.verdict})` : labelOf(manifest, frame.key);
  const words = [...(blank(frame.comment) ? [] : [(frame.comment ?? "").trim()]), ...(frame.annotations ?? []).map((pin, index) => `pin ${index + 1}: ${pin.note.trim()}`)];
  return words.length === 0 ? head : `${head}: ${words.join("; ")}`;
}

/** One earlier round's feedback as one PR saw it: that PR's merge answer, and the answers and frames in its scope. */
function feedbackItem({ manifest, feedback, followUps = [] }: EarlierRound & { feedback: Feedback }, merge: MergeQuestion | undefined, pr?: string): PriorFeedback | null {
  const answer = merge && feedback.answers.find((each) => each.questionId === merge.id);
  const pick = answer?.pick !== undefined && !(merge?.merge.ship ?? []).includes(answer.pick) ? answer.pick : undefined;
  const scope = pr === undefined || merge === undefined ? undefined : { answers: shipScope(manifest, merge.id), frames: frameScope(manifest, merge.id) };
  const answers = feedback.answers.filter((each) => !followUps.includes(each.questionId) && (scope?.answers.has(each.questionId) ?? true));
  const comment = commentsOf(answers, answer?.questionId).join("\n\n");
  const frames = feedback.variants.filter((frame) => asksChange(frame) && (scope?.frames.has(frame.key) ?? true)).map((frame) => frameLine(manifest, frame));
  const words: Omit<PriorFeedback, "round" | "submittedAt" | "pr"> = {
    ...(pick !== undefined && { pick }),
    ...(answer?.revisionRequested && { revisionRequested: true as const }),
    ...(comment !== "" && { comment }),
    ...(!blank(feedback.general) && { general: feedback.general }),
    ...(frames.length > 0 && { frames }),
  };
  return Object.keys(words).length > 0 ? { round: manifest.round, submittedAt: feedback.submittedAt, ...words, ...(pr !== undefined && { pr }) } : null;
}

/** A round with several Ship questions gives one entry per PR the current round still asks about; any other round one entry. */
function feedbackItems(earlier: EarlierRound & { feedback: Feedback }, asked: ReadonlySet<string>): (PriorFeedback | null)[] {
  const merges = earlier.manifest.questions.filter(isMerge);
  if (merges.length < 2) return [feedbackItem(earlier, merges[0])];
  return merges.filter((merge) => asked.has(pageOf(merge))).map((merge) => feedbackItem(earlier, merge, pageOf(merge)));
}

/** Earlier sent rounds of the same unit that asked for anything but a plain Ship, oldest first. */
export function priorFeedback(manifest: Manifest, rounds: readonly EarlierRound[]): PriorFeedback[] {
  const asked = new Set(manifest.questions.filter(isMerge).map(pageOf));
  return rounds
    .flatMap(({ manifest: earlier, feedback, followUps }) =>
      earlier.unit === manifest.unit && earlier.round < manifest.round && feedback !== null ? feedbackItems({ manifest: earlier, feedback, followUps }, asked) : [],
    )
    .filter((item): item is PriorFeedback => item !== null)
    .sort((left, right) => left.round - right.round || left.submittedAt.localeCompare(right.submittedAt));
}

/** What a side pick must match to ship: what the PR implements, else a recommendation the page already shows. */
function expectedChoice(manifest: Manifest, question: Question): readonly string[] | undefined {
  if (question.kind !== "pick-one" && question.kind !== "pick-many") return undefined;
  if (question.implemented !== undefined) return [question.implemented].flat();
  const recommended = manifest.recommendations === "shown" ? question.recommendation?.answer : undefined;
  return typeof recommended === "string" || Array.isArray(recommended) ? [recommended].flat() : undefined;
}

function differs(expected: readonly string[], answer: DraftAnswer): boolean {
  if (answer.revisionRequested) return true;
  if (answer.pick !== undefined) return !expected.includes(answer.pick);
  if (answer.picks === undefined) return false;
  return answer.picks.length !== expected.length || answer.picks.some((pick) => !expected.includes(pick));
}

/** Why this one answer would keep the round from shipping; empty when it is informational. */
export function answerBlockers(manifest: Manifest, answer: DraftAnswer): string[] {
  const question = manifest.questions.find((each) => each.id === answer.questionId);
  if (question === undefined) return [];
  const expected = isMerge(question) ? undefined : expectedChoice(manifest, question);
  return [
    ...(blank(answer.comment) ? [] : [`you left a comment on "${question.prompt}"`]),
    ...(expected !== undefined && differs(expected, answer) ? [`your answer to "${question.prompt}" differs from the implemented choice`] : []),
  ];
}

/** What on a side question blocks Ship: a pick-one's other options, a pick-many's every set but one, else only a comment. */
type ShipStake = { kind: "picks"; blocking: string[] } | { kind: "set"; expected: readonly string[] } | { kind: "comment" };

export function shipStake(manifest: Manifest, question: Question): ShipStake {
  const expected = isMerge(question) ? undefined : expectedChoice(manifest, question);
  if (expected === undefined) return { kind: "comment" };
  if (question.kind === "pick-many") return { kind: "set", expected };
  const options = question.kind === "pick-one" ? question.options : [];
  return { kind: "picks", blocking: options.filter((option) => !expected.includes(option)) };
}

/**
 * The questions whose answers bear on shipping one merge question: in a round with several (TP-3329), its own PR group's and
 * those no group claims, never another PR's; in a round with one, every question.
 */
export function shipScope(manifest: Manifest, mergeId: string): ReadonlySet<string> {
  const merges = manifest.questions.filter(isMerge);
  const all = new Set(manifest.questions.map((question) => question.id));
  const merge = merges.find((question) => question.id === mergeId);
  if (merges.length < 2 || merge === undefined || manifest.prGroups === undefined) return all;
  const groupOf = new Map(manifest.prGroups.flatMap((group) => group.sectionIds.map((sectionId) => [sectionId, group.pr] as const)));
  const claimedBy = new Map(manifest.sections.flatMap((section) => section.questionIds.map((id) => [id, groupOf.get(section.id)] as const)));
  const own = pageOf(merge);
  return new Set([...all].filter((id) => (claimedBy.get(id) ?? own) === own && (id === mergeId || !merges.some((other) => other.id === id))));
}

/**
 * The frames whose feedback bears on shipping one merge question: in a round with several, those its own PR group's sections
 * show and those no group shows; in a round with one, every frame. A frame belongs to the PR its montage belongs to.
 */
export function frameScope(manifest: Manifest, mergeId: string): ReadonlySet<string> {
  const all = manifest.variants.map((variant) => variant.key);
  const merge = manifest.questions.filter(isMerge).find((question) => question.id === mergeId);
  if (manifest.questions.filter(isMerge).length < 2 || merge === undefined || manifest.prGroups === undefined) return new Set(all);
  const keysOf = (group: NonNullable<Manifest["prGroups"]>[number]) => manifest.sections.filter((section) => group.sectionIds.includes(section.id)).flatMap((section) => section.variantKeys);
  const own = new Set(manifest.prGroups.filter((group) => group.pr === pageOf(merge)).flatMap(keysOf));
  const claimed = new Set(manifest.prGroups.flatMap(keysOf));
  return new Set(all.filter((key) => own.has(key) || !claimed.has(key)));
}

const NEEDS_NOTE = "Send back needs a note: say what to fix in the Ship comment or the round note.";

/**
 * Why one PR's Send back is off; undefined when it may go. The fixer's note is the round note and the comment
 * on that PR's own Ship question, and the factory refuses an empty one, so Send back waits for one of them
 * (owner decision 513). A note on another PR's Ship question does not count, and unanswered side questions
 * go with it as unanswered. A frame's comment or pin reaches the fixer too (TP-3799), so it is a note; the
 * caller passes only the frames `frameScope` gives this PR.
 */
export function sendBackBlocker(draft: Pick<ShipDraft, "answers" | "general" | "variants">, mergeId: string): string | undefined {
  const note = draft.answers.find((answer) => answer.questionId === mergeId)?.comment;
  return blank(note) && blank(draft.general) && !(draft.variants ?? []).some(hasWords) ? NEEDS_NOTE : undefined;
}

/** The PR a Ship answers: `mergeId`'s, else the round's one Ship question's. */
function shippingPr(manifest: Manifest, mergeId: string | undefined): string | undefined {
  const merges = manifest.questions.filter(isMerge);
  const merge = mergeId === undefined ? (merges.length === 1 ? merges[0] : undefined) : merges.find((question) => question.id === mergeId);
  return merge && pageOf(merge);
}

/** Why Ship is off, in plain words; empty when it may ship. Given `mergeId`, only that PR's answers count (`shipScope`). */
export function shipBlockers(manifest: Manifest, prior: readonly PriorFeedback[], draft: ShipDraft, mergeId?: string): string[] {
  const pr = shippingPr(manifest, mergeId);
  const ours = prior.filter((item) => item.pr === undefined || item.pr === pr);
  const open = [...new Set(ours.filter((item) => !draft.addressed.includes(item.round)).map((item) => item.round))];
  const scope = mergeId === undefined ? undefined : shipScope(manifest, mergeId);
  const thisPr = draft.answers.filter((answer) => !(draft.followUps ?? []).includes(answer.questionId) && (scope?.has(answer.questionId) ?? true));
  const frames = mergeId === undefined ? undefined : frameScope(manifest, mergeId);
  const judged = (draft.variants ?? []).filter((frame) => asksChange(frame) && (frames?.has(frame.key) ?? true));
  return [
    ...open.map((round) => `your feedback from round ${round} is not ticked Addressed`),
    ...thisPr.flatMap((answer) => answerBlockers(manifest, answer)),
    ...judged.map((frame) => `you left feedback on frame "${labelOf(manifest, frame.key)}"`),
    ...(blank(draft.general) ? [] : ["you left feedback on this round"]),
  ];
}
