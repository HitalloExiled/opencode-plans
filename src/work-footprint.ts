/**
 * Plan footprints and implicit dependencies (F4).
 *
 * The plan declares the files/globs it touches; two items whose footprints
 * overlap must not run in parallel, so one gains an implicit dependency on the
 * other. Direction is deterministic (rank, created_at, id) and the edges only
 * ever point from a later item to an earlier one, so the computation itself
 * cannot create a cycle. A pair already ordered by the explicit graph is left
 * alone: order is order, whichever edge created it.
 *
 * Matching is conservative on purpose: an exact path is matched against the
 * other side's glob, while two globs overlap when their literal prefixes are
 * compatible. Over-serializing is safe; running two writers in parallel is not.
 */

export type FootprintItem = {
  id: string;
  rank: number;
  createdAt: string;
  /** Empty means unknown: it conflicts with everything (serializes). */
  touches: readonly string[];
};

export type DepEdge = { itemID: string; blocksID: string };
export type ImplicitEdge = DepEdge & { reason: string };

function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function hasGlob(pattern: string): boolean {
  return pattern.includes("*") || pattern.includes("?");
}

function globToRegex(pattern: string): RegExp {
  const value = normalizePath(pattern);
  let out = "^";
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!;
    if (char === "*") {
      if (value[index + 1] === "*") {
        out += ".*";
        index++;
        // "src/**/x" should also match "src/x".
        if (value[index + 1] === "/") index++;
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      continue;
    }
    out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${out}$`);
}

/** Exact path, or a directory prefix when the pattern has no glob. */
function matchesEntry(pattern: string, path: string): boolean {
  const clean = normalizePath(pattern);
  const target = normalizePath(path);
  if (hasGlob(clean)) return globToRegex(clean).test(target);
  const prefix = clean.endsWith("/") ? clean : `${clean}/`;
  return target === clean || target.startsWith(prefix);
}

function staticPrefix(pattern: string): string {
  const value = normalizePath(pattern);
  const index = value.search(/[*?]/);
  return index < 0 ? value : value.slice(0, index);
}

function entriesOverlap(left: string, right: string): boolean {
  const leftGlob = hasGlob(left);
  const rightGlob = hasGlob(right);
  if (!leftGlob) return matchesEntry(right, left);
  if (!rightGlob) return matchesEntry(left, right);
  // Both globs: compatible literal prefixes are enough (conservative).
  const a = staticPrefix(left);
  const b = staticPrefix(right);
  return a.startsWith(b) || b.startsWith(a);
}

/** The overlapping entry pairs, e.g. "src/** ∩ src/a.ts"; "*" for unknown. */
export function overlapPaths(left: readonly string[], right: readonly string[]): string[] {
  if (left.length === 0 || right.length === 0) return ["*"];
  const hits: string[] = [];
  for (const a of left) {
    for (const b of right) {
      if (!entriesOverlap(a, b)) continue;
      const label = `${normalizePath(a)} ∩ ${normalizePath(b)}`;
      if (!hits.includes(label)) hits.push(label);
    }
  }
  return hits;
}

function compareItems(a: FootprintItem, b: FootprintItem): number {
  if (a.rank !== b.rank) return a.rank - b.rank;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function addEdge(graph: Map<string, Set<string>>, itemID: string, blocksID: string): void {
  const bucket = graph.get(itemID);
  if (bucket) bucket.add(blocksID);
  else graph.set(itemID, new Set([blocksID]));
}

function hasPath(graph: ReadonlyMap<string, ReadonlySet<string>>, from: string, to: string): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === to) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of graph.get(current) ?? []) stack.push(next);
  }
  return false;
}

/**
 * Implicit edges for the overlapping pairs that the explicit graph has not
 * already ordered. The later item depends on the earlier one.
 */
export function computeImplicitDeps(
  items: readonly FootprintItem[],
  explicit: readonly DepEdge[],
): ImplicitEdge[] {
  const ordered = [...items].sort(compareItems);
  const graph = new Map<string, Set<string>>();
  for (const edge of explicit) addEdge(graph, edge.itemID, edge.blocksID);

  const edges: ImplicitEdge[] = [];
  for (let earlier = 0; earlier < ordered.length; earlier++) {
    for (let later = earlier + 1; later < ordered.length; later++) {
      const first = ordered[earlier]!;
      const second = ordered[later]!;
      const overlap = overlapPaths(first.touches, second.touches);
      if (overlap.length === 0) continue;
      if (hasPath(graph, first.id, second.id) || hasPath(graph, second.id, first.id)) continue;

      addEdge(graph, second.id, first.id);
      edges.push({
        itemID: second.id,
        blocksID: first.id,
        reason: JSON.stringify(overlap),
      });
    }
  }
  return edges;
}

/**
 * The first cycle in the dependency graph, if any: the ids in order, the last
 * one depending on the first. Used by the run preflight.
 */
export function findDependencyCycle(edges: readonly DepEdge[]): string[] | undefined {
  const graph = new Map<string, Set<string>>();
  for (const edge of edges) addEdge(graph, edge.itemID, edge.blocksID);

  const state = new Map<string, "visiting" | "done">();
  const path: string[] = [];

  const visit = (node: string): string[] | undefined => {
    const current = state.get(node);
    if (current === "visiting") {
      const start = path.indexOf(node);
      return [...path.slice(start), node];
    }
    if (current === "done") return undefined;
    state.set(node, "visiting");
    path.push(node);
    for (const next of graph.get(node) ?? []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    path.pop();
    state.set(node, "done");
    return undefined;
  };

  for (const node of graph.keys()) {
    const cycle = visit(node);
    if (cycle) return cycle;
  }
  return undefined;
}
