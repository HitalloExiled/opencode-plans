/**
 * Ordering shared by the work list surfaces: status first (the UI order), then
 * the manual rank, then creation. Kept pure so the RPC and the tests agree.
 */

import { WORK_STATUS_ORDER } from "./gui/contract.js";

export type WorkItemLike = { status: string; rank: number; created_at: string };

export function workStatusRank(status: string): number {
  const index = WORK_STATUS_ORDER.indexOf(status as (typeof WORK_STATUS_ORDER)[number]);
  return index === -1 ? WORK_STATUS_ORDER.length : index;
}

export function sortWorkItems<T extends WorkItemLike>(items: readonly T[]): T[] {
  return [...items].sort(
    (a, b) =>
      workStatusRank(a.status) - workStatusRank(b.status) ||
      a.rank - b.rank ||
      a.created_at.localeCompare(b.created_at),
  );
}
