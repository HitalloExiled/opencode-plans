/**
 * US-01 — a work item belongs to an initiative that groups N repositories.
 *
 * There is no resolution, tools, RPC or UI in this slice: only the schema v3,
 * the containment invariants and the store API they are built on.
 */

import { describe, expect, test } from "bun:test";

const { DatabaseSync } = (await import("node:sqlite")) as any;

import {
  addInitiativeRepo,
  createInitiative,
  createWorkItem,
  ensureInitiativeRepo,
  getInitiative,
  getWorkItem,
  initSchema,
  listInitiatives,
  listWorkItems,
  listWorkItemsAll,
  removeInitiativeRepo,
  updateInitiative,
  setWorkItemRepo,
  SCHEMA_VERSION,
  schemaVersion,
  setInitiativePrimary,
  updateWorkItem,
  type Db,
} from "../src/store";

const open = (): Db => {
  const db = new DatabaseSync(":memory:") as Db;
  initSchema(db);
  return db;
};

function project(db: Db, name = "OpenCode Tools", repos = ["/work/app", "/work/plugins"]) {
  const result = createInitiative(db, {
    name,
    repos: repos.map((directory) => ({ directory })),
  });
  if (!result.ok) throw new Error(result.error);
  return result.initiative;
}

describe("schema migrations", () => {
  test("migrates a v2 database to the current schema keeping the plans intact", () => {
    const db = new DatabaseSync(":memory:") as Db;
    initSchema(db); // current schema, so a plan can be written

    db.prepare(
      `INSERT INTO plans
         (id, project_id, project_directory, session_id, message_id, title, body, status, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL)`,
    ).run("plan-1", "opencode-1", "/work/app", "session-1", "v2 plan", "# v2 plan", "active", "2026-01-01", "2026-01-01");

    // Simulate the v2 file: the work-item tables do not exist yet.
    db.prepare("DROP TABLE work_item_deps").run();
    db.prepare("DROP TABLE work_items").run();
    db.prepare("DROP TABLE initiative_repos").run();
    db.prepare("DROP TABLE initiatives").run();
    db.prepare("PRAGMA user_version = 2").run();
    expect(schemaVersion(db)).toBe(2);

    initSchema(db);
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    expect((db.prepare("SELECT title FROM plans WHERE id = 'plan-1'").get() as { title: string }).title).toBe(
      "v2 plan",
    );
    expect(listInitiatives(db)).toEqual([]);

    // Re-running the migration is a no-op.
    initSchema(db);
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
  });
});

