import { describe, expect, test } from "bun:test";
import { sortWorkItems, workStatusRank } from "../src/work-list";

const item = (status: string, rank: number, created_at = "2026-01-01T00:00:00.000Z") => ({
  status,
  rank,
  created_at,
});

describe("work list ordering", () => {
  test("follows the UI status order, not the alphabet", () => {
    const sorted = sortWorkItems([
      item("dropped", 1),
      item("backlog", 1),
      item("done", 1),
      item("blocked", 1),
      item("ready", 1),
      item("doing", 1),
    ]);
    expect(sorted.map((entry) => entry.status)).toEqual([
      "doing",
      "ready",
      "blocked",
      "backlog",
      "done",
      "dropped",
    ]);
  });

  test("sorts by rank inside a status and by creation as the tiebreaker", () => {
    const sorted = sortWorkItems([
      item("ready", 3),
      item("ready", 1, "2026-01-02T00:00:00.000Z"),
      item("ready", 1, "2026-01-01T00:00:00.000Z"),
      item("ready", 2),
    ]);
    expect(sorted.map((entry) => entry.rank)).toEqual([1, 1, 2, 3]);
    expect(sorted[0]!.created_at).toBe("2026-01-01T00:00:00.000Z");
  });

  test("an unknown status goes last", () => {
    expect(workStatusRank("bogus")).toBeGreaterThan(workStatusRank("dropped"));
  });
});
