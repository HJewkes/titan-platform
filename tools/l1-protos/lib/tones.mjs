// Styling metadata only: which area colours each element. Areas take titan's categorical palette
// in rank order (largest area first), and only the first six, which are the CVD-safe ones
// (CATEGORICAL_CVD_SAFE_MAX in titan-design's primitives.ts). Later areas and the standalone
// bucket are "other". Layout never reads this.
const CVD_SAFE = 6;
const PREFIX = /^(pkg|more|top|bot|file):/;

export function toneOf(model) {
  const rank = new Map(model.areas.filter((a) => a.id !== "area:standalone").map((a, i) => [a.id, i]));
  const areaOf = (key) => {
    if (rank.has(key) || key.startsWith("area:")) return key;
    const pkg = model.packages.get(key) ?? model.packages.get(model.packageOf(key));
    return pkg?.area;
  };
  return (id) => {
    if (!PREFIX.test(id) && !id.startsWith("area:")) return undefined;
    const area = areaOf(id.replace(PREFIX, ""));
    if (area === undefined) return undefined;
    const r = rank.get(area);
    return r !== undefined && r < CVD_SAFE ? String(r) : "other";
  };
}

/** The frame with a `tone` on every box-like element that belongs to an area. */
export function withTones(frame, tone) {
  const elements = frame.elements.map((e) => {
    if (e.kind === "edge" || e.kind === "elabel" || e.kind === "band") return e;
    const t = tone(e.id);
    return t === undefined ? e : { ...e, tone: t };
  });
  return { ...frame, elements };
}
