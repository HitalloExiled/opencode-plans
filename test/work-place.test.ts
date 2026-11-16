import { describe, expect, test } from "bun:test";

const { DatabaseSync } = (await import("node:sqlite")) as any;

import {
  createProject,
  createWorkItem,
  getWorkItem,
  initSchema,
  listWorkItems,
  placeWorkItem,
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
  const add = (title: string) => {
    const result = createWorkItem(db, { projectID: project.project.id, title });
    if (!result.ok) throw new Error(result.error);
    return result.item;
  };
  return { db, projectID: project.project.id, add };
}

const titles = (db: Db, projectID: string, status: string) =>
  listWorkItems(db, projectID)
    .filter((item) => item.status === status)
    .map((item) => item.title);
const ranks = (db: Db, projectID: string, status: string) =>
  listWorkItems(db, projectID)
    .filter((item) => item.status === status)
    .map((item) => item.rank);

describe("placeWorkItem", () => {
  test("moves into another status at an exact index and renumbers it", () => {
    const { db, projectID, add } = setup();
    add("a");
    add("b");
    const c = add("c");
    // Promote a and b so the destination has an order to insert into.
    for (const title of ["a", "b"]) {
      const item = listWorkItems(db, projectID).find((entry) => entry.title === title)!;
      placeWorkItem(db, { id: item.id, status: "ready", position: 0 });
    }
    expect(titles(db, projectID, "ready")).toEqual(["b", "a"]);

    const moved = placeWorkItem(db, { id: c.id, status: "ready", position: 1 });
    expect(moved.ok).toBe(true);
    expect(titles(db, projectID, "ready")).toEqual(["b", "c", "a"]);
    expect(ranks(db, projectID, "ready")).toEqual([1, 2, 3]);
    expect(titles(db, projectID, "backlog")).toEqual([]);
  });

  test("reorders inside the same status", () => {
    const { db, projectID, add } = setup();
    add("a");
    add("b");
    const c = add("c");

    expect(placeWorkItem(db, { id: c.id, status: "backlog", position: 0 }).ok).toBe(true);
    expect(titles(db, projectID, "backlog")).toEqual(["c", "a", "b"]);
    expect(ranks(db, projectID, "backlog")).toEqual([1, 2, 3]);

    expect(placeWorkItem(db, { id: c.id, status: "backlog", position: 99 }).ok).toBe(true);
    expect(titles(db, projectID, "backlog")).toEqual(["a", "b", "c"]);
  });

  test("rejects an invalid transition", () => {
    const { db, add } = setup();
    const a = add("a");
    const result = placeWorkItem(db, { id: a.id, status: "doing", position: 0 });
    expect(result.ok).toBe(false);
  });

  test("closing sets closed_at; moving back clears it", () => {
    const { db, add } = setup();
    const a = add("a");
    placeWorkItem(db, { id: a.id, status: "ready", position: 0 });
    placeWorkItem(db, { id: a.id, status: "doing", position: 0 });

    expect(placeWorkItem(db, { id: a.id, status: "done", position: 0 }).ok).toBe(true);
    const closed = getWorkItem(db, a.id)!;
    expect(closed.status).toBe("done");
    expect(closed.closed_at).not.toBeNull();

    expect(placeWorkItem(db, { id: a.id, status: "ready", position: 0 }).ok).toBe(true);
    expect(getWorkItem(db, a.id)!.closed_at).toBeNull();
  });
});
