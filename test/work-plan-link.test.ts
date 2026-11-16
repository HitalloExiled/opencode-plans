import { describe, expect, test } from "bun:test";

const { DatabaseSync } = (await import("node:sqlite")) as any;

import {
  createProject,
  createWorkItem,
  getPlan,
  getPlanByWorkItem,
  initSchema,
  savePlan,
  SCHEMA_VERSION,
  schemaVersion,
  type Db,
} from "../src/store";

const open = (): Db => {
  const db = new DatabaseSync(":memory:") as Db;
  initSchema(db);
  return db;
};

function setup() {
  const db = open();
  const project = createProject(db, { name: "App", locations: [{ directory: "/work/app" }] });
  if (!project.ok) throw new Error(project.error);
  const item = createWorkItem(db, { projectID: project.project.id, title: "Need" });
  if (!item.ok) throw new Error(item.error);
  return { db, item: item.item };
}

const plan = (db: Db, workItemID: string, extra: Record<string, unknown> = {}) =>
  savePlan(db, {
    title: "The plan",
    body: "# The plan\n\n- [ ] do it",
    projectID: "opencode-1",
    projectDirectory: "/work/app",
    sessionID: "session-1",
    workItemID,
    ...extra,
  });

describe("plan <-> work item link", () => {
  test("links a plan to the item and resolves it both ways", () => {
    const { db, item } = setup();
    const saved = plan(db, item.id);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;

    expect(saved.plan.work_item_id).toBe(item.id);
    expect(getPlan(db, saved.plan.id)?.work_item_id).toBe(item.id);
    expect(getPlanByWorkItem(db, item.id)?.id).toBe(saved.plan.id);
    expect(getPlanByWorkItem(db, "missing")).toBeUndefined();
  });

  test("rejects a second plan for the same item", () => {
    const { db, item } = setup();
    expect(plan(db, item.id).ok).toBe(true);
    expect(plan(db, item.id)).toEqual({
      ok: false,
      error: "este work item já tem um plano; edite o plano existente",
    });
  });

  test("rejects an unknown item and keeps the link on edit", () => {
    const { db, item } = setup();
    expect(plan(db, "missing").ok).toBe(false);

    const saved = plan(db, item.id);
    if (!saved.ok) throw new Error(saved.error);
    const edited = savePlan(db, {
      id: saved.plan.id,
      title: "Edited",
      body: "# Edited\n\n- [ ] do it",
      projectID: "opencode-1",
      projectDirectory: "/work/app",
      sessionID: "session-1",
    });
    expect(edited.ok && edited.plan.work_item_id === item.id).toBe(true);

    const unlinked = savePlan(db, {
      id: saved.plan.id,
      title: "Unlinked",
      body: "# Unlinked",
      projectID: "opencode-1",
      projectDirectory: "/work/app",
      sessionID: "session-1",
      workItemID: null,
    });
    expect(unlinked.ok && unlinked.plan.work_item_id === null).toBe(true);
  });

  test("migrates a v4 database, adding the column and the unique index", () => {
    const db = new DatabaseSync(":memory:") as Db;
    db.prepare(
      `CREATE TABLE plans (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        project_directory TEXT NOT NULL,
        session_id TEXT NOT NULL,
        message_id TEXT,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      )`,
    ).run();
    db.prepare(
      `CREATE TABLE plan_steps (
        plan_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        step_id TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        PRIMARY KEY (plan_id, position)
      )`,
    ).run();
    db.prepare("PRAGMA user_version = 4").run();
    db.prepare(
      `INSERT INTO plans (id, project_id, project_directory, session_id, message_id, title, body, status, created_at, updated_at, completed_at)
       VALUES ('p1', 'opencode-1', '/work/app', 's1', NULL, 'Old', '# Old', 'active', '2026-01-01', '2026-01-01', NULL)`,
    ).run();

    initSchema(db);
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    expect(getPlan(db, "p1")?.title).toBe("Old");
    expect(getPlan(db, "p1")?.work_item_id).toBeNull();

    const columns = db.prepare("PRAGMA table_info(plans)").all() as { name: string }[];
    expect(columns.map((column) => column.name)).toContain("work_item_id");

    // The partial unique index is the final guard against two linked plans.
    const insert = (id: string) =>
      db
        .prepare(
          `INSERT INTO plans (id, project_id, project_directory, session_id, message_id, title, body, status, created_at, updated_at, completed_at, work_item_id)
           VALUES (?, 'opencode-1', '/work/app', 's1', NULL, 'T', '# T', 'active', '2026-01-01', '2026-01-01', NULL, 'item-1')`,
        )
        .run(id);
    insert("p2");
    expect(() => insert("p3")).toThrow();
  });
});
