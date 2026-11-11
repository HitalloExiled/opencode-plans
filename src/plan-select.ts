/**
 * Which plan the composer pill offers to run.
 *
 * Kept free of GUI imports so the rule is testable without a desktop host:
 * only an `active` plan of the routed session qualifies, and the most recently
 * updated one wins.
 */

import type { Plan } from "./gui/contract.js";

export function pickRunnablePlan(plans: readonly Plan[], sessionID: string): Plan | undefined {
  let best: Plan | undefined;
  for (const plan of plans) {
    if (plan.sessionID !== sessionID || plan.status !== "active") continue;
    if (!best || plan.updatedAt > best.updatedAt) best = plan;
  }
  return best;
}
