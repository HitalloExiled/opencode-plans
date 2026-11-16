import { describe, expect, test } from "bun:test";
import { repoForItem } from "../src/work-plan";
import type { Initiative, InitiativeRepo } from "../src/gui/contract";

const repo = (id: string, primary: boolean): InitiativeRepo => ({
  id,
  directory: `/work/${id}`,
  label: id,
  primary,
  position: 0,
});

const initiative = (repos: InitiativeRepo[]): Initiative => ({
  id: "p1",
  name: "P",
  createdAt: "",
  updatedAt: "",
  repos,
});

describe("repoForItem", () => {
  test("prefers the item's own repository", () => {
    const value = initiative([repo("a", true), repo("b", false)]);
    expect(repoForItem(value, "b")?.id).toBe("b");
  });

  test("falls back to the primary, then the first", () => {
    const value = initiative([repo("a", false), repo("b", true)]);
    expect(repoForItem(value, null)?.id).toBe("b");
    expect(repoForItem(value, "missing")?.id).toBe("b");

    const noPrimary = initiative([repo("a", false), repo("b", false)]);
    expect(repoForItem(noPrimary)?.id).toBe("a");
  });

  test("is undefined without repositories", () => {
    expect(repoForItem(initiative([]))).toBeUndefined();
  });
});
