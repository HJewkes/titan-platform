interface GateSpine {
  sentence: string;
  blocks: readonly { seconds: number }[];
}

interface GateProfile {
  runtime: { minS: number; maxS: number };
}

const CONTRASTIVE = /\b(but|yet|however)\b/i;
const CONSEQUENTIAL = /\b(so|therefore|which means)\b/i;

/** The $0 outline-gate checks: the blocks' seconds fill the profile's runtime band, and the sentence turns twice (ABT). */
export function outlineIssues(spine: GateSpine, profile: GateProfile): string[] {
  const issues: string[] = [];
  const total = spine.blocks.reduce((sum, block) => sum + block.seconds, 0);
  const { minS, maxS } = profile.runtime;
  if (total < minS || total > maxS) issues.push(`blocks total ${total} s, outside the runtime band ${minS}-${maxS} s`);
  if (!CONTRASTIVE.test(spine.sentence)) issues.push("sentence lacks a contrastive turn (but, yet, however)");
  if (!CONSEQUENTIAL.test(spine.sentence)) issues.push("sentence lacks a consequential turn (so, therefore, which means)");
  return issues;
}
