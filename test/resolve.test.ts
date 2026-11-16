/**
 * US-02 — the user project is resolved from the session workspace: exact
 * match first, then the deepest ancestor at a path boundary.
 */

import { describe, expect, test } from "bun:test";

const { DatabaseSync } = (await import("node:sqlite")) as any;

import {
  createInitiative,
  initSchema,
  isInsideWorkspace,
  resolveInitiative,
  type Db,
} from "../src/store";

const open = (): Db => {
  const db = new DatabaseSync(":memory:") as Db;
  initSchema(db);
  return db;
};

function project(db: Db, name: string, repos: string[]) {
  const result = createInitiative(db, { name, repos: repos.map((directory) => ({ directory })) });
  if (!result.ok) throw new Error(result.error);
  return result.initiative;
}

describe("isInsideWorkspace", () => {
  test("matches at path boundaries only", () => {
    expect(isInsideWorkspace("/work/app/src", "/work/app")).toBe(true);
    expect(isInsideWorkspace("/work/app", "/work/app")).toBe(false);
    expect(isInsideWorkspace("/work/app2", "/work/app")).toBe(false);
    expect(isInsideWorkspace("/work", "/")).toBe(true);
    expect(isInsideWorkspace("/", "/")).toBe(false);
  });
});

describe("resolveInitiative", () => {
  test("matches the workspace exactly", () => {
    const db = open();
    const app = project(db, "App", ["/work/app"]);
    const found = resolveInitiative(db, "/work/app");
    expect(found?.initiative.id).toBe(app.id);
    expect(found?.repo.directory).toBe("/work/app");
    expect(found?.match).toBe("exact");
  });

  test("normalizes a trailing slash", () => {
    const db = open();
    const app = project(db, "App", ["/work/app"]);
    expect(resolveInitiative(db, "/work/app/")?.initiative.id).toBe(app.id);
  });

  test("falls back to the ancestor for a subdirectory", () => {
    const db = open();
    const app = project(db, "App", ["/work/app"]);
    const found = resolveInitiative(db, "/work/app/src/deep");
    expect(found?.initiative.id).toBe(app.id);
    expect(found?.match).toBe("ancestor");
  });

  test("does not match a sibling with a shared name prefix", () => {
    const db = open();
    project(db, "App", ["/work/app"]);
    expect(resolveInitiative(db, "/work/app2/src")).toBeUndefined();
  });

  test("nested projects resolve by the most specific workspace", () => {
    const db = open();
    const work = project(db, "Work", ["/work"]);
    const app = project(db, "App", ["/work/app"]);

    expect(resolveInitiative(db, "/work/app/src")?.initiative.id).toBe(app.id);
    expect(resolveInitiative(db, "/work/app")?.initiative.id).toBe(app.id);
    expect(resolveInitiative(db, "/work/app")?.match).toBe("exact");
    expect(resolveInitiative(db, "/work/other")?.initiative.id).toBe(work.id);
    expect(resolveInitiative(db, "/work")?.initiative.id).toBe(work.id);
    expect(resolveInitiative(db, "/work")?.match).toBe("exact");
  });

  test("returns undefined when no workspace contains the directory", () => {
    const db = open();
    project(db, "App", ["/work/app"]);
    expect(resolveInitiative(db, "/elsewhere")).toBeUndefined();
    expect(resolveInitiative(db, "/")).toBeUndefined();
    expect(resolveInitiative(db, "")).toBeUndefined();
  });

  test("the root workspace is an ancestor of everything and an exact match of itself", () => {
    const db = open();
    const root = project(db, "Root", ["/"]);
    expect(resolveInitiative(db, "/anything/here")?.initiative.id).toBe(root.id);
    expect(resolveInitiative(db, "/anything/here")?.match).toBe("ancestor");
    expect(resolveInitiative(db, "/")?.initiative.id).toBe(root.id);
    expect(resolveInitiative(db, "/")?.match).toBe("exact");
  });
});
