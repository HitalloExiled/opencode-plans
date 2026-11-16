import { describe, expect, test } from "bun:test";

const { DatabaseSync } = (await import("node:sqlite")) as any;

import { createProject, initSchema, listProjects, type Db } from "../src/store";
import { captureWorkItem } from "../src/work-capture";

const open = (): Db => {
  const db = new DatabaseSync(":memory:") as Db;
  initSchema(db);
  return db;
};

describe("captureWorkItem", () => {
  test("requires a title and writes nothing without it", () => {
    const db = open();
    expect(captureWorkItem(db, { directory: "/work/app", title: "   " })).toEqual({
      ok: false,
      error: "o título do work item é obrigatório",
    });
    expect(listProjects(db)).toHaveLength(0);
  });

  test("creates the project on first use and starts the item in the backlog", () => {
    const db = open();
    const result = captureWorkItem(db, {
      directory: "/work/new-repo",
      title: "  First need  ",
      body: "  what needs to exist  ",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.createdProject).toBe(true);
    expect(result.project.name).toBe("new-repo");
    expect(result.project.locations.map((location) => location.directory)).toEqual(["/work/new-repo"]);
    expect(result.item.title).toBe("First need");
    expect(result.item.body).toBe("what needs to exist");
    expect(result.item.status).toBe("backlog");
    expect(result.item.origin).toBe("user");
    expect(result.item.project_id).toBe(result.project.id);
    expect(result.item.location_id).toBe(result.project.locations[0]!.id);
  });

  test("reuses the project (and its workspace) for a subdirectory", () => {
    const db = open();
    const created = createProject(db, { name: "App", locations: [{ directory: "/work/app" }] });
    if (!created.ok) throw new Error(created.error);

    const result = captureWorkItem(db, { directory: "/work/app/src", title: "Inside the repo" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.createdProject).toBe(false);
    expect(result.project.id).toBe(created.project.id);
    expect(result.item.location_id).toBe(created.project.locations[0]!.id);
    expect(listProjects(db)).toHaveLength(1);
  });

  test("surfaces a workspace error without writing", () => {
    const db = open();
    expect(captureWorkItem(db, { directory: "relative", title: "Need" })).toEqual({
      ok: false,
      error: "o workspace precisa de um caminho absoluto: relative",
    });
    expect(listProjects(db)).toHaveLength(0);
  });
});
