/**
 * In-page geometry inspector for the render QA gate. `inspectScript(opts)` is the source of one expression that runs
 * every check over the page's current frame and evaluates to a `FrameInspection`.
 *
 * The page's own elements carry the exemptions and hints this reads (the data-qa-* protocol, README "The data-qa-*
 * protocol"). Text fully covered by a painted element is reported once as occluded and then left out of the other
 * checks. When several elements share a tag, class and text (a rail's arrows), a finding carries `twin`, its
 * element's place among them, so findings on two different arrows are two findings and do not hold as one.
 */
import { FRAME_RULE_STEPS } from './inspect-frame-rules.js'
import { GEOMETRY_STEPS } from './inspect-geometry.js'
import { LAYOUT_STEPS } from './inspect-layout.js'
import { OVERLAP_STEPS } from './inspect-overlap.js'
import type { FrameInspection, InspectOptions, Inspector, Steps } from './inspect-types.js'

export type { Finding, FrameInspection, InspectOptions, Rect4 } from './inspect-types.js'

export const DEFAULT_OPTIONS: InspectOptions = {
  W: 1920, H: 1080, floorPx: 40, minContrast: 4.5, largeContrast: 3, largePx: 40, clearPx: 6, anchorTolPx: 4, edgeLabelReachPx: 60,
  chromeSelector: '.xp-chrome', furnitureSelector: '.xp-chrome, .xp-legend', bandSelector: '.xp-band-top, .xp-band-bottom',
}

function inspect(h: Inspector): FrameInspection {
  const allRuns = h.textRuns()
  h.markOccluded(allRuns)
  const runs = allRuns.filter((r) => !r.hidden)
  const boxes = h.visibleBoxes()
  h.checkTextOverlap(runs)
  h.checkTextBox(runs, boxes)
  h.checkBoxes(boxes)
  h.checkEdgeCrossing(runs, boxes)
  h.checkRuns(runs)
  h.checkOverflow(boxes, runs)
  h.checkCrowding(runs, boxes)
  h.checkWraps()
  h.checkFlexWrap()
  h.checkAnchors()
  h.checkEdgeLabelReach()
  h.checkDroppedLabels()
  h.checkDoubleChrome()
  h.checkUnderChrome(runs)
  h.checkFillOrder()
  h.checkTone()
  h.checkCardText()
  h.checkAdjacent(runs)
  h.checkLevel()
  const content = runs.filter((r) => !r.el.closest(h.opts.furnitureSelector)).length
  return { findings: h.findings, textRuns: runs.length, contentRuns: content }
}

const STEPS: Steps = { ...GEOMETRY_STEPS, ...OVERLAP_STEPS, ...LAYOUT_STEPS, ...FRAME_RULE_STEPS, inspect }

/** Runs in the page: binds each step to one inspector object, so steps reach each other by name whatever a bundler renames. */
function runInspector(steps: Record<string, (h: unknown, ...args: unknown[]) => unknown>, opts: InspectOptions): unknown {
  const ctx = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true })
  const bound: Record<string, (...args: unknown[]) => unknown> = {}
  const h = Object.assign(bound, { opts, findings: [], ctx })
  for (const [name, step] of Object.entries(steps)) h[name] = (...args: unknown[]) => step(h, ...args)
  return h.inspect?.()
}

const STEPS_SOURCE = `{ ${Object.entries(STEPS).map(([name, step]) => `${name}: ${String(step)}`).join(', ')} }`

/** The source of an expression that inspects the page's current frame, for `page.evaluate(inspectScript(opts))`. */
export function inspectScript(opts: InspectOptions): string {
  return `(${String(runInspector)})(${STEPS_SOURCE}, ${JSON.stringify(opts)})`
}
