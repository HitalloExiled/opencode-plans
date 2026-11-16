import { describe, expect, test } from "bun:test";
import { locationForItem } from "../src/work-plan";
import type { Project, ProjectLocation } from "../src/gui/contract";

const location = (id: string, primary: boolean): ProjectLocation => ({
  id,
  directory: `/work/${id}`,
  label: id,
  primary,
  position: 0,
});

const project = (locations: ProjectLocation[]): Project => ({
  id: "p1",
  name: "P",
  createdAt: "",
  updatedAt: "",
  locations,
});

describe("locationForItem", () => {
  test("prefers the item's own workspace", () => {
    const p = project([location("a", true), location("b", false)]);
    expect(locationForItem(p, "b")?.id).toBe("b");
  });

  test("falls back to the primary, then the first", () => {
    const p = project([location("a", false), location("b", true)]);
    expect(locationForItem(p, null)?.id).toBe("b");
    expect(locationForItem(p, "missing")?.id).toBe("b");

    const noPrimary = project([location("a", false), location("b", false)]);
    expect(locationForItem(noPrimary)?.id).toBe("a");
  });

  test("is undefined without workspaces", () => {
    expect(locationForItem(project([]))).toBeUndefined();
  });
});
