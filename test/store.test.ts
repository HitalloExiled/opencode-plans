/**
 * Store tests — schema, parsing, and the plan/step lifecycle.
 *
 * Runs against an in-memory `node:sqlite` database (same backend as
 * production, `:memory:` path), so the schema is exercised exactly as it
 * runs on first open of a real plans.db.
 */

import { describe, expect, test } from "bun:test";

const { DatabaseSync } = (await import("node:sqlite")) as any;

import {
  deletePlan,
  deriveStatus,
  extractTitle,
  getPlan,
  initSchema,
  listPlans,
  parseSteps,
  planProgress,
  renderPlanFull,
  savePlan,
  schemaVersion,
  setStep,
  updatePlan,
  type Db,
} from "../src/store";

const open = (): Db => {
  const db = new DatabaseSync(":memory:") as Db;
  initSchema(db);
  return db;
};

const base = {
  projectID: "project-1",
  projectDirectory: "/tmp/project-1",
  sessionID: "session-1",
  messageID: "message-1",
};

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

describe("parseSteps", () => {
  test("task-list items anywhere win", () => {
    const steps = parseSteps("# Plan\n\n- [ ] First\n- [x] Second\n");
    expect(steps).toEqual([
      { text: "First", status: "todo" },
      { text: "Second", status: "done" },
    ]);
  });

  test("numbered items under a plan heading", () => {
    const steps = parseSteps("# Plan\n\n## Steps\n1. Explore\n2. Implement\n3. Test\n");
    expect(steps.map((step) => step.text)).toEqual(["Explore", "Implement", "Test"]);
    expect(steps.every((step) => step.status === "todo")).toBe(true);
  });

  test("fenced code is ignored", () => {
    const steps = parseSteps("## Steps\n1. Run this:\n```bash\n1. not a step\n2. also not\n```\n2. Then test\n");
    expect(steps.map((step) => step.text)).toEqual(["Run this:", "Then test"]);
  });

  test("light Markdown is cleaned", () => {
    const steps = parseSteps("- [ ] **Bold** and `code` and [link](https://example.com)\n");
    expect(steps[0]?.text).toBe("Bold and code and link");
  });

  test("deduplicates and caps", () => {
    const body = Array.from({ length: 120 }, (_, index) => `- [ ] Step ${index % 100}`).join("\n");
    const steps = parseSteps(body);
    expect(steps.length).toBe(100);
  });
});

describe("extractTitle", () => {
  test("uses the first heading", () => {
    expect(extractTitle("## Ship the release\n\nbody")).toBe("Ship the release");
  });

  test("falls back to the first line", () => {
    expect(extractTitle("Implement the plans plugin\n\nbody")).toBe("Implement the plans plugin");
  });

  test("ignores fenced code", () => {
    expect(extractTitle("```\ncode\n```\n# Real title")).toBe("Real title");
  });

  test("fallback when empty", () => {
    expect(extractTitle("   ", "Fallback")).toBe("Fallback");
  });
});

describe("deriveStatus", () => {
  test("no steps -> active", () => {
    expect(deriveStatus([])).toBe("active");
  });

  test("all done -> done", () => {
    expect(deriveStatus([{ status: "done" }, { status: "done" }])).toBe("done");
  });

  test("a pending step -> active", () => {
    expect(deriveStatus([{ status: "done" }, { status: "todo" }])).toBe("active");
  });

  test("terminal states are preserved", () => {
    expect(deriveStatus([{ status: "todo" }], "abandoned")).toBe("abandoned");
    expect(deriveStatus([{ status: "todo" }], "superseded")).toBe("superseded");
  });
});

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

