type RestatementKind = 'decision' | 'task' | 'session' | 'other';

interface Restatement {
  kind: RestatementKind;
  cue: string;
  ref?: string;
}

// A bare "again" is deliberately absent: retries are not restatements.
const CUE =
  /\b(as i (?:said|mentioned|told you)|i already (?:told|said|mentioned)|we (?:already )?decided|like i (?:said|mentioned)|remember that|i (?:told|said to) you)\b/i;
const DECISION = /\b(decid(?:ed|e|ing)|decisions?)\b/i;
const SESSION = /\b(?:(?:earlier|previous|prior|last|other) session|session [\w-]+)\b/i;
const TASK_ID = /\b[A-Z][A-Z0-9]*-\d+\b/g;

function stripCode(text: string): string {
  return text.replace(/```[\s\S]*?(?:```|$)/g, ' ').replace(/`[^`\n]*`/g, ' ');
}

function firstKnownTask(text: string, knownTaskIds: ReadonlySet<string>): string | undefined {
  return (text.match(TASK_ID) ?? []).find((id) => knownTaskIds.has(id));
}

export function detectRestatement(
  prompt: string,
  knownTaskIds: ReadonlySet<string>,
): Restatement | null {
  const text = stripCode(prompt);
  const cue = CUE.exec(text);
  if (!cue) return null;
  const hit = { cue: cue[1]!.toLowerCase() };
  const ref = firstKnownTask(text, knownTaskIds);
  if (ref) return { kind: 'task', ...hit, ref };
  if (DECISION.test(text)) return { kind: 'decision', ...hit };
  if (SESSION.test(text)) return { kind: 'session', ...hit };
  return { kind: 'other', ...hit };
}
