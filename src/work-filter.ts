/**
 * Client-side views over the work list. Kept pure so the filtering is tested
 * without the renderer.
 */

import type { WorkGroup } from "./gui/contract.js";

/** Keeps only agent-proposed items; groups left empty are dropped. */
export function filterWorkGroups(groups: readonly WorkGroup[], agentOnly: boolean): WorkGroup[] {
  if (!agentOnly) return [...groups];
  return groups
    .map((group) => ({ ...group, items: group.items.filter((item) => item.origin === "agent") }))
    .filter((group) => group.items.length > 0);
}
