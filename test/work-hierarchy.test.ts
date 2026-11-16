import { describe, expect, test } from "bun:test";

const { DatabaseSync } = (await import("node:sqlite")) as any;

import {
  createProject,
  createWorkItem,
  getWorkItem,
  initSchema,
  setWorkItemParent,
  setWorkItemStatus,
  workItemChildren,
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
  const a = add("A");
  const b = add("B");
  const c = add("C");
  return { db, projectID: project.project.id, a, b, c, add };
}

const titles = (items: readonly { title: string }[]) => items.map((item) => item.title);

describe("work item hierarchy", () => {
  test("groups items under a root parent, one level deep", () => {
    const { db, a, b, c } = setup();
    expect(setWorkItemParent(db, { id: b.id, parentID: a.id }).ok).toBe(true);
    expect(setWorkItemParent(db, { id: c.id, parentID: a.id }).ok).toBe(true);

    expect(titles(workItemChildren(db, a.id))).toEqual(["B", "C"]);
    expect(getWorkItem(db, b.id)?.parent_id).toBe(a.id);
  });

  test("rejects self, cross-project, depth and an item that already has children", () => {
    const { db, projectID, a, b, add } = setup();
    expect(setWorkItemParent(db, { id: a.id, parentID: a.id })).toEqual({
      ok: false,
      error: "um work item não pode ser pai de si mesmo",
    });

    const other = createProject(db, { name: "Other", locations: [{ directory: "/work/other" }] });
    if (!other.ok) throw new Error(other.error);
    const d = createWorkItem(db, { projectID: other.project.id, title: "D" });
    if (!d.ok) throw new Error(d.error);
    expect(setWorkItemParent(db, { id: a.id, parentID: d.item.id }).ok).toBe(false);

    setWorkItemParent(db, { id: b.id, parentID: a.id });
    expect(setWorkItemParent(db, { id: a.id, parentID: b.id })).toEqual({
      ok: false,
      error: "profundidade máxima de 1: o pai escolhido já é filho de outro item",
    });

    const root = add("Root");
    expect(setWorkItemParent(db, { id: a.id, parentID: root.id })).toEqual({
      ok: false,
      error: "um item com filhos não pode ter pai",
    });
    expect(projectID).toBeTruthy();
  });

  test("clears and re-parents", () => {
    const { db, a, b, c } = setup();
    setWorkItemParent(db, { id: b.id, parentID: a.id });
    expect(setWorkItemParent(db, { id: b.id, parentID: null }).ok).toBe(true);
    expect(getWorkItem(db, b.id)?.parent_id).toBeNull();
    expect(workItemChildren(db, a.id)).toEqual([]);

    expect(setWorkItemParent(db, { id: b.id, parentID: c.id }).ok).toBe(true);
    expect(titles(workItemChildren(db, c.id))).toEqual(["B"]);
  });

  test("dropping the parent keeps the children linked", () => {
    const { db, a, b } = setup();
    setWorkItemParent(db, { id: b.id, parentID: a.id });
    expect(setWorkItemStatus(db, { id: a.id, status: "dropped" }).ok).toBe(true);
    expect(getWorkItem(db, b.id)?.parent_id).toBe(a.id);
  });
});
