import type { StyleExtractor, Observation, ParsedFile } from "./types.js";

interface ReviewComment {
  body: string;
  file?: string;
}

type ReviewTopic =
  | "naming"
  | "error-handling"
  | "complexity"
  | "style"
  | "performance"
  | "documentation"
  | "testing"
  | "security"
  | "readability"
  | "structure";

interface TopicPattern {
  topic: ReviewTopic;
  patterns: RegExp[];
}

const TOPIC_PATTERNS: TopicPattern[] = [
  {
    topic: "naming",
    patterns: [
      /\bnam(?:e|ing)\b/i,
      /\brenam(?:e|ing)\b/i,
      /\bcamelCase\b/i,
      /\bsnake_case\b/i,
      /\bdescriptive\b/i,
      /\bconfusing\b/i,
      /\bprefer\s+\S+\s+over\b/i,
    ],
  },
  {
    topic: "error-handling",
    patterns: [
      /\berror\s*handl/i,
      /\bmissing\s+error/i,
      /\btry\s*\/?\s*catch\b/i,
      /\bwhat\s+happens\s+if\b/i,
      /\bedge\s*case/i,
      /\bnull\b/i,
      /\bfails?\b/i,
    ],
  },
  {
    topic: "complexity",
    patterns: [
      /\bcomplex\b/i,
      /\btoo\s+long\b/i,
      /\bsplit\b.*\bup\b/i,
      /\bextract\b.*\bfunction/i,
      /\bsmaller\s+functions?\b/i,
      /\bsimplif/i,
      /\bnesting\b/i,
    ],
  },
  {
    topic: "style",
    patterns: [
      /\bstyle\b/i,
      /\bformat/i,
      /\bconsistenc/i,
      /\bnit\b/i,
      /\bquotes?\b/i,
      /\bsemicolon/i,
      /\bindent/i,
      /\bwhitespace\b/i,
    ],
  },
  {
    topic: "performance",
    patterns: [
      /\bperforman/i,
      /\bmemoiz/i,
      /\bre-?render/i,
      /\boptimiz/i,
      /\bexpensive\b/i,
      /\befficien/i,
      /\bcach/i,
    ],
  },
  {
    topic: "documentation",
    patterns: [
      /\bdocument/i,
      /\bjsdoc\b/i,
    ],
  },
  {
    topic: "testing",
    patterns: [
      /\btest/i,
      /\bcover(?:age)?\b/i,
      /\bassert/i,
      /\bmock/i,
      /\bspec\b/i,
    ],
  },
  {
    topic: "security",
    patterns: [
      /\bsecur/i,
      /\bvulnerab/i,
      /\bsaniti[zs]/i,
      /\binject/i,
      /\bescap/i,
      /\bxss\b/i,
    ],
  },
  {
    topic: "readability",
    patterns: [
      /\breadab/i,
      /\bearly\s+return/i,
      /\bguard\s+clause/i,
    ],
  },
  {
    topic: "structure",
    patterns: [
      /\bstructur/i,
      /\barchitect/i,
      /\borganiz/i,
      /\bseparati/i,
    ],
  },
];

const KEYWORD_PATTERNS: Array<{ keyword: string; pattern: RegExp }> = [
  { keyword: "early-return", pattern: /\bearly\s+return\b/i },
  { keyword: "guard-clause", pattern: /\bguard\s+clause\b/i },
  {
    keyword: "single-responsibility",
    pattern: /\bsingle\s+responsib/i,
  },
  { keyword: "dry", pattern: /\b(?:DRY|don'?t\s+repeat)\b/i },
  { keyword: "immutability", pattern: /\bimmutab/i },
  { keyword: "type-safety", pattern: /\btype[\s-]*safe/i },
  { keyword: "null-check", pattern: /\bnull\s+check/i },
  { keyword: "magic-number", pattern: /\bmagic\s+number/i },
];

export class ReviewVoiceExtractor implements StyleExtractor {
  readonly name = "reviewVoice";

  extract(_file: ParsedFile): Observation[] {
    return [];
  }

  extractFromComments(comments: ReviewComment[]): Observation[] {
    if (comments.length === 0) return [];

    const observations: Observation[] = [];

    observations.push(...this.categorizeTopics(comments));
    observations.push(...this.extractKeywords(comments));

    return observations;
  }

  private categorizeTopics(comments: ReviewComment[]): Observation[] {
    const topicCounts = new Map<ReviewTopic, number>();
    const topicExamples = new Map<ReviewTopic, string[]>();

    for (const comment of comments) {
      const matchedTopics = new Set<ReviewTopic>();

      for (const { topic, patterns } of TOPIC_PATTERNS) {
        for (const pattern of patterns) {
          if (pattern.test(comment.body)) {
            matchedTopics.add(topic);
            break;
          }
        }
      }

      for (const topic of matchedTopics) {
        topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1);

        const examples = topicExamples.get(topic) ?? [];
        if (examples.length < 3) {
          examples.push(comment.body);
          topicExamples.set(topic, examples);
        }
      }
    }

    const observations: Observation[] = [];

    for (const [topic, count] of topicCounts) {
      observations.push({
        type: "reviewVoice.topicFrequency",
        category: "reviewVoice",
        value: topic,
        file: "_reviews",
        line: 0,
        metadata: {
          count,
          total: comments.length,
          ratio: count / comments.length,
          examples: topicExamples.get(topic) ?? [],
        },
      });
    }

    observations.sort(
      (a, b) =>
        ((b.metadata?.count as number) ?? 0) -
        ((a.metadata?.count as number) ?? 0),
    );

    return observations;
  }

  private extractKeywords(comments: ReviewComment[]): Observation[] {
    const keywordCounts = new Map<string, number>();

    for (const comment of comments) {
      for (const { keyword, pattern } of KEYWORD_PATTERNS) {
        if (pattern.test(comment.body)) {
          keywordCounts.set(
            keyword,
            (keywordCounts.get(keyword) ?? 0) + 1,
          );
        }
      }
    }

    const observations: Observation[] = [];

    for (const [keyword, count] of keywordCounts) {
      observations.push({
        type: "reviewVoice.keyword",
        category: "reviewVoice",
        value: keyword,
        file: "_reviews",
        line: 0,
        metadata: {
          count,
          total: comments.length,
        },
      });
    }

    return observations;
  }
}
