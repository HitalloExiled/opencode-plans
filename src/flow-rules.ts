/**
 * Pure mapping from the flow setting to the concrete agent ids. Kept apart from
 * `flow.ts` (which touches the filesystem) so the GUI and the capture path can
 * share one rule and the mapping is unit-tested.
 */

import type { PlanFlow } from "./gui/contract.js";

/** The agent a run switches the session to. */
export function runAgent(flow: PlanFlow): "build" | "executor" {
  return flow === "dedicated" ? "executor" : "build";
}

/** The agent a pause returns the session to. */
export function pauseAgent(flow: PlanFlow): "plan" | "planner" {
  return flow === "dedicated" ? "planner" : "plan";
}

/** Agent ids whose messages `/save-plan` accepts. */
export function planMessageAgents(flow: PlanFlow): readonly string[] {
  return flow === "dedicated" ? ["plan", "planner"] : ["plan"];
}

/**
 * The agent a live session moves to when the flow changes, keeping its role.
 * A session planning stays planning and one executing stays executing; any
 * other agent (a custom one) is left alone, so the toggle never replaces a
 * choice the plugin did not make.
 */
export function flowAgentFor(
  current: string | undefined,
  flow: PlanFlow,
): "plan" | "planner" | "build" | "executor" | undefined {
  switch (current) {
    case "plan":
    case "planner":
      return pauseAgent(flow);
    case "build":
    case "executor":
      return runAgent(flow);
    default:
      return undefined;
  }
}
