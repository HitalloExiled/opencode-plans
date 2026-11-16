/**
 * US-03 — a workspace without a project gets one on first use, idempotently.
 */

import { describe, expect, test } from "bun:test";

const { DatabaseSync } = (await import("node:sqlite")) as any;

import {
  addInitiativeRepo,
  createInitiative,
  ensureInitiativeForDirectory,
  initSchema,
  listInitiatives,
  initiativeNameForDirectory,
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

describe("initiativeNameForDirectory", () => {
  test("uses the basename, falling back to a readable name", () => {
    expect(initiativeNameForDirectory("/work/opencode-tools/")).toBe("opencode-tools");
    expect(initiativeNameForDirectory("/")).toBe("Workspace");
  });
});

describe("ensureInitiativeForDirectory", () => {
  test("creates a project named after the workspace on first use", () => {
    const db = open();
    const result = ensureInitiativeForDirectory(db, "/work/new-repo");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.created).toBe(true);
    expect(result.initiative.name).toBe("new-repo");
    expect(result.initiative.repos.map((repo) => repo.directory)).toEqual(["/work/new-repo"]);
    expect(result.repo.directory).toBe("/work/new-repo");
    expect(listInitiatives(db)).toHaveLength(1);
  });

  test("is idempotent, including with a trailing slash", () => {
    const db = open();
    const first = ensureInitiativeForDirectory(db, "/work/new-repo");
    const second = ensureInitiativeForDirectory(db, "/work/new-repo/");
    if (!first.ok || !second.ok) throw new Error("expected both calls to succeed");

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.initiative.id).toBe(first.initiative.id);
    expect(listInitiatives(db)).toHaveLength(1);
  });

  test("reuses the ancestor project instead of creating one for a subdirectory", () => {
    const db = open();
    const work = project(db, "Work", ["/work"]);
    const result = ensureInitiativeForDirectory(db, "/work/app/src");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.created).toBe(false);
    expect(result.initiative.id).toBe(work.id);
    expect(result.repo.directory).toBe("/work");
    expect(listInitiatives(db)).toHaveLength(1);
    // No new workspace was registered for the subdirectory.
    expect(result.initiative.repos).toHaveLength(1);
  });

  test("reuses an exact workspace", () => {
    const db = open();
    const app = project(db, "App", ["/work/app"]);
    const result = ensureInitiativeForDirectory(db, "/work/app");
    expect(result.ok && result.created === false && result.initiative.id === app.id).toBe(true);
  });

  test("fails on a relative or empty directory without writing", () => {
    const db = open();
    expect(ensureInitiativeForDirectory(db, "work/app")).toEqual({
      ok: false,
      error: "o repositório precisa de um caminho absoluto: work/app",
    });
    expect(ensureInitiativeForDirectory(db, "   ")).toEqual({
      ok: false,
      error: "o diretório do repositório é obrigatório",
    });
    expect(listInitiatives(db)).toHaveLength(0);
  });

  test("a root workspace becomes a 'Workspace' project", () => {
    const db = open();
    const result = ensureInitiativeForDirectory(db, "/");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(true);
    expect(result.initiative.name).toBe("Workspace");
    expect(result.repo.directory).toBe("/");
  });

  test("does not touch an existing project's other workspaces", () => {
    const db = open();
    const app = project(db, "App", ["/work/app"]);
    addInitiativeRepo(db, app.id, { directory: "/work/docs" });
    const result = ensureInitiativeForDirectory(db, "/work/app/src");
    expect(result.ok && result.initiative.repos.length === 2).toBe(true);
  });
});
