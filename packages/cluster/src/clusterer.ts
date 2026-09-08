import type { DrainTreeOptions, DrainTreeSnapshot } from "./drain/tree.js";
import { DEFAULT_MASK_CONFIGS, applyMasks, type MaskConfigs } from "./masks.js";
import { DrainTreeRegistry } from "./registry.js";
import { extractSignature, type Signature } from "./signature.js";
import { templateId as computeTemplateId } from "./template-id.js";

export interface ClustererOptions {
  drain?: DrainTreeOptions;
  masks?: MaskConfigs;
}

export interface ClusterInput {
  /** Drain partition, e.g. a tool type. Also selects the mask config. */
  partition: string;
  text: string;
}

export interface ClusterResult {
  templateId: string;
  partition: string;
  maskedSignature: string;
  extractedParams: Record<string, string>;
  signature: Signature;
  /** True the first time this template id is minted by this clusterer (or since its snapshot). */
  isNewTemplate: boolean;
}

/** One partition's persisted state: the Drain tree plus its cluster-to-template bindings. */
export interface PartitionSnapshot extends DrainTreeSnapshot {
  partition: string;
  templateIds: [clusterId: number, templateId: string][];
}

export interface ClustererSnapshot {
  version: 1;
  partitions: PartitionSnapshot[];
}

function tokenize(signatureLine: string): string[] {
  return signatureLine.split(/\s+/).filter((t) => t.length > 0);
}

/**
 * The storage-free clustering pipeline: signature extraction, masking, Drain,
 * deterministic template id. Persist the snapshot to survive restarts with
 * learned wildcards and id bindings intact; where occurrences go is the
 * caller's concern.
 */
export class Clusterer {
  private readonly registry: DrainTreeRegistry;
  private readonly masks: MaskConfigs;
  private readonly clusterTemplateIds = new Map<string, Map<number, string>>();
  private readonly knownTemplateIds = new Set<string>();

  constructor(private readonly options: ClustererOptions = {}) {
    this.registry = new DrainTreeRegistry(options.drain);
    this.masks = options.masks ?? DEFAULT_MASK_CONFIGS;
  }

  static fromSnapshot(snapshot: ClustererSnapshot, options: ClustererOptions = {}): Clusterer {
    const clusterer = new Clusterer(options);
    for (const part of snapshot.partitions) {
      clusterer.registry.restore(part.partition, { nextClusterId: part.nextClusterId, clusters: part.clusters });
      for (const [clusterId, id] of part.templateIds) clusterer.bind(part.partition, clusterId, id);
    }
    return clusterer;
  }

  cluster({ partition, text }: ClusterInput): ClusterResult {
    const signature = extractSignature(partition, text);
    const { maskedSignature, extractedParams } = applyMasks(partition, signature.signatureLine, this.masks);
    const { cluster } = this.registry.getTree(partition).insert(tokenize(maskedSignature));

    const bound = this.clusterTemplateIds.get(partition)?.get(cluster.clusterId);
    const id = bound ?? computeTemplateId(partition, maskedSignature);
    const isNewTemplate = !this.knownTemplateIds.has(id);
    if (bound === undefined) this.bind(partition, cluster.clusterId, id);
    return { templateId: id, partition, maskedSignature, extractedParams, signature, isNewTemplate };
  }

  snapshot(): ClustererSnapshot {
    const partitions = Object.entries(this.registry.snapshot()).map(([partition, tree]) => ({
      partition,
      ...tree,
      templateIds: [...(this.clusterTemplateIds.get(partition) ?? new Map<number, string>())],
    }));
    return { version: 1, partitions };
  }

  get templateCount(): number {
    return this.knownTemplateIds.size;
  }

  /** True once any partition is at its cluster cap; clustering is no longer order-independent. */
  get evicting(): boolean {
    return this.registry.anyAtCapacity;
  }

  private bind(partition: string, clusterId: number, id: string): void {
    let byCluster = this.clusterTemplateIds.get(partition);
    if (!byCluster) {
      byCluster = new Map();
      this.clusterTemplateIds.set(partition, byCluster);
    }
    byCluster.set(clusterId, id);
    this.knownTemplateIds.add(id);
  }
}