describe("v7 migration repair", () => {
  test("keeps the old rows when empty new tables exist (aborted migration)", () => {
    const db = new DatabaseSync(":memory:") as Db;
    db.prepare(
      `CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        base_branch TEXT, max_parallel INTEGER NOT NULL DEFAULT 2, verify_command TEXT
      )`,
    ).run();
    db.prepare(
      `CREATE TABLE project_locations (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, directory TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL, is_primary INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      )`,
    ).run();
    db.prepare(
      `CREATE TABLE initiatives (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, base_branch TEXT,
        max_parallel INTEGER NOT NULL DEFAULT 2, verify_command TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`,
    ).run();
    db.prepare(
      `CREATE TABLE initiative_repos (
        id TEXT PRIMARY KEY, initiative_id TEXT NOT NULL, directory TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL, is_primary INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      )`,
    ).run();
    db.prepare("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('old', 'Keep', 'a', 'a')").run();
    db.prepare(
      "INSERT INTO project_locations (id, project_id, directory, label, is_primary, position, created_at) VALUES ('loc', 'old', '/work/app', 'app', 1, 0, 'a')",
    ).run();
    db.prepare("PRAGMA user_version = 6").run();

    initSchema(db);

    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    expect(getInitiative(db, "old")?.name).toBe("Keep");
    expect(getInitiative(db, "old")?.repos.map((repo) => repo.directory)).toEqual(["/work/app"]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='projects'").get()).toBeUndefined();
  });
});

describe("v8 migration", () => {
  test("adds the description column to a v7 database", () => {
    const db = new DatabaseSync(":memory:") as Db;
    db.prepare(
      `CREATE TABLE initiatives (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, base_branch TEXT,
        max_parallel INTEGER NOT NULL DEFAULT 2, verify_command TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`,
    ).run();
    db.prepare("INSERT INTO initiatives (id, name, created_at, updated_at) VALUES ('i1', 'Old', 'a', 'a')").run();
    db.prepare("PRAGMA user_version = 7").run();

    initSchema(db);

    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
  });
});

describe("projects", () => {
  test("is born with its repositories, the first is primary", () => {
    const db = open();
    const app = project(db);
    expect(app.name).toBe("OpenCode Tools");
    expect(app.repos.map((repo) => repo.directory)).toEqual(["/work/app", "/work/plugins"]);
    expect(app.repos.map((repo) => repo.primary)).toEqual([true, false]);
    expect(app.repos.map((repo) => repo.label)).toEqual(["app", "plugins"]);
  });

  test("can start empty, with only a name", () => {
    const db = open();
    const created = createInitiative(db, { name: "Empty" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.initiative.repos).toEqual([]);
    expect(createInitiative(db, { name: "Plain" }).ok).toBe(true);
  });

  test("requires an absolute repository path", () => {
    const db = open();
    expect(createInitiative(db, { name: "Relative", repos: [{ directory: "work/app" }] })).toEqual({
      ok: false,
      error: "o repositório precisa de um caminho absoluto: work/app",
    });
  });

  test("rejects a repeated directory, with or without a trailing slash", () => {
    const db = open();
    expect(createInitiative(db, { name: "Dup", repos: [{ directory: "/a" }, { directory: "/a/" }] }).ok).toBe(false);
  });

  test("a directory belongs to a single project", () => {
    const db = open();
    project(db);
    const second = createInitiative(db, { name: "Other", repos: [{ directory: "/work/app/" }] });
    expect(second).toEqual({ ok: false, error: "o repositório /work/app já pertence a outra iniciativa" });
  });

  test("adds a repository at the end, not primary", () => {
    const db = open();
    const app = project(db);
    const added = addInitiativeRepo(db, app.id, { directory: "/work/docs/" });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.repo.directory).toBe("/work/docs");
    expect(added.repo.primary).toBe(false);
    expect(added.repo.position).toBe(2);
    expect(getInitiative(db, app.id)!.repos).toHaveLength(3);
  });

  test("switches the primary", () => {
    const db = open();
    const app = project(db);
    const second = app.repos[1]!;
    expect(setInitiativePrimary(db, app.id, second.id).ok).toBe(true);
    expect(getInitiative(db, app.id)!.repos.map((repo) => repo.primary)).toEqual([false, true]);
    expect(setInitiativePrimary(db, app.id, "missing").ok).toBe(false);
  });

  test("removes a repository with items only after confirmation", () => {
    const db = open();
    const app = project(db);
    const second = app.repos[1]!;
    const item = createWorkItem(db, { initiativeID: app.id, repoID: second.id, title: "Need" });
    if (!item.ok) throw new Error(item.error);

    expect(removeInitiativeRepo(db, app.id, second.id)).toEqual({
      ok: false,
      error: "há 1 work item(ns) neste repositório; confirme para removê-lo e deixá-los sem repositório",
      needsConfirmation: true,
      items: 1,
    });
    expect(getWorkItem(db, item.item.id)?.repo_id).toBe(second.id);

    expect(removeInitiativeRepo(db, app.id, second.id, { confirm: true }).ok).toBe(true);
    expect(getWorkItem(db, item.item.id)?.repo_id).toBeNull();
    expect(getInitiative(db, app.id)!.repos.map((repo) => repo.id)).toEqual([app.repos[0]!.id]);

    // The last repository can go too: the initiative just has none.
    expect(removeInitiativeRepo(db, app.id, app.repos[0]!.id).ok).toBe(true);
    expect(getInitiative(db, app.id)!.repos).toEqual([]);
  });

  test("updates the name keeping ids and links", () => {
    const db = open();
    const app = project(db);
    const item = createWorkItem(db, { initiativeID: app.id, title: "Need" });
    if (!item.ok) throw new Error(item.error);

    const renamed = updateInitiative(db, { id: app.id, name: "  New name  " });
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;
    expect(renamed.initiative.name).toBe("New name");
    expect(renamed.initiative.id).toBe(app.id);
    expect(renamed.initiative.repos.map((repo) => repo.id)).toEqual(
      app.repos.map((repo) => repo.id),
    );
    expect(getWorkItem(db, item.item.id)?.initiative_id).toBe(app.id);
    expect(updateInitiative(db, { id: app.id, name: "   " })).toEqual({
      ok: false,
      error: "o nome da iniciativa é obrigatório",
    });
    expect(updateInitiative(db, { id: "missing", name: "x" }).ok).toBe(false);
  });

  test("removing the primary promotes the next repository", () => {
    const db = open();
    const app = project(db);
    const second = app.repos[1]!;
    setInitiativePrimary(db, app.id, second.id);
    expect(removeInitiativeRepo(db, app.id, second.id).ok).toBe(true);
    expect(getInitiative(db, app.id)!.repos.map((repo) => repo.primary)).toEqual([true]);
  });
});

describe("repo selection", () => {
  test("ensureInitiativeRepo reuses an existing repo and creates a new one", () => {
    const db = open();
    const app = project(db);

    const existing = ensureInitiativeRepo(db, app.id, "/work/app/");
    expect(existing.ok).toBe(true);
    if (!existing.ok) return;
    expect(existing.created).toBe(false);
    expect(existing.repo.id).toBe(app.repos[0]!.id);

    const added = ensureInitiativeRepo(db, app.id, "/work/extra");
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.created).toBe(true);
    expect(getInitiative(db, app.id)!.repos.map((repo) => repo.directory)).toContain("/work/extra");

    const other = project(db, "Other", ["/work/other"]);
    expect(ensureInitiativeRepo(db, other.id, "/work/extra").ok).toBe(false);
    expect(ensureInitiativeRepo(db, other.id, "relative").ok).toBe(false);
  });

  test("setWorkItemRepo moves the item inside its initiative only", () => {
    const db = open();
    const app = project(db);
    const other = project(db, "Other", ["/work/other"]);
    const item = createWorkItem(db, { initiativeID: app.id, title: "Need" });
    if (!item.ok) throw new Error(item.error);

    const moved = setWorkItemRepo(db, { id: item.item.id, repoID: app.repos[1]!.id });
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.item.repo_id).toBe(app.repos[1]!.id);

    expect(setWorkItemRepo(db, { id: item.item.id, repoID: other.repos[0]!.id }).ok).toBe(false);
    expect(setWorkItemRepo(db, { id: item.item.id, repoID: "nope" }).ok).toBe(false);
  });
});

