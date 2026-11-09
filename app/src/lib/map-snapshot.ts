/**
 * Client-side normalization of a disk-map snapshot.
 *
 * The backend emits aggregate "… N smaller items" nodes with an empty id.
 * Several aggregates would then share one React key and one selection id.
 * Each id-less node gets a unique synthetic id; its `can_reveal` stays false,
 * so the synthetic id is never sent to `reveal_map_node`.
 */
export interface NormalizableMapNode {
  id: string;
  name: string;
  can_reveal: boolean;
  children: NormalizableMapNode[];
}

export const AGGREGATE_ID_PREFIX = "aggregate:";

export function normalizeMapTree<N extends NormalizableMapNode>(root: N): N {
  const visit = (node: N, parentId: string, index: number): N => {
    const synthetic = !node.id;
    const id = synthetic ? `${AGGREGATE_ID_PREFIX}${parentId}/${index}` : node.id;
    return {
      ...node,
      id,
      can_reveal: synthetic ? false : node.can_reveal,
      children: node.children.map((child, childIndex) => visit(child as N, id, childIndex)),
    };
  };
  return visit(root, "root", 0);
}

export function isAggregateNode(node: { id: string; can_reveal: boolean }) {
  return node.id.startsWith(AGGREGATE_ID_PREFIX) && !node.can_reveal;
}

/** Extracts N from the backend aggregate label "… N smaller items". */
export function aggregateItemCount(name: string): number | null {
  const match = /(\d+)\s+smaller items/.exec(name);
  return match ? Number(match[1]) : null;
}
