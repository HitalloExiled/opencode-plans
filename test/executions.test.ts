import { describe, expect, test } from "bun:test";

const { DatabaseSync } = (await import("node:sqlite")) as any;

import {
  activeExecutions,
  finishExecution,
  initSchema,
  staleExecutions,
  startExecution,
  type Db,
} from "../src/store";

const open = (): Db => {
  const db = new DatabaseSync(":memory:") as Db;
  initSchema(db);
  return db;
};

const start = (db: Db, repo = "/work/app", mode: "solo" | "worktree" = "solo") =>
  startExecution(db, { repo, mode, branch: "wi/item-1", workItemID: "item-1" });

describe("executions", () => {
  test("a started execution is active until it finishes", () => {
    const db = open();
    const started = start(db);
    if (!started.ok) throw new Error(started.error);

    expect(activeExecutions(db, "/work/app").map((row) => row.id)).toEqual([started.execution.id]);
    expect(finishExecution(db, started.execution.id).ok).toBe(true);
    expect(activeExecutions(db, "/work/app")).toEqual([]);
  });

  test("only the same repository counts", () => {
    const db = open();
    const here = start(db, "/work/app");
    const elsewhere = start(db, "/work/other");
    if (!here.ok || !elsewhere.ok) throw new Error("start");

    expect(activeExecutions(db, "/work/app").map((row) => row.id)).toEqual([here.execution.id]);
    expect(activeExecutions(db, "/work/app", here.execution.id)).toEqual([]);
  });

  test("a stale row is ignored and can be closed", () => {
    const db = open();
    const started = start(db);
    if (!started.ok) throw new Error(started.error);
    const old = new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString();
    db.prepare("UPDATE executions SET started_at = ? WHERE id = ?").run(old, started.execution.id);

    expect(activeExecutions(db, "/work/app")).toEqual([]);
    expect(staleExecutions(db)).toBe(1);
  });
});
