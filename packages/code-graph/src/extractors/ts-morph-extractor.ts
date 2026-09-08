import * as path from "node:path";
import { existsSync } from "node:fs";
import {
  Project,
  ScriptTarget,
  ModuleKind,
  ModuleResolutionKind,
  type ExportDeclaration,
  type ImportDeclaration,
  type SourceFile,
} from "ts-morph";
import type { Extractor, ParsedFile } from "../parser/index.js";
import type { GraphEdge, GraphFragment, GraphNode } from "../types.js";
import { buildFileModuleNodes } from "./file-nodes.js";
import { externalId, fileId, symbolId } from "./ids.js";
import {
  addWeightedEdge,
  bindingWeight,
  buildLocalUsageCounts,
  importWeight,
  namedImportBindings,
  reExportWeight,
} from "./reference-weight.js";
import { buildSymbolNodes } from "./symbol-nodes.js";
import {
  dynamicImportSpecifiers,
  recordDynamicSymbolRefEdges,
} from "./dynamic-imports.js";
import { resolveReExportOrigin } from "./reexport-resolve.js";
import {
  inRepoFileId,
  isRelativeSpecifier,
  resolveRelativeAbs,
} from "./module-resolution.js";

/** Mutable accumulator threaded through one file's edge collection. */
interface EdgeCollector {
  srcAbs: string;
  srcFileId: string;
  usage: Map<string, number>;
  agg: Map<string, GraphEdge>;
  externalNodes: GraphNode[];
  seenExternals: Set<string>;
}

export interface TsMorphGraphExtractorOptions {
  repoRoot: string;
  tsConfigPath?: string;
  project?: Project;
}

export class TsMorphGraphExtractor implements Extractor<GraphFragment> {
  readonly name = "ts-morph-graph";
  private readonly repoRoot: string;
  private readonly tsConfigPath?: string;
  private project?: Project;

  constructor(options: TsMorphGraphExtractorOptions) {
    this.repoRoot = options.repoRoot;
    this.tsConfigPath = options.tsConfigPath;
    this.project = options.project;
  }

  extract(file: ParsedFile): GraphFragment[] {
    if (!isTypeScriptFile(file)) return [];

    const project = this.ensureProject();
    const sourceFile = this.loadSourceFile(project, file);
    const nodes = this.buildFileAndModuleNodes(sourceFile);
    const symbolNodes = buildSymbolNodes(this.repoRoot, sourceFile, file);
    const { edges, externalNodes } = this.collectEdges(sourceFile);
    return [{ nodes: [...nodes, ...symbolNodes, ...externalNodes], edges }];
  }

  private ensureProject(): Project {
    if (this.project) return this.project;
    this.project = this.tsConfigPath
      ? new Project({ tsConfigFilePath: this.tsConfigPath })
      : new Project({
          compilerOptions: {
            allowJs: true,
            target: ScriptTarget.ESNext,
            module: ModuleKind.ESNext,
            moduleResolution: ModuleResolutionKind.NodeNext,
          },
        });
    return this.project;
  }

  private loadSourceFile(project: Project, file: ParsedFile): SourceFile {
    const existing = project.getSourceFile(file.filePath);
    if (existing) {
      if (existing.getFullText() !== file.content) {
        existing.replaceWithText(file.content);
      }
      return existing;
    }
    return project.createSourceFile(file.filePath, file.content, {
      overwrite: true,
    });
  }

  private buildFileAndModuleNodes(sourceFile: SourceFile): GraphNode[] {
    return buildFileModuleNodes(this.repoRoot, sourceFile.getFilePath());
  }

  private collectEdges(sourceFile: SourceFile): {
    edges: GraphEdge[];
    externalNodes: GraphNode[];
  } {
    const c: EdgeCollector = {
      srcAbs: sourceFile.getFilePath(),
      srcFileId: fileId(this.repoRoot, sourceFile.getFilePath()),
      usage: buildLocalUsageCounts(sourceFile),
      agg: new Map(),
      externalNodes: [],
      seenExternals: new Set(),
    };
    for (const decl of sourceFile.getImportDeclarations()) {
      this.recordImportEdge(c, decl);
    }
    for (const decl of sourceFile.getExportDeclarations()) {
      this.recordReExportEdge(c, decl);
    }
    for (const specifier of dynamicImportSpecifiers(sourceFile)) {
      const dstId = this.resolveRelativeInternal(c.srcAbs, specifier);
      if (dstId) addWeightedEdge(c.agg, c.srcFileId, dstId, "imports", specifier, 1);
    }
    // C-68: destructured dynamic imports (`const { x } = await import(...)`) also
    // credit the target symbol; resolution is delegated so this stays out of the
    // (churn-hot, LOC-bound) extractor body.
    recordDynamicSymbolRefEdges(sourceFile, c.srcFileId, c.agg, (s) =>
      this.resolveRelativeInternal(c.srcAbs, s),
    );
    return { edges: [...c.agg.values()], externalNodes: c.externalNodes };
  }

  private recordImportEdge(c: EdgeCollector, decl: ImportDeclaration): void {
    const specifier = decl.getModuleSpecifierValue();
    const dstId = this.resolveTarget(c, specifier, decl);
    if (dstId) {
      addWeightedEdge(c.agg, c.srcFileId, dstId, "imports", specifier, importWeight(decl, c.usage));
    }
    this.recordSymbolReferences(c, decl);
  }