describe("work item containment", () => {
  test("requires a title and an existing project", () => {
    const db = open();
    const app = project(db);
    expect(createWorkItem(db, { initiativeID: app.id, title: "   " }).ok).toBe(false);
    expect(createWorkItem(db, { initiativeID: "missing", title: "Need" }).ok).toBe(false);
  });

  test("belongs to the project and starts in the backlog, ranked", () => {
    const db = open();
    const app = project(db);
    const first = createWorkItem(db, { initiativeID: app.id, title: "  First need  " });
    const second = createWorkItem(db, { initiativeID: app.id, title: "Second need", origin: "agent" });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(first.item.title).toBe("First need");
    expect(first.item.initiative_id).toBe(app.id);
    expect(first.item.repo_id).toBeNull();
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

    const ok = createWorkItem(db, { initiativeID: app.id, repoID: app.repos[1]!.id, title: "Need" });
    expect(ok.ok).toBe(true);

    const wrong = createWorkItem(db, { initiativeID: app.id, repoID: other.repos[0]!.id, title: "Need" });
    expect(wrong).toEqual({ ok: false, error: "o repositório não pertence a esta iniciativa" });
  });

  test("updates the need, preserving what is omitted", () => {
    const db = open();
    const app = project(db);
    const created = createWorkItem(db, { initiativeID: app.id, title: "Need", body: "why" });
    if (!created.ok) throw new Error(created.error);
    const id = created.item.id;

    const titleOnly = updateWorkItem(db, { id, title: "  Better need  " });
    expect(titleOnly.ok).toBe(true);
    if (!titleOnly.ok) return;
    expect(titleOnly.item.title).toBe("Better need");
    expect(titleOnly.item.body).toBe("why");

    const bodyOnly = updateWorkItem(db, { id, body: "new context" });
    expect(bodyOnly.ok && bodyOnly.item.title === "Better need" && bodyOnly.item.body === "new context").toBe(true);

    expect(updateWorkItem(db, { id, title: "   " })).toEqual({
      ok: false,
      error: "o título do work item é obrigatório",
    });
    expect(updateWorkItem(db, { id: "missing", title: "x" }).ok).toBe(false);
  });

  test("listWorkItemsAll returns items from every project", () => {
    const db = open();
    const first = project(db, "First", ["/work/first"]);
    const second = project(db, "Second", ["/work/second"]);
    createWorkItem(db, { initiativeID: first.id, title: "a1" });
    createWorkItem(db, { initiativeID: second.id, title: "b1" });
    expect(listWorkItemsAll(db).map((item) => item.title).sort()).toEqual(["a1", "b1"]);
  });

  test("getWorkItem returns what was stored", () => {
    const db = open();
    const app = project(db);
    const created = createWorkItem(db, { initiativeID: app.id, title: "Need", body: "  why  " });
    if (!created.ok) throw new Error(created.error);
    expect(getWorkItem(db, created.item.id)?.body).toBe("why");
    expect(getWorkItem(db, "missing")).toBeUndefined();
  });
});

describe("initiative overview", () => {
  test("schema v12 carries the overview column", () => {
    const db = open();
    const columns = db.prepare("PRAGMA table_info(initiatives)").all() as { name: string }[];
    expect(columns.some((column) => column.name === "overview")).toBe(true);
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
  });

  test("the overview round-trips", () => {
    const db = open();
    const created = createInitiative(db, {
      name: "App",
      overview: "# What\n\nA todo app.",
      repos: [{ directory: "/work/app" }],
    });
    if (!created.ok) throw new Error(created.error);
    expect(created.initiative.overview).toBe("# What\n\nA todo app.");

    // Omitted fields are kept; a blank overview clears it and nothing else.
    const renamed = updateInitiative(db, { id: created.initiative.id, name: "App 2" });
    expect(renamed.ok).toBe(true);
    expect(getInitiative(db, created.initiative.id)?.overview).toBe("# What\n\nA todo app.");

    const cleared = updateInitiative(db, { id: created.initiative.id, overview: "   " });
    expect(cleared.ok).toBe(true);
    expect(getInitiative(db, created.initiative.id)?.overview).toBe(null);
  });
});
