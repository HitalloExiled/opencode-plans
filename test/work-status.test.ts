import { describe, expect, test } from "bun:test";

const { DatabaseSync } = (await import("node:sqlite")) as any;

import {
  createProject,
  createWorkItem,
  getWorkItem,
  initSchema,
  setWorkItemStatus,
  type Db,
} from "../src/store";

const open = (): Db => {
  const db = new DatabaseSync(":memory:") as Db;
  initSchema(db);
  return db;
};

function item(db: Db) {
  const project = createProject(db, { name: "App", locations: [{ directory: "/work/app" }] });
  if (!project.ok) throw new Error(project.error);
  const created = createWorkItem(db, { projectID: project.project.id, title: "Need" });
  if (!created.ok) throw new Error(created.error);
  return created.item;
}

describe("work item status", () => {
  test("walks backlog -> ready -> doing -> done and closes at done", () => {
    const db = open();
    const first = item(db);

    for (const status of ["ready", "doing", "done"] as const) {
      const moved = setWorkItemStatus(db, { id: first.id, status });
      expect(moved.ok, status).toBe(true);
      if (!moved.ok) return;
      expect(moved.item.status).toBe(status);
      expect(Boolean(moved.item.closed_at), status).toBe(status === "done");
    }
  });

  test("reopening a done item clears closed_at", () => {
    const db = open();
    const first = item(db);
    setWorkItemStatus(db, { id: first.id, status: "ready" });
    setWorkItemStatus(db, { id: first.id, status: "doing" });
    const done = setWorkItemStatus(db, { id: first.id, status: "done" });
    expect(done.ok && done.item.closed_at !== null).toBe(true);

    const reopened = setWorkItemStatus(db, { id: first.id, status: "ready" });
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    expect(reopened.item.status).toBe("ready");
    expect(reopened.item.closed_at).toBeNull();
  });

  test("dropping closes and restoring clears", () => {
    const db = open();
    const first = item(db);
    const dropped = setWorkItemStatus(db, { id: first.id, status: "dropped" });
    expect(dropped.ok && dropped.item.closed_at !== null).toBe(true);
    const restored = setWorkItemStatus(db, { id: first.id, status: "backlog" });
    expect(restored.ok && restored.item.status === "backlog" && restored.item.closed_at === null).toBe(true);
  });

  test("blocked is reachable from ready and doing", () => {
    const db = open();
    const first = item(db);
    expect(setWorkItemStatus(db, { id: first.id, status: "ready" }).ok).toBe(true);
    expect(setWorkItemStatus(db, { id: first.id, status: "blocked" }).ok).toBe(true);
    expect(setWorkItemStatus(db, { id: first.id, status: "doing" }).ok).toBe(true);
    expect(getWorkItem(db, first.id)?.status).toBe("doing");
  });

  test("rejects an invalid move with the reason", () => {
    const db = open();
    const first = item(db);
    expect(setWorkItemStatus(db, { id: first.id, status: "done" })).toEqual({
      ok: false,
      error: "transição inválida: backlog -> done",
    });

    setWorkItemStatus(db, { id: first.id, status: "ready" });
    setWorkItemStatus(db, { id: first.id, status: "doing" });
    setWorkItemStatus(db, { id: first.id, status: "done" });
    expect(setWorkItemStatus(db, { id: first.id, status: "doing" })).toEqual({
      ok: false,
      error: "transição inválida: done -> doing",
    });
  });

  test("same status is a no-op and an unknown id fails", () => {
    const db = open();
    const first = item(db);
    const before = getWorkItem(db, first.id)!;
    const same = setWorkItemStatus(db, { id: first.id, status: "backlog" });
    expect(same.ok && same.item.status === "backlog").toBe(true);
    expect(getWorkItem(db, first.id)?.updated_at).toBe(before.updated_at);
    expect(setWorkItemStatus(db, { id: "missing", status: "ready" }).ok).toBe(false);
  });
});
