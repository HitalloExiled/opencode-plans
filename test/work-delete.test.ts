import { describe, expect, test } from "bun:test";

const { DatabaseSync } = (await import("node:sqlite")) as any;

import {
  createInitiative,
  createRun,
  createRunItem,
  createWorkItem,
  deleteInitiative,
  deleteWorkItem,
  enqueueMerge,
  getInitiative,
  getRun,
  getWorkItem,
  initSchema,
  savePlan,
  setWorkItemParent,
  setRunStatus,
  type Db,
} from "../src/store";

const open = (): Db => {
  const db = new DatabaseSync(":memory:") as Db;
  initSchema(db);
  return db;
};

function setup() {
  const db = open();
  const initiative = createInitiative(db, {
    name: "App",
    repos: [{ directory: "/work/app" }],
  });
  if (!initiative.ok) throw new Error(initiative.error);
  const item = (title: string) => {
    const created = createWorkItem(db, { initiativeID: initiative.initiative.id, title });
    if (!created.ok) throw new Error(created.error);
    return created.item;
  };
  const plan = (workItemID: string) => {
    const saved = savePlan(db, {
      body: `# ${workItemID}\n\n- [ ] one`,
      projectID: "p1",
      projectDirectory: "/work/app",
      sessionID: "s1",
      workItemID,
    });
    if (!saved.ok) throw new Error(saved.error);
    return saved.plan;
  };
  return { db, initiativeID: initiative.initiative.id, item, plan };
}

describe("deleteWorkItem", () => {
  test("removes the item, its deps and unlinks the plan; children become roots", () => {
    const { db, item, plan } = setup();
    const parent = item("Parent");
    const child = item("Child");
    const other = item("Other");
    setWorkItemParent(db, { id: child.id, parentID: parent.id });
    db.prepare("INSERT INTO work_item_deps (item_id, blocks_id, kind, created_at) VALUES (?, ?, 'explicit', 'now')").run(
      parent.id,
      other.id,
    );
    const saved = plan(parent.id);

    expect(deleteWorkItem(db, parent.id).ok).toBe(true);
    expect(getWorkItem(db, parent.id)).toBeUndefined();
    expect(getWorkItem(db, child.id)?.parent_id).toBeNull();
    expect(
      db.prepare("SELECT COUNT(*) AS c FROM work_item_deps WHERE item_id = ? OR blocks_id = ?").get(parent.id, parent.id),
    ).toEqual({ c: 0 });
    expect(getWorkItem(db, other.id)?.id).toBe(other.id);
    // The plan survives, unlinked.
    const row = db.prepare("SELECT work_item_id FROM plans WHERE id = ?").get(saved.id) as { work_item_id: string | null };
    expect(row.work_item_id).toBeNull();
  });

  test("refuses an item that belongs to a run", () => {
    const { db, initiativeID, item } = setup();
    const target = item("In a run");
    const run = createRun(db, { initiativeID, baseRef: "main" });
    if (!run.ok) throw new Error(run.error);
    createRunItem(db, { runID: run.run.id, workItemID: target.id });

    const result = deleteWorkItem(db, target.id);
    expect(result.ok).toBe(false);
  });
});

describe("deleteInitiative", () => {
  test("cascades items, repos and runs; plans stay unlinked", () => {
    const { db, initiativeID, item, plan } = setup();
    const first = item("First");
    const second = item("Second");
    db.prepare("INSERT INTO work_item_deps (item_id, blocks_id, kind, created_at) VALUES (?, ?, 'explicit', 'now')").run(
      first.id,
      second.id,
    );
    const saved = plan(first.id);

    const run = createRun(db, { initiativeID, baseRef: "main" });
    if (!run.ok) throw new Error(run.error);
    createRunItem(db, { runID: run.run.id, workItemID: first.id });
    enqueueMerge(db, { runID: run.run.id, workItemID: first.id });
    setRunStatus(db, { id: run.run.id, status: "cancelled" });

    expect(deleteInitiative(db, initiativeID).ok).toBe(true);
    expect(getInitiative(db, initiativeID)).toBeUndefined();
    expect(getWorkItem(db, first.id)).toBeUndefined();
    expect(getWorkItem(db, second.id)).toBeUndefined();
    expect(getRun(db, run.run.id)).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS c FROM initiative_repos").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) AS c FROM merge_queue").get()).toEqual({ c: 0 });
    const row = db.prepare("SELECT work_item_id FROM plans WHERE id = ?").get(saved.id) as { work_item_id: string | null };
    expect(row.work_item_id).toBeNull();
  });

  test("refuses while an active run exists", () => {
    const { db, initiativeID } = setup();
    const run = createRun(db, { initiativeID, baseRef: "main" });
    if (!run.ok) throw new Error(run.error);

    const result = deleteInitiative(db, initiativeID);
    expect(result.ok).toBe(false);
  });
});
