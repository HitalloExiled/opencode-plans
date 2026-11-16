/**
 * US-01 — a work item belongs to a user project that groups N workspaces.
 *
 * There is no resolution, tools, RPC or UI in this slice: only the schema v3,
 * the containment invariants and the store API they are built on.
 */

import { describe, expect, test } from "bun:test";

const { DatabaseSync } = (await import("node:sqlite")) as any;

import {
  addProjectLocation,
  createProject,
  createWorkItem,
  getProject,
  getWorkItem,
  initSchema,
  listProjects,
  listWorkItems,
  listWorkItemsAll,
  removeProjectLocation,
  renameProject,
  schemaVersion,
  setPrimaryLocation,
  type Db,
} from "../src/store";

const open = (): Db => {
  const db = new DatabaseSync(":memory:") as Db;
  initSchema(db);
  return db;
};

function project(db: Db, name = "OpenCode Tools", locations = ["/work/app", "/work/plugins"]) {
  const result = createProject(db, {
    name,
    locations: locations.map((directory) => ({ directory })),
  });
  if (!result.ok) throw new Error(result.error);
  return result.project;
}

describe("schema v3", () => {
  test("migrates a v2 database to v3 keeping the plans intact", () => {
    const db = new DatabaseSync(":memory:") as Db;
    initSchema(db); // current schema, so a plan can be written

    db.prepare(
      `INSERT INTO plans
         (id, project_id, project_directory, session_id, message_id, title, body, status, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL)`,
    ).run("plan-1", "opencode-1", "/work/app", "session-1", "v2 plan", "# v2 plan", "active", "2026-01-01", "2026-01-01");

    // Simulate the v2 file: the work-item tables do not exist yet.
    db.prepare("DROP TABLE work_items").run();
    db.prepare("DROP TABLE project_locations").run();
    db.prepare("DROP TABLE projects").run();
    db.prepare("PRAGMA user_version = 2").run();
    expect(schemaVersion(db)).toBe(2);

    initSchema(db);
    expect(schemaVersion(db)).toBe(3);
    expect((db.prepare("SELECT title FROM plans WHERE id = 'plan-1'").get() as { title: string }).title).toBe(
      "v2 plan",
    );
    expect(listProjects(db)).toEqual([]);

    // Re-running the migration is a no-op.
    initSchema(db);
    expect(schemaVersion(db)).toBe(3);
  });
});

describe("projects", () => {
  test("is born with its workspaces, the first is primary", () => {
    const db = open();
    const app = project(db);
    expect(app.name).toBe("OpenCode Tools");
    expect(app.locations.map((location) => location.directory)).toEqual(["/work/app", "/work/plugins"]);
    expect(app.locations.map((location) => location.primary)).toEqual([true, false]);
    expect(app.locations.map((location) => location.label)).toEqual(["app", "plugins"]);
  });

  test("requires at least one workspace", () => {
    const db = open();
    expect(createProject(db, { name: "Empty", locations: [] })).toEqual({
      ok: false,
      error: "um projeto precisa de pelo menos um workspace",
    });
  });

  test("requires an absolute workspace path", () => {
    const db = open();
    expect(createProject(db, { name: "Relative", locations: [{ directory: "work/app" }] })).toEqual({
      ok: false,
      error: "o workspace precisa de um caminho absoluto: work/app",
    });
  });

  test("rejects a repeated directory, with or without a trailing slash", () => {
    const db = open();
    expect(createProject(db, { name: "Dup", locations: [{ directory: "/a" }, { directory: "/a/" }] }).ok).toBe(false);
  });

  test("a directory belongs to a single project", () => {
    const db = open();
    project(db);
    const second = createProject(db, { name: "Other", locations: [{ directory: "/work/app/" }] });
    expect(second).toEqual({ ok: false, error: "o workspace /work/app já pertence a outro projeto" });
  });

  test("adds a workspace at the end, not primary", () => {
    const db = open();
    const app = project(db);
    const added = addProjectLocation(db, app.id, { directory: "/work/docs/" });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.location.directory).toBe("/work/docs");
    expect(added.location.primary).toBe(false);
    expect(added.location.position).toBe(2);
    expect(getProject(db, app.id)!.locations).toHaveLength(3);
  });

  test("switches the primary", () => {
    const db = open();
    const app = project(db);
    const second = app.locations[1]!;
    expect(setPrimaryLocation(db, app.id, second.id).ok).toBe(true);
    expect(getProject(db, app.id)!.locations.map((location) => location.primary)).toEqual([false, true]);
    expect(setPrimaryLocation(db, app.id, "missing").ok).toBe(false);
  });

  test("removes a workspace with items only after confirmation", () => {
    const db = open();
    const app = project(db);
    const second = app.locations[1]!;
    const item = createWorkItem(db, { projectID: app.id, locationID: second.id, title: "Need" });
    if (!item.ok) throw new Error(item.error);

    expect(removeProjectLocation(db, app.id, second.id)).toEqual({
      ok: false,
      error: "há 1 work item(ns) neste workspace; confirme para removê-lo e deixá-los sem workspace",
      needsConfirmation: true,
      items: 1,
    });
    expect(getWorkItem(db, item.item.id)?.location_id).toBe(second.id);

    expect(removeProjectLocation(db, app.id, second.id, { confirm: true }).ok).toBe(true);
    expect(getWorkItem(db, item.item.id)?.location_id).toBeNull();
    expect(getProject(db, app.id)!.locations.map((location) => location.id)).toEqual([app.locations[0]!.id]);

    expect(removeProjectLocation(db, app.id, app.locations[0]!.id)).toEqual({
      ok: false,
      error: "o projeto precisa de pelo menos um workspace",
    });
  });

  test("renames the project keeping ids and links", () => {
    const db = open();
    const app = project(db);
    const item = createWorkItem(db, { projectID: app.id, title: "Need" });
    if (!item.ok) throw new Error(item.error);

    const renamed = renameProject(db, app.id, "  New name  ");
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;
    expect(renamed.project.name).toBe("New name");
    expect(renamed.project.id).toBe(app.id);
    expect(renamed.project.locations.map((location) => location.id)).toEqual(
      app.locations.map((location) => location.id),
    );
    expect(getWorkItem(db, item.item.id)?.project_id).toBe(app.id);
    expect(renameProject(db, app.id, "   ")).toEqual({ ok: false, error: "o nome do projeto é obrigatório" });
    expect(renameProject(db, "missing", "x").ok).toBe(false);
  });

  test("removing the primary promotes the next workspace", () => {
    const db = open();
    const app = project(db);
    const second = app.locations[1]!;
    setPrimaryLocation(db, app.id, second.id);
    expect(removeProjectLocation(db, app.id, second.id).ok).toBe(true);
    expect(getProject(db, app.id)!.locations.map((location) => location.primary)).toEqual([true]);
  });
});

