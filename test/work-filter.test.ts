import { describe, expect, test } from "bun:test";
import { filterWorkGroups } from "../src/work-filter";
import type { Initiative, WorkGroup, WorkItem } from "../src/gui/contract";

const initiative = (id: string): Initiative => ({
  id,
  name: id,
  createdAt: "",
  updatedAt: "",
  repos: [],
});

const item = (
  id: string,
  origin: "user" | "agent",
  initiativeID = "p1",
  status: WorkItem["status"] = "backlog",
): WorkItem => ({
  id,
  initiativeID,
  title: id,
  status,
  rank: 1,
  origin,
  createdAt: "",
  updatedAt: "",
});

const group = (id: string, items: WorkItem[]): WorkGroup => ({ initiative: initiative(id), items });

const ids = (groups: WorkGroup[]) => groups.flatMap((entry) => entry.items.map((item) => item.id));

describe("filterWorkGroups", () => {
  test("hides dropped items by default and keeps the rest", () => {
    const groups = [group("p1", [item("a", "user"), item("b", "user", "p1", "dropped")])];
    expect(ids(filterWorkGroups(groups, { agentOnly: false, showDropped: false }))).toEqual(["a"]);
    expect(ids(filterWorkGroups(groups, { agentOnly: false, showDropped: true }))).toEqual(["a", "b"]);
  });

  test("keeps only agent items", () => {
    const groups = [group("p1", [item("a", "user"), item("b", "agent")])];
    expect(ids(filterWorkGroups(groups, { agentOnly: true, showDropped: true }))).toEqual(["b"]);
  });

  test("composes origin and status and drops empty groups", () => {
    const groups = [
      group("p1", [item("a", "user"), item("b", "agent"), item("c", "agent", "p1", "dropped")]),
      group("p2", [item("d", "user", "p2")]),
    ];
    const filtered = filterWorkGroups(groups, { agentOnly: true, showDropped: false });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.initiative.id).toBe("p1");
    expect(ids(filtered)).toEqual(["b"]);

    expect(filterWorkGroups([group("p1", [item("a", "user")])], { agentOnly: true, showDropped: true })).toEqual(
      [],
    );
  });
});
