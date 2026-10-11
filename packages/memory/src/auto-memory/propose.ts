import { jaccard } from "../text.js";
import { topicTokens } from "./group.js";
import type { DestinationProposal, FactGroup, MemoryFactType, ParsedFact, SkillSummary } from "./types.js";

const DAY_MS = 86_400_000;
const DEFAULT_STALE_DAYS = 30;
const SKILL_MATCH = 0.25;
const COORDINATION = /\b(coordinators?|seats?|charters?|dispatch(?:es|ed|ing)?|spawn(?:s|ed|ing)?|teleport(?:s|ed|ing)?|pool|merge authority)\b/i;

export interface ProposeOptions {
  now: Date;
  staleDays?: number;
}

function sources(group: FactGroup): ParsedFact[] {
  return group.facts.flatMap((deduped) => deduped.sources);
}

function topicOf(group: FactGroup): string {
  return [...new Set(group.facts.flatMap(({ fact }) => [...topicTokens(`${fact.name} ${fact.description}`)]))].join(" ");
}

function bestSkill(topic: string, skills: readonly SkillSummary[]): { name: string; score: number } | undefined {
  let best: { name: string; score: number } | undefined;
  for (const skill of skills) {
    const skillTopic = [...topicTokens(skill.description)].join(" ");
    if (topic === "" || skillTopic === "") continue;
    const score = jaccard(topic, skillTopic);
    if (score < SKILL_MATCH) continue;
    if (!best || score > best.score || (score === best.score && skill.name < best.name)) best = { name: skill.name, score };
  }
  return best;
}

function allOf(facts: readonly ParsedFact[], types: readonly MemoryFactType[]): boolean {
  return facts.every((fact) => types.includes(fact.type));
}

function isStale(facts: readonly ParsedFact[], cutoff: number): boolean {
  return facts.every((fact) => fact.modified !== undefined && Date.parse(fact.modified) < cutoff);
}

function slug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "memory";
}

/** Proposes where a group of facts should live; the first matching rule wins, so the order is the policy. */
export function proposeDestination(group: FactGroup, skills: readonly SkillSummary[], options: ProposeOptions): DestinationProposal {
  const facts = sources(group);
  const projects = [...new Set(facts.map((fact) => fact.ref.project))].sort();
  const skill = bestSkill(topicOf(group), skills);
  if (skill) return { destination: `skill:${skill.name}`, reason: `topic matches skill "${skill.name}" (Jaccard ${skill.score.toFixed(2)})` };
  const text = group.facts.map(({ fact }) => `${fact.name} ${fact.description} ${fact.body}`).join("\n");
  if (allOf(facts, ["feedback"]) && COORDINATION.test(text)) return { destination: "charter", reason: "feedback about coordination belongs in the charter" };
  const guidance = allOf(facts, ["feedback", "user"]);
  if (guidance && projects.length >= 2) return { destination: "claude-md:global", reason: `guidance repeated across ${projects.length} projects` };
  const staleDays = options.staleDays ?? DEFAULT_STALE_DAYS;
  if (allOf(facts, ["project"]) && isStale(facts, options.now.getTime() - staleDays * DAY_MS)) {
    return { destination: "delete", reason: `project facts not modified in ${staleDays} days` };
  }
  if (guidance && projects[0] !== undefined) return { destination: `claude-md:${projects[0]}`, reason: `guidance from one project, ${projects[0]}` };
  return { destination: `new-skill:${slug(group.label)}`, reason: "no existing skill or instruction file fits" };
}
