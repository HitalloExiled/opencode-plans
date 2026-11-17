import { describe, expect, test } from "bun:test";

const { DatabaseSync } = (await import("node:sqlite")) as any;

import { createInitiative, createRun, getRun, initSchema, setRunStatus, type Db } from "../src/store";
import { recoverRuns, resumeProjectRun } from "../src/run-engine";

const open = (): Db => {
  const db = new DatabaseSync(":memory:") as Db;
  initSchema(db);
  return db;
};

function setup() {
  const db = open();
  const initiative = createInitiative(db, { name: "App", repos: [{ directory: "/work/app" }] });
  if (!initiative.ok) throw new Error(initiative.error);
  const created = createRun(db, { initiativeID: initiative.initiative.id, baseRef: "main" });
  if (!created.ok) throw new Error(created.error);
  return { db, runID: created.run.id };
}

describe("resumeProjectRun", () => {
  test("takes an interrupted run out of interrupted", async () => {
    const { db, runID } = setup();
    expect(recoverRuns(db)).toBe(1);
    expect(getRun(db, runID)?.status).toBe("interrupted");

    const result = await resumeProjectRun({} as never, db, runID);
    expect(result.ok).toBe(true);
    expect(getRun(db, runID)?.status).not.toBe("interrupted");
    expect(getRun(db, runID)?.error).toBeNull();
  });

  test("refuses a run that is not interrupted", async () => {
    const { db, runID } = setup();
    expect(setRunStatus(db, { id: runID, status: "cancelled" }).ok).toBe(true);

    const result = await resumeProjectRun({} as never, db, runID);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("interrompida");
  });

  test("refuses an unknown run", async () => {
    const { db } = setup();
    const result = await resumeProjectRun({} as never, db, "nope");
    expect(result.ok).toBe(false);
  });
});
