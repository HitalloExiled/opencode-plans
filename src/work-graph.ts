/**
 * Layered layout for the dependency graph: dependencies on the left, the
 * items that wait for them on the right. Pure and deterministic so the same
 * data always produces the same picture.
 */

export type GraphNodeInput = {
  id: string;
  rank: number;
  createdAt: string;
};

export type GraphEdgeInput = { itemID: string; blocksID: string };

export type GraphPlacement = {
  id: string;
  layer: number;
  row: number;
  x: number;
  y: number;
};

export type GraphLayout = {
  placements: GraphPlacement[];
  width: number;
  height: number;
  layers: number;
  hasCycle: boolean;
};

export const GRAPH_NODE_WIDTH = 190;
/** Tall enough for the pills row, two title lines and the action row. */
export const GRAPH_NODE_HEIGHT = 100;
export const GRAPH_GAP_X = 90;
export const GRAPH_GAP_Y = 16;
export const GRAPH_PAD = 24;

/**
 * A closed work item offers no follow-up action: the engine closes it on
 * `done`, the user on `dropped`, so the card buttons must not show.
 */
export function isTerminalWorkStatus(status: string): boolean {
  return status === "done" || status === "dropped";
}

function orderNodes(nodes: readonly GraphNodeInput[]): GraphNodeInput[] {
  return [...nodes].sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export function layoutWorkGraph(
  nodes: readonly GraphNodeInput[],
  edges: readonly GraphEdgeInput[],
): GraphLayout {
  const ordered = orderNodes(nodes);
  const known = new Set(ordered.map((node) => node.id));
  const deps = new Map<string, string[]>();
  for (const edge of edges) {
    if (!known.has(edge.itemID) || !known.has(edge.blocksID)) continue;
    const bucket = deps.get(edge.itemID);
    if (bucket) bucket.push(edge.blocksID);
    else deps.set(edge.itemID, [edge.blocksID]);
  }

  const levels = new Map<string, number>();
  const visiting = new Set<string>();
  let hasCycle = false;

  const level = (id: string): number => {
    const cached = levels.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) {
      hasCycle = true;
      return 0;
    }
    visiting.add(id);
    let value = 0;
    for (const dep of deps.get(id) ?? []) value = Math.max(value, level(dep) + 1);
    visiting.delete(id);
    levels.set(id, value);
    return value;
  };

  for (const node of ordered) level(node.id);

  const layers = Math.max(0, ...ordered.map((node) => levels.get(node.id) ?? 0)) + 1;
  const rows = new Map<number, number>();
  const placements = ordered.map((node) => {
    const layer = levels.get(node.id) ?? 0;
    const row = rows.get(layer) ?? 0;
    rows.set(layer, row + 1);
    return {
      id: node.id,
      layer,
      row,
      x: GRAPH_PAD + layer * (GRAPH_NODE_WIDTH + GRAPH_GAP_X),
      y: GRAPH_PAD + row * (GRAPH_NODE_HEIGHT + GRAPH_GAP_Y),
    };
  });

  const maxRows = Math.max(1, ...rows.values());
  return {
    placements,
    layers,
    hasCycle,
    width: GRAPH_PAD * 2 + layers * (GRAPH_NODE_WIDTH + GRAPH_GAP_X) - GRAPH_GAP_X,
    height: GRAPH_PAD * 2 + maxRows * (GRAPH_NODE_HEIGHT + GRAPH_GAP_Y) - GRAPH_GAP_Y,
  };
}

/**
 * Whether adding `itemID depends on blocksID` would close a cycle: it would
 * when blocksID already depends on itemID, directly or transitively. The drag
 * uses this to refuse the drop before asking the server.
 */
export function wouldCreateCycle(
  edges: readonly GraphEdgeInput[],
  itemID: string,
  blocksID: string,
): boolean {
  if (itemID === blocksID) return true;
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const bucket = adjacency.get(edge.itemID);
    if (bucket) bucket.push(edge.blocksID);
    else adjacency.set(edge.itemID, [edge.blocksID]);
  }
  const seen = new Set<string>();
  const stack = [blocksID];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === itemID) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of adjacency.get(current) ?? []) stack.push(next);
  }
  return false;
}
