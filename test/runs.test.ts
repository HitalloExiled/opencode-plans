import { describe, expect, test } from "bun:test";

const { DatabaseSync } = (await import("node:sqlite")) as any;

import {
  claimNextMerge,
  createInitiative,
  createRun,
  createRunItem,
  enqueueMerge,
  finishMerge,
  getInitiative,
  getRun,
  getRunItem,
  initSchema,
  listMergeQueue,
  listRunItems,
  planTouches,
  setPlanTouches,
  setInitiativeRunSettings,
  setRunItemStatus,
  setRunMergeSession,
  setRunStatus,
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
  return { db, initiativeID: project.initiative.id };
}

const newRun = (db: Db, initiativeID: string) => {
  const run = createRun(db, { initiativeID, baseRef: "main" });
  if (!run.ok) throw new Error(run.error);
  return run.run;
};

describe("runs", () => {
  test("one active run per project, defaulting the parallelism", () => {
    const { db, initiativeID } = setup();
    const run = newRun(db, initiativeID);
    expect(run.status).toBe("running");
    expect(run.max_parallel).toBe(2);

    const second = createRun(db, { initiativeID, baseRef: "main" });
    expect(second.ok).toBe(false);
  });

  test("an interrupted run keeps blocking until it resumes or is cancelled", () => {
    const { db, initiativeID } = setup();
    const run = newRun(db, initiativeID);

    expect(setRunStatus(db, { id: run.id, status: "interrupted" }).ok).toBe(true);
    expect(createRun(db, { initiativeID, baseRef: "main" }).ok).toBe(false);

    expect(setRunStatus(db, { id: run.id, status: "running" }).ok).toBe(true);
    expect(getRun(db, run.id)?.finished_at).toBeNull();

    expect(setRunStatus(db, { id: run.id, status: "cancelled" }).ok).toBe(true);
    expect(createRun(db, { initiativeID, baseRef: "main" }).ok).toBe(true);
  });

  test("a failed run records the error and the finish time; terminal runs freeze", () => {
    const { db, initiativeID } = setup();
    const run = newRun(db, initiativeID);
    const failed = setRunStatus(db, { id: run.id, status: "failed", error: "boom" });
    expect(failed.ok).toBe(true);
    if (!failed.ok) return;
    expect(failed.run.error).toBe("boom");
    expect(failed.run.finished_at).not.toBeNull();

    expect(setRunStatus(db, { id: run.id, status: "running" }).ok).toBe(false);
  });

  test("links the merge session", () => {
    const { db, initiativeID } = setup();
    const run = newRun(db, initiativeID);
    const linked = setRunMergeSession(db, run.id, "ses_merge");
    expect(linked.ok).toBe(true);
    if (!linked.ok) return;
    expect(linked.run.merge_session_id).toBe("ses_merge");
  });
});

describe("run items", () => {
  test("tracks queued -> running -> merged with timestamps and sha", () => {
    const { db, initiativeID } = setup();
    const run = newRun(db, initiativeID);
    const created = createRunItem(db, { runID: run.id, workItemID: "item-1", planID: "plan-1" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.item.status).toBe("queued");
    expect(created.item.started_at).toBeNull();

    const running = setRunItemStatus(db, { runID: run.id, workItemID: "item-1", status: "running", sessionID: "ses_1" });
    expect(running.ok).toBe(true);
    if (!running.ok) return;
    expect(running.item.started_at).not.toBeNull();
    expect(running.item.session_id).toBe("ses_1");

    const merged = setRunItemStatus(db, {
      runID: run.id,
      workItemID: "item-1",
      status: "merged",
      mergedSha: "abc123",
    });
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.item.finished_at).not.toBeNull();
    expect(merged.item.merged_sha).toBe("abc123");
    expect(listRunItems(db, run.id)).toHaveLength(1);
  });

  test("a failure keeps the reason", () => {
    const { db, initiativeID } = setup();
    const run = newRun(db, initiativeID);
    createRunItem(db, { runID: run.id, workItemID: "item-1" });
    setRunItemStatus(db, { runID: run.id, workItemID: "item-1", status: "failed", error: "nope" });
    expect(getRunItem(db, run.id, "item-1")?.error).toBe("nope");
  });
});

describe("merge queue", () => {
  test("enqueues once and claims FIFO, one at a time", () => {
    const { db, initiativeID } = setup();
    const run = newRun(db, initiativeID);
    enqueueMerge(db, { runID: run.id, workItemID: "a" });
    enqueueMerge(db, { runID: run.id, workItemID: "a" });
    enqueueMerge(db, { runID: run.id, workItemID: "b" });
    expect(listMergeQueue(db, run.id)).toHaveLength(2);

    const first = claimNextMerge(db, run.id);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.entry?.work_item_id).toBe("a");
    expect(first.entry?.status).toBe("merging");

    const busy = claimNextMerge(db, run.id);
    expect(busy.ok).toBe(true);
    if (!busy.ok) return;
    expect(busy.entry).toBeNull();

    expect(finishMerge(db, { id: first.entry!.id, status: "merged", mergedSha: "sha" }).ok).toBe(true);
    const second = claimNextMerge(db, run.id);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.entry?.work_item_id).toBe("b");
  });

  test("a finish requires a claimed entry", () => {
    const { db, initiativeID } = setup();
    const run = newRun(db, initiativeID);
    enqueueMerge(db, { runID: run.id, workItemID: "a" });
    const entry = listMergeQueue(db, run.id)[0]!;
    expect(finishMerge(db, { id: entry.id, status: "merged" }).ok).toBe(false);
  });
});

describe("footprint and settings", () => {
  test("replaces the plan footprint without duplicates", () => {
    const { db } = setup();
    setPlanTouches(db, "plan-1", ["src/a.ts", "src/a.ts", " src/b.ts "]);
    expect(planTouches(db, "plan-1")).toEqual(["src/a.ts", "src/b.ts"]);
    setPlanTouches(db, "plan-1", ["src/c.ts"]);
    expect(planTouches(db, "plan-1")).toEqual(["src/c.ts"]);
    setPlanTouches(db, "plan-1", []);
    expect(planTouches(db, "plan-1")).toEqual([]);
  });

  test("stores the run settings, clamping the parallelism", () => {
    const { db, initiativeID } = setup();
    const result = setInitiativeRunSettings(db, initiativeID, {
      baseBranch: " develop ",
      maxParallel: 42,
      verifyCommand: "bun test",
    });
    expect(result.ok).toBe(true);
    const project = getInitiative(db, initiativeID)!;
    expect(project.base_branch).toBe("develop");
    expect(project.max_parallel).toBe(8);
    expect(project.verify_command).toBe("bun test");

    const run = newRun(db, initiativeID);
    expect(run.max_parallel).toBe(8);
  });

  test("a run remembers the repository the preflight resolved", () => {
    const { db, initiativeID } = setup();
    const created = createRun(db, { initiativeID, baseRef: "main", repo: "/work/app" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.run.repo).toBe("/work/app");
    expect(getRun(db, created.run.id)?.repo).toBe("/work/app");
  });
});
