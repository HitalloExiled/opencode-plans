import { describe, expect, test } from "bun:test";
import { renderWorkItemDetail, renderWorkItemLine } from "../src/work-render";
import type { Plan, StepRow, WorkItemRow } from "../src/store";

const item = (id: string, overrides: Partial<WorkItemRow> = {}): WorkItemRow => ({
  id,
  initiative_id: "p1",
  repo_id: null,
  parent_id: null,
  title: `Item ${id}`,
  body: "",
  status: "backlog",
  rank: 1,
  origin: "user",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  closed_at: null,
  ...overrides,
});

const step = (id: string, status: StepRow["status"]): StepRow => ({
  plan_id: "plan-1",
  position: Number(id.slice(1)),
  step_id: id,
  text: `Step ${id}`,
  status,
});

const plan = (steps: StepRow[], status: Plan["status"] = "active"): Plan => ({
  id: "plan-1",
  project_id: "prj_1",
  project_directory: "/work",
  session_id: "ses_1",
  message_id: null,
  title: "Ship it",
  body: "# Ship it",
  status,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  completed_at: null,
  work_item_id: "a",
  steps,
});

describe("renderWorkItemLine", () => {
  test("shows id, rank, plan progress and blocked ids", () => {
    const line = renderWorkItemLine(item("a", { status: "doing", rank: 2 }), {
      blockedBy: [item("b"), item("c")],
      plan: plan([step("s1", "done"), step("s2", "doing")]),
    });
    expect(line).toBe("- [doing] Item a (id=a, rank=2, plan=active 1/2, blocked-by=b,c)");
  });

  test("marks an absent plan and no blockers", () => {
    expect(renderWorkItemLine(item("a"), { blockedBy: [] })).toBe(
      "- [backlog] Item a (id=a, rank=1, plan=none, blocked-by=none)",
    );
  });

  test("collapses newlines in the title", () => {
    expect(renderWorkItemLine(item("a", { title: "line one\nline two" }), { blockedBy: [] })).toContain(
      "line one line two",
    );
  });
});

describe("renderWorkItemDetail", () => {
  test("renders metadata, deps, plans and the body as data", () => {
    const text = renderWorkItemDetail({
      item: item("a", { title: "Need it", body: "  do the thing  ", status: "doing" }),
      initiativeName: "App",
      blockedBy: [item("b", { title: "First" })],
      blocks: [],
      parent: undefined,
      children: [item("c")],
      plan: plan([step("s1", "done")]),
    });
    expect(text).toContain("Work item: Need it");
    expect(text).toContain("id=a initiative=\"App\" status=doing");
    expect(text).toContain("parent: none");
    expect(text).toContain("children (1): c");
    expect(text).toContain("  - b — First (backlog)");
    expect(text).toContain("blocks (0):");
    expect(text).toContain("plan: Ship it (id=plan-1) status=active steps=1/1 session=ses_1");
    expect(text).toContain("<work-item-body>\ndo the thing\n</work-item-body>");
  });

  test("marks a missing body and a missing plan", () => {
    const text = renderWorkItemDetail({
      item: item("a"),
      initiativeName: "App",
      blockedBy: [],
      blocks: [],
      children: [],
    });
    expect(text).toContain("plan: none");
    expect(text).toContain("(sem corpo)");
    expect(text).toContain("children (0): none");
  });
});
