// What the visual-diff threshold (TP-4320) names a snapshot by. The measure itself, and the bounded decoder it reads
// through, live in @titan-design/png-delta.

const PLATFORM_SUFFIX = /-[a-z]+-(?:linux|darwin|win32)$/;
const SPEC_SUFFIX = /(?:\.screenshot)?\.(?:test|spec)\.[cm]?[jt]sx?-snapshots$/;

/**
 * The component a snapshot shows, for display only. A story shot (`<story-title>--<story>-chromium-linux.png`) names
 * its story title; a specimen shot names its spec's stem and the snapshot, as `<spec>/<snapshot>`.
 */
export function componentOf(path: string): string {
  const parts = path.split("/");
  const name = (parts.at(-1) ?? "").replace(/\.png$/, "").replace(PLATFORM_SUFFIX, "");
  const story = name.indexOf("--");
  if (story > 0) return name.slice(0, story);
  const dir = parts.at(-2) ?? "";
  return SPEC_SUFFIX.test(dir) ? `${dir.replace(SPEC_SUFFIX, "")}/${name}` : name;
}
