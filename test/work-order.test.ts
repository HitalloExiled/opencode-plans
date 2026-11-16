import { describe, expect, test } from "bun:test";

const { DatabaseSync } = (await import("node:sqlite")) as any;

import {
  createInitiative,
  createWorkItem,
  initSchema,
  listWorkItems,
  moveWorkItem,
  setWorkItemStatus,
  type Db,
} from "../src/store";

const open = (): Db => {
  const db = new DatabaseSync(":memory:") as Db;
  initSchema(db);
  return db;
};

function setup() {
  const db = open();
  const project = createInitiative(db, { name: "App", repos: [{ directory: "/work/app" }] });
  if (!project.ok) throw new Error(project.error);
  const add = (title: string) => {
    const result = createWorkItem(db, { initiativeID: project.initiative.id, title });
    if (!result.ok) throw new Error(result.error);
    return result.item;
  };
  return { db, initiativeID: project.initiative.id, add };
}

const titles = (db: Db, initiativeID: string) => listWorkItems(db, initiativeID).map((item) => item.title);
const ranks = (db: Db, initiativeID: string) => listWorkItems(db, initiativeID).map((item) => item.rank);

describe("manual order", () => {
  test("moves an item up and down, renumbering the group", () => {
    const { db, initiativeID, add } = setup();
    add("a");
    add("b");
    const c = add("c");
    expect(titles(db, initiativeID)).toEqual(["a", "b", "c"]);

    expect(moveWorkItem(db, { id: c.id, direction: "up" }).ok).toBe(true);
    expect(titles(db, initiativeID)).toEqual(["a", "c", "b"]);

    expect(moveWorkItem(db, { id: c.id, direction: "up" }).ok).toBe(true);
    expect(titles(db, initiativeID)).toEqual(["c", "a", "b"]);
    expect(ranks(db, initiativeID)).toEqual([1, 2, 3]);

    expect(moveWorkItem(db, { id: c.id, direction: "down" }).ok).toBe(true);
    expect(titles(db, initiativeID)).toEqual(["a", "c", "b"]);
    expect(ranks(db, initiativeID)).toEqual([1, 2, 3]);
  });

  test("is a no-op at the edges", () => {
    const { db, initiativeID, add } = setup();
    const a = add("a");
    const b = add("b");
    const before = ranks(db, initiativeID);

    expect(moveWorkItem(db, { id: a.id, direction: "up" }).ok).toBe(true);
    expect(moveWorkItem(db, { id: b.id, direction: "down" }).ok).toBe(true);
    expect(titles(db, initiativeID)).toEqual(["a", "b"]);
    expect(ranks(db, initiativeID)).toEqual(before);
  });

  test("a status change lands at the end of the destination section", () => {
    const { db, initiativeID, add } = setup();
    add("a");
    add("b");
    const d = add("first ready");
    const e = add("second ready");
    expect(setWorkItemStatus(db, { id: d.id, status: "ready" }).ok).toBe(true);
    expect(setWorkItemStatus(db, { id: e.id, status: "ready" }).ok).toBe(true);

    const ready = listWorkItems(db, initiativeID).filter((item) => item.status === "ready");
    expect(ready.map((item) => item.title)).toEqual(["first ready", "second ready"]);
    expect(ready.map((item) => item.rank)).toEqual([1, 2]);
  });

  test("an unknown id fails", () => {
    const { db } = setup();
    expect(moveWorkItem(db, { id: "missing", direction: "up" }).ok).toBe(false);
  });
});
