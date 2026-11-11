/**
 * Which plan the composer pill offers: pure selection rules, no GUI host.
 */

import { describe, expect, test } from "bun:test";
import { pickRunnablePlan } from "../src/plan-select";
import type { Plan } from "../src/gui/contract";

const plan = (overrides: Partial<Plan> = {}): Plan => ({
  id: "p1",
  projectID: "proj",
  projectDirectory: "/tmp/proj",
  sessionID: "s1",
  title: "Plan",
  body: "# Plan",
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  steps: [],
  ...overrides,
});

describe("pickRunnablePlan", () => {
  test("returns the most recently updated active plan of the session", () => {
    const older = plan({ id: "old", updatedAt: "2026-01-01T00:00:00.000Z" });
    const newer = plan({ id: "new", updatedAt: "2026-02-01T00:00:00.000Z" });
    expect(pickRunnablePlan([older, newer], "s1")?.id).toBe("new");
    expect(pickRunnablePlan([newer, older], "s1")?.id).toBe("new");
  });

  test("ignores plans of another session", () => {
    const other = plan({ id: "other", sessionID: "s2" });
    const mine = plan({ id: "mine" });
    expect(pickRunnablePlan([other, mine], "s1")?.id).toBe("mine");
    expect(pickRunnablePlan([other], "s1")).toBeUndefined();
  });

  test("ignores plans that are not active", () => {
    for (const status of ["done", "archived", "superseded"] as const) {
      expect(pickRunnablePlan([plan({ status })], "s1")).toBeUndefined();
    }
  });

  test("returns undefined when nothing qualifies", () => {
    expect(pickRunnablePlan([], "s1")).toBeUndefined();
  });
});
