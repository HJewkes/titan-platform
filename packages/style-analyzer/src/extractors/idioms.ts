import type { StyleExtractor, Observation, ParsedFile } from "./types.js";
import type {
  IClone,
  IMapFrame,
  IOptions,
} from "@jscpd/core";

interface SourceFile {
  content: string;
  path: string;
  language: string;
}

interface CloneInstance {
  sourceFile: string;
  startLine: number;
  endLine: number;
  fragment: string;
}

interface CloneGroup {
  instances: CloneInstance[];
  linesCount: number;
}

export class IdiomsExtractor implements StyleExtractor {
  readonly name = "idioms";

  private minLines: number;
  private minTokens: number;

  constructor(options?: { minLines?: number; minTokens?: number }) {
    this.minLines = options?.minLines ?? 3;
    this.minTokens = options?.minTokens ?? 25;
  }

  extract(_file: ParsedFile): Observation[] {
    return [];
  }

  async extractFromSources(sources: SourceFile[]): Promise<Observation[]> {
    const observations: Observation[] = [];

    const clones = await this.detectClones(sources);
    const groups = this.groupClones(clones);

    for (const group of groups.values()) {
      const frequency = group.instances.length;
      if (frequency < 2) continue;

      observations.push(this.cloneObservation(group));
    }

    return observations;
  }

  private cloneObservation(group: CloneGroup): Observation {
    const frequency = group.instances.length;
    const first = group.instances[0]!;

    return {
      type: "idiom.clone",
      category: "idioms",
      value: this.summarizeClone(first.fragment),
      file: first.sourceFile,
      line: first.startLine,
      metadata: {
        frequency,
        fragment: first.fragment,
        linesCount: group.linesCount,
        locations: group.instances.map((inst) => ({
          file: inst.sourceFile,
          startLine: inst.startLine,
          endLine: inst.endLine,
        })),
      },
    };
  }

  private async detectClones(
    sources: SourceFile[],
  ): Promise<CloneGroup[]> {
    const { allClones, sourceMap } = await this.runDetector(sources);
    return allClones.map((clone) => this.toCloneGroup(clone, sourceMap));
  }

  private async runDetector(
    sources: SourceFile[],
  ): Promise<{ allClones: IClone[]; sourceMap: Map<string, string> }> {
    const { Detector, MemoryStore } = await import("@jscpd/core");
    const { Tokenizer } = await import("@jscpd/tokenizer");

    const options: IOptions = {
      minLines: this.minLines,
      minTokens: this.minTokens,
    };

    const store = new MemoryStore<IMapFrame>();
    const tokenizer = new Tokenizer();
    const detector = new Detector(tokenizer, store, [], options);

    const allClones: IClone[] = [];
    const sourceMap = new Map<string, string>();

    for (const source of sources) {
      sourceMap.set(source.path, source.content);
      const format = this.languageToFormat(source.language);
      const detected = await detector.detect(
        source.path,
        source.content,
        format,
      );
      allClones.push(...detected);
    }

    return { allClones, sourceMap };
  }

  private toCloneGroup(
    clone: IClone,
    sourceMap: Map<string, string>,
  ): CloneGroup {
    return {
      instances: [
        this.toInstance(clone.duplicationA, sourceMap),
        this.toInstance(clone.duplicationB, sourceMap),
      ],
      linesCount:
        clone.duplicationA.end.line - clone.duplicationA.start.line + 1,
    };
  }

  private toInstance(
    duplication: IClone["duplicationA"],
    sourceMap: Map<string, string>,
  ): CloneInstance {
    const content = sourceMap.get(duplication.sourceId) ?? "";
    return {
      sourceFile: duplication.sourceId,
      startLine: duplication.start.line,
      endLine: duplication.end.line,
      fragment: this.extractFragment(
        content,
        duplication.start.line,
        duplication.end.line,
      ),
    };
  }

  private extractFragment(
    content: string,
    startLine: number,
    endLine: number,
  ): string {
    const lines = content.split("\n");
    return lines.slice(startLine - 1, endLine).join("\n");
  }

  private languageToFormat(language: string): string {
    const mapping: Record<string, string> = {
      typescript: "typescript",
      javascript: "javascript",
      python: "python",
      tsx: "tsx",
      jsx: "jsx",
    };
    return mapping[language] ?? language;
  }

  private groupClones(
    clones: CloneGroup[],
  ): Map<string, CloneGroup> {
    const groups = new Map<string, CloneGroup>();

    for (const clone of clones) {
      const key = this.normalizeFragment(clone.instances[0]?.fragment ?? "");

      const existing = groups.get(key);
      if (existing) {
        this.mergeInstances(existing, clone);
      } else {
        groups.set(key, {
          instances: [...clone.instances],
          linesCount: clone.linesCount,
        });
      }
    }

    return groups;
  }

  private mergeInstances(existing: CloneGroup, clone: CloneGroup): void {
    for (const inst of clone.instances) {
      const alreadyTracked = existing.instances.some(
        (e) =>
          e.sourceFile === inst.sourceFile &&
          e.startLine === inst.startLine,
      );
      if (!alreadyTracked) {
        existing.instances.push(inst);
      }
    }
  }

  private normalizeFragment(fragment: string): string {
    return fragment.replace(/\s+/g, " ").trim().substring(0, 200);
  }

  private summarizeClone(fragment: string): string {
    const firstLine = fragment.split("\n")[0]?.trim() ?? "";
    if (firstLine.length > 80) {
      return firstLine.substring(0, 77) + "...";
    }
    return firstLine;
  }
}
