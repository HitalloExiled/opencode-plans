import { describe, expect, test } from "bun:test";
import { planProgressOf } from "../src/work-progress";
import type { Plan, PlanStep } from "../src/gui/contract";

const step = (id: string, status: PlanStep["status"], text = id): PlanStep => ({
  id,
  position: Number(id.slice(1)),
  text,
  status,
});

const plan = (steps: PlanStep[]): Plan => ({
  id: "plan-1",
  projectID: "p1",
  projectDirectory: "/work/app",
  sessionID: "ses_1",
  title: "Plan",
  body: "",
  status: "active",
  createdAt: "",
  updatedAt: "",
  workItemID: "item-1",
  steps,
});

describe("planProgressOf", () => {
  test("counts done steps and rounds the percent", () => {
    const progress = planProgressOf(plan([step("s1", "done"), step("s2", "todo"), step("s3", "todo")]));
    expect(progress).toEqual({ done: 1, total: 3, percent: 33 });
  });

  test("reports the doing step text", () => {
    const progress = planProgressOf(plan([step("s1", "done"), step("s2", "doing", "wire the store")]));
    expect(progress.doing).toBe("wire the store");
    expect(progress.done).toBe(1);
    expect(progress.percent).toBe(50);
  });

  test("has no doing text when every step is done", () => {
    const progress = planProgressOf(plan([step("s1", "done"), step("s2", "done")]));
    expect(progress.doing).toBeUndefined();
    expect(progress.percent).toBe(100);
  });

  test("a plan with no steps is zeroed", () => {
    expect(planProgressOf(plan([]))).toEqual({ done: 0, total: 0, percent: 0 });
  });
});
