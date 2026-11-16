/**
 * Pure run scheduler (F4). The engine owns the side effects; this module only
 * decides, from the item statuses and the dependency graph, which items start
 * now, which dependents a failure skips, and whether the run is finished.
 *
 * Rules:
 * - only `queued` items with every dependency `merged` are eligible (the gate
 *   is integration, not just execution);
 * - a running item occupies a slot, a merging one does not: the merge queue is
 *   serialized separately;
 * - a failed/skipped dependency skips its dependents transitively;
 * - order is the caller's (rank, created_at, id), never a Map's.
 */

import type { RunItemStatus } from "./store.js";

export type SchedulerItem = {
  id: string;
  /** Items it waits for. */
  deps: readonly string[];
  status: RunItemStatus;
};

export type SchedulerDecision = {
  /** Items to launch now, in order. */
  start: string[];
  /** Items to mark skipped because a dependency failed. */
  skip: string[];
  /** Nothing left to execute or merge. */
  done: boolean;
};

const FAILED = new Set<RunItemStatus>(["failed", "skipped"]);
const RUNNING: RunItemStatus = "running";
const MERGING: RunItemStatus = "merging";
const MERGED: RunItemStatus = "merged";

export function scheduleRun(items: readonly SchedulerItem[], maxParallel: number): SchedulerDecision {
  const byId = new Map(items.map((item) => [item.id, item]));

  // Propagate failures first: a skip in this pass can skip the next level.
  const skip = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of items) {
      if (item.status !== "queued" || skip.has(item.id)) continue;
      const blocked = item.deps.some((dep) => {
        const current = byId.get(dep);
        return current !== undefined && (FAILED.has(current.status) || skip.has(dep));
      });
      if (blocked) {
        skip.add(item.id);
        changed = true;
      }
    }
  }

  const running = items.filter((item) => item.status === RUNNING).length;
  const slots = Math.max(0, Math.max(1, Math.trunc(maxParallel)) - running);
  const start: string[] = [];
  for (const item of items) {
    if (start.length >= slots) break;
    if (item.status !== "queued" || skip.has(item.id)) continue;
    const ready = item.deps.every((dep) => byId.get(dep)?.status === MERGED || byId.get(dep) === undefined);
    if (ready) start.push(item.id);
  }

  const pending = items.some(
    (item) =>
      !skip.has(item.id) &&
      (item.status === "queued" || item.status === RUNNING || item.status === MERGING),
  );

  return { start, skip: [...skip], done: !pending };
}

/**
 * A run's overall status: failed when an item failed (skips alone are the
 * consequence), otherwise done once nothing is pending.
 */
export function summarizeRun(
  items: readonly { status: RunItemStatus }[],
): { status: "running" | "done" | "failed"; merged: number; failed: number; skipped: number } {
  const failed = items.filter((item) => item.status === "failed").length;
  const merged = items.filter((item) => item.status === "merged").length;
  const skipped = items.filter((item) => item.status === "skipped").length;
  const pending = items.some((item) => item.status === "queued" || item.status === "running" || item.status === "merging");
  if (!pending) return { status: failed > 0 ? "failed" : "done", merged, failed, skipped };
  return { status: "running", merged, failed, skipped };
}