describe("plan lifecycle", () => {
  test("schema version is current", () => {
    expect(schemaVersion(open())).toBe(1);
  });

  test("save creates a plan with parsed steps", () => {
    const db = open();
    const result = savePlan(db, {
      ...base,
      body: "# Plan\n\n## Steps\n1. Explore\n2. Implement\n",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.title).toBe("Plan");
    expect(result.plan.project_id).toBe("project-1");
    expect(result.plan.project_directory).toBe("/tmp/project-1");
    expect(result.plan.session_id).toBe("session-1");
    expect(result.plan.status).toBe("active");
    expect(result.plan.steps.map((step) => step.text)).toEqual(["Explore", "Implement"]);
    expect(result.plan.steps[0]?.step_id).toBe("s1");
  });

  test("save with an id updates and preserves done steps", () => {
    const db = open();
    const created = savePlan(db, {
      ...base,
      body: "# Plan\n\n- [ ] One\n- [ ] Two\n",
    });
    if (!created.ok) throw new Error(created.error);
    const first = setStep(db, { id: created.plan.id, stepID: "s1", done: true });
    if (!first.ok) throw new Error(first.error);

    const updated = savePlan(db, {
      ...base,
      id: created.plan.id,
      body: "# Plan\n\n- [ ] One\n- [ ] Two\n- [ ] Three\n",
    });
    if (!updated.ok) throw new Error(updated.error);
    expect(updated.plan.steps.map((step) => [step.text, step.status])).toEqual([
      ["One", "done"],
      ["Two", "todo"],
      ["Three", "todo"],
    ]);
  });

  test("setStep marks the plan done when all steps are done", () => {
    const db = open();
    const created = savePlan(db, {
      ...base,
      body: "# Plan\n\n- [ ] One\n- [ ] Two\n",
    });
    if (!created.ok) throw new Error(created.error);

    const first = setStep(db, { id: created.plan.id, stepID: "s1", done: true });
    if (!first.ok) throw new Error(first.error);
    expect(first.plan.status).toBe("active");

    const second = setStep(db, { id: created.plan.id, stepID: "s2", done: true });
    if (!second.ok) throw new Error(second.error);
    expect(second.plan.status).toBe("done");
    expect(second.plan.completed_at).not.toBeNull();

    const reopened = setStep(db, { id: created.plan.id, stepID: "s1", done: false });
    if (!reopened.ok) throw new Error(reopened.error);
    expect(reopened.plan.status).toBe("active");
    expect(reopened.plan.completed_at).toBeNull();
  });

  test("updatePlan changes status and title", () => {
    const db = open();
    const created = savePlan(db, { ...base, body: "# Plan\n\n- [ ] One\n" });
    if (!created.ok) throw new Error(created.error);

    const updated = updatePlan(db, {
      id: created.plan.id,
      title: "Renamed",
      status: "abandoned",
    });
    if (!updated.ok) throw new Error(updated.error);
    expect(updated.plan.title).toBe("Renamed");
    expect(updated.plan.status).toBe("abandoned");
  });

  test("list filters by project and status, newest first", () => {
    const db = open();
    const first = savePlan(db, { ...base, body: "# One\n\n- [ ] A\n" });
    const second = savePlan(db, { ...base, body: "# Two\n\n- [ ] B\n" });
    const other = savePlan(db, {
      ...base,
      projectID: "project-2",
      projectDirectory: "/tmp/project-2",
      body: "# Other\n\n- [ ] C\n",
    });
    if (!first.ok || !second.ok || !other.ok) throw new Error("save failed");

    const active = listPlans(db, { projectID: "project-1", status: "active" });
    expect(active.map((plan) => plan.title)).toEqual(["Two", "One"]);

    const all = listPlans(db, { projectID: "project-1", status: "all" });
    expect(all.length).toBe(2);

    const global = listPlans(db, { status: "all" });
    expect(global.length).toBe(3);
  });

  test("getPlan and deletePlan", () => {
    const db = open();
    const created = savePlan(db, { ...base, body: "# Plan\n\n- [ ] One\n" });
    if (!created.ok) throw new Error(created.error);

    expect(getPlan(db, created.plan.id)?.title).toBe("Plan");
    expect(getPlan(db, "missing")).toBeUndefined();

    const removed = deletePlan(db, created.plan.id);
    expect(removed.ok).toBe(true);
    expect(getPlan(db, created.plan.id)).toBeUndefined();
  });

  test("planProgress and renderPlanFull", () => {
    const db = open();
    const created = savePlan(db, { ...base, body: "# Plan\n\n- [x] One\n- [ ] Two\n" });
    if (!created.ok) throw new Error(created.error);

    expect(planProgress(created.plan)).toEqual({ done: 1, total: 2 });
    const rendered = renderPlanFull(created.plan);
    expect(rendered).toContain("# Plan");
    expect(rendered).toContain("- [x] One");
    expect(rendered).toContain("- [ ] Two");
    expect(rendered).toContain("## Plano");
  });

  test("empty body is rejected", () => {
    const db = open();
    const result = savePlan(db, { ...base, body: "   " });
    expect(result.ok).toBe(false);
  });
});
