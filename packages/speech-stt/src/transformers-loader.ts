import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isObjectLike } from "@titan-design/rpc-protocol/narrow";

const TRANSFORMERS_PEER = "@huggingface/transformers";

export type ModuleImporter = (name: string) => Promise<unknown>;

export function missingPeerMessage(feature: string): string {
  return `${TRANSFORMERS_PEER} is not installed; run \`npm i ${TRANSFORMERS_PEER}\` to use ${feature}`;
}

/** Imports the optional transformers.js peer, naming the install command when it is absent. */
export async function loadTransformersModule(
  importModule: ModuleImporter,
  feature: string,
): Promise<Record<string, unknown>> {
  let mod: unknown;
  try {
    mod = await importModule(TRANSFORMERS_PEER);
  } catch (err) {
    throw new Error(missingPeerMessage(feature), { cause: err });
  }
  if (!isObjectLike(mod)) throw new Error(missingPeerMessage(feature));
  return mod;
}

interface CachedFile {
  /** A path inside the model repo, e.g. `onnx/model.onnx`. */
  file: string;
  /** transformers.js caches a revision other than `main` under its own directory. */
  revision?: string;
}

/**
 * With TITAN_SPEECH_OFFLINE set, an uncached model is refused before the runtime can reach the network. Naming the
 * file matters when one repo holds several weights: a cache holding only fp32 must not pass a q8 request.
 */
export function assertCachedWhenOffline(model: string, cacheDir: string | undefined, required?: CachedFile): void {
  if (!process.env.TITAN_SPEECH_OFFLINE) return;
  if (cacheDir === undefined) throw new Error(`offline: TITAN_SPEECH_OFFLINE is set and no cacheDir is given for ${model}`);
  const dir = join(cacheDir, model);
  if (required === undefined) {
    if (!existsSync(dir) || readdirSync(dir).length === 0) {
      throw new Error(`offline: ${model} is not in ${cacheDir} and TITAN_SPEECH_OFFLINE is set`);
    }
    return;
  }
  const revision = required.revision === undefined || required.revision === "main" ? [] : [required.revision];
  if (!existsSync(join(dir, ...revision, required.file))) {
    throw new Error(`offline: ${model} (${required.file}) is not in ${cacheDir} and TITAN_SPEECH_OFFLINE is set`);
  }
}
