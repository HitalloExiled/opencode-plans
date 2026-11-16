import { describe, expect, test } from "bun:test";

const { DatabaseSync } = (await import("node:sqlite")) as any;

import {
  addWorkItemDep,
  createInitiative,
  createWorkItem,
  depEdges,
  initSchema,
  removeWorkItemDep,
  workItemDeps,
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
  const a = add("A");
  const b = add("B");
  const c = add("C");
  return { db, initiativeID: project.initiative.id, a, b, c };
}

const titles = (items: readonly { title: string }[]) => items.map((item) => item.title);

describe("depEdges", () => {
  test("returns the edges of the initiative with their kind", () => {
    const { db, initiativeID, a, b } = setup();
    addWorkItemDep(db, { itemID: b.id, blocksID: a.id });

    expect(depEdges(db, initiativeID)).toEqual([
      { itemID: b.id, blocksID: a.id, kind: "explicit", reason: null },
    ]);
    expect(depEdges(db, "unknown")).toEqual([]);
  });
});

describe("work item dependencies", () => {
  test("adds a dependency and lists both sides", () => {
    const { db, a, b } = setup();
    expect(addWorkItemDep(db, { itemID: a.id, blocksID: b.id }).ok).toBe(true);

    const fromA = workItemDeps(db, a.id);
    expect(titles(fromA.blockedBy)).toEqual(["B"]);
    expect(fromA.blocks).toEqual([]);

    const fromB = workItemDeps(db, b.id);
    expect(fromB.blockedBy).toEqual([]);
    expect(titles(fromB.blocks)).toEqual(["A"]);
  });

  test("duplicating is a no-op and self-dependency is rejected", () => {
    const { db, a, b } = setup();
    expect(addWorkItemDep(db, { itemID: a.id, blocksID: b.id }).ok).toBe(true);
    expect(addWorkItemDep(db, { itemID: a.id, blocksID: b.id }).ok).toBe(true);
    expect(workItemDeps(db, a.id).blockedBy).toHaveLength(1);

    expect(addWorkItemDep(db, { itemID: a.id, blocksID: a.id })).toEqual({
      ok: false,
      error: "um work item não pode depender de si mesmo",
    });
  });

  test("requires both items in the same project", () => {
    const { db, a } = setup();
    const other = createInitiative(db, { name: "Other", repos: [{ directory: "/work/other" }] });
    if (!other.ok) throw new Error(other.error);
    const d = createWorkItem(db, { initiativeID: other.initiative.id, title: "D" });
    if (!d.ok) throw new Error(d.error);

    expect(addWorkItemDep(db, { itemID: a.id, blocksID: d.item.id })).toEqual({
      ok: false,
      error: "os itens precisam pertencer à mesma iniciativa",
    });
    expect(addWorkItemDep(db, { itemID: a.id, blocksID: "missing" }).ok).toBe(false);
  });

  test("rejects a transitive cycle and accepts it after breaking the path", () => {
    const { db, a, b, c } = setup();
    expect(addWorkItemDep(db, { itemID: a.id, blocksID: b.id }).ok).toBe(true);
    expect(addWorkItemDep(db, { itemID: b.id, blocksID: c.id }).ok).toBe(true);

    expect(addWorkItemDep(db, { itemID: c.id, blocksID: a.id })).toEqual({
      ok: false,
      error: "dependência circular: A já depende de C",
    });

    expect(removeWorkItemDep(db, { itemID: b.id, blocksID: c.id }).ok).toBe(true);
    expect(addWorkItemDep(db, { itemID: c.id, blocksID: a.id }).ok).toBe(true);
  });

  test("removing clears both sides", () => {
    const { db, a, b } = setup();
    addWorkItemDep(db, { itemID: a.id, blocksID: b.id });
    expect(removeWorkItemDep(db, { itemID: a.id, blocksID: b.id }).ok).toBe(true);
    expect(workItemDeps(db, a.id).blockedBy).toEqual([]);
    expect(workItemDeps(db, b.id).blocks).toEqual([]);
    // Removing again is harmless.
    expect(removeWorkItemDep(db, { itemID: a.id, blocksID: b.id }).ok).toBe(true);
  });
});
