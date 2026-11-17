import { describe, expect, test } from "bun:test";

const { DatabaseSync } = (await import("node:sqlite")) as any;

import {
  createInitiative,
  createWorkItem,
  getPlan,
  getPlanByWorkItem,
  getWorkItem,
  initSchema,
  savePlan,
  setPlanWorkItem,
  setStep,
  updatePlan,
  type Db,
} from "../src/store";

const open = (): Db => {
  const db = new DatabaseSync(":memory:") as Db;
  initSchema(db);
  return db;
};

function setup() {
  const db = open();
  const initiative = createInitiative(db, { name: "App", repos: [{ directory: "/work/app" }] });
  if (!initiative.ok) throw new Error(initiative.error);
  const item = (title: string) => {
    const created = createWorkItem(db, { initiativeID: initiative.initiative.id, title });
    if (!created.ok) throw new Error(created.error);
    return created.item;
  };
  const plan = (title: string) => {
    const saved = savePlan(db, {
      body: `# ${title}\n\n- [ ] one`,
      projectID: "p1",
      projectDirectory: "/work/app",
      sessionID: "s1",
    });
    if (!saved.ok) throw new Error(saved.error);
    return saved.plan;
  };
  return { db, item, plan };
}

describe("setPlanWorkItem", () => {
  test("links a saved plan to an item and is visible through both reads", () => {
    const { db, item, plan } = setup();
    const target = item("Needs a plan");
    const saved = plan("Adopted plan");

    expect(setPlanWorkItem(db, { id: saved.id, workItemID: target.id }).ok).toBe(true);
    expect(getPlan(db, saved.id)?.work_item_id).toBe(target.id);
    expect(getPlanByWorkItem(db, target.id)?.id).toBe(saved.id);
  });

  test("null unlinks the plan and keeps the plan alive", () => {
    const { db, item, plan } = setup();
    const target = item("Needs a plan");
    const saved = plan("Adopted plan");
    setPlanWorkItem(db, { id: saved.id, workItemID: target.id });

    expect(setPlanWorkItem(db, { id: saved.id, workItemID: null }).ok).toBe(true);
    expect(getPlan(db, saved.id)?.work_item_id).toBeNull();
    expect(getPlanByWorkItem(db, target.id)).toBeUndefined();
  });

  test("refuses to adopt an item another plan already owns", () => {
    const { db, item, plan } = setup();
    const target = item("Needs a plan");
    const first = plan("First");
    const second = plan("Second");
    setPlanWorkItem(db, { id: first.id, workItemID: target.id });

    const result = setPlanWorkItem(db, { id: second.id, workItemID: target.id });
    expect(result.ok).toBe(false);
    expect(getPlanByWorkItem(db, target.id)?.id).toBe(first.id);
  });

  test("refuses unknown plans and items", () => {
    const { db, item, plan } = setup();
    const saved = plan("Adopted plan");
    const target = item("Needs a plan");

    expect(setPlanWorkItem(db, { id: "nope", workItemID: target.id }).ok).toBe(false);
    expect(setPlanWorkItem(db, { id: saved.id, workItemID: "nope" }).ok).toBe(false);
  });
});

describe("plan completion and the work item", () => {
  test("finishing the plan closes the item, reopening the plan reopens it", () => {
    const { db, item, plan } = setup();
    const target = item("Needs a plan");
    const saved = plan("Adopted plan");
    setPlanWorkItem(db, { id: saved.id, workItemID: target.id });

    const step = getPlan(db, saved.id)!.steps[0]!;
    expect(setStep(db, { id: saved.id, stepID: step.step_id, status: "done" }).ok).toBe(true);
    expect(getPlan(db, saved.id)?.status).toBe("done");
    expect(getWorkItem(db, target.id)?.status).toBe("done");

    expect(updatePlan(db, { id: saved.id, status: "active" }).ok).toBe(true);
    expect(getWorkItem(db, target.id)?.status).toBe("ready");
  });
});
