import type { Profile } from "../schema/profile.js";
import type { GeneratedFile } from "./types.js";
import {
  getRulesByTier,
  readableConvention,
  detectLanguages,
} from "./template-helpers.js";
import type { RuleEntry } from "./template-helpers.js";
import { loadTemplate } from "./templates.js";

function buildTieredRulesContext(profile: Profile) {
  const tiers = getRulesByTier(profile);

  const mapRule = (r: RuleEntry) => ({
    name: `${r.category}.${r.name}`,
    readableConvention: readableConvention(r),
    confidencePercent: (r.confidence * 100).toFixed(0),
  });

  return {
    criticalRules: tiers.critical.map(mapRule),
    strongRules: tiers.strong.map(mapRule),
    preferredRules: tiers.preferred.map(mapRule),
  };
}

function buildNamingContext(profile: Profile) {
  const section = profile.naming;
  return Object.entries(section).map(([name, rule]) => ({
    label: name.charAt(0).toUpperCase() + name.slice(1),
    convention:
      typeof rule.convention === "string"
        ? rule.convention
        : JSON.stringify(rule.convention),
    confidencePercent: (rule.confidence * 100).toFixed(0),
    stability: rule.stability,
    fixability: rule.fixability,
    description: rule.description,
    examples: rule.examples,
  }));
}

function buildPatternsContext(profile: Profile) {
  const section = profile.patterns;
  const patternRules = Object.entries(section).map(([name, rule]) => ({
    name,
    strength:
      typeof rule.convention === "string" ? rule.convention : "detected",
    confidencePercent: (rule.confidence * 100).toFixed(0),
    description: rule.description,
    fixability: rule.fixability,
    examples: rule.examples,
  }));

  const preferredPatterns = profile.structure?.preferredPatterns;
  let preferredList: string[] | undefined;
  if (preferredPatterns && Array.isArray(preferredPatterns.convention)) {
    preferredList = preferredPatterns.convention as string[];
  }

  return { patterns: patternRules, preferredPatterns: preferredList };
}

function buildIdiomsContext(profile: Profile) {
  return profile.idioms.detected.map((idiom) => ({
    name: idiom.name,
    description: idiom.description,
    example: idiom.example,
  }));
}

function buildAntiPatternsContext(profile: Profile) {
  return profile.antiPatterns.acknowledged.map((ap) => ({
    pattern: ap.pattern,
    reason: ap.reason,
  }));
}

function buildLanguageContext(profile: Profile, lang: string) {
  const tiers = getRulesByTier(profile);
  const mapRule = (r: RuleEntry) => ({
    category: r.category,
    name: r.name,
    convention:
      typeof r.convention === "string"
        ? r.convention
        : JSON.stringify(r.convention),
    confidencePercent: (r.confidence * 100).toFixed(0),
    readableConvention: readableConvention(r),
    description: r.description,
  });

  return {
    language: lang.charAt(0).toUpperCase() + lang.slice(1),
    criticalRules: tiers.critical.map(mapRule),
    strongRules: tiers.strong.map(mapRule),
    preferredRules: tiers.preferred.map(mapRule),
  };
}

function renderSkillFile(profile: Profile, languages: string[]): GeneratedFile {
  const skillTemplate = loadTemplate("skill.md.hbs");
  const idioms = buildIdiomsContext(profile);
  const antiPatterns = buildAntiPatternsContext(profile);
  return {
    path: "skill.md",
    content: skillTemplate({
      author: profile.author,
      ...buildTieredRulesContext(profile),
      languages,
      idioms: idioms.length > 0 ? idioms : undefined,
      antiPatterns: antiPatterns.length > 0 ? antiPatterns : undefined,
    }),
  };
}

export function generateSkillFiles(profile: Profile): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const languages = detectLanguages(profile);

  files.push(renderSkillFile(profile, languages));

  const namingTemplate = loadTemplate("naming.md.hbs");
  files.push({
    path: "references/naming.md",
    content: namingTemplate({ rules: buildNamingContext(profile) }),
  });

  const patternsTemplate = loadTemplate("patterns.md.hbs");
  files.push({
    path: "references/patterns.md",
    content: patternsTemplate(buildPatternsContext(profile)),
  });

  const langTemplate = loadTemplate("per-language.md.hbs");
  for (const lang of languages) {
    files.push({
      path: `references/per-language/${lang}.md`,
      content: langTemplate(buildLanguageContext(profile, lang)),
    });
  }

  return files;
}
