import { describe, expect, test } from "bun:test";
import { scheduleRun, summarizeRun, type SchedulerItem } from "../src/run-scheduler";

const item = (id: string, status: SchedulerItem["status"], deps: string[] = []): SchedulerItem => ({
  id,
  deps,
  status,
});

describe("scheduleRun", () => {
  test("starts independent items up to the limit, in order", () => {
    const decision = scheduleRun([item("a", "queued"), item("b", "queued"), item("c", "queued")], 2);
    expect(decision.start).toEqual(["a", "b"]);
    expect(decision.skip).toEqual([]);
    expect(decision.done).toBe(false);
  });

  test("a dependent only starts once the dependency is merged", () => {
    expect(scheduleRun([item("a", "running"), item("b", "queued", ["a"])], 2).start).toEqual([]);
    expect(scheduleRun([item("a", "merging"), item("b", "queued", ["a"])], 2).start).toEqual([]);
    expect(scheduleRun([item("a", "merged"), item("b", "queued", ["a"])], 2).start).toEqual(["b"]);
  });

  test("a failure skips the dependents transitively, independent branches continue", () => {
    const decision = scheduleRun(
      [
        item("a", "failed"),
        item("b", "queued", ["a"]),
        item("c", "queued", ["b"]),
        item("d", "queued"),
      ],
      2,
    );
    expect(decision.skip).toEqual(["b", "c"]);
    expect(decision.start).toEqual(["d"]);
  });

  test("merging does not occupy an execution slot", () => {
    const decision = scheduleRun([item("a", "merging"), item("b", "queued")], 1);
    expect(decision.start).toEqual(["b"]);
  });

  test("a run is done when nothing is queued, running or merging", () => {
    expect(scheduleRun([item("a", "merged"), item("b", "failed")], 2).done).toBe(true);
    expect(scheduleRun([item("a", "merged"), item("b", "queued")], 2).done).toBe(false);
  });
});

describe("summarizeRun", () => {
  test("running while anything is pending", () => {
    expect(summarizeRun([item("a", "merged"), item("b", "running")])).toEqual({
      status: "running",
      merged: 1,
      failed: 0,
      skipped: 0,
    });
  });

  test("failed when an item failed and nothing is pending", () => {
    expect(summarizeRun([item("a", "merged"), item("b", "failed"), item("c", "skipped")])).toEqual({
      status: "failed",
      merged: 1,
      failed: 1,
      skipped: 1,
    });
  });

  test("done when everything finished without failures", () => {
    expect(summarizeRun([item("a", "merged"), item("b", "merged")])).toEqual({
      status: "done",
      merged: 2,
      failed: 0,
      skipped: 0,
    });
  });
});