describe("work item containment", () => {
  test("requires a title and an existing project", () => {
    const db = open();
    const app = project(db);
    expect(createWorkItem(db, { projectID: app.id, title: "   " }).ok).toBe(false);
    expect(createWorkItem(db, { projectID: "missing", title: "Need" }).ok).toBe(false);
  });

  test("belongs to the project and starts in the backlog, ranked", () => {
    const db = open();
    const app = project(db);
    const first = createWorkItem(db, { projectID: app.id, title: "  First need  " });
    const second = createWorkItem(db, { projectID: app.id, title: "Second need", origin: "agent" });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(first.item.title).toBe("First need");
    expect(first.item.project_id).toBe(app.id);
    expect(first.item.location_id).toBeNull();
    expect(first.item.status).toBe("backlog");
    expect(first.item.rank).toBe(1);
    expect(first.item.origin).toBe("user");
    expect(second.item.rank).toBe(2);
    expect(second.item.origin).toBe("agent");
    expect(listWorkItems(db, app.id).map((item) => item.title)).toEqual(["First need", "Second need"]);
  });

  test("can target one of the project's workspaces, never another project's", () => {
    const db = open();
    const app = project(db);
    const other = project(db, "Other", ["/work/other"]);

    const ok = createWorkItem(db, { projectID: app.id, locationID: app.locations[1]!.id, title: "Need" });
    expect(ok.ok).toBe(true);

    const wrong = createWorkItem(db, { projectID: app.id, locationID: other.locations[0]!.id, title: "Need" });
    expect(wrong).toEqual({ ok: false, error: "o workspace não pertence a este projeto" });
  });

  test("listWorkItemsAll returns items from every project", () => {
    const db = open();
    const first = project(db, "First", ["/work/first"]);
    const second = project(db, "Second", ["/work/second"]);
    createWorkItem(db, { projectID: first.id, title: "a1" });
    createWorkItem(db, { projectID: second.id, title: "b1" });
    expect(listWorkItemsAll(db).map((item) => item.title).sort()).toEqual(["a1", "b1"]);
  });

  test("getWorkItem returns what was stored", () => {
    const db = open();
    const app = project(db);
    const created = createWorkItem(db, { projectID: app.id, title: "Need", body: "  why  " });
    if (!created.ok) throw new Error(created.error);
    expect(getWorkItem(db, created.item.id)?.body).toBe("why");
    expect(getWorkItem(db, "missing")).toBeUndefined();
  });
});
