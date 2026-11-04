import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ArtifactStore, Provenance } from "../workflow/artifacts.js";
import { writeText } from "../workflow/run-dir.js";
import { LayerBuildSchema, type LayerBuild } from "./beat-worker.js";

const PACKET_KEY = /^[0-9a-f]{64}$/;

/**
 * Builds by packet key across runs. The `mapItems` memo lives inside one resolve child run, and any script or facts
 * edit makes a new one, so without this an unchanged beat would be rebuilt (and paid for) on every edit. The build
 * itself is an artifact in the store; `<dir>/<key>` names its sha, like the take cache's `<dir>/<key>.json`.
 */
export class LayerBuildCache {
  constructor(private readonly dir: string, private readonly store: ArtifactStore) {}

  get(key: string): LayerBuild | undefined {
    const pointer = this.pointer(key);
    if (!existsSync(pointer)) return undefined;
    return LayerBuildSchema.parse(JSON.parse(this.store.readText(readFileSync(pointer, "utf8").trim())));
  }

  /** Only a build that passed the compile gate belongs here: a cached failure would never be retried. */
  put(key: string, build: LayerBuild, from: Provenance): void {
    const sha = this.store.putText(`${JSON.stringify(build)}\n`, "layer-build", from);
    writeText(this.pointer(key), `${sha}\n`);
  }

  private pointer(key: string): string {
    if (!PACKET_KEY.test(key)) throw new Error(`layer build cache: ${JSON.stringify(key)} is not a packet key`);
    return path.join(this.dir, key);
  }
}
