import { DrainTree, type DrainTreeOptions, type DrainTreeSnapshot } from "./drain/tree.js";

/**
 * One `DrainTree` per partition key, created lazily. Partition before Drain
 * sees a line (by tool type, log source, whatever the domain routes on) so two
 * sources whose token shapes happen to overlap never share a cluster.
 */
export class DrainTreeRegistry {
  private readonly trees = new Map<string, DrainTree>();

  constructor(private readonly options?: DrainTreeOptions) {}

  getTree(partition: string): DrainTree {
    let tree = this.trees.get(partition);
    if (!tree) {
      tree = new DrainTree(this.options);
      this.trees.set(partition, tree);
    }
    return tree;
  }

  /** Install a tree rebuilt from a snapshot, replacing any tree for `partition`. */
  restore(partition: string, snapshot: DrainTreeSnapshot): void {
    this.trees.set(partition, DrainTree.fromSnapshot(snapshot, this.options));
  }

  snapshot(): Record<string, DrainTreeSnapshot> {
    return Object.fromEntries([...this.trees].map(([key, tree]) => [key, tree.toSnapshot()]));
  }

  /** True when any partition has hit its cluster cap and is evicting. */
  get anyAtCapacity(): boolean {
    return [...this.trees.values()].some((tree) => tree.atCapacity);
  }

  get partitions(): string[] {
    return [...this.trees.keys()];
  }
}
