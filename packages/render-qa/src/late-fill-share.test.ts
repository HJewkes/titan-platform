import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'vitest'
import { LATE_FILL_SHARE } from './held.js'

const SAMPLES = new URL('./fixtures/samples/', import.meta.url)
function read<T>(name: string): T {
  const parsed: T = JSON.parse(readFileSync(new URL(name, SAMPLES), 'utf8'))
  return parsed
}

interface WordsBeat { id: string; durationS: number; words: { word: string; start: number }[] }
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9%]/g, '')

function wordsBeat(id: string): WordsBeat {
  const beat = read<{ beats: WordsBeat[] }>('demo.words.json').beats.find((b) => b.id === id)
  if (!beat) throw new Error(`demo.words.json has no beat ${id}`)
  return beat
}

/** Beat-local seconds of `word#n`, the nth spoken occurrence, as a page's cueAt reads it. */
function cueSeconds(beat: WordsBeat, atCue: string): number {
  const [word, nth] = atCue.split('#')
  const hit = beat.words.filter((w) => norm(w.word) === norm(word ?? ''))[(nth ? Number(nth) : 1) - 1]
  assert.ok(hit, `${beat.id}: no spoken "${atCue}"`)
  return hit.start
}

test('b3-cards shows both of its cards before the late-fill share of the beat', () => {
  const beat = wordsBeat('b3-cards')
  const visual = read<{ beats: { id: string; cues: { atCue: string }[] }[] }>('demo.visual.json').beats.find((b) => b.id === 'b3-cards')
  const latest = Math.max(...(visual?.cues ?? []).map((c) => cueSeconds(beat, c.atCue)))
  assert.ok(latest <= LATE_FILL_SHARE * beat.durationS, `last cue at ${latest} s is past ${LATE_FILL_SHARE * beat.durationS} s`)
})

// catches: a map beat holding its first station alone past the share while its other cues wait
test('b1-map puts a second station on stage before the late-fill share of the beat', () => {
  const beat = wordsBeat('b1-map')
  const visual = read<{ beats: { id: string; map_state: { reveal: { atCue: string }[] } }[] }>('demo.visual.json').beats.find((b) => b.id === 'b1-map')
  const second = (visual?.map_state.reveal ?? []).map((r) => cueSeconds(beat, r.atCue)).sort((a, b) => a - b)[1] ?? Infinity
  assert.ok(second <= LATE_FILL_SHARE * beat.durationS, `second station at ${second} s is past ${LATE_FILL_SHARE * beat.durationS} s`)
})
