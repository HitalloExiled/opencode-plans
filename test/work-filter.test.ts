import { describe, expect, test } from "bun:test";
import { filterWorkGroups } from "../src/work-filter";
import type { Project, WorkGroup, WorkItem } from "../src/gui/contract";

const project = (id: string): Project => ({
  id,
  name: id,
  createdAt: "",
  updatedAt: "",
  locations: [],
});

const item = (id: string, origin: "user" | "agent", projectID = "p1"): WorkItem => ({
  id,
  projectID,
  title: id,
  status: "backlog",
  rank: 1,
  origin,
  createdAt: "",
  updatedAt: "",
});

const group = (id: string, items: WorkItem[]): WorkGroup => ({ project: project(id), items });

describe("filterWorkGroups", () => {
  test("returns everything when the filter is off", () => {
    const groups = [group("p1", [item("a", "user"), item("b", "agent")]), group("p2", [item("c", "user", "p2")])];
    expect(filterWorkGroups(groups, false)).toEqual(groups);
  });

  test("keeps only agent items and drops empty groups", () => {
    const groups = [
      group("p1", [item("a", "user"), item("b", "agent")]),
      group("p2", [item("c", "user", "p2"), item("d", "user", "p2")]),
    ];
    const filtered = filterWorkGroups(groups, true);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.project.id).toBe("p1");
    expect(filtered[0]!.items.map((entry) => entry.id)).toEqual(["b"]);
  });

  test("can end up empty", () => {
    expect(filterWorkGroups([group("p1", [item("a", "user")])], true)).toEqual([]);
  });
});
