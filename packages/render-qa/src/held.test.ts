import assert from 'node:assert/strict'
import { test } from 'vitest'
import { addLateFill, classify, type SampledFrame } from './held.js'
import type { Finding } from './inspect.js'

const finding = (kind: string, text = 'x', extra: Partial<Finding> = {}): Finding => ({ kind, el: 'div.a', text, at: { x: 0, y: 0, w: 10, h: 10 }, ...extra })
const frame = (beat: string, t: number, kind: SampledFrame['kind'], findings: Finding[], contentRuns = 5): SampledFrame =>
  ({ beat, local: t, t, kind, contentRuns, findings })

// Mutation: classify gates the transient branch, so one sample of an error kind is a held error.
test('a finding in one mid-beat sample is info, not an error (an entrance fade passing through)', () => {
  const held = classify([frame('a', 1, 'cue', [finding('text-overlap')]), frame('a', 2, 'mid', []), frame('a', 3, 'end', [])])

  assert.equal(held.errors.length, 0)
  assert.equal(held.info[0]?.reason, 'transient')
})

test('a finding in two consecutive samples of a beat is a held error', () => {
  const held = classify([frame('a', 1, 'cue', [finding('text-overlap')]), frame('a', 2, 'mid', [finding('text-overlap')]), frame('a', 3, 'end', [])])

  assert.deepEqual(held.errors.map((e) => [e.kind, e.samples, e.reason]), [['text-overlap', 2, 'held']])
})

test('the same text on two twin elements in neighbouring samples does not hold (two rail arrows, each mid-fade)', () => {
  const held = classify([frame('a', 1, 'cue', [finding('low-contrast', '→', { twin: 0 })]), frame('a', 2, 'cue', [finding('low-contrast', '→', { twin: 1 })]), frame('a', 3, 'end', [])])

  assert.equal(held.errors.length, 0)
})

test('two samples that are not neighbours do not hold', () => {
  const held = classify([frame('a', 1, 'cue', [finding('text-overlap')]), frame('a', 2, 'mid', []), frame('a', 3, 'cue', [finding('text-overlap')]), frame('a', 4, 'end', [])])

  assert.equal(held.errors.length, 0)
})

test('a single sample at the settled end moment is an error', () => {
  const held = classify([frame('a', 1, 'mid', []), frame('a', 2, 'end', [finding('small-text')])])

  assert.deepEqual(held.errors.map((e) => e.reason), ['settled'])
})

test('samples in neighbouring beats do not make one finding held', () => {
  const held = classify([frame('a', 1, 'mid', [finding('box-overlap')]), frame('b', 2, 'cue', [finding('box-overlap')]), frame('b', 3, 'end', [])])

  assert.equal(held.errors.length, 0)
})

test('kinds the gate does not own stay info however long they last', () => {
  const held = classify([frame('a', 1, 'mid', [finding('crowding')]), frame('a', 2, 'end', [finding('crowding')])])

  assert.equal(held.errors.length, 0)
  assert.equal(held.info[0]?.reason, 'info-kind')
})

test('a wrap is an error only when it leaves an orphan', () => {
  const held = classify([
    frame('a', 1, 'mid', [finding('wrap', 'ok', { orphan: false }), finding('wrap', 'bad', { orphan: true })]),
    frame('a', 2, 'end', [finding('wrap', 'ok', { orphan: false }), finding('wrap', 'bad', { orphan: true })]),
  ])

  assert.deepEqual(held.errors.map((e) => e.finding.text), ['bad'])
})

test('late-fill: a nearly empty stage past 35 % of the beat with cues pending is a finding', () => {
  const frames = [frame('a', 2, 'cue', [], 1), frame('a', 5, 'mid', [], 1), frame('a', 9.8, 'end', [], 4)]
  addLateFill(frames, [{ beat: 'a', atS: 8 }], new Map([['a', 10]]))

  assert.deepEqual(frames.map((f) => f.findings.length), [0, 1, 0])
})

test('late-fill skips a beat that shows a full stage at any moment', () => {
  const frames = [frame('a', 5, 'mid', [], 1), frame('a', 9.8, 'end', [], 12)]
  addLateFill(frames, [{ beat: 'a', atS: 8 }], new Map([['a', 10]]))

  assert.deepEqual(frames.map((f) => f.findings.length), [0, 0])
})

test('one late-fill sample gates: it is already a statement about the beat past 35 % of its length', () => {
  const held = classify([frame('a', 5, 'mid', [finding('late-fill', '1 runs, 2 cues pending')]), frame('a', 9.8, 'end', [])])

  assert.deepEqual(held.errors.map((e) => [e.kind, e.reason]), [['late-fill', 'timing']])
})

test('a dropped label held across two samples is an error, one error per label id', () => {
  const dropped = (id: string) => finding('label-dropped', id)
  const held = classify([frame('a', 1, 'cue', [dropped('e:x'), dropped('a#pin1')]), frame('a', 2, 'mid', [dropped('e:x'), dropped('a#pin1')]), frame('a', 3, 'end', [])])

  assert.deepEqual(held.errors.map((e) => [e.kind, e.finding.text]), [['label-dropped', 'e:x'], ['label-dropped', 'a#pin1']])
})

// catches: a one-frame overprint at a beat boundary passing as a transient
test('one sample of a double chrome or of text under a chrome band gates', () => {
  const held = classify([frame('a', 0, 'start', [finding('double-chrome')]), frame('b', 5.3, 'enter', [finding('under-chrome', 'workspace')])])

  assert.deepEqual(held.errors.map((e) => [e.kind, e.reason]), [['double-chrome', 'frame'], ['under-chrome', 'frame']])
})

test('the start and enter moments read only the frame kinds; an entrance mid-fade there is not a finding', () => {
  const held = classify([frame('a', 0, 'start', [finding('low-contrast')]), frame('a', 0.3, 'enter', [finding('low-contrast')])])

  assert.deepEqual([held.errors, held.info], [[], []])
})

test('a kind left out of the gate list stays info however long it holds', () => {
  const frames = [frame('a', 1, 'cue', [finding('small-text')]), frame('a', 2, 'mid', [finding('small-text')]), frame('a', 3, 'end', [finding('small-text')])]

  const held = classify(frames, { gate: ['text-overlap'] })

  assert.deepEqual([held.errors, held.info.map((i) => [i.kind, i.reason])], [[], [['small-text', 'info-kind']]])
})
