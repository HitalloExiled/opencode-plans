/**
 * Write rules for the `work.*` tools: title normalization, dedupe and the
 * per-request write budget. Pure so the limits are tested without the store.
 */

import type { WorkItemRow, WorkItemStatus } from "./store.js";

/** A request may create at most this many items, across every work.save call. */
export const MAX_ITEMS_PER_REQUEST = 3;

/** How long a message's budget is remembered. */
export const BUDGET_WINDOW_MS = 30 * 60 * 1000;

export function isTerminalStatus(status: WorkItemStatus): boolean {
  return status === "done" || status === "dropped";
}

/** Accent- and case-insensitive, whitespace collapsed: "Fix  THE bug" == "fix the bug". */
export function normalizeItemTitle(title: string): string {
  return title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The dedupe rule: same project (the caller already filtered), same parent and
 * a non-terminal status. A closed item with the same title does not absorb a
 * new need — it was done or dropped, so the need came back.
 */
export function findDuplicateItem(
  items: readonly WorkItemRow[],
  input: { title: string; parentID: string | null },
): WorkItemRow | undefined {
  const wanted = normalizeItemTitle(input.title);
  return items.find(
    (item) =>
      item.parent_id === input.parentID &&
      !isTerminalStatus(item.status) &&
      normalizeItemTitle(item.title) === wanted,
  );
}

export type BudgetEntry = { count: number; at: number };

/**
 * Claims `requested` item slots for a request key. Returns the remaining slots,
 * or `undefined` when the request would exceed the cap (and nothing is
 * claimed). Entries older than the window are pruned on every call.
 */
export function claimItems(
  entries: Map<string, BudgetEntry>,
  key: string,
  requested: number,
  now: number,
): number | undefined {
  for (const [entryKey, entry] of entries) {
    if (now - entry.at > BUDGET_WINDOW_MS) entries.delete(entryKey);
  }
  const used = entries.get(key)?.count ?? 0;
  if (used + requested > MAX_ITEMS_PER_REQUEST) return undefined;
  entries.set(key, { count: used + requested, at: now });
  return MAX_ITEMS_PER_REQUEST - used - requested;
}
