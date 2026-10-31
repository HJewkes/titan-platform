import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { collectDigest, type DigestSources } from "./collect.js";
import type { DigestSlot } from "./model.js";
import type { DigestPushConfig } from "../config.js";
import { DEFAULT_CAPS, NO_CAPS, rankDigest } from "./rank.js";
import { alarmNote, gateAlarm, safeConsoleOrigin } from "./gate-alarm.js";
import { renderMarkdown } from "./render-md.js";
import { pushDigest, type PushDeps } from "./push.js";
import type { Directories } from "./sources.js";
import { errorMessage } from "../narrow.js";

export interface DigestRun {
  sources: DigestSources;
  now: Date;
  slot: DigestSlot;
  windowMinutes: number;
  full: boolean;
  consoleOrigin?: string;
}

interface BuiltDigest {
  markdown: string;
  /** The planner's copy of the gate alarm; absent when the alarm does not fire. */
  alarmNote?: string;
}

export async function buildDigest({ sources, now, slot, windowMinutes, full, consoleOrigin }: DigestRun): Promise<BuiltDigest> {
  const model = await collectDigest({ sources, now, slot, windowMinutes });
  const markdown = renderMarkdown(rankDigest({ ...model, ...(consoleOrigin !== undefined && { consoleOrigin }) }, full ? NO_CAPS : DEFAULT_CAPS));
  const alarm = gateAlarm(model.friction, model.ownerGateAlarm ?? []);
  const origin = consoleOrigin === undefined ? undefined : safeConsoleOrigin(consoleOrigin);
  return { markdown, ...(alarm !== undefined && { alarmNote: alarmNote(alarm, origin) }) };
}

export const ALARM_NOTE_FILE = "owner-gate-alarm.md";

/** One fixed name, so the planner's input is the latest run's alarm; a run with no alarm removes the last one rather than leave it reading as current. */
export function syncAlarmNote(dir: string, note: string | undefined): void {
  if (note === undefined) return rmSync(join(dir, ALARM_NOTE_FILE), { force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ALARM_NOTE_FILE), note);
}

export interface Delivery {
  written: string[];
  warnings: string[];
}

/** The slot names the file, so a rerun for the same slot replaces it; a failed copy or push warns but keeps the local file. */
export async function deliverDigest(markdown: string, slot: DigestSlot, dirs: Directories, push?: DigestPushConfig, pushDeps?: PushDeps): Promise<Delivery> {
  const name = `${slot.date}-${slot.hour}.md`;
  const write = (dir: string): string => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), markdown);
    return join(dir, name);
  };
  const written = [write(dirs.outDir)];
  const warnings: string[] = [];
  for (const dir of dirs.copyDirs) {
    try {
      written.push(write(dir));
    } catch (error) {
      warnings.push(`copy to ${dir} failed: ${errorMessage(error)}`);
    }
  }
  const pushWarning = push ? await pushDigest(markdown, slot, push, pushDeps) : undefined;
  if (pushWarning) warnings.push(pushWarning);
  return { written, warnings };
}
