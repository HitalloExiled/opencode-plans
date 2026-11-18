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

/**
 * Agent ids whose messages `/save-plan` accepts. `planner` is captured in
 * either flow: it is not a flow switch, it is a session that can have a
 * `planner` agent selected by hand with the switch off.
 */
export function planMessageAgents(_flow: PlanFlow): readonly string[] {
  return ["plan", "planner"];
}
