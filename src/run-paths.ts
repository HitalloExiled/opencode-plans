/**
 * Where a run keeps its git things. Pure paths so the engine, the merge
 * session and the tests agree without importing each other.
 */

import { dirname, join } from "node:path";
import { plansDbPath } from "./store.js";

/** Worktrees live next to `plans.db`, never inside the user's repo. */
export function runPaths(runID: string) {
  const root = join(dirname(plansDbPath()), "worktrees", runID);
  return {
    root,
    integration: join(root, "integration"),
    item: (itemID: string) => join(root, "items", itemID),
  };
}

export function integrationBranch(runID: string): string {
  return `run/${runID}`;
}

export function itemBranch(itemID: string): string {
  return `wi/${itemID}`;
}
