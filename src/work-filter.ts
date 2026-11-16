/**
 * Client-side views over the work list. Kept pure so the filtering is tested
 * without the renderer.
 */

import type { WorkGroup } from "./gui/contract.js";

export type WorkFilters = {
  /** Keep only items proposed by the agent. */
  agentOnly: boolean;
  /** Include discarded items (hidden by default). */
  showDropped: boolean;
};

export function filterWorkGroups(groups: readonly WorkGroup[], filters: WorkFilters): WorkGroup[] {
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter(
        (item) =>
          (!filters.agentOnly || item.origin === "agent") &&
          (filters.showDropped || item.status !== "dropped"),
      ),
    }))
    .filter((group) => group.items.length > 0);
}
