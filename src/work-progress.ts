/**
 * Plan progress shown on a work item card. Kept pure so the counting is tested
 * without the renderer; the card and the detail can share the same numbers.
 */

import type { Plan } from "./gui/contract.js";

export type PlanProgress = {
  done: number;
  total: number;
  /** Rounded 0-100, for the bar width. */
  percent: number;
  /** Text of the step in progress, when one is doing. */
  doing?: string;
};

export function planProgressOf(plan: Plan): PlanProgress {
  const total = plan.steps.length;
  const done = plan.steps.filter((step) => step.status === "done").length;
  const doing = plan.steps.find((step) => step.status === "doing")?.text;
  return {
    done,
    total,
    percent: total === 0 ? 0 : Math.round((done / total) * 100),
    ...(doing ? { doing } : {}),
  };
}