  /**
   * Split an import into per-export `references` edges targeting `symbol` nodes,
   * so per-symbol utilization (which exports are hot) falls out of the same
   * inbound-weight sum that powers file utilization (C-53). Extracted *forward*
   * from the importing file — source-local, exactly like the file-level import
   * weight — which sidesteps the reuse-breaking reverse `findReferences` query:
   * an unchanged file's outbound reference edges are carried forward verbatim.
   */
  private recordSymbolReferences(c: EdgeCollector, decl: ImportDeclaration): void {
    const specifier = decl.getModuleSpecifierValue();
    for (const binding of namedImportBindings(decl)) {
      const dstId = this.resolveSymbolTarget(c, decl, binding.importedName);
      if (!dstId) continue;
      addWeightedEdge(
        c.agg,
        c.srcFileId,
        dstId,
        "references",
        specifier,
        bindingWeight(binding, c.usage),
      );
    }
  }

  /**
   * Resolve an imported name to the id of the `symbol` node for the export that
   * actually *declares* it — following re-exports through barrels via ts-morph's
   * own `getExportedDeclarations`, so `import { x } from "./barrel"` credits the
   * origin file's `x`, not the barrel. When ts-morph can't resolve the specifier
   * (e.g. an extensionless relative import), falls back to a filesystem-based
   * re-export walk that still sees through barrel hops (C-70). Returns null for
   * external / unresolved targets.
   * A name that resolves to no local declaration (an aliased re-export the
   * origin doesn't export under this name) yields a dangling edge, pruned after
   * assembly (`pruneDanglingReferences`).
   */
  private resolveSymbolTarget(
    c: EdgeCollector,
    decl: ImportDeclaration,
    importedName: string,
  ): string | null {
    const targetSf = decl.getModuleSpecifierSourceFile();
    if (targetSf) {
      const decls = targetSf.getExportedDeclarations().get(importedName);
      const originSf =
        decls && decls.length > 0 ? decls[0]!.getSourceFile() : targetSf;
      const originId = this.inRepoFileId(remapDistToSrc(originSf.getFilePath()));
      return originId ? symbolId(originId, importedName) : null;
    }
    // ts-morph couldn't link the specifier (extensionless / out-of-project);
    // trace the target's re-export hops on disk so an import through an
    // extensionless barrel still credits the origin symbol (C-70).
    return resolveReExportOrigin(
      { project: this.ensureProject(), repoRoot: this.repoRoot },
      c.srcAbs,
      decl.getModuleSpecifierValue(),
      importedName,
    );
  }

  private recordReExportEdge(c: EdgeCollector, decl: ExportDeclaration): void {
    if (!decl.hasModuleSpecifier()) return;
    const specifier = decl.getModuleSpecifierValue();
    if (!specifier) return;
    const dstId = this.resolveTarget(c, specifier, decl);
    if (dstId) {
      addWeightedEdge(c.agg, c.srcFileId, dstId, "re-exports", specifier, reExportWeight(decl));
    }
  }

  /**
   * Resolve an import/export specifier to a graph node id (an in-repo file id or
   * an `external` node, creating the external node on first sight), or `null`
   * when it should not produce an edge.
   */
  private resolveTarget(
    c: EdgeCollector,
    specifier: string,
    decl: ImportDeclaration | ExportDeclaration,
  ): string | null {
    const internal =
      this.resolveInternal(decl.getModuleSpecifierSourceFile()) ??
      this.resolveRelativeInternal(c.srcAbs, specifier);
    if (internal) return internal;
    if (isRelativeSpecifier(specifier)) {
      // A relative import ts-morph could not resolve and that does not point at
      // a file on disk (e.g. an alias, or a genuinely missing target). Dropping
      // it is correct: bucketing it as an npm external produced `npm:..` junk
      // nodes and masked real internal edges for any out-of-project TS (C-44).
      return null;
    }
    const extId = externalId(specifier);
    if (!c.seenExternals.has(extId)) {
      c.seenExternals.add(extId);
      c.externalNodes.push({ id: extId, kind: "external", name: specifier });
    }
    return extId;
  }

  private resolveInternal(target: SourceFile | undefined): string | null {
    if (!target) return null;
    return this.inRepoFileId(remapDistToSrc(target.getFilePath()));
  }

  /**
   * Resolve a relative specifier ts-morph failed to link by walking the
   * filesystem from the importing file. ts-morph's NodeNext resolution only
   * links relative imports that carry an explicit `.js` extension, so
   * extensionless bundler-style imports (`../types`, common in code outside the
   * tsconfig project such as `dashboard/`) resolve to nothing and would
   * otherwise fall through to the `npm:` external bucket (C-44). Resolves
   * through the ts-morph filesystem host so it honours in-memory test fixtures.
   */
  private resolveRelativeInternal(
    srcAbs: string,
    specifier: string,
  ): string | null {
    const abs = resolveRelativeAbs(
      this.ensureProject().getFileSystem(),
      srcAbs,
      specifier,
    );
    return abs ? inRepoFileId(this.repoRoot, abs) : null;
  }

  private inRepoFileId(abs: string): string | null {
    return inRepoFileId(this.repoRoot, abs);
  }
}

// ts-morph resolves workspace imports like `@codewatch/analyzer` to the
// package's `types` entry (`<pkg>/dist/index.d.ts`), but the indexer's file
// walker excludes `dist/` and `.d.ts`. Without remapping, every cross-package
// edge points to a nonexistent node and the rendered graph fails to construct.
function remapDistToSrc(abs: string): string {
  const m = /^(.*)[\\/]dist[\\/](.+)\.d\.ts$/.exec(abs);
  if (!m) return abs;
  const base = m[1]!;
  const sub = m[2]!;
  for (const ext of [".ts", ".tsx"]) {
    const candidate = path.join(base, "src", sub + ext);
    if (existsSync(candidate)) return candidate;
  }
  return abs;
}

function isTypeScriptFile(file: ParsedFile): boolean {
  return file.language === "typescript" || file.language === "tsx";
}
