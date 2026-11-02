import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";
import type { TimingRun } from "./artifact.js";
import type { RawRef } from "./store.js";

export const fileSafeId = (id: string) => id.replace(/[^\w.-]+/g, "_");

/**
 * Writes one record gzipped under `<home>/raw/<runner>/<yyyy-mm>/` and appends its checksum to that month's
 * SHA256SUMS, so the corpus can always be rebuilt from raw alone and a tampered file is detectable.
 */
export function archiveRaw(home: string, run: Pick<TimingRun, "id" | "runner" | "startedAt">, body: string): RawRef {
  const dir = join(home, "raw", fileSafeId(run.runner), run.startedAt.slice(0, 7));
  mkdirSync(dir, { recursive: true });
  const name = `${fileSafeId(run.id)}.json.gz`;
  const gz = gzipSync(body);
  writeFileSync(join(dir, name), gz);
  const sha256 = createHash("sha256").update(gz).digest("hex");
  appendFileSync(join(dir, "SHA256SUMS"), `${sha256}  ${name}\n`);
  return { path: relative(home, join(dir, name)), sha256 };
}
