/**
 * US-03 — a workspace without a project gets one on first use, idempotently.
 */

import { describe, expect, test } from "bun:test";

const { DatabaseSync } = (await import("node:sqlite")) as any;

import {
  addProjectLocation,
  createProject,
  ensureProjectForDirectory,
  initSchema,
  listProjects,
  projectNameForDirectory,
  type Db,
} from "../src/store";

const open = (): Db => {
  const db = new DatabaseSync(":memory:") as Db;
  initSchema(db);
  return db;
};

function project(db: Db, name: string, locations: string[]) {
  const result = createProject(db, { name, locations: locations.map((directory) => ({ directory })) });
  if (!result.ok) throw new Error(result.error);
  return result.project;
}

describe("projectNameForDirectory", () => {
  test("uses the basename, falling back to a readable name", () => {
    expect(projectNameForDirectory("/work/opencode-tools/")).toBe("opencode-tools");
    expect(projectNameForDirectory("/")).toBe("Workspace");
  });
});

describe("ensureProjectForDirectory", () => {
  test("creates a project named after the workspace on first use", () => {
    const db = open();
    const result = ensureProjectForDirectory(db, "/work/new-repo");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.created).toBe(true);
    expect(result.project.name).toBe("new-repo");
    expect(result.project.locations.map((location) => location.directory)).toEqual(["/work/new-repo"]);
    expect(result.location.directory).toBe("/work/new-repo");
    expect(listProjects(db)).toHaveLength(1);
  });

  test("is idempotent, including with a trailing slash", () => {
    const db = open();
    const first = ensureProjectForDirectory(db, "/work/new-repo");
    const second = ensureProjectForDirectory(db, "/work/new-repo/");
    if (!first.ok || !second.ok) throw new Error("expected both calls to succeed");

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.project.id).toBe(first.project.id);
    expect(listProjects(db)).toHaveLength(1);
  });

  test("reuses the ancestor project instead of creating one for a subdirectory", () => {
    const db = open();
    const work = project(db, "Work", ["/work"]);
    const result = ensureProjectForDirectory(db, "/work/app/src");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.created).toBe(false);
    expect(result.project.id).toBe(work.id);
    expect(result.location.directory).toBe("/work");
    expect(listProjects(db)).toHaveLength(1);
    // No new workspace was registered for the subdirectory.
    expect(result.project.locations).toHaveLength(1);
  });

  test("reuses an exact workspace", () => {
    const db = open();
    const app = project(db, "App", ["/work/app"]);
    const result = ensureProjectForDirectory(db, "/work/app");
    expect(result.ok && result.created === false && result.project.id === app.id).toBe(true);
  });

  test("fails on a relative or empty directory without writing", () => {
    const db = open();
    expect(ensureProjectForDirectory(db, "work/app")).toEqual({
      ok: false,
      error: "o workspace precisa de um caminho absoluto: work/app",
    });
    expect(ensureProjectForDirectory(db, "   ")).toEqual({
      ok: false,
      error: "o diretório do workspace é obrigatório",
    });
    expect(listProjects(db)).toHaveLength(0);
  });

  test("a root workspace becomes a 'Workspace' project", () => {
    const db = open();
    const result = ensureProjectForDirectory(db, "/");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(true);
    expect(result.project.name).toBe("Workspace");
    expect(result.location.directory).toBe("/");
  });

  test("does not touch an existing project's other workspaces", () => {
    const db = open();
    const app = project(db, "App", ["/work/app"]);
    addProjectLocation(db, app.id, { directory: "/work/docs" });
    const result = ensureProjectForDirectory(db, "/work/app/src");
    expect(result.ok && result.project.locations.length === 2).toBe(true);
  });
});
