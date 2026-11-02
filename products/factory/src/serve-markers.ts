import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "@titan-design/store-sqlite";
import type { MarkersConfig } from "./markers/config.js";
import type { FactoryHostOptions } from "./host.js";
import { carryProbeSource, diffPinSource, markerMirrors, treeOfSource } from "./markers/shadow-diff/git-sources.js";
import { logSink } from "./markers/shadow-diff/log.js";
import type { ShadowSink } from "./markers/shadow.js";

type MarkerShadow = NonNullable<FactoryHostOptions["markerShadow"]>;
type SeatClone = (repo: string) => string | undefined;

/**
 * The host's marker shadow as serve runs it: undefined, so no shadow at all, unless `markers.shadow.enabled`. `db` is read
 * on the first event, because the host that opens the database also takes these options.
 */
export function markerShadowOptions(config: MarkersConfig | undefined, db: () => Db, stateDir: string, clones: SeatClone, now: () => number = Date.now): MarkerShadow | undefined {
  if (config?.shadow.enabled !== true) return undefined;
  const mirrorOf = markerMirrors(stateDir, clones);
  const diffPin = diffPinSource(mirrorOf, { now });
  const madeMirrors = (): Promise<readonly string[]> => Promise.resolve(mirrorsUnder(join(stateDir, "marker-git")));
  const options: MarkerShadow = { sink: lazyLogSink(db, now), diffPin, treeOf: treeOfSource(madeMirrors), carryProbe: carryProbeSource(mirrorOf, diffPin) };
  return config.shadow.entryBudget === undefined ? options : { ...options, entryBudget: config.shadow.entryBudget };
}

function lazyLogSink(db: () => Db, now: () => number): ShadowSink {
  let sink: ShadowSink | undefined;
  return (event) => (sink ??= logSink(db(), () => new Date(now()).toISOString()))(event);
}

/** A staging directory left by a clone that died is not a mirror; only a renamed `.git` directory with a HEAD is. */
function mirrorsUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".git"))
    .map((name) => join(dir, name))
    .filter((mirror) => existsSync(join(mirror, "HEAD")));
}
