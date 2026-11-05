import { arch, cpus, platform } from "node:os";
import { withBrowser } from "@titan-design/frame-capture";
import type { Browser } from "playwright-core";
import { z } from "zod";
import { runFfmpeg } from "./ffmpeg.js";

const Sha = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * What the render ran on, because worker count and host are still part of a render's identity. Strict, and with no
 * hostname, user or path: a manifest is published beside the video.
 */
export const RenderHostSchema = z.strictObject({
  platform: z.string(),
  arch: z.string(),
  cpuModel: z.string(),
  cpus: z.number().int().positive(),
  node: z.string(),
  ffmpeg: z.string(),
  chromium: z.string(),
});
export type RenderHost = z.infer<typeof RenderHostSchema>;

export const RenderManifestSchema = z.strictObject({
  schema: z.literal("explainer.render-manifest/v1"),
  workers: z.number().int().positive(),
  fps: z.number().positive(),
  frames: z.number().int().positive(),
  durationS: z.number().positive(),
  pageDurationS: z.number().positive(),
  renderWallS: z.number().nonnegative(),
  /** True when no narration was given: the video is a silent draft and the page shows the DRAFT stamp. */
  draft: z.boolean(),
  /**
   * `passed` when the pre-capture gate held no errors and, when the caller ran qa after encode (the render stage does),
   * every qa gate row passed on the MP4; `absent` when the caller asked for no gate, so nothing may read the manifest as
   * QA-passed; `skipped` for `--no-qa`.
   */
  qaGate: z.enum(["absent", "passed", "skipped"]),
  /** Set only when the gate passed: the held errors it counted and the gate profile's sha. */
  qa: z.strictObject({ heldErrors: z.literal(0), gateProfile: Sha }).optional(),
  host: RenderHostSchema,
  shas: z.strictObject({ timeline: Sha, page: Sha, mix: Sha, mp4: Sha, vtt: Sha, words: Sha.optional() }),
}).refine((m) => (m.qa !== undefined) === (m.qaGate === "passed"), { message: "qa is recorded exactly when qaGate is passed" });
export type RenderManifest = z.infer<typeof RenderManifestSchema>;

export function renderManifestJson(manifest: RenderManifest): string {
  return `${JSON.stringify(RenderManifestSchema.parse(manifest), null, 2)}\n`;
}

/** The first line of `ffmpeg -version` names the build; later lines carry configure flags with install paths. */
async function ffmpegVersion(): Promise<string> {
  const out = await runFfmpeg(["-version"]);
  return out.split("\n")[0]!.trim();
}

/** The host, its Chromium read from `browser` when one is lent, else from one launched for the read. */
export async function collectRenderHost(browser?: Browser): Promise<RenderHost> {
  const [ffmpeg, chromium] = await Promise.all([ffmpegVersion(), withBrowser(browser, async (readFrom) => readFrom.version())]);
  const cores = cpus();
  return { platform: platform(), arch: arch(), cpuModel: cores[0]?.model.trim() ?? "unknown", cpus: cores.length, node: process.version, ffmpeg, chromium };
}
