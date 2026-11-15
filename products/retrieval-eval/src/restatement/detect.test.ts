import { describe, expect, it } from 'vitest';
import { detectRestatement } from './detect.js';

const known = new Set(['TP-101', 'TP-202']);

describe('detectRestatement', () => {
  it('flags a decision restatement', () => {
    const hit = detectRestatement('As I said, we decided to ship the parser first.', known);
    expect(hit).toEqual({ kind: 'decision', cue: 'as i said' });
  });

  it('flags a task restatement and returns the known task id', () => {
    const hit = detectRestatement('I already told you TP-101 needs a changeset.', known);
    expect(hit).toEqual({ kind: 'task', cue: 'i already told', ref: 'TP-101' });
  });

  it('flags a session restatement', () => {
    const hit = detectRestatement('Like I mentioned in the earlier session, keep the CLI thin.', known);
    expect(hit).toEqual({ kind: 'session', cue: 'like i mentioned' });
  });

  it('flags other restatements with no decision, task or session wording', () => {
    const hit = detectRestatement('Remember that the fixtures stay synthetic.', known);
    expect(hit).toEqual({ kind: 'other', cue: 'remember that' });
  });

  it('treats an unknown task id as not a task', () => {
    const hit = detectRestatement('As I said, TP-999 is the one that matters.', known);
    expect(hit).toEqual({ kind: 'other', cue: 'as i said' });
  });

  it('prefers task over decision when both are present', () => {
    const hit = detectRestatement('We decided on TP-202 already.', known);
    expect(hit?.kind).toBe('task');
    expect(hit?.ref).toBe('TP-202');
  });

  it('ignores a bare try again', () => {
    expect(detectRestatement('Try again.', known)).toBeNull();
    expect(detectRestatement('That failed, run it again please', known)).toBeNull();
  });

  it('ignores a cue that only appears inside a code block', () => {
    const text = 'Please review:\n```\n// as I said, we decided this\n```\nthanks';
    expect(detectRestatement(text, known)).toBeNull();
  });

  it('ignores a cue inside inline code', () => {
    expect(detectRestatement('The string `as I said` is a log label.', known)).toBeNull();
  });

  it('ignores a prompt naming a task id with no cue', () => {
    expect(detectRestatement('Please pick up TP-101 next.', known)).toBeNull();
  });
});
