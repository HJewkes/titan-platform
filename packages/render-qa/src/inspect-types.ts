/** Options and shapes the in-page inspector shares with Node. Types only: nothing here runs in the page. */

export interface InspectOptions {
  W: number
  H: number
  /** Computed font sizes under this are small-text. */
  floorPx: number
  /** WCAG ratio for text under `largePx`. */
  minContrast: number
  /** WCAG ratio for text at or over `largePx`. */
  largeContrast: number
  largePx: number
  /** Unrelated items closer than this without touching are crowding. */
  clearPx: number
  /** Anchored elements further than this from their anchor centre are anchor-offset. */
  anchorTolPx: number
  /** An edge label whose box is further than this from its own edge's line is edge-label-far (titan's EDGE_REACH). */
  edgeLabelReachPx: number
  /** Subtrees skipped by the crowding check. */
  chromeSelector: string
  /** Subtrees that do not count as stage content in `contentRuns`. */
  furnitureSelector: string
  /** The bands stage content must stay out of. */
  bandSelector: string
}

export interface Rect4 { x: number; y: number; w: number; h: number }

export interface Finding {
  kind: string
  el: string
  text?: string
  other?: string
  otherEl?: string
  by?: string
  byText?: string
  edge?: string
  orphan?: boolean
  /** off-frame: the painted rect has no area on the frame, so nothing of it shows at this sample. */
  parked?: boolean
  op?: number
  px?: number
  ratio?: number
  /** low-contrast: the ratio the run's size needed, and its text and ground colours as drawn, `#rrggbb`. */
  need?: number
  fg?: string
  bg?: string
  /** Which of several same-looking elements this is, in page order; absent when the element has no twin. */
  twin?: number
  /** Where to draw the annotation: the ink or box the finding is about. */
  at: Rect4
  [detail: string]: unknown
}

export interface FrameInspection {
  findings: Finding[]
  textRuns: number
  /** Visible text runs outside the chrome and legend. */
  contentRuns: number
}

export interface Rect { left: number; top: number; right: number; bottom: number; width: number; height: number }
export interface Run { node: Node; el: Element; text: string; op: number; px: number; lines: Rect[]; box: Rect; hidden?: boolean }
export interface Item { el: Element; r: Rect }
export type Rgba = [number, number, number, number]
export type Rgb = [number, number, number]

/**
 * The inspector as the page sees it: every step bound to this object, so a step calls another as `h.name(...)`.
 * Steps are serialised one by one, so this indirection, not a module-scope call, is how they reach each other.
 */
export interface Inspector {
  opts: InspectOptions
  findings: Finding[]
  ctx: CanvasRenderingContext2D
  rgba(css: string): Rgba
  opacity(el: Element | null): number
  describe(el: Element): string
  r4(r: { left: number; top: number; width: number; height: number }): Rect4
  rect(left: number, top: number, right: number, bottom: number): Rect
  inter(a: Rect, b: Rect): { w: number; h: number } | null
  shrink(r: Rect, d: number): Rect
  unionRect(rs: Rect[]): Rect
  asR(r: DOMRect): Rect
  /** True when `r` has no area on the frame: whatever it holds is not on screen. */
  parked(r: Rect): boolean
  related(a: Element, b: Element): boolean
  decor(el: Element): boolean
  inFlight(el: Element): boolean
  within(inner: Rect, outer: Rect): boolean
  sitsOn(a: Item, b: Item): boolean
  isBox(el: Element): boolean
  isPainted(el: Element): boolean
  textOf(el: Element): string
  twinOf(el: Element): { twin?: number }
  add(kind: string, el: Element, detail: Record<string, unknown> & { rect?: Rect4 }): void
  ink(line: Rect, px: number): Rect
  mergeLines(rects: DOMRect[]): Rect[]
  textRuns(): Run[]
  coverAt(el: Element, x: number, y: number): Element | null
  markOccluded(runs: Run[]): void
  checkTextOverlap(runs: Run[]): void
  visibleBoxes(): Item[]
  checkTextBox(runs: Run[], boxes: Item[]): void
  checkBoxes(boxes: Item[]): void
  strokes(): SVGGeometryElement[]
  drawnPoints(path: SVGGeometryElement): [number, number][]
  strokeShows(path: Element, target: Element, x: number, y: number): boolean
  checkEdgeCrossing(runs: Run[], boxes: Item[]): void
  innerOf(el: Element): Rect
  checkOverflow(boxes: Item[], runs: Run[]): void
  checkCrowding(runs: Run[], boxes: Item[]): void
  checkRuns(runs: Run[]): void
  checkEscape(run: Run): void
  checkWraps(): void
  clusterLines(rects: DOMRect[]): Rect[]
  flexItems(el: Element): Element[]
  checkFlexWrap(): void
  checkAnchors(): void
  checkEdgeLabelReach(): void
  checkDroppedLabels(): void
  pageBg(): Rgb
  blend(c: Rgba, op: number, under: Rgb): Rgb
  bgBehind(el: Element): Rgb
  lum(c: Rgb): number
  hex(c: Rgb): string
  checkContrast(run: Run): void
  turned(el: Element): boolean
  insetOf(e: Element): Rect | undefined
  clipped(el: Element, r: Rect): Rect | null
  shown(el: Element): boolean
  checkDoubleChrome(): void
  checkUnderChrome(runs: Run[]): void
  checkFillOrder(): void
  checkTone(): void
  checkCardText(): void
  checkAdjacent(runs: Run[]): void
  checkLevel(): void
  inspect(): FrameInspection
}

type StepName = { [K in keyof Inspector]: Inspector[K] extends (...args: never[]) => unknown ? K : never }[keyof Inspector]
type Unbound<F> = F extends (...args: infer A) => infer R ? (h: Inspector, ...args: A) => R : never

/** Each step takes the inspector first; `bindInspector` in the page drops that argument for callers. */
export type Steps = { [K in StepName]: Unbound<Inspector[K]> }
export type PartialSteps<K extends StepName> = { [P in K]: Unbound<Inspector[P]> }
