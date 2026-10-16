import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSpeechRuntime } from "./resolve-runtime.js";

const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function profileFile(contents: unknown): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "resolve-runtime-"));
  scratch.push(dir);
  const file = path.join(dir, "profile.json");
  await writeFile(file, JSON.stringify(contents));
  return file;
}

const NO_ORT = () => undefined;

describe("resolveSpeechRuntime", () => {
  it("lists only cpu and does not throw when onnxruntime-node is not found", async () => {
    const runtime = await resolveSpeechRuntime({ env: {}, findOrtDir: NO_ORT });

    expect(runtime.available).toEqual(["cpu"]);
  });

  it("reads the profile named by TITAN_SPEECH_PROFILE", async () => {
    const file = await profileFile({ version: 1, runtime: { device: { tts: "cpu" } } });

    const runtime = await resolveSpeechRuntime({ env: { TITAN_SPEECH_PROFILE: file }, findOrtDir: NO_ORT });

    expect(runtime.source.device.tts).toBe("profile");
  });

  it("treats a missing profile file as no profile", async () => {
    const missing = path.join(tmpdir(), "resolve-runtime-absent", "profile.json");

    const runtime = await resolveSpeechRuntime({ env: { TITAN_SPEECH_PROFILE: missing }, findOrtDir: NO_ORT });

    expect(runtime.source.device.tts).toBe("default");
  });

  it("follows TITAN_SPEECH_OFFLINE from the injected env", async () => {
    const runtime = await resolveSpeechRuntime({ env: { TITAN_SPEECH_OFFLINE: "1" }, findOrtDir: NO_ORT });

    expect(runtime.offline).toBe(true);
  });

  it("finds an onnxruntime-node directory or none, and never throws, with the real lookup", async () => {
    await expect(resolveSpeechRuntime({ env: {} })).resolves.toMatchObject({ available: expect.arrayContaining(["cpu"]) });
  });
});
